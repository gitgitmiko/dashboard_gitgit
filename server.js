import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { cp, lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { homedir as osHomedir, hostname as osHostname, loadavg, uptime, cpus, networkInterfaces } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer } from "ws";
import { collectCleanup, killCleanup } from "./cleanup.js";
import { remoteStatus, startRemote, stopRemote } from "./remote-claude.js";
import { appIcon, appsStatus, deleteAnnouncement, draftAnnouncement, postAnnouncement } from "./apps.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
// UI baru (React, hasil `npm run build` di web/); selama transisi disajikan di BASE/v2/.
const WEB_DIST = resolve(process.env.WEB_DIST || join(__dirname, "web", "dist"));
// Subdomain khusus dashboard: UI di root "/", sedangkan BASE/... (API, WebSocket) tetap
// dilayani apa adanya, jadi UI memakai API yang sama dengan akses lokal (BASE/v2/).
const DASHBOARD_HOST = (process.env.DASHBOARD_HOST || "dashboard.gitgitmiko.my.id").toLowerCase();
// Host publik lain (mis. gitgitmiko.my.id/agen lewat tunnel) tidak dilindungi Cloudflare Access, jadi hanya
// melayani link preview publik dan mengalihkan sisanya ke DASHBOARD_HOST. PUBLIC_HOST_LOCKDOWN=0 mematikannya.
const PUBLIC_HOST_LOCKDOWN = process.env.PUBLIC_HOST_LOCKDOWN !== "0";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
// Proses yatim yang lebih muda dari ini tidak ditawarkan untuk dibersihkan (mungkin sengaja baru dijalankan).
const CLEANUP_MIN_AGE_SEC = Number(process.env.CLEANUP_MIN_AGE_SEC ?? 1800);
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(join(__dirname, ".env"));

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4180);
const BASE = (process.env.BASE_PATH || "/agen").replace(/\/+$/, "") || "/agen";
if (!process.env.DASHBOARD_PASSWORD) {
  console.warn("DASHBOARD_PASSWORD belum di-set; login akan selalu ditolak");
}
const HOME = osHomedir();
const PYTHON = "/usr/bin/python3";
const PTY_BRIDGE = join(__dirname, "pty-bridge.py");
const MAX_PREVIEW = 512 * 1024;
const MAX_LIST = 4000;
const PAGE_SIZES = [10, 25, 50, 100];
const CCTV_DIR = resolve(process.env.CCTV_REC_DIR || "/mnt/cctv");
// API konten sosmed milik scraper-data-gitgit (hanya bisa dijangkau dari host); dibaca read-only.
const SOCIAL_API_URL = (process.env.SOCIAL_API_URL || "http://172.18.0.1:8791").replace(/\/+$/, "");
const SOCIAL_API_KEY = process.env.SOCIAL_API_KEY || "";
// API monitoring "Apa yang terjadi jika" (whatif-automation, service whatif); dibaca read-only.
const WHATIF_API_URL = (process.env.WHATIF_API_URL || "http://172.18.0.1:8798").replace(/\/+$/, "");
const WHATIF_API_TOKEN = process.env.WHATIF_API_TOKEN || "";
const CCTV_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CCTV_FILE_RE = /^\d{2}-\d{2}-\d{2}\.mp4$/;
const MAX_TERM = 16;
// Folder project yang ditawarkan di tab Remote Claude (satu tombol per repo git).
const REPOS_DIR = resolve(process.env.REMOTE_REPOS_DIR || join(HOME, "github-repos"));
const TERM_BUFFER_MAX = 1024 * 1024;
const sessions = new Map();
const SESSION_MS = 12 * 60 * 60 * 1000;
const termSessions = new Map();
let termSeq = 0;

let cpuPrev = readCpuSample();
let netPrev = { at: Date.now(), counters: readNetCounters() };

function passwordOk(input) {
  const expected = process.env.DASHBOARD_PASSWORD || "";
  if (!expected) return false;
  const a = createHash("sha256").update(String(input ?? ""), "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function sessionUser(req) {
  const token = readCookie(req, "dg_session");
  if (!token) return null;
  const row = sessions.get(token);
  if (!row) return null;
  if (row.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return row;
}

function send(res, status, body, headers = {}) {
  const data = Buffer.from(body);
  res.writeHead(status, {
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(data);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), { "Content-Type": "application/json; charset=utf-8" });
}

function readCpuSample() {
  const line = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = (line[3] || 0) + (line[4] || 0);
  const total = line.reduce((sum, n) => sum + n, 0);
  return { idle, total };
}

function cpuPercent() {
  const next = readCpuSample();
  const idle = next.idle - cpuPrev.idle;
  const total = next.total - cpuPrev.total;
  cpuPrev = next;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idle / total) * 100));
}

function readMeminfo() {
  const out = {};
  for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
    const match = line.match(/^(\w+):\s+(\d+)/);
    if (match) out[match[1]] = Number(match[2]) * 1024;
  }
  return out;
}

function readNetCounters() {
  const counters = {};
  const lines = readFileSync("/proc/net/dev", "utf8").split("\n").slice(2);
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;
    const name = parts[0].replace(":", "");
    if (name === "lo") continue;
    counters[name] = { rx: Number(parts[1]), tx: Number(parts[9]) };
  }
  return counters;
}

function networkRates() {
  const now = Date.now();
  const counters = readNetCounters();
  const seconds = Math.max(0.001, (now - netPrev.at) / 1000);
  const ifaces = [];
  for (const [name, row] of Object.entries(counters)) {
    const prev = netPrev.counters[name] || row;
    ifaces.push({
      name,
      rx_bps: Math.max(0, (row.rx - prev.rx) / seconds),
      tx_bps: Math.max(0, (row.tx - prev.tx) / seconds),
    });
  }
  netPrev = { at: now, counters };
  return ifaces.sort((a, b) => b.rx_bps + b.tx_bps - (a.rx_bps + a.tx_bps));
}

async function readDisks() {
  const { stdout } = await execFileAsync("df", ["-B1", "-x", "tmpfs", "-x", "devtmpfs", "-x", "overlay", "-x", "squashfs"]);
  return stdout
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      const mount = parts.slice(5).join(" ");
      return {
        source: parts[0],
        size: Number(parts[1]),
        used: Number(parts[2]),
        avail: Number(parts[3]),
        percent: Number(String(parts[4]).replace("%", "")),
        mount,
      };
    })
    .filter((row) => row.mount && row.size > 0 && !row.mount.startsWith("/sys") && !row.mount.startsWith("/proc") && !row.mount.startsWith("/dev"));
}

async function collectStats() {
  const mem = readMeminfo();
  const total = mem.MemTotal || 0;
  const available = mem.MemAvailable || 0;
  const used = Math.max(0, total - available);
  const swapTotal = mem.SwapTotal || 0;
  const swapFree = mem.SwapFree || 0;
  const [one, five, fifteen] = loadavg();
  const cpuList = cpus();
  return {
    hostname: osHostname(),
    time: new Date().toISOString(),
    uptime_sec: uptime(),
    home: HOME,
    load: { one, five, fifteen },
    cpu: {
      percent: cpuPercent(),
      model: cpuList[0]?.model?.trim() || "CPU",
      cores: cpuList.length,
    },
    memory: {
      total,
      used,
      available,
      percent: total ? (used / total) * 100 : 0,
      swap_total: swapTotal,
      swap_used: Math.max(0, swapTotal - swapFree),
    },
    disks: await readDisks(),
    network: networkRates(),
  };
}

// Keterangan alamat yang sudah dikenal di server ini. Yang tidak ada di sini tetap
// ditampilkan dengan nama proses (kalau terbaca) supaya layanan baru ikut terlihat.
const KNOWN_PORTS = {
  22: "SSH — akses remote shell ke server",
  53: "DNS — AdGuard Home (192.168.18.207) / systemd-resolved (127.0.0.53)",
  631: "CUPS — layanan printer",
  3000: "AdGuard Home — panel admin web (DNS filter iklan untuk LAN)",
  1883: "Mosquitto — broker MQTT (Home Assistant ↔ Frigate)",
  3306: "MySQL — database",
  33060: "MySQL X Protocol",
  4173: "WEBUNIME — situs utama gitgitmiko.my.id",
  5000: "Frigate — API internal NVR",
  4180: "Dashboard ini (dashboard.gitgitmiko.my.id; /agen di domain utama hanya preview publik)",
  5037: "ADB server — koneksi debug Android",
  5678: "n8n — otomasi workflow Instagram (container Docker)",
  8790: "Media n8n — nginx penyaji file media (media.gitgitmiko.my.id)",
  8791: "scraper-social-api — API konten Sosmed (scraper-data-gitgit)",
  8796: "gitgitdev-site — situs gitgitdev.my.id",
  8797: "KUISABON — API youtube_short_automation",
  8123: "Home Assistant — otomasi rumah (ha.gitgitmiko.my.id)",
  8554: "Frigate — restream RTSP kamera (go2rtc)",
  8555: "Frigate — WebRTC live view kamera",
  8798: "What If — API pipeline whatif-automation",
  8971: "Frigate — NVR/deteksi objek CCTV (cctv.gitgitmiko.my.id)",
  20128: "9router — router/proxy model AI (9router.gitgitmiko.my.id)",
  20241: "cloudflared — metrik tunnel Cloudflare",
};
const KNOWN_LAN = {
  "192.168.18.1": "Router / gateway internet (DHCP)",
  "192.168.18.102": "Kamera CCTV (RTSP, direkam ke /mnt/cctv)",
  "192.168.18.207": "Server ini (gitgit-server)",
};
const CLOUDFLARED_CONFIG = process.env.CLOUDFLARED_CONFIG || join(HOME, ".cloudflared", "config.yml");
let addressCache = { at: 0, data: null };

function describeInterface(name) {
  if (name === "lo") return "Loopback — hanya bisa diakses dari server sendiri";
  if (/^wl/.test(name)) return "Wi-Fi — jaringan lokal (LAN) rumah";
  if (/^(en|eth)/.test(name)) return "Ethernet — jaringan lokal (LAN)";
  if (name === "docker0") return "Bridge default Docker";
  if (/^br-/.test(name)) return "Bridge jaringan Docker compose";
  if (/^veth/.test(name)) return "Kabel virtual container Docker";
  if (/^(tun|wg|tailscale)/.test(name)) return "VPN / tunnel";
  return "Antarmuka jaringan";
}

function readTunnelIngress() {
  let text;
  try {
    text = readFileSync(CLOUDFLARED_CONFIG, "utf8");
  } catch {
    return [];
  }
  // Parser kecil untuk bagian ingress config.yml (cukup untuk format cloudflared yang datar).
  const rules = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(-\s*)?(hostname|path|service):\s*(.+?)\s*$/);
    if (!m) continue;
    if (m[1]) {
      cur = {};
      rules.push(cur);
    }
    if (cur) cur[m[2]] = m[3].replace(/^["']|["']$/g, "");
  }
  return rules
    .filter((r) => r.hostname)
    .map((r) => {
      const port = Number((r.service.match(/:(\d+)(\/|$)/) || [])[1]);
      return {
        hostname: r.hostname,
        path: r.path ? r.path.replace(/^\^/, "") : "",
        service: r.service,
        info: KNOWN_PORTS[port] || "",
      };
    });
}

async function readListeners() {
  let out = "";
  try {
    ({ stdout: out } = await execFileAsync("ss", ["-H", "-ltnp"], { timeout: 4000 }));
  } catch {
    return [];
  }
  const seen = new Map();
  for (const line of out.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const local = parts[3];
    const idx = local.lastIndexOf(":");
    const rawAddress = local.slice(0, idx).replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    // IPv4 dan IPv6 wildcard untuk port yang sama dianggap satu baris.
    const address = rawAddress === "::" || rawAddress === "*" ? "0.0.0.0" : rawAddress;
    const port = Number(local.slice(idx + 1));
    const proc = (line.match(/users:\(\("([^"]+)"/) || [])[1] || "";
    const key = `${address}:${port}`;
    if (!seen.has(key)) seen.set(key, { address, port, process: proc, info: KNOWN_PORTS[port] || (proc ? `Proses ${proc}` : "Tidak dikenal") });
  }
  const scope = (a) => (a === "0.0.0.0" ? "Semua antarmuka (LAN)" : a.startsWith("127.") || a === "::1" ? "Lokal saja" : a.startsWith("172.") ? "Docker" : "LAN");
  return [...seen.values()].map((r) => ({ ...r, scope: scope(r.address) })).sort((a, b) => a.port - b.port || a.address.localeCompare(b.address));
}

async function readDockerAddresses() {
  try {
    const { stdout } = await execFileAsync("docker", ["ps", "-q"], { timeout: 4000 });
    const ids = stdout.split("\n").filter(Boolean);
    if (!ids.length) return [];
    const { stdout: info } = await execFileAsync(
      "docker",
      ["inspect", "--format", "{{.Name}}|{{.Config.Image}}|{{.HostConfig.NetworkMode}}|{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", ...ids],
      { timeout: 4000 },
    );
    return info
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, image, mode, ips] = line.split("|");
        return { name: name.replace(/^\//, ""), image, network: mode, ip: mode === "host" ? "pakai IP host" : ips.trim() || "—" };
      });
  } catch {
    return [];
  }
}

async function readLanNeighbors() {
  try {
    const { stdout } = await execFileAsync("ip", ["-4", "neigh"], { timeout: 4000 });
    return stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((p) => p.length >= 5 && p[3] === "lladdr" && !p[2].startsWith("br-") && p[2] !== "docker0")
      .map((p) => ({ ip: p[0], dev: p[2], mac: p[4], state: p[p.length - 1], info: KNOWN_LAN[p[0]] || "Perangkat lain di LAN (HP/laptop via DHCP)" }))
      .sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

async function collectAddresses() {
  if (addressCache.data && Date.now() - addressCache.at < 30000) return addressCache.data;
  const interfaces = Object.entries(networkInterfaces())
    .flatMap(([name, list]) => (list || []).filter((a) => a.family === "IPv4").map((a) => ({ name, address: a.cidr || a.address, info: describeInterface(name) })));
  const [listeners, docker, lan] = await Promise.all([readListeners(), readDockerAddresses(), readLanNeighbors()]);
  const data = { interfaces, domains: readTunnelIngress(), listeners, docker, lan };
  addressCache = { at: Date.now(), data };
  return data;
}

function requestHost(req) {
  return String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
}

function isDashboardHost(req) {
  return requestHost(req) === DASHBOARD_HOST;
}

/** Request dari host publik selain subdomain dashboard (server ini hanya listen di loopback, jadi akses lokal = perawatan). */
function isLockedPublicHost(req) {
  return PUBLIC_HOST_LOCKDOWN && !isDashboardHost(req) && !LOCAL_HOSTS.has(requestHost(req));
}

function cookie(req, token, maxAge) {
  const secure = process.env.COOKIE_SECURE === "0" ? "" : "; Secure";
  // Di subdomain, UI ada di "/" sementara API di BASE, jadi cookie harus berlaku untuk seluruh host.
  const path = isDashboardHost(req) ? "/" : BASE;
  return `dg_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAge}${secure}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function resolveUserPath(input) {
  const raw = String(input ?? "").trim() || HOME;
  if (raw.includes("\0")) throw httpError(400, "Path tidak valid");
  const expanded = raw === "~" ? HOME : raw.startsWith("~/") ? join(HOME, raw.slice(2)) : raw;
  const target = resolve(expanded);
  if (!target.startsWith("/")) throw httpError(400, "Path tidak valid");
  return target;
}

function fileType(st) {
  if (st.isSymbolicLink()) return "link";
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  return "other";
}

function imageExt(filePath) {
  return [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extname(filePath).toLowerCase());
}

function imageMime(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function safeDownloadName(filePath) {
  return basename(filePath).replace(/[\r\n"]/g, "_") || "berkas";
}

async function listPath(rawPath) {
  const target = resolveUserPath(rawPath);
  let st;
  try {
    st = await lstat(target);
  } catch (err) {
    throw httpError(err.code === "ENOENT" ? 404 : err.code === "EACCES" ? 403 : 400, err.code === "ENOENT" ? "Tidak ditemukan" : err.code === "EACCES" ? "Tidak ada izin" : err.message);
  }
  if (!st.isDirectory()) throw httpError(400, "Bukan folder");
  let names;
  try {
    names = await readdir(target);
  } catch (err) {
    throw httpError(err.code === "EACCES" ? 403 : 500, err.code === "EACCES" ? "Tidak ada izin" : err.message);
  }
  const truncated = names.length > MAX_LIST;
  const entries = [];
  for (const name of names.slice(0, MAX_LIST)) {
    const full = join(target, name);
    try {
      const row = await lstat(full);
      entries.push({
        name,
        path: full,
        type: fileType(row),
        size: row.isDirectory() ? null : row.size,
        mtime: row.mtime.toISOString(),
        mode: (row.mode & 0o777).toString(8).padStart(3, "0"),
      });
    } catch {
      entries.push({ name, path: full, type: "unknown", size: null, mtime: null, mode: null });
    }
  }
  entries.sort((a, b) => {
    const ad = a.type === "dir" ? 0 : 1;
    const bd = b.type === "dir" ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name, "id", { sensitivity: "base" });
  });
  return {
    path: target,
    parent: target === "/" ? null : dirname(target),
    truncated,
    entries,
  };
}

async function previewPath(rawPath) {
  const target = resolveUserPath(rawPath);
  let st;
  try {
    st = await stat(target);
  } catch (err) {
    throw httpError(err.code === "ENOENT" ? 404 : err.code === "EACCES" ? 403 : 400, err.code === "ENOENT" ? "Tidak ditemukan" : err.code === "EACCES" ? "Tidak ada izin" : err.message);
  }
  if (st.isDirectory()) throw httpError(400, "Ini folder");
  if (!st.isFile()) throw httpError(400, "Bukan berkas biasa");
  if (imageExt(target)) {
    return { path: target, name: basename(target), type: "image", size: st.size, mtime: st.mtime.toISOString() };
  }
  const handle = await open(target, "r");
  try {
    const len = Math.min(st.size, MAX_PREVIEW);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await handle.read(buf, 0, len, 0);
    const slice = buf.subarray(0, bytesRead);
    const binary = slice.includes(0);
    return {
      path: target,
      name: basename(target),
      type: binary ? "binary" : "text",
      size: st.size,
      truncated: st.size > MAX_PREVIEW,
      mtime: st.mtime.toISOString(),
      content: binary ? null : slice.toString("utf8"),
    };
  } finally {
    await handle.close();
  }
}

function fsError(err) {
  if (err.status) return err;
  const known = { ENOENT: [404, "Tidak ditemukan"], EACCES: [403, "Tidak ada izin"], EPERM: [403, "Tidak ada izin"],
    EEXIST: [409, "Nama sudah dipakai"], ENOTEMPTY: [409, "Folder tidak kosong"], EINVAL: [400, "Tidak bisa dipindah ke dalam dirinya sendiri"] };
  const [status, message] = known[err.code] || [500, err.message];
  return httpError(status, message);
}

function cleanName(name) {
  const n = String(name ?? "").trim();
  if (!n || n === "." || n === ".." || n.includes("/") || n.includes("\0")) throw httpError(400, "Nama tidak valid");
  return n;
}

async function exists(p) {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

// "laporan.txt" -> "laporan (salinan).txt", "laporan (salinan 2).txt", ... until the name is free.
async function freeName(dir, name) {
  if (!(await exists(join(dir, name)))) return join(dir, name);
  const ext = name.startsWith(".") ? "" : extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; ; i++) {
    const candidate = join(dir, `${stem} (salinan${i > 1 ? ` ${i}` : ""})${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
}

// Folders that must never be deleted, moved or renamed from the dashboard.
function guardProtected(p) {
  if (p === "/" || p === HOME || dirname(p) === "/") throw httpError(403, `Folder ${p} dilindungi`);
}

// Folder actions from the Folder tab: mkdir, newfile, rename, copy, move, delete.
async function fsOp(body) {
  const op = body.op;
  if (op === "mkdir" || op === "newfile") {
    const target = join(resolveUserPath(body.dir), cleanName(body.name));
    try {
      if (op === "mkdir") await mkdir(target);
      else await writeFile(target, "", { flag: "wx" });
    } catch (err) {
      throw fsError(err);
    }
    return { path: target };
  }
  if (op === "rename") {
    const src = resolveUserPath(body.path);
    guardProtected(src);
    const target = join(dirname(src), cleanName(body.name));
    if (target === src) return { path: src };
    if (await exists(target)) throw httpError(409, "Nama sudah dipakai");
    try {
      await rename(src, target);
    } catch (err) {
      throw fsError(err);
    }
    return { path: target };
  }
  const paths = (Array.isArray(body.paths) ? body.paths : []).map(resolveUserPath);
  if (!paths.length) throw httpError(400, "Tidak ada yang dipilih");
  if (op === "copy" || op === "move") {
    const dest = resolveUserPath(body.dest);
    const done = [];
    for (const src of paths) {
      if (op === "move") guardProtected(src);
      if (dest === src || dest.startsWith(`${src}/`)) throw httpError(400, `Tidak bisa ${op === "copy" ? "menyalin" : "memindah"} folder ke dalam dirinya sendiri: ${basename(src)}`);
      if (op === "move" && dirname(src) === dest) continue;
      const target = await freeName(dest, basename(src));
      try {
        if (op === "copy") {
          await cp(src, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
        } else {
          try {
            await rename(src, target);
          } catch (err) {
            if (err.code !== "EXDEV") throw err;
            // Another disk: copy, then remove the original.
            await cp(src, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
            await rm(src, { recursive: true });
          }
        }
      } catch (err) {
        throw fsError(err);
      }
      done.push(target);
    }
    return { paths: done };
  }
  if (op === "delete") {
    for (const src of paths) guardProtected(src);
    for (const src of paths) {
      try {
        await rm(src, { recursive: true });
      } catch (err) {
        throw fsError(err);
      }
    }
    return { deleted: paths.length };
  }
  throw httpError(400, "Operasi tidak dikenal");
}

// Upload from the Folder tab: the raw request body is streamed to a temp file next to
// the target, then renamed into place so a broken upload never leaves a half-written file.
async function uploadFile(req, rawDir, rawName, overwrite) {
  const dir = resolveUserPath(rawDir);
  const target = join(dir, cleanName(rawName));
  let st;
  try {
    st = await stat(dir);
  } catch (err) {
    throw fsError(err);
  }
  if (!st.isDirectory()) throw httpError(400, "Bukan folder");
  try {
    const cur = await lstat(target);
    if (!overwrite) throw httpError(409, "Nama sudah dipakai");
    if (cur.isDirectory()) throw httpError(409, "Sudah ada folder dengan nama itu");
  } catch (err) {
    if (err.status) throw err;
    if (err.code !== "ENOENT") throw fsError(err);
  }
  const tmp = join(dir, `.${basename(target)}.upload-${randomBytes(4).toString("hex")}`);
  try {
    await pipeline(req, createWriteStream(tmp, { flags: "wx" }));
    if (!overwrite && (await exists(target))) throw httpError(409, "Nama sudah dipakai");
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw fsError(err);
  }
  return { path: target, size: (await stat(target)).size };
}

async function sendFile(req, res, rawPath, download) {
  const target = resolveUserPath(rawPath);
  let st;
  try {
    st = await stat(target);
  } catch (err) {
    throw httpError(err.code === "ENOENT" ? 404 : err.code === "EACCES" ? 403 : 400, err.code === "ENOENT" ? "Tidak ditemukan" : err.code === "EACCES" ? "Tidak ada izin" : err.message);
  }
  if (!st.isFile()) throw httpError(400, "Bukan berkas biasa");
  const name = safeDownloadName(target);
  const type = download ? "application/octet-stream" : imageExt(target) ? imageMime(target) : "text/plain; charset=utf-8";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": st.size,
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(target).pipe(res);
}

function requireAuth(req, res) {
  if (sessionUser(req)) return true;
  sendJson(res, 401, { ok: false, message: "Belum masuk" });
  return false;
}

function pushTermBuffer(session, data) {
  const chunk = Buffer.from(data);
  session.buffer.chunks.push(chunk);
  session.buffer.size += chunk.length;
  while (session.buffer.size > TERM_BUFFER_MAX && session.buffer.chunks.length > 1) {
    const dropped = session.buffer.chunks.shift();
    session.buffer.size -= dropped.length;
  }
}

function dumpTermBuffer(session) {
  if (!session.buffer.chunks.length) return Buffer.alloc(0);
  return Buffer.concat(session.buffer.chunks, session.buffer.size);
}

function sendJsonWs(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

function listTermSessions() {
  return [...termSessions.values()].map((session) => ({ id: session.id, title: session.title }));
}

function spawnPty(cwd = HOME) {
  return spawn(PYTHON, ["-u", PTY_BRIDGE], {
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: process.env.LANG || "C.UTF-8",
      HOME,
      SHELL: process.env.SHELL || "/bin/bash",
      USER: process.env.USER || "gitgitmiko",
      PWD: cwd,
      PTY_CWD: cwd,
      PTY_ROWS: "24",
      PTY_COLS: "80",
    },
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
}

function broadcastTerm(session, data) {
  for (const client of session.clients) {
    if (client.readyState !== client.OPEN) continue;
    try {
      client.send(data);
    } catch {
      /* ignore */
    }
  }
}

function destroyTermSession(id, { alreadyDead } = {}) {
  const session = termSessions.get(id);
  if (!session || session.destroyed) return;
  session.destroyed = true;
  termSessions.delete(id);
  for (const client of session.clients) {
    sendJsonWs(client, { type: "exit", id });
    try {
      client.close();
    } catch {
      /* ignore */
    }
  }
  session.clients.clear();
  if (!alreadyDead) {
    try {
      session.child.kill("SIGHUP");
    } catch {
      /* ignore */
    }
  }
}

// opts: { cwd, title, repo, input } — dipakai tab Remote Claude untuk membuka shell di root project
// dan langsung mengetikkan perintah awal (sama seperti mengetik manual di terminal baru).
function createTermSession(opts = {}) {
  const id = randomBytes(8).toString("hex");
  const child = spawnPty(opts.cwd || HOME);
  const session = {
    id,
    title: opts.title || `Terminal ${++termSeq}`,
    repo: opts.repo || null,
    child,
    buffer: { chunks: [], size: 0 },
    clients: new Set(),
    destroyed: false,
  };
  const onOut = (data) => {
    pushTermBuffer(session, data);
    broadcastTerm(session, data);
  };
  child.stdout.on("data", onOut);
  child.stderr.on("data", onOut);
  child.on("error", (err) => {
    const msg = Buffer.from(`Gagal membuka terminal: ${err.message}\r\n`);
    pushTermBuffer(session, msg);
    broadcastTerm(session, msg);
    destroyTermSession(id, { alreadyDead: true });
  });
  child.on("exit", () => {
    destroyTermSession(id, { alreadyDead: true });
  });
  termSessions.set(id, session);
  if (opts.input && child.stdin.writable) child.stdin.write(opts.input);
  return session;
}

function closeWsSoon(ws, code, reason) {
  setTimeout(() => {
    try {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
    } catch {
      /* ignore */
    }
  }, 50);
}

function attachTerminal(ws, requestedId) {
  const run = () => attachTerminalOpen(ws, requestedId);
  if (ws.readyState === ws.OPEN) run();
  else ws.once("open", run);
}

function attachTerminalOpen(ws, requestedId) {
  if (!existsSync(PTY_BRIDGE) || !existsSync(PYTHON)) {
    sendJsonWs(ws, { type: "error", message: "Terminal tidak siap: python3 atau pty-bridge.py tidak ada." });
    closeWsSoon(ws);
    return;
  }

  let session = requestedId ? termSessions.get(requestedId) : null;
  if (requestedId && !session) {
    sendJsonWs(ws, { type: "gone", id: requestedId });
    closeWsSoon(ws);
    return;
  }
  if (!session) {
    if (termSessions.size >= MAX_TERM) {
      sendJsonWs(ws, { type: "error", message: "Terlalu banyak sesi terminal. Tutup salah satu lalu coba lagi." });
      closeWsSoon(ws, 1013, "too many terminals");
      return;
    }
    session = createTermSession();
  }

  const replay = dumpTermBuffer(session).toString("base64");
  session.clients.add(ws);
  sendJsonWs(ws, { type: "session", id: session.id, title: session.title, replay });

  const ping = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 25000);

  const dropClient = () => {
    clearInterval(ping);
    session.clients.delete(ws);
  };

  ws.on("close", dropClient);
  ws.on("error", dropClient);
  ws.on("message", (raw, isBinary) => {
    if (session.destroyed) return;
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    if (!isBinary && text.startsWith("{")) {
      try {
        const msg = JSON.parse(text);
        if (msg.type === "close") {
          destroyTermSession(session.id);
          return;
        }
        if (msg.type === "resize" && session.child.stdio[3]) {
          session.child.stdio[3].write(`${JSON.stringify({ rows: Number(msg.rows) || 24, cols: Number(msg.cols) || 80 })}\n`);
          return;
        }
      } catch {
        /* treat as input */
      }
    }
    if (session.child.stdin.writable) session.child.stdin.write(isBinary ? raw : text);
  });
}
const CATALOG_LOG = process.env.CATALOG_LOG || join(HOME, "cron", "scraper", "scraper.log");
const LOG_TAIL_BYTES = 512 * 1024;
const WATCH_RE = /^\[watch\] (\S+) (.*)$/;

function summarizeRun(run) {
  const msgs = run.events.map((e) => e.msg);
  const has = (re) => msgs.some((m) => re.test(m));
  if (has(/lewati/)) return "skipped";
  if (has(/gagal|cek gagal/)) return "failed";
  if (has(/^selesai \(fail=0\)/)) return "synced";
  if (has(/^selesai/)) return "partial";
  if (has(/tidak ada konten baru/)) return "nochange";
  return "running";
}

async function readCatalogLog(lines, rawPage, rawPageSize) {
  const want = Math.max(20, Math.min(2000, lines || 300));
  const pageSize = PAGE_SIZES.includes(Number(rawPageSize)) ? Number(rawPageSize) : 10;
  const page = Math.max(1, Math.floor(Number(rawPage)) || 1);
  let handle;
  try {
    handle = await open(CATALOG_LOG, "r");
  } catch {
    const err = new Error(`Log tidak ditemukan: ${CATALOG_LOG}`);
    err.status = 404;
    throw err;
  }
  try {
    const st = await handle.stat();
    const len = Math.min(st.size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, st.size - len);
    let all = buf.toString("utf8").split("\n");
    if (st.size > len) all.shift();
    if (all[all.length - 1] === "") all.pop();
    const runs = [];
    for (const line of all) {
      const m = WATCH_RE.exec(line);
      if (!m) continue;
      const [, ts, msg] = m;
      if (msg === "pull kode" || !runs.length || /lewati/.test(msg)) {
        runs.push({ start: ts, end: ts, events: [] });
      }
      const run = runs[runs.length - 1];
      run.end = ts;
      run.events.push({ ts, msg });
    }
    const allRuns = runs.reverse().map((r) => ({
      start: r.start,
      end: r.end,
      status: summarizeRun(r),
      events: r.events,
    }));
    const total = allRuns.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * pageSize;

    // Ringkasan (kartu atas) selalu dihitung dari jendela run terbaru, terpisah
    // dari halaman yang sedang dilihat, supaya tidak berubah saat pindah halaman.
    const windowRuns = allRuns.slice(0, Math.min(30, total));
    const summary = {
      last: allRuns[0] || null,
      windowSize: windowRuns.length,
      synced: windowRuns.filter((r) => r.status === "synced" || r.status === "partial").length,
      failed: windowRuns.filter((r) => r.status === "failed").length,
    };

    return {
      path: CATALOG_LOG,
      size: st.size,
      mtime: st.mtimeMs,
      truncated: st.size > len,
      runs: allRuns.slice(start, start + pageSize),
      runsTotal: total,
      page: safePage,
      pageSize,
      totalPages,
      summary,
      lines: all.slice(-want),
    };
  } finally {
    await handle.close();
  }
}

const ROUTER_DB = join(osHomedir(), ".9router", "db", "data.sqlite");
const ROUTER_FREE_COMBO = process.env.ROUTER_FREE_COMBO || "gemini-free";

function readFreeUsage() {
  const db = new DatabaseSync(ROUTER_DB, { readOnly: true });
  try {
    const combo = db.prepare("SELECT models FROM combos WHERE name = ?").get(ROUTER_FREE_COMBO);
    if (!combo) throw httpError(404, `Combo "${ROUTER_FREE_COMBO}" tidak ditemukan di 9router`);
    const pool = [...new Set(JSON.parse(combo.models))].filter((m) => m.includes("/") && m !== ROUTER_FREE_COMBO);
    const conns = db.prepare("SELECT provider, isActive, data FROM providerConnections").all();
    const providers = {};
    for (const c of conns) {
      const d = JSON.parse(c.data);
      providers[c.provider] = {
        active: !!c.isActive,
        status: d.testStatus || "unknown",
        rateLimitedUntil: d.rateLimitedUntil || null,
        lastError: d.lastError ? String(d.lastError).replace(/\s+/g, " ").slice(0, 140) : null,
        locks: Object.fromEntries(Object.entries(d).filter(([k, v]) => k.startsWith("modelLock_") && v).map(([k, v]) => [k.slice(10), v])),
      };
    }
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const rows = db.prepare(`SELECT provider, model, COUNT(*) AS total, SUM(promptTokens + completionTokens) AS tokens,
        SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) AS today, MAX(timestamp) AS last
      FROM usageHistory GROUP BY provider, model`).all(dayStart.toISOString());
    const used = new Map(rows.map((r) => [`${r.provider}/${r.model}`, r]));
    const now = Date.now();
    const models = pool.map((full) => {
      const r = used.get(full);
      const provider = full.slice(0, full.indexOf("/"));
      const model = full.slice(provider.length + 1);
      const info = providers[provider];
      const lock = info?.locks[model];
      const limited = (lock && Date.parse(lock) > now) || (info?.rateLimitedUntil && Date.parse(info.rateLimitedUntil) > now);
      return {
        model, provider,
        today: r?.today || 0, total: r?.total || 0, tokens: r?.tokens || 0, last: r?.last || null,
        state: limited || info?.status === "unavailable" ? "limit" : info && info.active === false ? "off" : "ok",
        note: limited ? (lock || info.rateLimitedUntil) : info?.status === "unavailable" ? info.lastError : null,
      };
    }).sort((a, b) => b.today - a.today || b.total - a.total || a.model.localeCompare(b.model));
    const usedToday = models.filter((m) => m.today > 0).length;
    const usedAll = models.filter((m) => m.total > 0).length;
    return {
      combo: ROUTER_FREE_COMBO, totalModels: models.length, usedToday, usedAll,
      percentToday: models.length ? (usedToday / models.length) * 100 : 0,
      percentAll: models.length ? (usedAll / models.length) * 100 : 0,
      requestsToday: models.reduce((n, m) => n + m.today, 0),
      models,
    };
  } finally {
    db.close();
  }
}

async function fetchSocial(endpoint, params) {
  if (!SOCIAL_API_KEY) throw httpError(503, "SOCIAL_API_KEY belum di-set di .env dashboard");
  const qs = new URLSearchParams();
  for (const key of ["account", "platform", "status", "date", "page", "pageSize"]) {
    const v = params.get(key);
    if (v) qs.set(key, v);
  }
  let res;
  try {
    res = await fetch(`${SOCIAL_API_URL}${endpoint}${qs.size ? `?${qs}` : ""}`, {
      headers: { "X-API-Key": SOCIAL_API_KEY },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw httpError(502, "API sosmed tidak bisa dihubungi (service scraper-social-api mati?)");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res.status, data.error || `API sosmed error ${res.status}`);
  return data;
}

async function fetchWhatif(endpoint, params) {
  if (!WHATIF_API_TOKEN) throw httpError(503, "WHATIF_API_TOKEN belum di-set di .env dashboard");
  const qs = new URLSearchParams();
  for (const key of ["status", "date", "page", "pageSize", "lines"]) {
    const v = params.get(key);
    if (v) qs.set(key, v);
  }
  let res;
  try {
    res = await fetch(`${WHATIF_API_URL}/api/monitor/${endpoint}${qs.size ? `?${qs}` : ""}`, {
      headers: { "X-Token": WHATIF_API_TOKEN },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw httpError(502, "API Apa yang terjadi jika tidak bisa dihubungi (service whatif mati?)");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res.status, data.error || `API whatif error ${res.status}`);
  return data;
}

function cctvRecordingFromFile(dateDir, name, st) {
  const m = /^(\d{2})-(\d{2})-(\d{2})\.mp4$/.exec(name);
  return {
    date: dateDir,
    name,
    hour: m ? m[1] : null,
    time: m ? `${m[1]}:${m[2]}` : null,
    // Nama folder/berkas memakai waktu lokal server (WIB), bukan UTC, jadi tidak diberi akhiran "Z".
    started_at: `${dateDir}T${m ? `${m[1]}:${m[2]}:${m[3]}` : "00:00:00"}`,
    size: st.size,
    mtime: st.mtime.toISOString(),
  };
}

async function listCctvDates() {
  let names;
  try {
    names = await readdir(CCTV_DIR);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw httpError(500, err.message);
  }
  const dates = names.filter((n) => CCTV_DATE_RE.test(n));
  dates.sort().reverse();
  return dates;
}

async function listCctvFilesIn(date) {
  const dir = join(CCTV_DIR, date);
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw httpError(err.code === "EACCES" ? 403 : 500, err.message);
  }
  const out = [];
  for (const name of names) {
    if (!CCTV_FILE_RE.test(name)) continue;
    try {
      const st = await stat(join(dir, name));
      out.push(cctvRecordingFromFile(date, name, st));
    } catch {
      /* lewati berkas yang hilang/rusak */
    }
  }
  return out;
}

function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function listCctvRecordings(rawDate, rawPage, rawPageSize) {
  const requested = rawDate ? String(rawDate).trim() : "";
  if (requested && !CCTV_DATE_RE.test(requested)) throw httpError(400, "Format tanggal salah (YYYY-MM-DD)");
  // Tanpa filter: tampilkan rekaman hari ini saja (waktu lokal server). Untuk
  // tanggal lain, pengguna harus memakai filter tanggal secara eksplisit.
  const date = requested || localDateStr();

  const pageSize = PAGE_SIZES.includes(Number(rawPageSize)) ? Number(rawPageSize) : 10;
  const page = Math.max(1, Math.floor(Number(rawPage)) || 1);

  const out = await listCctvFilesIn(date);
  out.sort((a, b) => b.name.localeCompare(a.name));

  const total = out.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  return {
    date,
    recordings: out.slice(start, start + pageSize),
    total,
    page: safePage,
    pageSize,
    totalPages,
  };
}

function resolveCctvFile(rawDate, rawName) {
  const date = String(rawDate ?? "").trim();
  const name = String(rawName ?? "").trim();
  if (!CCTV_DATE_RE.test(date)) throw httpError(400, "Tanggal tidak valid");
  if (!CCTV_FILE_RE.test(name)) throw httpError(400, "Nama berkas tidak valid");
  const target = resolve(join(CCTV_DIR, date, name));
  if (target !== join(CCTV_DIR, date, name)) throw httpError(400, "Path tidak valid");
  return target;
}

async function sendCctvFile(req, res, rawDate, rawName, download) {
  const target = resolveCctvFile(rawDate, rawName);
  let st;
  try {
    st = await stat(target);
  } catch (err) {
    throw httpError(err.code === "ENOENT" ? 404 : err.code === "EACCES" ? 403 : 400, err.code === "ENOENT" ? "Rekaman tidak ditemukan" : "Tidak bisa dibuka");
  }
  if (!st.isFile()) throw httpError(400, "Bukan berkas rekaman");
  // Nama berkas di disk cuma jam (05-00-00.mp4); saat diunduh beri tanggal
  // lengkap supaya tidak bentrok/membingungkan, mis. cctv_2026-10-24_05-00-00.mp4.
  const name = safeDownloadName(`cctv_${basename(dirname(target))}_${basename(target)}`);
  const headers = {
    "Content-Type": "video/mp4",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
  };
  // Range (satu rentang saja) supaya video bisa di-seek saat diputar di browser. Ukuran diambil saat
  // request, jadi berkas jam berjalan yang masih ditulis ffmpeg tetap dilayani sampai byte terakhirnya.
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || "").trim());
  if (range && (range[1] || range[2]) && st.size > 0) {
    const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${st.size}` });
    if (req.method === "HEAD") { res.end(); return; }
    createReadStream(target, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "Content-Length": st.size });
  if (req.method === "HEAD") { res.end(); return; }
  createReadStream(target).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  let pathname = url.pathname;
  // dashboard.<domain>/x → BASE/v2/x (UI baru); BASE/... di host itu tidak diubah.
  if (isDashboardHost(req) && pathname !== BASE && !pathname.startsWith(`${BASE}/`)) pathname = `${BASE}/v2${pathname}`;
  const path = pathname.replace(/\/+$/, "") || "/";
  const base = BASE;

  if (isLockedPublicHost(req) && !path.startsWith(`${base}/preview/whatif/`)) {
    if (req.method === "GET" || req.method === "HEAD") {
      res.writeHead(302, { Location: `https://${DASHBOARD_HOST}/`, "Cache-Control": "no-store" });
      res.end();
    } else {
      sendJson(res, 403, { ok: false, message: `Dashboard dipindah ke https://${DASHBOARD_HOST}/` });
    }
    return;
  }

  // BASE (dan alamat UI lama BASE/legacy) dialihkan ke UI: "/" di subdomain, BASE/v2/ di akses lokal.
  if ((path === base || path === `${base}/legacy`) && req.method === "GET") {
    res.writeHead(302, { Location: isDashboardHost(req) ? "/" : `${base}/v2/`, "Cache-Control": "no-store" });
    res.end();
    return;
  }

  if ((path === `${base}/v2` || path.startsWith(`${base}/v2/`)) && (req.method === "GET" || req.method === "HEAD")) {
    // Aset dirujuk relatif (./assets/...), jadi halaman harus dibuka dengan garis miring di akhir.
    if (pathname === `${base}/v2`) {
      res.writeHead(301, { Location: `${base}/v2/${url.search}` });
      res.end();
      return;
    }
    const rel = path.slice(`${base}/v2`.length + 1);
    let file = resolve(WEB_DIST, rel || "index.html");
    if (!file.startsWith(`${WEB_DIST}/`)) {
      send(res, 400, "Path tidak valid");
      return;
    }
    // Rute yang bukan berkas (mis. /agen/v2/apa-saja) jatuh ke index.html; aset yang hilang tetap 404.
    if (!existsSync(file) || !(await stat(file)).isFile()) {
      if (rel.startsWith("assets/")) {
        send(res, 404, "Tidak ditemukan");
        return;
      }
      file = join(WEB_DIST, "index.html");
    }
    if (!existsSync(file)) {
      send(res, 503, "UI baru belum di-build: jalankan `npm run build` di folder web/");
      return;
    }
    const st = await stat(file);
    res.writeHead(200, {
      "Content-Type": STATIC_TYPES[extname(file)] || "application/octet-stream",
      "Content-Length": st.size,
      // Nama berkas di assets/ mengandung hash isi, jadi aman di-cache lama; index.html selalu segar.
      "Cache-Control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
    return;
  }

  // Link download preview video What If, publik tanpa login: kuncinya ada di URL, dan service whatif
  // berhenti melayaninya begitu video sudah terupload ke YouTube.
  const wiPreview = /^\/preview\/whatif\/([\w-]+)\/(\w+)\.mp4$/.exec(path.slice(base.length));
  if (path.startsWith(base) && wiPreview && (req.method === "GET" || req.method === "HEAD")) {
    let up;
    try {
      up = await fetch(`${WHATIF_API_URL}/api/preview/${wiPreview[1]}/${wiPreview[2]}.mp4`, {
        headers: req.headers.range ? { Range: req.headers.range } : {},
      });
    } catch {
      send(res, 502, "Service whatif tidak bisa dihubungi");
      return;
    }
    if (!up.ok) {
      send(res, 404, "Link preview sudah tidak berlaku (video sudah terupload ke YouTube).");
      return;
    }
    const headers = { "Cache-Control": "no-store" };
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition"]) {
      if (up.headers.get(h)) headers[h] = up.headers.get(h);
    }
    res.writeHead(up.status, headers);
    if (!up.body || req.method === "HEAD") {
      up.body?.cancel();
      res.end();
      return;
    }
    Readable.fromWeb(up.body).on("error", () => res.destroy()).pipe(res);
    return;
  }

  if (path === `${base}/api/session` && req.method === "GET") {
    const ok = Boolean(sessionUser(req));
    sendJson(res, ok ? 200 : 401, { ok, home: HOME });
    return;
  }

  if (path === `${base}/login` && req.method === "POST") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    if (!passwordOk(params.get("password"))) {
      sendJson(res, 401, { ok: false, message: "Kata sandi salah" });
      return;
    }
    const token = randomBytes(24).toString("hex");
    sessions.set(token, { expires: Date.now() + SESSION_MS });
    send(res, 200, JSON.stringify({ ok: true, home: HOME }), {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": cookie(req, token, Math.floor(SESSION_MS / 1000)),
    });
    return;
  }

  if (path === `${base}/logout` && req.method === "POST") {
    const token = readCookie(req, "dg_session");
    if (token) sessions.delete(token);
    send(res, 204, "", { "Set-Cookie": cookie(req, "", 0) });
    return;
  }

  if (path === `${base}/api/terminals` && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    sendJson(res, 200, { ok: true, terminals: listTermSessions() });
    return;
  }

  if (path.startsWith(`${base}/api/terminals/`) && req.method === "DELETE") {
    if (!requireAuth(req, res)) return;
    const id = path.slice(`${base}/api/terminals/`.length);
    if (!/^[a-f0-9]{16}$/.test(id)) {
      sendJson(res, 400, { ok: false, message: "Sesi tidak valid" });
      return;
    }
    if (!termSessions.has(id)) {
      sendJson(res, 404, { ok: false, message: "Sesi tidak ada" });
      return;
    }
    destroyTermSession(id);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === `${base}/api/stats` && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    try {
      sendJson(res, 200, { ok: true, ...(await collectStats()) });
    } catch (err) {
      sendJson(res, 500, { ok: false, message: err.message });
    }
    return;
  }

  if (path === `${base}/api/addresses` && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    try {
      sendJson(res, 200, { ok: true, ...(await collectAddresses()) });
    } catch (err) {
      sendJson(res, 500, { ok: false, message: err.message });
    }
    return;
  }

  if (path === `${base}/api/remote-claude` && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    try {
      sendJson(res, 200, { ok: true, maxTerm: MAX_TERM, terminals: termSessions.size, ...(await remoteStatus({ reposDir: REPOS_DIR, termSessions })) });
    } catch (err) {
      sendJson(res, 500, { ok: false, message: err.message });
    }
    return;
  }

  const remoteAction = /^\/api\/remote-claude\/(start|stop)$/.exec(path.slice(base.length));
  if (path.startsWith(base) && remoteAction && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
      sendJson(res, 415, { ok: false, message: "Harus JSON" });
      return;
    }
    try {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        throw httpError(400, "JSON tidak valid");
      }
      const repoName = String(body.repo || "");
      const result =
        remoteAction[1] === "start"
          ? await startRemote({ reposDir: REPOS_DIR, termSessions, createTermSession, maxTerm: MAX_TERM, repoName })
          : await stopRemote({ reposDir: REPOS_DIR, termSessions, destroyTermSession, repoName });
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJson(res, err.status || 500, { ok: false, message: err.message });
    }
    return;
  }

  if (path === `${base}/api/apps` && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    try {
      sendJson(res, 200, { ok: true, apps: await appsStatus() });
    } catch (err) {
      sendJson(res, 500, { ok: false, message: err.message });
    }
    return;
  }

  const appIconMatch = /^\/api\/apps\/([a-z0-9-]+)\/icon$/.exec(path.slice(base.length));
  if (path.startsWith(base) && appIconMatch && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    try {
      send(res, 200, await appIcon(appIconMatch[1]), { "Content-Type": "image/png" });
    } catch (err) {
      sendJson(res, err.status || 404, { ok: false, message: err.message });
    }
    return;
  }

  // POST /api/apps/:id/draft · POST /api/apps/:id/announcements · POST /api/apps/:id/announcements/delete
  const appAction = /^\/api\/apps\/([a-z0-9-]+)\/(draft|announcements|announcements\/delete)$/.exec(path.slice(base.length));
  if (path.startsWith(base) && appAction && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
      sendJson(res, 415, { ok: false, message: "Harus JSON" });
      return;
    }
    try {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        throw httpError(400, "JSON tidak valid");
      }
      const [, appId, action] = appAction;
      const result =
        action === "draft"
          ? { draft: await draftAnnouncement(appId) }
          : action === "announcements"
            ? { announcement: await postAnnouncement(appId, body) }
            : await deleteAnnouncement(appId, body.id);
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJson(res, err.status || 500, { ok: false, message: err.message });
    }
    return;
  }

  if (path === `${base}/api/cleanup` && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    try {
      sendJson(res, 200, { ok: true, ...(await collectCleanup({ serverPid: process.pid, ptyBridge: PTY_BRIDGE, minAgeSec: CLEANUP_MIN_AGE_SEC })) });
    } catch (err) {
      sendJson(res, 500, { ok: false, message: err.message });
    }
    return;
  }

  if (path === `${base}/api/cleanup/kill` && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
      sendJson(res, 415, { ok: false, message: "Harus JSON" });
      return;
    }
    try {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        throw httpError(400, "JSON tidak valid");
      }
      const targets = Array.isArray(body.targets) ? body.targets.filter((t) => Number.isInteger(t?.pid) && Number.isInteger(t?.start)).slice(0, 50) : [];
      if (!targets.length) throw httpError(400, "Tidak ada proses yang dipilih");
      sendJson(res, 200, { ok: true, ...(await killCleanup({ serverPid: process.pid, ptyBridge: PTY_BRIDGE, targets, minAgeSec: CLEANUP_MIN_AGE_SEC, logFile: join(HOME, "cron", "dashboard-cleanup.log") })) });
    } catch (err) {
      sendJson(res, err.status || 500, { ok: false, message: err.message });
    }
    return;
  }

  if (path === `${base}/api/free-usage` && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    try {
      sendJson(res, 200, { ok: true, ...readFreeUsage() });
    } catch (err) {
      sendJson(res, err.status || 500, { ok: false, message: err.message });
    }
    return;
  }

  if (path === `${base}/api/logs` && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    try {
      sendJson(res, 200, { ok: true, ...(await readCatalogLog(Number(url.searchParams.get("lines")), url.searchParams.get("page"), url.searchParams.get("pageSize"))) });
    } catch (err) {
      sendJson(res, err.status || 500, { ok: false, message: err.message });
    }
    return;
  }

  if ((path === `${base}/api/sosmed/overview` || path === `${base}/api/sosmed/posts`) && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    try {
      sendJson(res, 200, { ok: true, ...(await fetchSocial(path.endsWith("/overview") ? "/overview" : "/posts", url.searchParams)) });
    } catch (err) {
      sendJson(res, err.status || 502, { ok: false, message: err.message });
    }
    return;
  }

  const wiMatch = /^\/api\/whatif\/(overview|history|logs)$/.exec(path.slice(base.length));
  if (path.startsWith(base) && wiMatch && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    try {
      sendJson(res, 200, { ok: true, ...(await fetchWhatif(wiMatch[1], url.searchParams)) });
    } catch (err) {
      sendJson(res, err.status || 502, { ok: false, message: err.message });
    }
    return;
  }

  if (path === `${base}/api/cctv/recordings` && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    try {
      sendJson(res, 200, { ok: true, ...(await listCctvRecordings(url.searchParams.get("date"), url.searchParams.get("page"), url.searchParams.get("pageSize"))) });
    } catch (err) {
      sendJson(res, err.status || 500, { ok: false, message: err.message });
    }
    return;
  }

  if (path === `${base}/api/cctv/dates` && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    try {
      sendJson(res, 200, { ok: true, dates: await listCctvDates() });
    } catch (err) {
      sendJson(res, err.status || 500, { ok: false, message: err.message });
    }
    return;
  }

  if (path === `${base}/api/cctv/file` && (req.method === "GET" || req.method === "HEAD")) {
    if (!requireAuth(req, res)) return;
    try {
      await sendCctvFile(req, res, url.searchParams.get("date"), url.searchParams.get("name"), url.searchParams.get("download") === "1");
    } catch (err) {
      sendJson(res, err.status || 500, { ok: false, message: err.message });
    }
    return;
  }

  if (path === `${base}/api/fs` && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    try {
      sendJson(res, 200, { ok: true, ...(await listPath(url.searchParams.get("path"))) });
    } catch (err) {
      sendJson(res, err.status || 500, { ok: false, message: err.message });
    }
    return;
  }

  if (path === `${base}/api/fs/preview` && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    try {
      sendJson(res, 200, { ok: true, ...(await previewPath(url.searchParams.get("path"))) });
    } catch (err) {
      sendJson(res, err.status || 500, { ok: false, message: err.message });
    }
    return;
  }

  if (path === `${base}/api/fs/op` && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
      sendJson(res, 415, { ok: false, message: "Harus JSON" });
      return;
    }
    try {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        throw httpError(400, "JSON tidak valid");
      }
      sendJson(res, 200, { ok: true, ...(await fsOp(body)) });
    } catch (err) {
      sendJson(res, err.status || 500, { ok: false, message: err.message });
    }
    return;
  }

  if (path === `${base}/api/fs/upload` && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    // Bukan tipe yang bisa dikirim form HTML lintas situs, sama seperti syarat JSON di /api/fs/op.
    if (!String(req.headers["content-type"] || "").startsWith("application/octet-stream")) {
      sendJson(res, 415, { ok: false, message: "Harus application/octet-stream" });
      return;
    }
    try {
      sendJson(res, 200, { ok: true, ...(await uploadFile(req, url.searchParams.get("dir"), url.searchParams.get("name"), url.searchParams.get("overwrite") === "1")) });
    } catch (err) {
      req.resume();
      sendJson(res, err.status || 500, { ok: false, message: err.message });
    }
    return;
  }

  if (path === `${base}/api/fs/file` && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    try {
      await sendFile(req, res, url.searchParams.get("path"), url.searchParams.get("download") === "1");
    } catch (err) {
      sendJson(res, err.status || 500, { ok: false, message: err.message });
    }
    return;
  }

  send(res, 404, "Tidak ditemukan");
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path !== `${BASE}/ws/terminal` || isLockedPublicHost(req)) {
    socket.destroy();
    return;
  }
  if (!sessionUser(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    attachTerminal(ws, url.searchParams.get("id") || "");
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Dashboard listening on http://${HOST}:${PORT}${BASE}/`);
});

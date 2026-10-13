import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { hostname as osHostname, loadavg, uptime } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4180);
const BASE = (process.env.BASE_PATH || "/agen").replace(/\/+$/, "") || "/agen";
const sessions = new Map();
const SESSION_MS = 12 * 60 * 60 * 1000;

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
  return {
    hostname: osHostname(),
    time: new Date().toISOString(),
    uptime_sec: uptime(),
    load: { one, five, fifteen },
    cpu: { percent: cpuPercent() },
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

function cookie(token, maxAge) {
  const secure = process.env.COOKIE_SECURE === "0" ? "" : "; Secure";
  return `dg_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=${BASE}; Max-Age=${maxAge}${secure}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const base = BASE;

  if (path === base && req.method === "GET") {
    const file = join(PUBLIC_DIR, "index.html");
    if (!existsSync(file)) {
      send(res, 500, "Halaman tidak ada");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    createReadStream(file).pipe(res);
    return;
  }

  if (path === `${base}/api/session` && req.method === "GET") {
    sendJson(res, sessionUser(req) ? 200 : 401, { ok: Boolean(sessionUser(req)) });
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
    send(res, 200, JSON.stringify({ ok: true }), {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": cookie(token, Math.floor(SESSION_MS / 1000)),
    });
    return;
  }

  if (path === `${base}/logout` && req.method === "POST") {
    const token = readCookie(req, "dg_session");
    if (token) sessions.delete(token);
    send(res, 204, "", { "Set-Cookie": cookie("", 0) });
    return;
  }

  if (path === `${base}/api/stats` && req.method === "GET") {
    if (!sessionUser(req)) {
      sendJson(res, 401, { ok: false });
      return;
    }
    try {
      sendJson(res, 200, { ok: true, ...(await collectStats()) });
    } catch (err) {
      sendJson(res, 500, { ok: false, message: err.message });
    }
    return;
  }

  if (path.startsWith(`${base}/`)) {
    const rel = path.slice(base.length + 1);
    const file = join(PUBLIC_DIR, rel);
    if (rel && existsSync(file) && file.startsWith(PUBLIC_DIR)) {
      const type = rel.endsWith(".css") ? "text/css" : rel.endsWith(".js") ? "text/javascript" : "application/octet-stream";
      const data = await readFile(file);
      send(res, 200, data, { "Content-Type": `${type}; charset=utf-8` });
      return;
    }
  }

  send(res, 404, "Tidak ditemukan");
});

server.listen(PORT, HOST, () => {
  console.log(`Dashboard listening on http://${HOST}:${PORT}${BASE}/`);
});

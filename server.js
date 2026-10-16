import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { lstat, open, readFile, readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir as osHomedir, hostname as osHostname, loadavg, uptime } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

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
const MAX_TERM = 8;
const sessions = new Map();
const SESSION_MS = 12 * 60 * 60 * 1000;
let termCount = 0;

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
    home: HOME,
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

function attachTerminal(ws) {
  if (termCount >= MAX_TERM) {
    ws.send("Terlalu banyak sesi terminal. Tutup tab lain lalu coba lagi.\r\n");
    ws.close(1013, "too many terminals");
    return;
  }
  if (!existsSync(PTY_BRIDGE) || !existsSync(PYTHON)) {
    ws.send("Terminal tidak siap: python3 atau pty-bridge.py tidak ada.\r\n");
    ws.close();
    return;
  }

  let reuse = false;
  let child = null;
  if (persistentChild) {
    try { persistentChild.kill(0); reuse = true; } catch { reuse = false; }
  }
  if (reuse) {
    child = persistentChild;
    if (persistentKillTimeout) { clearTimeout(persistentKillTimeout); persistentKillTimeout = null; }
  } else {
    termCount += 1;
    child = spawn(PYTHON, ["-u", PTY_BRIDGE], {
      cwd: HOME,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        LANG: process.env.LANG || "C.UTF-8",
        HOME,
        SHELL: process.env.SHELL || "/bin/bash",
        USER: process.env.USER || "gitgitmiko",
        PWD: HOME,
        PTY_ROWS: "24",
        PTY_COLS: "80",
      },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    persistentChild = child;
  }

  let cleaned = false;
  const ping = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 25000);

  const cleanupWsOnly = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(ping);
    if (!reuse) {
      termCount = Math.max(0, termCount - 1);
      try { child.kill("SIGHUP"); } catch { /* ignore */ }
    } else {
      persistentKillTimeout = setTimeout(() => {
        if (persistentChild) {
          try { persistentChild.kill("SIGHUP"); } catch { /* ignore */ }
          persistentChild = null;
        }
        persistentKillTimeout = null;
      }, 60000);
    }
  };

  // Always attach new stdout/stderr handlers for the new ws (old ws won't match .OPEN)
  child.stdout.on("data", (data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  child.stderr.on("data", (data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  child.on("error", (err) => {
    if (ws.readyState === ws.OPEN) ws.send(`Gagal membuka terminal: ${err.message}\r\n`);
    cleanupWsOnly();
    ws.close();
  });
  child.on("exit", () => {
    cleanupWsOnly();
    if (ws.readyState === ws.OPEN) ws.close();
  });
  ws.on("close", () => {
    cleanupWsOnly();
  });
  ws.on("message", (raw, isBinary) => {
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    if (!isBinary && text.startsWith("{")) {
      try {
        const msg = JSON.parse(text);
        if (msg.type === "resize" && child.stdio[3]) {
          child.stdio[3].write(`${JSON.stringify({ rows: Number(msg.rows) || 24, cols: Number(msg.cols) || 80 })}\n`);
          return;
        }
      } catch {
        /* treat as input */
      }
    }
    if (child.stdin.writable) child.stdin.write(isBinary ? raw : text);
  });
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
    if (!requireAuth(req, res)) return;
    try {
      sendJson(res, 200, { ok: true, ...(await collectStats()) });
    } catch (err) {
      sendJson(res, 500, { ok: false, message: err.message });
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

  if (path === `${base}/api/fs/file` && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    try {
      await sendFile(req, res, url.searchParams.get("path"), url.searchParams.get("download") === "1");
    } catch (err) {
      sendJson(res, err.status || 500, { ok: false, message: err.message });
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

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path !== `${BASE}/ws/terminal`) {
    socket.destroy();
    return;
  }
  if (!sessionUser(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    attachTerminal(ws);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Dashboard listening on http://${HOST}:${PORT}${BASE}/`);
});

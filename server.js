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
const CCTV_DIR = resolve(process.env.CCTV_REC_DIR || "/mnt/cctv");
const CCTV_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CCTV_FILE_RE = /^\d{2}-\d{2}-\d{2}\.mp4$/;
const MAX_TERM = 8;
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

function spawnPty() {
  return spawn(PYTHON, ["-u", PTY_BRIDGE], {
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

function createTermSession() {
  const id = randomBytes(8).toString("hex");
  const child = spawnPty();
  const session = {
    id,
    title: `Terminal ${++termSeq}`,
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

async function readCatalogLog(lines) {
  const want = Math.max(20, Math.min(2000, lines || 300));
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
    const recent = runs.slice(-30).reverse().map((r) => ({
      start: r.start,
      end: r.end,
      status: summarizeRun(r),
      events: r.events,
    }));
    return {
      path: CATALOG_LOG,
      size: st.size,
      mtime: st.mtimeMs,
      truncated: st.size > len,
      runs: recent,
      lines: all.slice(-want),
    };
  } finally {
    await handle.close();
  }
}

function cctvRecordingFromFile(dateDir, name, st) {
  const hourMatch = /^(\d{2})-\d{2}-\d{2}\.mp4$/.exec(name);
  return {
    date: dateDir,
    name,
    hour: hourMatch ? hourMatch[1] : null,
    // Nama folder/berkas memakai waktu lokal server (WIB), bukan UTC, jadi tidak diberi akhiran "Z".
    started_at: `${dateDir}T${hourMatch ? hourMatch[1] : "00"}:00:00`,
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

const CCTV_PAGE_SIZES = [10, 25, 50, 100];

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

async function listCctvRecordings(rawDate, rawPage, rawPageSize) {
  const date = rawDate ? String(rawDate).trim() : "";
  if (date && !CCTV_DATE_RE.test(date)) throw httpError(400, "Format tanggal salah (YYYY-MM-DD)");

  const pageSize = CCTV_PAGE_SIZES.includes(Number(rawPageSize)) ? Number(rawPageSize) : 10;
  const page = Math.max(1, Math.floor(Number(rawPage)) || 1);

  let out;
  if (date) {
    out = await listCctvFilesIn(date);
    out.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    const dates = await listCctvDates();
    out = [];
    for (const d of dates) {
      out.push(...(await listCctvFilesIn(d)));
    }
    out.sort((a, b) => b.date.localeCompare(a.date) || b.name.localeCompare(a.name));
  }

  const total = out.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  return {
    date: date || null,
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
  const name = safeDownloadName(target);
  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Content-Length": st.size,
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "none",
  });
  if (req.method === "HEAD") { res.end(); return; }
  createReadStream(target).pipe(res);
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

  if (path === `${base}/api/logs` && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    try {
      sendJson(res, 200, { ok: true, ...(await readCatalogLog(Number(url.searchParams.get("lines")))) });
    } catch (err) {
      sendJson(res, err.status || 500, { ok: false, message: err.message });
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
    attachTerminal(ws, url.searchParams.get("id") || "");
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Dashboard listening on http://${HOST}:${PORT}${BASE}/`);
});

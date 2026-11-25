// Tab "Hermes Chat": the same Hermes agent as on Telegram/WhatsApp (memory, skills, tools, model fallback), used
// per repo from the dashboard. Hermes does the work through its own API server (gateway platform "api_server",
// 127.0.0.1:8642); this module only starts a turn, follows its SSE stream and keeps what the page shows.
//
// A turn keeps going inside Hermes when the browser is closed, and even when this dashboard restarts: on the next
// look the conversation is refreshed from the Hermes session.
//
// Storage: ~/.config/gitgit-studio/hermes-chat/<repo>/<session id>.json
//   {id, repo, title, created, updated, tokens, events: [...what the page shows]}
// The transcript itself lives in Hermes (~/.hermes/state.db), under the same session id.
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const HOME = homedir();
const STORE = join(HOME, ".config", "gitgit-studio", "hermes-chat");
const UPLOADS = join(STORE, "_uploads");
const API_URL = () => (process.env.HERMES_API_URL || "http://127.0.0.1:8642").replace(/\/+$/, "");
const MAX_UPLOAD = 25 * 1024 * 1024;
const IMG_MAX = 4 * 1024 * 1024;  // images up to this size are shown to Hermes itself, not just their path
const SHOW_OUT = 4_000;           // characters of a tool result the page shows
const IMG_MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

const safe = (s) => String(s).replace(/[^\w.-]/g, "_");
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… [${s.length - n} karakter lagi]` : s);
const err = (status, message) => Object.assign(new Error(message), { status });

// ------------------------------------------------------------------ Hermes API
async function hermes(path, { method = "GET", body, signal } = {}) {
  const key = process.env.HERMES_API_KEY;
  if (!key) throw err(500, "HERMES_API_KEY belum di-set di .env dashboard");
  let res;
  try {
    res = await fetch(`${API_URL()}${path}`, {
      method, signal,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw err(502, "Hermes tidak bisa dihubungi (API server Hermes mati? cek service hermes-gateway)");
  }
  return res;
}

async function hermesJson(path, opts) {
  const res = await hermes(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw err(res.status, data?.error?.message || data?.message || `Hermes ${res.status}`);
  return data;
}

// ------------------------------------------------------------------ conversations on disk
const convPath = (repo, id) => join(STORE, safe(repo), `${safe(id)}.json`);

async function load(repo, id) {
  try {
    return JSON.parse(await readFile(convPath(repo, id), "utf8"));
  } catch {
    return null;
  }
}

async function save(conv) {
  const file = convPath(conv.repo, conv.id);
  await mkdir(join(STORE, safe(conv.repo)), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(conv), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

export async function listConversations(repo) {
  const dir = join(STORE, safe(repo));
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of await readdir(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const c = JSON.parse(await readFile(join(dir, f), "utf8"));
      out.push({ id: c.id, title: c.title, updated: c.updated, tokens: c.tokens || 0, running: runs.has(c.id) });
    } catch { /* half-written file */ }
  }
  return out.sort((a, b) => b.updated - a.updated);
}

export async function getConversation(repo, id) {
  const conv = await load(repo, id);
  if (!conv) throw err(404, "Percakapan tidak ada");
  return { ...conv, running: runs.has(id) };
}

export async function deleteConversation(repo, id) {
  if (runs.has(id)) throw err(409, "Percakapan masih berjalan; hentikan dulu");
  const res = await hermes(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
  if (res && !res.ok && res.status !== 404) throw err(res.status, `Hermes menolak menghapus sesi (${res.status})`);
  await rm(convPath(repo, id), { force: true });
}

// ------------------------------------------------------------------ uploads
export async function saveUpload(req, repoName, name) {
  const clean = basename(String(name || "file")).replace(/[^\w.\- ()]/g, "_").slice(-120) || "file";
  const dir = join(UPLOADS, safe(repoName));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${Date.now().toString(36)}-${clean}`);
  let size = 0;
  const limit = new Transform({
    transform(chunk, _e, cb) {
      size += chunk.length;
      cb(size > MAX_UPLOAD ? err(413, "File maksimal 25 MB") : null, chunk);
    },
  });
  try {
    await pipeline(req, limit, createWriteStream(file, { mode: 0o600 }));
  } catch (e) {
    await rm(file, { force: true });
    throw e;
  }
  return { path: file, name: clean, size, image: Boolean(IMG_MIME[extname(clean).toLowerCase()]) };
}

export function uploadedFile(path) {
  const file = resolve(String(path || ""));
  if (!file.startsWith(UPLOADS + "/") || !existsSync(file)) throw err(404, "File tidak ada");
  return { file, mime: IMG_MIME[extname(file).toLowerCase()] || "application/octet-stream" };
}

function attachmentPath(repoName, a) {
  const file = resolve(String(a?.path || ""));
  if (!file.startsWith(join(UPLOADS, safe(repoName)) + "/") || !existsSync(file)) throw err(400, "Lampiran tidak valid");
  return file;
}

// ------------------------------------------------------------------ live runs
// id -> { conv, runId, listeners:Set<res>, toolIdx: number[] }
const runs = new Map();

function emit(run, payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of run.listeners) res.write(line);
}

function push(run, ev) {
  run.conv.events.push(ev);
  emit(run, { type: "event", index: run.conv.events.length - 1, event: ev });
  return run.conv.events.length - 1;
}

function update(run, index, patch) {
  const ev = { ...run.conv.events[index], ...patch };
  run.conv.events[index] = ev;
  emit(run, { type: "event", index, event: ev });
}

/** Instructions sent with every turn (ephemeral, not stored in the transcript). */
function instructions(repo) {
  return [
    `Kamu sedang dipakai dari tab "Hermes Chat" di dashboard GitGit (web), bukan dari Telegram/WhatsApp.`,
    `Repo kerja percakapan ini: ${repo.name}, di ${repo.path} (branch ${repo.branch || "?"}).`,
    `Jalankan semua perintah terminal dan operasi file di folder itu (workdir ${repo.path}) kecuali pengguna meminta folder lain.`,
    `Jawab dalam Bahasa Indonesia. Balasanmu ditampilkan sebagai markdown di halaman web.`,
    `Jangan me-restart service hermes-gateway: itu menghentikan dirimu sendiri di tengah pekerjaan. Kalau perlu, minta pengguna yang menjalankannya.`,
  ].join("\n");
}

function toolLabel(name, args, preview) {
  if (preview) return String(preview).split("\n")[0].slice(0, 200);
  if (!args || typeof args !== "object") return "";
  const v = args.command ?? args.path ?? args.file_path ?? args.query ?? args.pattern ?? args.url ?? args.name ?? Object.values(args)[0];
  return v === undefined ? "" : String(typeof v === "string" ? v : JSON.stringify(v)).split("\n")[0].slice(0, 200);
}

function toolOutput(content) {
  const s = typeof content === "string" ? content : JSON.stringify(content ?? "");
  try {
    const j = JSON.parse(s);
    if (j && typeof j === "object" && ("output" in j || "error" in j)) {
      const parts = [];
      if (j.output) parts.push(String(j.output));
      if (j.error) parts.push(`[error] ${j.error}`);
      if (j.exit_code !== undefined && j.exit_code !== null && j.exit_code !== 0) parts.push(`[exit ${j.exit_code}]`);
      return clip(parts.join("\n") || "(tidak ada output)", SHOW_OUT);
    }
  } catch { /* plain text */ }
  return clip(s, SHOW_OUT);
}

/** After a turn: fill tool outputs from the Hermes transcript and refresh the token count. */
async function refreshFromHermes(conv) {
  try {
    const d = await hermesJson(`/api/sessions/${encodeURIComponent(conv.id)}/messages?include_compacted=true&inline_images=false&limit=1000`);
    const msgs = d.data || [];
    // The k-th user turn in our events matches the k-th user message in Hermes; tool results follow it in order.
    const userIdx = conv.events.reduce((a, e, i) => (e.t === "user" ? [...a, i] : a), []);
    const hUser = msgs.reduce((a, m, i) => (m.role === "user" ? [...a, i] : a), []);
    const offset = hUser.length - userIdx.length;
    userIdx.forEach((evStart, k) => {
      const hStart = hUser[k + offset];
      if (hStart === undefined) return;
      const evEnd = userIdx[k + 1] ?? conv.events.length;
      const hEnd = hUser[k + offset + 1] ?? msgs.length;
      const results = msgs.slice(hStart + 1, hEnd).filter((m) => m.role === "tool");
      const tools = conv.events.slice(evStart + 1, evEnd).filter((e) => e.t === "tool");
      tools.forEach((t, j) => {
        if (results[j] && !t.output) t.output = toolOutput(results[j].content);
      });
    });
  } catch { /* best effort: the page still has the live view */ }
  try {
    const s = (await hermesJson(`/api/sessions/${encodeURIComponent(conv.id)}`)).session || {};
    conv.tokens = (s.input_tokens || 0) + (s.output_tokens || 0);
  } catch { /* ignore */ }
}

/** Read an SSE response body and call onEvent(name, data) per event; ":" keepalive lines are skipped. */
async function readSse(body, onEvent) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let name = "message", data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trimStart();
      }
      if (!data) continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
      onEvent(name, parsed);
    }
  }
}

async function runTurn(run, repo, message) {
  const { conv } = run;
  let textIdx = -1;     // the text event that assistant.delta is currently appending to
  let streamed = "";    // everything streamed as answer text in this turn
  let ended = false;
  try {
    const res = await hermes(`/api/sessions/${encodeURIComponent(conv.id)}/chat/stream`, {
      method: "POST", body: { message, system_message: instructions(repo) },
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw err(res.status, d?.error?.message || d?.message || `Hermes ${res.status}`);
    }
    await readSse(res.body, (name, d) => {
      switch (name) {
        case "run.started":
          run.runId = d.run_id;
          break;
        case "assistant.delta": {
          if (!d.delta) break;
          streamed += d.delta;
          if (textIdx < 0) textIdx = push(run, { t: "text", text: d.delta.replace(/^\n+/, "") });
          else {
            conv.events[textIdx].text += d.delta;
            emit(run, { type: "delta", index: textIdx, text: d.delta });
          }
          break;
        }
        case "assistant.commentary":
          if (d.text && !d.already_streamed) push(run, { t: "text", text: d.text });
          textIdx = -1;
          break;
        case "tool.started":
          textIdx = -1;
          run.toolIdx.push(push(run, { t: "tool", id: `${run.toolIdx.length}`, name: d.tool_name || "tool", label: toolLabel(d.tool_name, d.args, d.preview), status: "run" }));
          break;
        case "tool.completed":
        case "tool.failed": {
          const i = run.toolIdx.find((x) => conv.events[x].status === "run" && conv.events[x].name === d.tool_name)
            ?? run.toolIdx.find((x) => conv.events[x].status === "run");
          if (i !== undefined) update(run, i, { status: name === "tool.failed" ? "err" : "ok" });
          break;
        }
        case "approval.request":
          textIdx = -1;
          push(run, {
            t: "approval", requestId: d.request_id || "", command: d.command || "", text: d.description || d.reason || "",
            choices: Array.isArray(d.choices) ? d.choices : ["once", "deny"], status: "pending",
          });
          break;
        case "approval.responded": {
          const i = conv.events.findLastIndex((e) => e.t === "approval" && e.status === "pending");
          if (i >= 0) update(run, i, { status: d.choice || "answered" });
          break;
        }
        case "assistant.completed":
          // a reply that was not streamed (some providers answer in one piece)
          if (d.content && !streamed.trim()) push(run, { t: "text", text: String(d.content) });
          break;
        case "run.failed":
          ended = true;
          push(run, { t: "error", text: d.error?.message || d.error || d.message || "Hermes gagal menyelesaikan giliran ini." });
          break;
        case "run.cancelled":
          ended = true;
          push(run, { t: "note", text: "Dihentikan." });
          break;
        case "run.completed":
          ended = true;
          if (d.interrupted && !streamed.trim()) push(run, { t: "note", text: "Giliran berhenti sebelum selesai." });
          break;
        default:
          break;
      }
    });
    if (!ended) push(run, { t: "error", text: "Sambungan ke Hermes terputus sebelum giliran selesai." });
  } catch (e) {
    push(run, { t: "error", text: e.message });
  } finally {
    for (const i of run.toolIdx) if (conv.events[i].status === "run") conv.events[i].status = "ok";
    for (const e of conv.events) if (e.t === "approval" && e.status === "pending") e.status = "expired";
    await refreshFromHermes(conv);
    conv.updated = Date.now();
    await save(conv).catch(() => {});
    runs.delete(conv.id);
    emit(run, { type: "done" });
    for (const res of run.listeners) res.end();
  }
}

export async function sendMessage({ repo, id, text, attachments = [] }) {
  const files = (Array.isArray(attachments) ? attachments : []).slice(0, 10).map((a) => attachmentPath(repo.name, a));
  const msg = String(text || "").trim();
  if (!msg && !files.length) throw err(400, "Pesan kosong");
  if (id && runs.has(id)) throw err(409, "Hermes masih mengerjakan pesan sebelumnya");

  let conv = id ? await load(repo.name, id) : null;
  if (id && !conv) throw err(404, "Percakapan tidak ada");
  if (!conv) {
    const title = (msg || "Lampiran").replace(/\s+/g, " ").slice(0, 70);
    const created = await hermesJson("/api/sessions", { method: "POST", body: { title: `${repo.name}: ${title}`.slice(0, 90), source: "dashboard" } })
      .catch(async (e) => {
        // a title Hermes already has: let it pick its own
        if (e.status === 400) return hermesJson("/api/sessions", { method: "POST", body: { source: "dashboard" } });
        throw e;
      });
    conv = { id: created.session.id, repo: repo.name, title, created: Date.now(), updated: Date.now(), tokens: 0, events: [] };
  }

  // What Hermes gets: the text, attached images inline, other files as paths it can open itself.
  const info = await Promise.all(files.map(async (f) => ({ path: f, name: basename(f).replace(/^[a-z0-9]+-/, ""), image: Boolean(IMG_MIME[extname(f).toLowerCase()]),
    size: (await stat(f)).size })));
  const listing = info.length ? `\n\nFile terlampir (ada di server):\n${info.map((f) => `- ${f.path}`).join("\n")}` : "";
  const textPart = (msg || "Lihat file terlampir.") + listing;
  const images = info.filter((f) => f.image && f.size <= IMG_MAX);
  const message = images.length
    ? [{ type: "text", text: textPart }, ...(await Promise.all(images.map(async (f) => ({
        type: "image_url", image_url: { url: `data:${IMG_MIME[extname(f.path).toLowerCase()]};base64,${(await readFile(f.path)).toString("base64")}` },
      }))))]
    : textPart;

  conv.events = conv.events.filter((e) => e.t !== "done");
  conv.events.push({ t: "user", text: msg || "Lihat file terlampir.", files: info.length ? info : undefined });
  conv.updated = Date.now();
  await save(conv);

  const run = { conv, runId: null, listeners: new Set(), toolIdx: [] };
  runs.set(conv.id, run);
  runTurn(run, repo, message);
  return { id: conv.id };
}

export async function stopRun(id) {
  const run = runs.get(id);
  if (!run) return false;
  if (!run.runId) throw err(409, "Giliran belum dimulai di Hermes; coba lagi sebentar");
  await hermesJson(`/v1/runs/${encodeURIComponent(run.runId)}/stop`, { method: "POST", body: {} });
  return true;
}

export async function answerApproval(id, choice, requestId) {
  const run = runs.get(id);
  if (!run?.runId) throw err(409, "Tidak ada giliran yang menunggu persetujuan");
  if (!["once", "session", "always", "deny"].includes(choice)) throw err(400, "Pilihan tidak valid");
  await hermesJson(`/v1/runs/${encodeURIComponent(run.runId)}/approval`, { method: "POST", body: { choice, ...(requestId ? { request_id: requestId } : {}) } });
  const i = run.conv.events.findLastIndex((e) => e.t === "approval" && e.status === "pending");
  if (i >= 0) update(run, i, { status: choice });
  return true;
}

/** SSE for the page: a snapshot first, then live events until the turn ends. */
export async function streamConversation(req, res, repo, id) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  const run = runs.get(id);
  const conv = run ? run.conv : await load(repo, id);
  if (!conv) {
    res.end(`data: ${JSON.stringify({ type: "error", message: "Percakapan tidak ada" })}\n\n`);
    return;
  }
  res.write(`data: ${JSON.stringify({ type: "snapshot", events: conv.events, running: Boolean(run), tokens: conv.tokens || 0 })}\n\n`);
  if (!run) {
    res.end();
    return;
  }
  run.listeners.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(ping);
    run.listeners.delete(res);
  });
}

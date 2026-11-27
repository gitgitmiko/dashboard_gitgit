// Tab "MiMo Chat": a coding agent per repo, powered only by the Xiaomi MiMo Token Plan (OpenAI-compatible chat API
// with tool calls). The loop runs here on the server, so a run keeps going when the browser is closed; the page
// follows it over Server-Sent Events. Full access: the agent reads, writes and runs commands as this user, in the repo.
//
// Storage: ~/.config/gitgit-studio/mimo-chat/<repo>/<conversation>.json
//   {id, repo, title, model, created, updated, messages: [...OpenAI messages], events: [...what the page shows]}
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { recordUsage } from "./mimo-usage.js";
import { callMcpTool, mcpTools, openGroup, USE_TOOLS } from "./mcp.js";

const HOME = homedir();
const STORE = join(HOME, ".config", "gitgit-studio", "mimo-chat");
const SKILLS = join(STORE, "skills");
const BASE_URL = (process.env.MIMO_BASE_URL || "https://token-plan-sgp.xiaomimimo.com/v1").replace(/\/+$/, "");
export const MODELS = { pro: "mimo-v2.6-pro", flash: "mimo-v2.6-flash" };
const MAX_STEPS = 80;           // model calls per message before it must stop and report
const TOOL_OUT = 10_000;        // characters of a tool result the model sees (each char is billed
                                // every call; ask again with offset/limit instead of sending more)
const SHOW_OUT = 4_000;         // characters of a tool result the page shows
const CONTEXT_CHARS = 220_000;  // past this, old tool results are shortened before the next call
export const UPLOADS = join(STORE, "_uploads");  // files attached in the chat, per repo
const MAX_UPLOAD = 25 * 1024 * 1024;
const IMG_MAX = 4 * 1024 * 1024;  // images up to this size are shown to the model itself, not just their path
const IMG_MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

function apiKey() {
  if (process.env.MIMO_API_KEY) return process.env.MIMO_API_KEY;
  throw Object.assign(new Error("MIMO_API_KEY belum di-set di .env dashboard"), { status: 500 });
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n / 2)}\n… [${s.length - n} karakter dipotong] …\n${s.slice(-n / 2)}` : s);

// ------------------------------------------------------------------ tools
const TOOLS = [
  {
    name: "read_file",
    description: "Read a text file. Returns numbered lines. Use offset/limit for big files.",
    parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", description: "first line, 1-based" }, limit: { type: "integer" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the full content (parent folders are created).",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  {
    name: "edit_file",
    description: "Replace an exact piece of text in a file. old_text must match exactly once unless replace_all is true. Read the file first.",
    parameters: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old_text", "new_text"] },
  },
  {
    name: "list_dir",
    description: "List a folder (one level), folders first. Skips .git and node_modules.",
    parameters: { type: "object", properties: { path: { type: "string", description: "default: repo root" } } },
  },
  {
    name: "search",
    description: "Search file contents with a regular expression (ripgrep/grep), optionally limited to a glob like '*.py'. Returns file:line: text.",
    parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" } }, required: ["pattern"] },
  },
  {
    name: "find_files",
    description: "Find files by name glob, e.g. '*.tsx' or 'src/**/test*'.",
    parameters: { type: "object", properties: { glob: { type: "string" }, path: { type: "string" } }, required: ["glob"] },
  },
  {
    name: "view_image",
    description: "Look at an image file (png/jpg/webp/gif) on the server, e.g. a screenshot, a rendered frame or an attached picture.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "bash",
    description: "Run a shell command (bash) in the repo folder: git, tests, builds, package managers, curl... Non-interactive; times out (default 120 s, max 600 s). Do not start servers that never exit.",
    parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "integer", description: "seconds" } }, required: ["command"] },
  },
].map((t) => ({ type: "function", function: t }));

function sh(command, cwd, timeoutMs, signal) {
  return new Promise((done) => {
    const child = exec(command, { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, shell: "/bin/bash", signal,
      env: { ...process.env, MIMO_API_KEY: "", GIT_TERMINAL_PROMPT: "0", CI: "1", PAGER: "cat", GIT_PAGER: "cat" } }, (err, stdout, stderr) => {
      let out = `${stdout}${stderr ? (stdout ? "\n" : "") + stderr : ""}`;
      if (err?.killed) out += `\n[dihentikan: lewat ${timeoutMs / 1000} detik]`;
      else if (err) out += `\n[exit ${err.code ?? "?"}]`;
      done({ ok: !err, out: out.trim() || "(tidak ada output)" });
    });
    child.stdin?.end();
  });
}

async function runTool(name, args, repoPath, signal) {
  const p = (x) => (x ? (isAbsolute(String(x)) ? String(x) : resolve(repoPath, String(x).replace(/^~\//, `${HOME}/`))) : repoPath);
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  switch (name) {
    case "read_file": {
      const file = p(args.path);
      const st = await stat(file);
      if (st.isDirectory()) return { ok: false, out: "Itu folder, pakai list_dir" };
      if (st.size > 5 * 1024 * 1024) return { ok: false, out: `File terlalu besar (${st.size} byte); baca sebagian lewat bash (sed -n)` };
      const lines = (await readFile(file, "utf8")).split("\n");
      const from = Math.max(1, Number(args.offset) || 1), n = Math.min(Number(args.limit) || 2000, 4000);
      const part = lines.slice(from - 1, from - 1 + n).map((l, i) => `${String(from + i).padStart(5)}\t${l}`).join("\n");
      const more = from - 1 + n < lines.length ? `\n[… ${lines.length - (from - 1 + n)} baris lagi; pakai offset]` : "";
      return { ok: true, out: (part || "(file kosong)") + more };
    }
    case "write_file": {
      const file = p(args.path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, String(args.content ?? ""));
      return { ok: true, out: `Tersimpan ${relative(repoPath, file) || file} (${String(args.content ?? "").split("\n").length} baris)` };
    }
    case "edit_file": {
      const file = p(args.path);
      const text = await readFile(file, "utf8");
      const old = String(args.old_text ?? "");
      if (!old) return { ok: false, out: "old_text kosong" };
      const count = text.split(old).length - 1;
      if (count === 0) return { ok: false, out: "old_text tidak ditemukan; baca ulang file dan salin teksnya persis" };
      if (count > 1 && !args.replace_all) return { ok: false, out: `old_text ada ${count} kali; tambah konteks supaya unik, atau replace_all` };
      await writeFile(file, args.replace_all ? text.split(old).join(String(args.new_text ?? "")) : text.replace(old, () => String(args.new_text ?? "")));
      return { ok: true, out: `Diubah ${relative(repoPath, file) || file} (${args.replace_all ? count : 1} tempat)` };
    }
    case "list_dir": {
      const dir = p(args.path);
      const items = (await readdir(dir, { withFileTypes: true })).filter((d) => d.name !== ".git" && d.name !== "node_modules");
      items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      return { ok: true, out: items.slice(0, 500).map((d) => (d.isDirectory() ? `${d.name}/` : d.name)).join("\n") || "(kosong)" };
    }
    case "search": {
      const where = q(p(args.path));
      const rg = `command -v rg >/dev/null && rg -n --no-heading --max-columns 300 ${args.glob ? `-g ${q(args.glob)}` : ""} -e ${q(args.pattern)} ${where} | head -300`;
      const gr = `grep -rnE --exclude-dir=.git --exclude-dir=node_modules ${args.glob ? `--include=${q(args.glob)}` : ""} -e ${q(args.pattern)} ${where} | cut -c1-300 | head -300`;
      const r = await sh(`(${rg}) || (${gr})`, repoPath, 60_000, signal);
      return { ok: true, out: r.out.replace(/\n?\[exit 1\]$/, "") || "(tidak ada hasil)" };
    }
    case "find_files": {
      const g = String(args.glob);
      const cmd = g.includes("/")
        ? `find ${q(p(args.path))} -path '*/node_modules' -prune -o -path '*/.git' -prune -o -path ${q(`*${g.replace(/\*\*\//g, "")}`)} -print | head -300`
        : `find ${q(p(args.path))} -path '*/node_modules' -prune -o -path '*/.git' -prune -o -name ${q(g)} -print | head -300`;
      const r = await sh(cmd, repoPath, 60_000, signal);
      return { ok: true, out: r.out };
    }
    case "view_image": {
      const file = p(args.path);
      const mime = IMG_MIME[extname(file).toLowerCase()];
      if (!mime) return { ok: false, out: "Bukan gambar png/jpg/webp/gif" };
      const st = await stat(file);
      if (st.size > IMG_MAX) return { ok: false, out: `Gambar terlalu besar (${st.size} byte); kecilkan dulu, mis. ffmpeg -i in -vf scale=800:-1 /tmp/kecil.jpg` };
      return { ok: true, out: `Gambar ${file} ditampilkan di pesan berikutnya.`, image: `data:${mime};base64,${(await readFile(file)).toString("base64")}` };
    }
    case "bash": {
      const cmd = String(args.command ?? "");
      // service ini adalah proses agen berjalan: restart/stop di tengah run mematikan diri sendiri,
      // lalu resume-on-restart menyambungnya lagi dan mengulang perintah yang sama — loop.
      if (/\bsystemctl\b[^|;&]*\b(restart|stop|kill)\b[^|;&]*\bdashboard-gitgit\b/.test(cmd) || /\bpkill\b[^|;&]*server\.js/.test(cmd)) {
        return { ok: false, out: "Tidak diizinkan: service dashboard-gitgit adalah proses agen ini sendiri; restart di tengah run memicu loop resume-restart. Minta pengguna menjalankan 'systemctl --user restart dashboard-gitgit' dari terminal setelah percakapan selesai." };
      }
      const secs = Math.min(Math.max(Number(args.timeout) || 120, 1), 600);
      return sh(cmd, repoPath, secs * 1000, signal);
    }
    default:
      if (signal.aborted) return { ok: false, out: "Dihentikan" };
      return callMcpTool(name, args);
  }
}

// ------------------------------------------------------------------ conversations on disk
const safe = (s) => String(s).replace(/[^\w.-]/g, "_");
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
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(conv), { mode: 0o600 });
  await rename(tmp, file);
}

export async function listConversations(repo) {
  const dir = join(STORE, safe(repo));
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of await readdir(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const c = JSON.parse(await readFile(join(dir, f), "utf8"));
      out.push({ id: c.id, title: c.title, model: c.model, updated: c.updated, tokens: c.tokens || 0, running: runs.has(`${repo}/${c.id}`) });
    } catch {
      /* half-written file */
    }
  }
  return out.sort((a, b) => b.updated - a.updated);
}

export async function getConversation(repo, id) {
  const c = await load(repo, id);
  if (!c) throw Object.assign(new Error("Percakapan tidak ada"), { status: 404 });
  return { id: c.id, repo: c.repo, title: c.title, model: c.model, events: c.events, tokens: c.tokens || 0, running: runs.has(`${repo}/${id}`) };
}

export async function deleteConversation(repo, id) {
  stopRun(repo, id);
  await rm(convPath(repo, id), { force: true });
}

// ------------------------------------------------------------------ the agent loop
const runs = new Map();   // "repo/id" -> {abort, bus, conv}

async function systemPrompt(repo) {
  let notes = "";
  for (const f of ["AGENTS.md", "CLAUDE.md", "README.md"]) {
    try {
      const t = await readFile(join(repo.path, f), "utf8");
      notes += `\n\n--- ${f} ---\n${clip(t, f === "README.md" ? 3000 : 8000)}`;
      if (f !== "README.md") break;
    } catch {
      /* not there */
    }
  }
  let ponytail = "";
  try {
    ponytail = await readFile(join(SKILLS, "ponytail", "SKILL.md"), "utf8");
    ponytail = ponytail.replace(/^---[\s\S]*?---\n/, ""); // tanpa front matter
  } catch {
    /* skill belum terpasang */
  }
  const git = await sh("git status --short | head -30; echo; git log --oneline -5", repo.path, 10_000);
  return `Kamu adalah MiMo, agen pemrograman yang bekerja langsung di server milik pengguna (Linux, user ${process.env.USER || "gitgitmiko"}), di repo "${repo.name}" (${repo.path}, branch ${repo.branch || "?"}).
Tanggal: ${new Date().toLocaleDateString("id-ID", { dateStyle: "full", timeZone: "Asia/Jakarta" })}.

Cara kerja:
- Balas dalam Bahasa Indonesia, singkat dan jelas. Pengguna membaca dari dashboard (sering dari HP).
- Kamu punya akses penuh: baca/tulis file dan jalankan perintah lewat tool. Kerjakan tugasnya sampai selesai, jangan hanya memberi saran.
- Sebelum mengubah file, baca dulu bagian yang relevan. Ubah seperlunya, ikuti gaya kode yang sudah ada.
- Setelah mengubah kode, cek hasilnya (jalankan test/build/linter bila ada).
- Commit atau push HANYA kalau pengguna memintanya. Jangan pernah menampilkan isi .env, token, atau kata sandi.
- Hati-hati dengan perintah yang merusak (rm -rf, reset --hard, drop table): tanyakan dulu kecuali pengguna jelas memintanya.
- Jangan menjalankan server yang tidak pernah berhenti di foreground; pakai nohup/systemd bila perlu.
- Jangan restart/stop service dashboard-gitgit atau bunuh server.js saat run berjalan: itu proses agen ini sendiri, restart akan memutus run dan memicu loop. Bila restart diperlukan, minta pengguna melakukannya dari terminal setelah percakapan selesai.
- Di akhir, laporkan apa yang dikerjakan dan hasilnya apa adanya (kalau gagal, katakan gagal).
- Ada tool tambahan yang harus diaktifkan dulu dengan use_tools: grup "web" (browser nyata Playwright: buka halaman, lalu web_browser_snapshot untuk melihat isinya, web_browser_click/type untuk berinteraksi) dan grup "cbm" (graph codebase: cbm_index_repository sekali per repo, lalu cbm_search_graph/cbm_get_code_snippet untuk mencari kode tanpa membaca file besar). Aktifkan hanya kalau tugasnya butuh; tiap grup menambah biaya token di setiap langkah.

--- Gaya kerja (Ponytail, aktif untuk seluruh sesi) ---
${clip(ponytail, 6000) || "(skill ponytail tidak ditemukan)"}

--- Skill Superpowers (baca SKILL.md yang relevan SEBELUM kerja besar; path: ${SKILLS}/superpowers/<nama>/SKILL.md) ---
brainstorming (gali kebutuhan sebelum desain) | writing-plans (rencana kerja) | executing-plans (eksekusi rencana) | test-driven-development (TDD) | systematic-debugging (debug berakar) | verification-before-completion (cek sebelum selesai) | subagent-driven-development (koordinasi subagen) | dispatching-parallel-agents (agen paralel) | requesting-code-review / receiving-code-review (review kode) | finishing-a-development-branch (selesaikan branch) | using-git-worktrees (worktree) | using-superpowers (cara pakai skill ini) | writing-skills (tulis skill baru) | diagnosing-superpowers (perbaiki instalasi skill).

Status git saat percakapan dimulai:
${git.out}${notes}`;
}

const lenOf = (m) => (Array.isArray(m.content) ? m.content.reduce((n, c) => n + (c.text?.length || 0) + (c.image_url ? 4000 : 0), 0) : m.content?.length || 0)
  + JSON.stringify(m.tool_calls || "").length;

/** Pictures are shown to the model once: from an earlier turn they are replaced by their path. */
function dropOldImages(messages) {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    m.content = m.content.map((c) => (c.type === "image_url" ? { type: "text", text: `[gambar sudah dilihat${c.path ? `: ${c.path}` : ""}; pakai view_image untuk melihat lagi]` } : c));
    if (m.content.every((c) => c.type === "text")) m.content = m.content.map((c) => c.text).join("\n");
  }
}

function shrinkContext(messages) {
  let total = messages.reduce((n, m) => n + lenOf(m), 0);
  if (total <= CONTEXT_CHARS) return;
  // each pass rewrites messages, which turns the whole prompt into a cache miss once (every
  // token re-billed at the uncached rate) and the new plan rate-limits ~300K token/min, so
  // oversized prompts earn 429s — pass must stay rare (hysteresis to 60%) but thorough:
  // old tool results AND old long text alike, never the newest 6 messages. The walk runs
  // BACKWARD and skips the head (Hermes-style head/tail protection): prompt caching only
  // pays while the EARLIEST messages stay byte-identical, so the first rewritten message
  // must sit as late as possible — rewriting message #1 first would flush the entire cache.
  const head = Math.min(4, messages.length - 7);
  for (let i = messages.length - 7; i >= head && total > CONTEXT_CHARS * 0.6; i--) {
    const m = messages[i];
    if (m.role === "tool" && m.content.length > 600) {
      total -= m.content.length - 200;
      m.content = `${m.content.slice(0, 200)}\n[output lama dipersingkat]`;
    } else if (typeof m.content === "string" && m.content.length > 800) {
      total -= m.content.length - 300;
      m.content = `${m.content.slice(0, 300)}\n[teks lama dipotong]`;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "text" && part.text.length > 800) {
          total -= part.text.length - 300;
          part.text = `${part.text.slice(0, 300)}\n[teks lama dipotong]`;
        }
      }
    }
    if (JSON.stringify(m.tool_calls || "").length > 2000) {
      total -= JSON.stringify(m.tool_calls).length - 200;
      m.tool_calls = m.tool_calls.map((c) => ({ ...c, function: { ...c.function, arguments: '{"_":"[argumen lama dipotong]"}' } }));
    }
  }
}

/** One model call, streamed. Calls onDelta for text/reasoning; returns the assistant message. */
async function callModel(model, messages, signal, onDelta, tools = TOOLS) {
  const body = JSON.stringify({ model, messages, tools, stream: true, stream_options: { include_usage: true }, temperature: 0.3 });
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
      body,
    });
    if (res.status !== 429 || attempt >= 3) break;
    // plan baru membatasi laju token per menit (429 "quota exhausted"); jendelanya bergulir
    // cepat — tunggu sebentar lalu ulangi, jangan langsung gagalkan run
    await res.text().catch(() => {});
    await new Promise((r) => setTimeout(r, [30_000, 60_000, 60_000][attempt]));
    if (signal.aborted) break;
  }
  if (!res.ok) throw new Error(`MiMo ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const dec = new TextDecoder();
  let buf = "", content = "", reasoning = "", finish = null, usage = null;
  const calls = [];
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.usage) usage = j.usage;
      const ch = j.choices?.[0];
      if (!ch) continue;
      const d = ch.delta || {};
      if (d.reasoning_content) { reasoning += d.reasoning_content; onDelta("thinking", d.reasoning_content); }
      if (d.content) { content += d.content; onDelta("text", d.content); }
      for (const tc of d.tool_calls || []) {
        const k = tc.index ?? calls.length;
        calls[k] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id) calls[k].id = tc.id;
        if (tc.function?.name) calls[k].function.name += tc.function.name;
        if (tc.function?.arguments) calls[k].function.arguments += tc.function.arguments;
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  const msg = { role: "assistant", content: content || null };
  if (reasoning) msg.reasoning_content = reasoning;
  const tc = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}_${Date.now()}` }));
  if (tc.length) msg.tool_calls = tc;
  return { msg, finish, usage };
}

function toolLabel(name, a) {
  switch (name) {
    case "bash": return String(a.command ?? "");
    case "search": return `${a.pattern}${a.path ? `  di ${a.path}` : ""}${a.glob ? `  (${a.glob})` : ""}`;
    case "find_files": return String(a.glob ?? "");
    case "read_file": case "write_file": case "view_image": return String(a.path ?? "");
    case "use_tools": return String(a.group ?? "");
    case "web_browser_navigate": return String(a.url ?? "");
    default: return JSON.stringify(a ?? {}).slice(0, 120); // MCP tools
  }
}

async function agentLoop(conv, repo, signal, emit) {
  const model = MODELS[conv.model] || MODELS.pro;
  for (let step = 0; step < MAX_STEPS; step++) {
    // MCP groups (browser, codebase graph) are only sent once the model opened them with use_tools
    const tools = [...TOOLS, USE_TOOLS, ...(conv.mcpGroups?.length ? await mcpTools(conv.mcpGroups).catch(() => []) : [])];
    shrinkContext(conv.messages);
    // reasoning stays out of what is sent back: only the answer and the tool calls are history
    const history = conv.messages.map(({ reasoning_content, ...m }) =>
      Array.isArray(m.content) ? { ...m, content: m.content.map(({ path, ...c }) => c) } : m);
    let live = null;
    const { msg, usage } = await callModel(model, history, signal, (kind, text) => {
      if (!live || live.t !== kind) {
        live = { t: kind, text: "" };
        conv.events.push(live);
        emit({ type: "event", index: conv.events.length - 1, event: live });
      }
      live.text += text;
      emit({ type: "delta", index: conv.events.length - 1, text });
    }, tools);
    if (usage) {
      conv.tokens = (conv.tokens || 0) + (usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
      emit({ type: "tokens", tokens: conv.tokens });
      recordUsage(`chat:${repo.name}`, model, usage).catch(() => {});
    }
    conv.messages.push(msg);
    if (!msg.tool_calls?.length) return;
    const seen = [];
    for (const call of msg.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = null;
      }
      const ev = { t: "tool", id: call.id, name: call.function.name, label: args ? toolLabel(call.function.name, args) : call.function.arguments.slice(0, 200), status: "run" };
      conv.events.push(ev);
      const at = conv.events.length - 1;
      emit({ type: "event", index: at, event: ev });
      let r;
      try {
        if (!args) r = { ok: false, out: "Argumen tool bukan JSON yang valid" };
        else if (call.function.name === "use_tools") {
          const group = String(args.group || "");
          const names = await openGroup(group);
          conv.mcpGroups = [...new Set([...(conv.mcpGroups || []), group])];
          r = { ok: true, out: `Grup "${group}" aktif mulai langkah berikutnya: ${names.join(", ")}` };
        } else r = await runTool(call.function.name, args, repo.path, signal);
      } catch (err) {
        r = { ok: false, out: `Gagal: ${err.message}` };
      }
      ev.status = r.ok ? "ok" : "err";
      ev.output = clip(r.out, SHOW_OUT);
      if (call.function.name === "edit_file" && args) ev.diff = { old: clip(String(args.old_text ?? ""), 1500), new: clip(String(args.new_text ?? ""), 1500) };
      emit({ type: "event", index: at, event: ev });
      conv.messages.push({ role: "tool", tool_call_id: call.id, content: clip(r.out, TOOL_OUT) });
      if (r.image) seen.push({ type: "image_url", image_url: { url: r.image }, path: args.path });
      if (signal.aborted) return;
    }
    if (seen.length) {
      dropOldImages(conv.messages);
      conv.messages.push({ role: "user", content: [{ type: "text", text: "Gambar yang diminta lewat view_image:" }, ...seen] });
    }
    await save(conv);
  }
  conv.events.push({ t: "text", text: `\n\n_(Berhenti setelah ${MAX_STEPS} langkah. Kirim "lanjut" untuk meneruskan.)_` });
}

/** Save a file attached in the chat; returns what /send takes in attachments. */
export async function saveUpload(req, repoName, name) {
  const clean = basename(String(name || "file")).replace(/[^\w.\- ()]/g, "_").slice(-120) || "file";
  const dir = join(UPLOADS, safe(repoName));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${Date.now().toString(36)}-${clean}`);
  let size = 0;
  const limit = new (await import("node:stream")).Transform({
    transform(chunk, _e, cb) {
      size += chunk.length;
      cb(size > MAX_UPLOAD ? Object.assign(new Error("File maksimal 25 MB"), { status: 413 }) : null, chunk);
    },
  });
  try {
    await pipeline(req, limit, createWriteStream(file, { mode: 0o600 }));
  } catch (err) {
    await rm(file, { force: true });
    throw err;
  }
  return { path: file, name: clean, size, image: Boolean(IMG_MIME[extname(clean).toLowerCase()]) };
}

/** An attachment may only point into the uploads folder of that repo. */
function attachmentPath(repoName, a) {
  const file = resolve(String(a?.path || ""));
  if (!file.startsWith(join(UPLOADS, safe(repoName)) + "/") || !existsSync(file)) throw Object.assign(new Error("Lampiran tidak valid"), { status: 400 });
  return file;
}

export function uploadedFile(path) {
  const file = resolve(String(path || ""));
  if (!file.startsWith(UPLOADS + "/") || !existsSync(file)) throw Object.assign(new Error("File tidak ada"), { status: 404 });
  return { file, mime: IMG_MIME[extname(file).toLowerCase()] || "application/octet-stream" };
}

export async function sendMessage({ repo, id, text, model, attachments = [] }) {
  const files = [];
  for (const a of (Array.isArray(attachments) ? attachments : []).slice(0, 10)) {
    const file = attachmentPath(repo.name, a);
    const st = await stat(file);
    files.push({ path: file, name: basename(file).replace(/^[a-z0-9]+-/, ""), size: st.size, image: Boolean(IMG_MIME[extname(file).toLowerCase()]) });
  }
  if (!String(text || "").trim() && !files.length) throw Object.assign(new Error("Pesan kosong"), { status: 400 });
  text = String(text || "").trim() || "Lihat file terlampir.";
  let conv = id ? await load(repo.name, id) : null;
  if (id && !conv) throw Object.assign(new Error("Percakapan tidak ada"), { status: 404 });
  if (!conv) {
    conv = { id: `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`, repo: repo.name, title: text.trim().slice(0, 60), model: model in MODELS ? model : "pro",
      created: Date.now(), updated: Date.now(), messages: [{ role: "system", content: await systemPrompt(repo) }], events: [] };
  }
  const key = `${repo.name}/${conv.id}`;
  if (runs.has(key)) throw Object.assign(new Error("MiMo masih mengerjakan pesan sebelumnya"), { status: 409 });
  if (model in MODELS) conv.model = model;
  if (files.length) {
    dropOldImages(conv.messages);
    const list = files.map((f) => `- ${f.path} (${f.name}, ${Math.ceil(f.size / 1024)} KB)`).join("\n");
    const parts = [{ type: "text", text: `${text}\n\nFile terlampir (sudah tersimpan di server):\n${list}` }];
    for (const f of files) {
      if (f.image && f.size <= IMG_MAX) parts.push({ type: "image_url", image_url: { url: `data:${IMG_MIME[extname(f.path).toLowerCase()]};base64,${(await readFile(f.path)).toString("base64")}` }, path: f.path });
    }
    conv.messages.push({ role: "user", content: parts });
  } else conv.messages.push({ role: "user", content: text });
  conv.events.push({ t: "user", text, model: conv.model, ...(files.length ? { files } : {}) });
  conv.running = true;
  conv.updated = Date.now();
  await save(conv);
  startRun(conv, repo);
  return { id: conv.id };
}

/** Tool loop secara async; dipakai sendMessage dan resumeInterrupted. */
function startRun(conv, repo) {
  const key = `${repo.name}/${conv.id}`;
  const abort = new AbortController();
  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  runs.set(key, { abort, bus, conv });
  const emit = (e) => bus.emit("e", e);
  (async () => {
    try {
      await agentLoop(conv, repo, abort.signal, emit);
    } catch (err) {
      if (abort.signal.aborted) conv.events.push({ t: "note", text: "Dihentikan." });
      else conv.events.push({ t: "error", text: err.message });
      // a half-finished tool round must not stay in the history: the API rejects calls without results
      const last = conv.messages[conv.messages.length - 1];
      if (last?.role === "assistant" && last.tool_calls) {
        for (const c of last.tool_calls) {
          if (!conv.messages.some((m) => m.role === "tool" && m.tool_call_id === c.id)) conv.messages.push({ role: "tool", tool_call_id: c.id, content: "[dihentikan]" });
        }
      }
    }
    conv.running = false;
    conv.events.push({ t: "done" });
    conv.updated = Date.now();
    await save(conv).catch(() => {});
    runs.delete(key);
    emit({ type: "done", events: conv.events.length });
  })();
}

export function stopRun(repo, id) {
  const r = runs.get(`${repo}/${id}`);
  if (r) r.abort.abort();
  return Boolean(r);
}

/** Sambung lagi run yang terputus oleh restart service (percakapan ber-flag running).
 *  History tersimpan tiap langkah, jadi cukup lanjutkan tool loop dari status terakhir. */
export async function resumeInterrupted(repos) {
  const resumed = [];
  for (const repo of repos) {
    let ids = [];
    try {
      ids = (await readdir(join(STORE, safe(repo.name)))).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    } catch {
      continue;
    }
    for (const id of ids) {
      const conv = await load(repo.name, id);
      if (!conv?.running || runs.has(`${repo.name}/${conv.id}`)) continue;
      // history harus valid sebelum loop lanjut: setiap tool_call wajib punya hasil
      const last = conv.messages[conv.messages.length - 1];
      if (last?.role === "assistant" && last.tool_calls) {
        for (const c of last.tool_calls) {
          if (!conv.messages.some((m) => m.role === "tool" && m.tool_call_id === c.id)) {
            conv.messages.push({ role: "tool", tool_call_id: c.id, content: "[terputus saat restart service]" });
          }
        }
      }
      // anti-loop: run yang di-resume lalu langsung me-restart service-nya sendiri akan
      // resume-restart selamanya. Kalau baru saja di-resume, jangan lanjutkan otomatis.
      if (conv.resumedAt && Date.now() - conv.resumedAt < 120_000) {
        conv.running = false;
        conv.events.push({ t: "note", text: "Tidak dilanjutkan otomatis: baru saja di-resume sebelum restart berikutnya (loop terdeteksi). Kirim pesan baru untuk melanjutkan." });
        await save(conv).catch(() => {});
        continue;
      }
      conv.resumedAt = Date.now();
      startRun(conv, repo);
      resumed.push(`${repo.name}/${conv.id}`);
    }
  }
  return resumed;
}

/** Server-Sent Events: everything from `from` on, then live updates until the run ends. */
export async function streamConversation(req, res, repo, id, from) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const r = runs.get(`${repo}/${id}`);
  const conv = r ? r.conv : await load(repo, id);
  if (!conv) {
    send({ type: "error", message: "Percakapan tidak ada" });
    return res.end();
  }
  send({ type: "snapshot", from, events: conv.events.slice(from), running: Boolean(r), title: conv.title, model: conv.model, tokens: conv.tokens || 0 });
  if (!r) return res.end();
  const on = (e) => {
    send(e);
    if (e.type === "done") res.end();
  };
  r.bus.on("e", on);
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(ping);
    r.bus.off("e", on);
  });
}

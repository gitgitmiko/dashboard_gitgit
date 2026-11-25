// MCP (Model Context Protocol) client for MiMo Chat: Playwright MCP (browser automation) and
// codebase-memory-mcp (code graph), spawned as child processes speaking JSON-RPC over stdio.
// One shared session per server, started lazily and restarted when it dies. Only a curated
// subset of each server's tools is offered, and only after the model asks for that group with
// use_tools: every tool definition is paid on every call (~5k tokens for both groups), so a
// conversation that never opens a browser never pays for one.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const CHROME = join(HOME, ".cache", "ms-playwright", "chromium-1228", "chrome-linux64", "chrome");
// files the browser saves on its own (page snapshots after navigate, screenshots): kept out of $HOME, capped at 50 MB
const OUTPUT = join(HOME, ".config", "gitgit-studio", "mimo-chat", "_browser");

const SERVERS = {
  web: {
    args: [join(HERE, "node_modules", "@playwright", "mcp", "cli.js"),
      "--headless", "--isolated", "--no-sandbox", "--executable-path", CHROME,
      "--image-responses", "omit", "--codegen", "none", "--output-dir", OUTPUT, "--output-max-size", String(50 * 1024 * 1024)],
    note: "browser Playwright",
    about: "browser nyata (Playwright, headless): buka URL, baca isi halaman lewat browser_snapshot, klik, isi form, cek console/network",
    tools: ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_fill_form",
      "browser_press_key", "browser_select_option", "browser_wait_for", "browser_evaluate",
      "browser_console_messages", "browser_network_requests", "browser_tabs", "browser_close"],
  },
  cbm: {
    args: [join(HERE, "node_modules", "codebase-memory-mcp", "bin.js")],
    note: "graph codebase",
    about: "graph kode repo (codebase-memory): index sekali, lalu cari fungsi/kelas, telusuri pemanggil, ambil potongan kode tanpa membaca file besar",
    tools: ["index_repository", "index_status", "list_projects", "search_graph", "get_code_snippet",
      "get_file_outline", "search_code", "trace_path", "get_architecture"],
  },
};
const LONG_CALLS = new Set(["index_repository", "browser_navigate", "browser_wait_for", "browser_evaluate"]);
const registry = new Map(); // "web_browser_click" -> {client, name}

class Client {
  constructor(key) {
    this.key = key;
    this.cfg = SERVERS[key];
    this.buf = "";
    this.pending = new Map();
    this.next = 1;
    this.ready = null;
    this.defs = null;  // tool definitions, listed once per server process
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      // the MiMo API key must never leak into an MCP server process
      this.child = spawn(process.execPath, this.cfg.args, { cwd: HOME, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MIMO_API_KEY: "" } });
      this.child.stdout.setEncoding("utf8");
      this.child.stderr.setEncoding("utf8");
      this.child.stdout.on("data", (d) => this.#data(d));
      this.child.stderr.on("data", () => {});
      this.child.on("exit", () => {
        for (const p of this.pending.values()) p.reject(new Error("MCP server mati"));
        this.pending.clear();
        this.ready = null;
        this.child = null;
        this.defs = null;
      });
      await this.#rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mimo-chat", version: "1.0" } }, 30_000);
      this.#send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return this;
    })().catch((err) => {
      this.ready = null;
      this.child?.kill();
      throw err;
    });
    return this.ready;
  }

  #send(msg) {
    this.child?.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  #data(d) {
    this.buf += d;
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      const p = m.id != null && this.pending.get(m.id);
      if (!p) continue;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message || `MCP error ${m.error.code}`));
      else p.resolve(m.result);
    }
  }

  #rpc(method, params, timeoutMs = 30_000) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timeout ${timeoutMs / 1000}s`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async tools() {
    await this.start();
    if (this.defs) return this.defs;
    const { tools = [] } = await this.#rpc("tools/list", {}, 30_000);
    this.defs = tools.filter((t) => this.cfg.tools.includes(t.name)).map((t) => {
      const name = `${this.key}_${t.name}`;
      registry.set(name, { client: this, name: t.name });
      return {
        type: "function",
        function: {
          name,
          description: `${this.cfg.note}: ${String(t.description || t.name).slice(0, 400)}`,
          parameters: t.inputSchema || { type: "object", properties: {} },
        },
      };
    });
    return this.defs;
  }

  async call(name, args) {
    await this.start();
    const res = await this.#rpc("tools/call", { name, arguments: args || {} }, LONG_CALLS.has(name) ? 300_000 : 120_000);
    const out = (res.content || []).map((c) => (c.type === "text" ? c.text : `[${c.type} tidak ditampilkan]`)).join("\n");
    return { ok: !res.isError, out: out || "(tidak ada output)" };
  }
}

const clients = Object.fromEntries(Object.keys(SERVERS).map((k) => [k, new Client(k)]));

export const MCP_GROUPS = Object.fromEntries(Object.entries(SERVERS).map(([k, v]) => [k, v.about]));

/** The one small tool the model always has: it opens a group of MCP tools for the rest of the conversation. */
export const USE_TOOLS = {
  type: "function",
  function: {
    name: "use_tools",
    description: `Aktifkan grup tool tambahan untuk sisa percakapan ini (baru tersedia di langkah berikutnya). Grup: ${Object.entries(MCP_GROUPS).map(([k, v]) => `"${k}" = ${v}`).join("; ")}. Aktifkan hanya kalau memang perlu.`,
    parameters: { type: "object", properties: { group: { type: "string", enum: Object.keys(SERVERS) } }, required: ["group"] },
  },
};

/** Tool definitions of the given groups (those whose server can be reached). */
export async function mcpTools(groups = Object.keys(SERVERS)) {
  const out = [];
  for (const g of groups) {
    const c = clients[g];
    if (!c) continue;
    try {
      out.push(...(await c.tools()));
    } catch {
      /* server unavailable: the agent works without it */
    }
  }
  return out;
}

/** Start a group's server and return the names of its tools, or throw if it cannot run. */
export async function openGroup(group) {
  const c = clients[group];
  if (!c) throw new Error(`Grup tidak dikenal: ${group}. Pilihan: ${Object.keys(SERVERS).join(", ")}`);
  return (await c.tools()).map((t) => t.function.name);
}

/** Run one MCP tool (name as passed to the model, e.g. "web_browser_click"). */
export async function callMcpTool(name, args) {
  const r = registry.get(name);
  if (!r) return { ok: false, out: `Tool MCP tidak dikenal: ${name}` };
  try {
    return await r.client.call(r.name, args);
  } catch (err) {
    return { ok: false, out: `MCP ${r.name}: ${err.message}` };
  }
}

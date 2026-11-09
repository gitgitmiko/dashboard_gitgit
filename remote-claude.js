// Tab "Remote Claude": satu tombol per repo di ~/github-repos untuk menjalankan `claude remote-control`
// di root project-nya (sama seperti membuka terminal, cd ke folder project, lalu mengetik perintahnya),
// supaya sesinya bisa dipakai dari aplikasi Claude di HP.
import { existsSync } from "node:fs";
import { readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

const MY_UID = process.getuid();
const LINK_RE = /https:\/\/claude\.ai\/code\?environment=[\w-]+/g;
const CAPACITY_RE = /Capacity:\s*(\d+)\s*\/\s*(\d+)/g;
// Perintah yang diketik di terminal; bisa diganti lewat env (dipakai pengujian dengan claude tiruan).
const REMOTE_CMD = process.env.REMOTE_CLAUDE_CMD || "claude remote-control";

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export async function listRepos(reposDir) {
  let names = [];
  try {
    names = await readdir(reposDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const repos = [];
  for (const d of names) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    const path = join(reposDir, d.name);
    if (!existsSync(join(path, ".git"))) continue; // Logs, Temp, dll. bukan project
    let branch = "";
    try {
      const head = (await readFile(join(path, ".git", "HEAD"), "utf8")).trim();
      branch = head.startsWith("ref: refs/heads/") ? head.slice(16) : head.slice(0, 7);
    } catch {
      /* worktree / submodule: .git berupa berkas */
    }
    repos.push({ name: d.name, path, branch });
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name, "id", { sensitivity: "base" }));
}

async function procInfo(pid) {
  try {
    const [stat, status, cmdline] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/status`, "utf8"),
      readFile(`/proc/${pid}/cmdline`),
    ]);
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      pid,
      ppid: Number(f[1]),
      uid: Number((status.match(/^Uid:\s+(\d+)/m) || [])[1]),
      argv: cmdline.toString("utf8").split("\0").filter(Boolean),
    };
  } catch {
    return null;
  }
}

/** Teks layar terminal (tanpa kode warna) untuk membaca link dan kapasitas sesi. */
function terminalText(session, maxBytes = 256 * 1024) {
  const buf = Buffer.concat(session.buffer.chunks);
  return buf
    .subarray(Math.max(0, buf.length - maxBytes))
    .toString("utf8")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "");
}

function lastMatch(re, text) {
  let m = null;
  for (const x of text.matchAll(re)) m = x;
  return m;
}

/** Proses `claude remote-control` milik user ini beserta repo dan terminal web yang menaunginya. */
export async function remoteStatus({ reposDir, termSessions }) {
  const repos = await listRepos(reposDir);
  const pids = (await readdir("/proc")).filter((d) => /^\d+$/.test(d)).map(Number);
  const procs = (await Promise.all(pids.map(procInfo))).filter(Boolean);
  const parent = new Map(procs.map((p) => [p.pid, p.ppid]));
  // pid pty-bridge -> sesi terminal web
  const bridgeToSession = new Map([...termSessions.values()].filter((s) => s.child?.pid).map((s) => [s.child.pid, s]));
  const hostOf = (pid) => {
    for (let p = pid, hop = 0; p > 1 && hop < 64; p = parent.get(p), hop += 1) {
      if (bridgeToSession.has(p)) return bridgeToSession.get(p);
    }
    return null;
  };

  const active = new Map();
  for (const p of procs) {
    if (p.uid !== MY_UID) continue;
    const exe = (p.argv[0] || "").split("/").pop();
    if (exe !== "claude" || !p.argv.includes("remote-control")) continue;
    let cwd = "";
    try {
      cwd = await readlink(`/proc/${p.pid}/cwd`);
    } catch {
      continue;
    }
    const repo = repos.find((r) => cwd === r.path || cwd.startsWith(`${r.path}/`));
    if (!repo) continue;
    const host = hostOf(p.pid);
    let link = null;
    let capacity = null;
    if (host) {
      const text = terminalText(host);
      link = lastMatch(LINK_RE, text)?.[0] || null;
      const c = lastMatch(CAPACITY_RE, text);
      if (c) capacity = { used: Number(c[1]), max: Number(c[2]) };
    }
    if (!active.has(repo.name)) active.set(repo.name, []);
    active.get(repo.name).push({
      pid: p.pid,
      terminalId: host?.id || null,
      terminalTitle: host?.title || null,
      startedHere: Boolean(host?.repo === repo.name),
      link,
      capacity,
    });
  }
  // Terminal yang baru dibuat tab ini dihitung "sedang dimulai" walau proses claude belum terlihat
  // (shell masih memuat), supaya klik ganda tidak membuat dua sesi untuk repo yang sama.
  for (const s of termSessions.values()) {
    if (!s.repo || s.destroyed) continue;
    const list = active.get(s.repo) || [];
    if (list.some((a) => a.terminalId === s.id)) continue;
    list.push({ pid: null, terminalId: s.id, terminalTitle: s.title, startedHere: true, starting: true, link: null, capacity: null });
    active.set(s.repo, list);
  }
  return { repos: repos.map((r) => ({ ...r, active: active.get(r.name) || [] })) };
}

export async function startRemote({ reposDir, termSessions, createTermSession, maxTerm, repoName }) {
  const repo = (await listRepos(reposDir)).find((r) => r.name === repoName);
  if (!repo) throw Object.assign(new Error("Repo tidak ditemukan di github-repos"), { status: 404 });
  const status = await remoteStatus({ reposDir, termSessions });
  if (status.repos.find((r) => r.name === repo.name)?.active.length) {
    throw Object.assign(new Error(`Sesi remote ${repo.name} sudah aktif`), { status: 409 });
  }
  if (termSessions.size >= maxTerm) {
    throw Object.assign(new Error(`Sudah ${maxTerm} terminal terbuka. Tutup salah satu dulu.`), { status: 409 });
  }
  const session = createTermSession({
    cwd: repo.path,
    title: `Remote: ${repo.name}`,
    repo: repo.name,
    input: `${REMOTE_CMD} --name ${shellQuote(repo.name)}\r`,
  });
  return { id: session.id, title: session.title };
}

export async function stopRemote({ reposDir, termSessions, destroyTermSession, repoName }) {
  const status = await remoteStatus({ reposDir, termSessions });
  const entry = status.repos.find((r) => r.name === repoName);
  if (!entry) throw Object.assign(new Error("Repo tidak ditemukan di github-repos"), { status: 404 });
  if (!entry.active.length) throw Object.assign(new Error(`Sesi remote ${repoName} tidak aktif`), { status: 409 });
  let stopped = 0;
  for (const a of entry.active) {
    if (a.pid) {
      try {
        process.kill(a.pid, "SIGTERM");
      } catch {
        /* sudah berhenti */
      }
    }
    stopped += 1;
    // Terminal yang dibuat tab ini sekalian ditutup; terminal biasa dibiarkan (mungkin ada pekerjaan lain).
    if (a.startedHere && a.terminalId) setTimeout(() => destroyTermSession(a.terminalId), a.pid ? 1500 : 0);
  }
  return { stopped };
}

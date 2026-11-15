// Tab "Remote Claude": satu tombol per repo di ~/github-repos untuk menjalankan `claude remote-control`
// di root project-nya (sama seperti membuka terminal, cd ke folder project, lalu mengetik perintahnya),
// supaya sesinya bisa dipakai dari aplikasi Claude di HP.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const MY_UID = process.getuid();
// Sesi baru menampilkan link environment; mode --continue menampilkan link sesi yang disambung.
const LINK_RE = /https:\/\/claude\.ai\/code(?:\?environment=[\w-]+|\/session_\w+)/g;
const CAPACITY_RE = /Capacity:\s*(\d+)\s*\/\s*(\d+)/g;
// Perintah yang diketik di terminal; bisa diganti lewat env (dipakai pengujian dengan claude tiruan).
const REMOTE_CMD = process.env.REMOTE_CLAUDE_CMD || "claude remote-control";
// `claude remote-control` berjalan di server tmux tersendiri (di luar cgroup service dashboard), jadi
// restart API tidak ikut membunuh sesinya. Terminal web hanya menjadi klien `tmux attach`.
const TMUX_SOCKET = process.env.REMOTE_TMUX_SOCKET || "dashboard-rc";
const TMUX_PREFIX = "rc-";

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

function tmux(...args) {
  return run("tmux", ["-L", TMUX_SOCKET, ...args], { timeout: 5000 });
}

/** Nama sesi tmux untuk repo (tmux tidak suka titik/titik dua di nama sesi). */
function tmuxName(repoName) {
  return TMUX_PREFIX + repoName.replace(/[.:]/g, "_");
}

/** Sesi tmux remote yang masih hidup: nama sesi -> { panePid }. Kosong kalau server tmux belum jalan. */
async function tmuxSessions() {
  const out = new Map();
  try {
    const { stdout } = await tmux("list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}");
    for (const line of stdout.split("\n")) {
      const [name, pid] = line.split("\t");
      if (name?.startsWith(TMUX_PREFIX) && !out.has(name)) out.set(name, { panePid: Number(pid) });
    }
  } catch {
    /* server tmux belum ada */
  }
  return out;
}

async function tmuxScreen(name) {
  try {
    const { stdout } = await tmux("capture-pane", "-p", "-J", "-S", "-2000", "-t", `=${name}:`);
    return stdout;
  } catch {
    return "";
  }
}

/** Input yang diketik di terminal web untuk menyambung ke sesi tmux repo. */
function attachInput(name) {
  return `exec tmux -L ${shellQuote(TMUX_SOCKET)} attach -t ${shellQuote(`=${name}`)}\r`;
}

/**
 * Buat sesi tmux yang menjalankan `claude remote-control`. Pertama coba `--continue` (sambung ke sesi
 * yang terakhir tercatat untuk folder ini); kalau tidak ada, baru buat sesi baru.
 */
async function spawnTmuxRemote(repo, name) {
  const cmd = `${REMOTE_CMD} --name ${shellQuote(repo.name)}`;
  const script = [
    `echo '[dashboard] Mencari sesi remote sebelumnya untuk ${repo.name.replace(/'/g, "")}…'`,
    // --continue keluar dengan error kalau tidak ada sesi sebelumnya; kalau ada, sesi itu disambung dalam
    // mode satu sesi yang keluar begitu sesinya selesai. Dua-duanya lanjut ke remote-control biasa,
    // jadi project tetap bisa dipakai dari HP.
    `${cmd} --continue`,
    "echo '[dashboard] Menjalankan sesi remote baru…'",
    cmd,
    "exec bash -l",
  ].join("\n");
  const tmuxArgs = [
    "-L", TMUX_SOCKET, "new-session", "-d", "-s", name, "-c", repo.path, "-x", "120", "-y", "40",
    "bash", "-lc", script,
    ";", "set-option", "-g", "status", "off",
    ";", "set-option", "-g", "history-limit", "5000",
  ];
  const serverUp = await tmux("list-sessions").then(() => true, () => false);
  if (!serverUp) {
    // Server tmux pertama dijalankan di scope systemd sendiri supaya selamat saat service di-restart.
    try {
      await run("systemd-run", ["--user", "--scope", "--quiet", "--collect", "--description=Dashboard Remote Claude (tmux)", "tmux", ...tmuxArgs], { timeout: 10000 });
      return;
    } catch {
      /* systemd-run tidak tersedia: jalankan langsung */
    }
  }
  await run("tmux", tmuxArgs, { timeout: 5000 });
}

/**
 * Dipanggil saat API start: sesi tmux remote yang masih hidup dari proses sebelumnya disambungkan lagi
 * ke terminal web, jadi tidak perlu membuat sesi baru.
 */
export async function restoreRemoteSessions({ reposDir, termSessions, createTermSession, maxTerm }) {
  const sessions = await tmuxSessions();
  if (!sessions.size) return [];
  const repos = await listRepos(reposDir);
  const restored = [];
  for (const name of sessions.keys()) {
    const repo = repos.find((r) => tmuxName(r.name) === name);
    if (!repo || termSessions.size >= maxTerm) continue;
    if ([...termSessions.values()].some((s) => s.tmux === name && !s.destroyed)) continue;
    const session = createTermSession({ cwd: repo.path, title: `Remote: ${repo.name}`, repo: repo.name, input: attachInput(name) });
    session.tmux = name;
    restored.push(repo.name);
  }
  return restored;
}

/** Proses `claude remote-control` milik user ini beserta repo dan terminal web yang menaunginya. */
export async function remoteStatus({ reposDir, termSessions }) {
  const repos = await listRepos(reposDir);
  const pids = (await readdir("/proc")).filter((d) => /^\d+$/.test(d)).map(Number);
  const procs = (await Promise.all(pids.map(procInfo))).filter(Boolean);
  const parent = new Map(procs.map((p) => [p.pid, p.ppid]));
  // pid pty-bridge -> sesi terminal web
  const bridgeToSession = new Map([...termSessions.values()].filter((s) => s.child?.pid).map((s) => [s.child.pid, s]));
  const tmuxList = await tmuxSessions();
  const paneToTmux = new Map([...tmuxList].map(([name, t]) => [t.panePid, name]));
  // Cari terminal web (pty-bridge) atau pane tmux yang menaungi proses.
  const hostOf = (pid) => {
    for (let p = pid, hop = 0; p > 1 && hop < 64; p = parent.get(p), hop += 1) {
      if (bridgeToSession.has(p)) return { session: bridgeToSession.get(p) };
      if (paneToTmux.has(p)) {
        const name = paneToTmux.get(p);
        return { tmux: name, session: [...termSessions.values()].find((s) => s.tmux === name && !s.destroyed) || null };
      }
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
    const found = hostOf(p.pid);
    const host = found?.session || null;
    let link = null;
    let capacity = null;
    if (found?.tmux || host) {
      const text = found?.tmux ? await tmuxScreen(found.tmux) : terminalText(host);
      link = lastMatch(LINK_RE, text)?.[0] || null;
      const c = lastMatch(CAPACITY_RE, text);
      if (c) capacity = { used: Number(c[1]), max: Number(c[2]) };
    }
    if (!active.has(repo.name)) active.set(repo.name, []);
    active.get(repo.name).push({
      pid: p.pid,
      terminalId: host?.id || null,
      terminalTitle: host?.title || null,
      startedHere: Boolean(found?.tmux || host?.repo === repo.name),
      tmux: found?.tmux || null,
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
  const name = tmuxName(repo.name);
  // Sesi tmux masih hidup (mis. claude-nya sudah keluar tapi shell-nya tersisa): pakai ulang saja.
  const reused = (await tmuxSessions()).has(name);
  if (!reused) await spawnTmuxRemote(repo, name);
  const session = createTermSession({ cwd: repo.path, title: `Remote: ${repo.name}`, repo: repo.name, input: attachInput(name) });
  session.tmux = name;
  return { id: session.id, title: session.title, reused };
}

export async function stopRemote({ reposDir, termSessions, destroyTermSession, repoName }) {
  const status = await remoteStatus({ reposDir, termSessions });
  const entry = status.repos.find((r) => r.name === repoName);
  if (!entry) throw Object.assign(new Error("Repo tidak ditemukan di github-repos"), { status: 404 });
  if (!entry.active.length) throw Object.assign(new Error(`Sesi remote ${repoName} tidak aktif`), { status: 409 });
  let stopped = 0;
  const name = tmuxName(repoName);
  if ((await tmuxSessions()).has(name)) {
    try {
      await tmux("kill-session", "-t", `=${name}`);
    } catch {
      /* sudah berhenti */
    }
  }
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

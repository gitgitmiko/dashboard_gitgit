// Pembersihan proses yang sudah tidak diperlukan (tombol "Bersihkan" di tab Ringkasan).
//
// Prinsipnya hati-hati: yang boleh dibersihkan hanya proses *yatim* milik user dashboard
// (lepas dari terminal/skrip yang menjalankannya, kini diasuh systemd --user) di cgroup
// dashboard atau sesi SSH. Semua yang dikelola service/timer/cron/Docker, terminal web beserta
// isinya, dan proses yang masih dipakai atau dirujuk proses lain (mis. Xvfb yang DISPLAY-nya
// tercatat di service whatif) selalu dilindungi. Hanya jenis yang dikenal aman yang dicentang
// otomatis; sisanya ditampilkan untuk diperiksa.
import { execFile } from "node:child_process";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLK_TCK = 100;
const PAGE_SIZE = 4096;
const MIN_AGE_SEC = 30 * 60;
const CPU_SAMPLE_MS = 1500;
const MY_UID = process.getuid();
const CLEANUP_CGROUP = /^(dashboard-gitgit\.service|session-\d+\.scope)$/;

async function readProc(pid) {
  try {
    const [stat, status, cgroup, cmdline, statm] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/status`, "utf8"),
      readFile(`/proc/${pid}/cgroup`, "utf8"),
      readFile(`/proc/${pid}/cmdline`),
      readFile(`/proc/${pid}/statm`, "utf8"),
    ]);
    // comm bisa berisi spasi/kurung, jadi field sesudahnya diambil setelah ')' terakhir.
    const close = stat.lastIndexOf(")");
    const comm = stat.slice(stat.indexOf("(") + 1, close);
    const f = stat.slice(close + 2).split(" ");
    const uid = Number((status.match(/^Uid:\s+(\d+)/m) || [])[1]);
    const cg = cgroup.trim().split("\n").pop().replace(/^0::/, "");
    return {
      pid,
      comm,
      state: f[0],
      ppid: Number(f[1]),
      cpuTicks: Number(f[11]) + Number(f[12]),
      start: Number(f[19]),
      uid,
      unit: cg.split("/").pop() || "",
      cgroup: cg,
      argv: cmdline.toString("utf8").split("\0").filter(Boolean),
      rss: Number(statm.split(" ")[1]) * PAGE_SIZE,
    };
  } catch {
    return null; // proses keburu selesai
  }
}

async function readEnvVar(pid, name) {
  try {
    const env = (await readFile(`/proc/${pid}/environ`)).toString("utf8").split("\0");
    const hit = env.find((e) => e.startsWith(`${name}=`));
    return hit ? hit.slice(name.length + 1) : null;
  } catch {
    return null;
  }
}

/** Samarkan kredensial di baris perintah sebelum ditampilkan (URL user:pass@, token=..., dst.). */
export function maskCmd(argv) {
  return argv
    .join(" ")
    .replace(/(\/\/)[^/@\s]*:[^/@\s]*@/g, "$1***@")
    .replace(/\b(password|passwd|pass|token|secret|api[_-]?key|key)([=:]|\s+)\S+/gi, "$1$2***")
    .slice(0, 300);
}

async function socketsByPid() {
  const established = new Map();
  const listening = new Map();
  const add = (map, out) => {
    for (const line of out.split("\n")) {
      for (const m of line.matchAll(/pid=(\d+)/g)) {
        const pid = Number(m[1]);
        const local = line.trim().split(/\s+/)[3] || "";
        if (!map.has(pid)) map.set(pid, []);
        map.get(pid).push(local);
      }
    }
  };
  try {
    add(established, (await execFileAsync("ss", ["-H", "-tnp", "state", "established"], { timeout: 4000 })).stdout);
    add(listening, (await execFileAsync("ss", ["-H", "-tlnp"], { timeout: 4000 })).stdout);
  } catch {
    /* tanpa info soket: proses dengan koneksi tidak bisa dibedakan, jadi tidak ada yang dicentang otomatis */
  }
  return { established, listening };
}

async function xClients(display) {
  // Jumlah koneksi yang sedang tersambung ke soket X server (/tmp/.X11-unix/X<n>).
  try {
    const { stdout } = await execFileAsync("ss", ["-H", "-xp", "state", "connected"], { timeout: 4000 });
    return stdout.split("\n").filter((l) => l.includes(`/tmp/.X11-unix/X${display}`) && !/Xvfb|Xorg/.test(l)).length;
  } catch {
    return 1; // tidak bisa memastikan: anggap dipakai
  }
}

async function cronCommands() {
  try {
    const { stdout } = await execFileAsync("crontab", ["-l"], { timeout: 3000 });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !/^[A-Z_]+=/.test(l))
      .map((l) => l.split(/\s+/).slice(5).join(" ").split("#")[0].trim().split(/\s+/)[0])
      .filter(Boolean);
  } catch {
    return [];
  }
}

function fmtUnit(unit) {
  if (unit.startsWith("docker-")) return "container Docker";
  if (unit === "cron.service") return "cron";
  return unit.replace(/\.service$/, "");
}

/**
 * Kumpulkan kandidat pembersihan. Mengembalikan kandidat (dikelompokkan per proses yatim beserta
 * turunannya) dan ringkasan proses yang dilindungi beserta alasannya.
 */
export async function collectCleanup({ serverPid, ptyBridge, sample = true, minAgeSec = MIN_AGE_SEC }) {
  const pids = (await readdir("/proc")).filter((d) => /^\d+$/.test(d)).map(Number);
  const procs = new Map();
  for (const p of await Promise.all(pids.map(readProc))) if (p) procs.set(p.pid, p);
  const uptime = Number((await readFile("/proc/uptime", "utf8")).split(" ")[0]);
  const children = new Map();
  for (const p of procs.values()) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  const descendants = (pid) => {
    const out = [];
    const stack = [...(children.get(pid) || [])];
    while (stack.length) {
      const c = stack.pop();
      out.push(c);
      stack.push(...(children.get(c) || []));
    }
    return out;
  };

  // Induk "asuh" proses yatim: PID 1 atau systemd --user milik user ini.
  const reapers = new Set([0, 1]);
  for (const p of procs.values()) if (p.uid === MY_UID && p.comm === "systemd" && p.argv.includes("--user")) reapers.add(p.pid);

  const terminalPids = new Set();
  for (const p of procs.values()) {
    if (p.argv.some((a) => a === ptyBridge)) {
      terminalPids.add(p.pid);
      for (const d of descendants(p.pid)) terminalPids.add(d);
    }
  }
  const serverTree = new Set([serverPid, ...descendants(serverPid)]);

  const [{ established, listening }, crons] = await Promise.all([socketsByPid(), cronCommands()]);

  // Proses yatim milik user ini di cgroup yang boleh dibersihkan. Yang menaungi terminal web
  // (mis. proses dashboard lain) disisihkan sejak awal supaya terminalnya tidak ikut terhitung kandidat.
  const orphans = [...procs.values()].filter(
    (p) => p.uid === MY_UID && reapers.has(p.ppid) && CLEANUP_CGROUP.test(p.unit) && !serverTree.has(p.pid) && !terminalPids.has(p.pid) && p.comm !== "systemd",
  );
  const shelters = orphans.filter((p) => descendants(p.pid).some((d) => terminalPids.has(d)));
  const roots = orphans.filter((p) => !shelters.includes(p));
  const candidateTree = new Set(roots.flatMap((r) => [r.pid, ...descendants(r.pid)]));

  // DISPLAY yang dirujuk proses di luar kandidat (service, terminal, ...): Xvfb-nya harus tetap hidup.
  const displayRefs = new Map();
  await Promise.all(
    [...procs.values()]
      .filter((p) => p.uid === MY_UID && !candidateTree.has(p.pid))
      .map(async (p) => {
        const d = await readEnvVar(p.pid, "DISPLAY");
        if (!d) return;
        const n = (d.match(/:(\d+)/) || [])[1];
        if (n === undefined) return;
        if (!displayRefs.has(n)) displayRefs.set(n, new Set());
        displayRefs.get(n).add(fmtUnit(p.unit) === "dashboard-gitgit" ? "terminal web" : fmtUnit(p.unit));
      }),
  );

  let cpuAfter = null;
  if (sample && candidateTree.size) {
    await new Promise((r) => setTimeout(r, CPU_SAMPLE_MS));
    cpuAfter = new Map();
    for (const pid of candidateTree) {
      const p = await readProc(pid);
      if (p) cpuAfter.set(pid, p.cpuTicks);
    }
  }

  const candidates = [];
  const protectedNotes = shelters.map((p) => ({
    pid: p.pid, start: p.start, name: p.comm, cmd: maskCmd(p.argv), ageSec: Math.round(uptime - p.start / CLK_TCK),
    rssBytes: p.rss, processes: 1, listens: [], idle: false, reason: "Menaungi terminal web (mis. proses dashboard lain), tidak boleh disentuh",
  }));
  const chromeRunning = [...procs.values()].some((p) => p.uid === MY_UID && /^(chrome|chromium|headless_shell)$/.test(p.comm));
  for (const root of roots) {
    const tree = [root.pid, ...descendants(root.pid)].map((pid) => procs.get(pid)).filter(Boolean);
    const cmd = maskCmd(root.argv);
    const age = Math.round(uptime - root.start / CLK_TCK);
    const rss = tree.reduce((n, p) => n + p.rss, 0);
    const conns = tree.flatMap((p) => established.get(p.pid) || []);
    const listens = [...new Set(tree.flatMap((p) => listening.get(p.pid) || []))];
    const busyTicks = cpuAfter ? tree.reduce((n, p) => n + Math.max(0, (cpuAfter.get(p.pid) ?? p.cpuTicks) - p.cpuTicks), 0) : null;
    const idle = busyTicks !== null && busyTicks <= 2; // <= ~1% CPU selama sampel
    const joined = root.argv.join(" ");
    const base = { pid: root.pid, start: root.start, name: root.comm, cmd, ageSec: age, rssBytes: rss, processes: tree.length, listens, idle };

    // --- yang tetap dilindungi meski yatim ---
    const xvfb = /^(Xvfb|Xorg)$/.test(root.comm) ? (joined.match(/\s:(\d+)/) || [])[1] : undefined;
    if (xvfb !== undefined && displayRefs.has(xvfb)) {
      protectedNotes.push({ ...base, reason: `Layar virtual :${xvfb} dipakai ${[...displayRefs.get(xvfb)].join(", ")}` });
      continue;
    }
    const cron = crons.find((c) => joined.includes(c));
    if (cron) {
      protectedNotes.push({ ...base, reason: `Menjalankan tugas cron (${cron.split("/").pop()})` });
      continue;
    }
    if (age < minAgeSec) {
      protectedNotes.push({ ...base, reason: "Baru berjalan kurang dari 30 menit, mungkin sengaja dijalankan" });
      continue;
    }
    if (conns.length) {
      protectedNotes.push({ ...base, reason: `Masih punya ${conns.length} koneksi jaringan aktif` });
      continue;
    }
    if (busyTicks !== null && !idle) {
      protectedNotes.push({ ...base, reason: "Masih memakai CPU (sedang bekerja)" });
      continue;
    }

    // --- kandidat: jenis yang dikenal aman dicentang otomatis ---
    let kind = "unknown";
    let reason = "Proses yatim yang tidak dikenali. Periksa dulu sebelum dihentikan.";
    if (/GradleDaemon|gradle-daemon-main/.test(joined)) {
      kind = "safe";
      reason = "Gradle daemon menganggur (sisa build). Dibuat ulang otomatis saat build berikutnya.";
    } else if (/KotlinCompileDaemon/.test(joined)) {
      kind = "safe";
      reason = "Kotlin compile daemon menganggur (sisa build). Dibuat ulang otomatis saat build berikutnya.";
    } else if (/(chrome|chromium|headless_shell)/i.test(root.comm + " " + (root.argv[0] || "")) && /--headless/.test(joined)) {
      kind = "safe";
      reason = "Browser headless sisa otomasi/pengujian, tidak dipakai proses lain.";
    } else if (xvfb !== undefined) {
      kind = (await xClients(xvfb)) === 0 ? "safe" : "unknown";
      reason = kind === "safe" ? `Layar virtual :${xvfb} tanpa pengguna dan tidak dirujuk service mana pun.` : `Layar virtual :${xvfb} masih punya klien tersambung.`;
    } else if (/chrome_crashpad/.test(root.comm + " " + (root.argv[0] || ""))) {
      kind = chromeRunning ? "unknown" : "safe";
      reason = chromeRunning
        ? "Pencatat crash Chrome; masih ada Chrome yang berjalan, jadi biarkan dulu."
        : "Pencatat crash Chrome sisa browser yang sudah ditutup (otomasi/pengujian).";
    } else if (root.comm === "sleep") {
      kind = "safe";
      reason = "Perintah sleep yang tertinggal.";
    } else if (listens.length) {
      reason = `Proses yatim yang membuka port ${listens.join(", ")}. Bisa jadi server yang sengaja dijalankan manual; periksa dulu.`;
    }
    candidates.push({ ...base, kind, reason });
  }

  // Ringkasan yang dilindungi: proses user ini per kelompok (tanpa baris perintah, supaya rahasia tidak bocor).
  const groups = new Map();
  for (const p of procs.values()) {
    if (p.uid !== MY_UID || candidateTree.has(p.pid) || p.state === "Z") continue;
    let g;
    if (terminalPids.has(p.pid)) g = "Terminal web (pekerjaan interaktif)";
    else if (serverTree.has(p.pid)) g = "Dashboard ini";
    else if (p.unit.startsWith("docker-")) g = "Container Docker";
    else if (p.unit === "cron.service") g = "Tugas cron";
    else if (p.unit.endsWith(".service") && p.unit !== "dashboard-gitgit.service") g = `Service: ${fmtUnit(p.unit)}`;
    else if (reapers.has(p.pid) || p.unit === "init.scope") g = "Sistem (systemd user)";
    else continue;
    groups.set(g, (groups.get(g) || 0) + 1);
  }
  const protectedGroups = [...groups.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => a.label.localeCompare(b.label));
  candidates.sort((a, b) => (a.kind === b.kind ? b.rssBytes - a.rssBytes : a.kind === "safe" ? -1 : 1));
  return { candidates, protected: protectedNotes, protectedGroups, generatedAt: new Date().toISOString() };
}

const alive = async (pid, start) => {
  const p = await readProc(pid);
  return Boolean(p && p.start === start && p.state !== "Z");
};

/**
 * Hentikan kandidat terpilih. Daftar kandidat dihitung ulang dulu: PID yang tidak lagi kandidat
 * (atau sudah dipakai proses lain, dicek lewat waktu mulai) ditolak.
 */
export async function killCleanup({ serverPid, ptyBridge, targets, logFile, minAgeSec = MIN_AGE_SEC }) {
  const fresh = await collectCleanup({ serverPid, ptyBridge, sample: true, minAgeSec });
  const byPid = new Map(fresh.candidates.map((c) => [c.pid, c]));
  const results = [];
  for (const t of targets) {
    const c = byPid.get(Number(t.pid));
    if (!c || c.start !== Number(t.start)) {
      results.push({ pid: t.pid, ok: false, message: "Tidak lagi memenuhi syarat (sudah berhenti, mulai dipakai, atau PID berubah)" });
      continue;
    }
    // Hentikan seluruh pohon proses, anak dulu.
    const tree = [];
    const all = await readdir("/proc");
    const procs = (await Promise.all(all.filter((d) => /^\d+$/.test(d)).map((d) => readProc(Number(d))))).filter(Boolean);
    const stack = [c.pid];
    while (stack.length) {
      const pid = stack.pop();
      const p = procs.find((x) => x.pid === pid);
      if (!p || p.uid !== MY_UID) continue;
      tree.unshift({ pid: p.pid, start: p.start });
      for (const ch of procs.filter((x) => x.ppid === pid)) stack.push(ch.pid);
    }
    for (const p of tree) {
      try {
        process.kill(p.pid, "SIGTERM");
      } catch {
        /* sudah berhenti */
      }
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (await Promise.all(tree.map((p) => alive(p.pid, p.start)))).some(Boolean)) {
      await new Promise((r) => setTimeout(r, 250));
    }
    let forced = 0;
    for (const p of tree) {
      if (await alive(p.pid, p.start)) {
        try {
          process.kill(p.pid, "SIGKILL");
          forced += 1;
        } catch {
          /* abaikan */
        }
      }
    }
    await new Promise((r) => setTimeout(r, 300));
    const left = (await Promise.all(tree.map((p) => alive(p.pid, p.start)))).filter(Boolean).length;
    results.push({ pid: c.pid, name: c.name, ok: left === 0, rssBytes: c.rssBytes, forced, message: left ? `${left} proses tidak bisa dihentikan` : forced ? "Dihentikan paksa (SIGKILL)" : "Dihentikan" });
  }
  if (logFile) {
    const line = JSON.stringify({ at: new Date().toISOString(), results: results.map(({ pid, name, ok, message }) => ({ pid, name, ok, message })) });
    await appendFile(logFile, `${line}\n`).catch(() => {});
  }
  return { results };
}

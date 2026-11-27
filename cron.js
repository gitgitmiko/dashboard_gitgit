// Tab "Otomasi": bagian server untuk linimasa hari ini. Produksi yang dijalankan crontab (jadwal + status per
// jalan dari log-nya), riset harian whatif, dan job berkala (cron yang jalan sering + timer systemd).
// Jadwal upload/posting tiap channel diambil frontend dari endpoint Sosmed yang sudah ada. Semua read-only.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HOME = homedir();
const REPOS = join(HOME, "github-repos");
const WHATIF_IDEAS = process.env.WHATIF_IDEAS_DIR || join(REPOS, "whatif-automation/data/ideas");
const MAX_TIMELINE = 8; // job yang jalan lebih sering dari ini per hari masuk "job berkala", bukan linimasa

// Job crontab yang dikenal: log-nya, channel-nya, dan apakah log-nya berformat produksi ("=== tgl jam" / "... lewati").
const KNOWN = [
  { re: /nostalgia-reels\/daily\.sh/, log: "nostalgia-reels/runs/daily.log", channel: "Kai & Kak Ara", what: "Produksi video", prod: true },
  { re: /gitgit_standup\/daily\.sh/, log: "gitgit_standup/runs/daily.log", channel: "Gitgit Stand-up", what: "Produksi video", prod: true },
  { re: /konten-arsip\.py/, log: () => join(HOME, "cron/konten-arsip.log"), channel: "Arsip", what: "Salin konten ke files.gitgitmiko.my.id" },
  { re: /run_scrape\.sh/, log: () => join(REPOS, `scraper-data-gitgit/data/logs/scrape-${wibDay()}.log`), channel: "Scraper", what: "Scrape data" },
  { re: /run-catalog-watch\.sh/, log: () => join(HOME, "cron/scraper/scraper.log"), channel: "WEBUNIME", what: "Pantau katalog" },
];

/** Tanggal "YYYY-MM-DD" dan menit sejak tengah malam, menurut WIB. */
function wib(d = new Date()) {
  const [day, time] = d.toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }).split(" ");
  const [h, m] = time.split(":").map(Number);
  return { day, minutes: h * 60 + m, dow: new Date(`${day}T12:00:00Z`).getUTCDay() };
}
const wibDay = () => wib().day;
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function parseField(field, min, max) {
  const out = new Set();
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = Number(stepStr || 1);
    const [lo, hi] = range.split("-");
    const a = lo === "*" ? min : Number(lo);
    const b = hi !== undefined ? Number(hi) : lo === "*" || stepStr ? max : a;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** Jam-jam "HH:MM" sebuah ekspresi cron pada hari ini (WIB; server dan crontab berjalan di Asia/Jakarta). */
export function todayTimes(expr, now = wib()) {
  const f = expr.trim().split(/\s+/);
  if (f.length < 5) return [];
  const [, mo, dm] = now.day.split("-").map(Number);
  const dows = new Set([...parseField(f[4], 0, 7)].map((d) => d % 7));
  const dayOk = (f[2] === "*" || parseField(f[2], 1, 31).has(dm)) && parseField(f[3], 1, 12).has(mo) && (f[4] === "*" || dows.has(now.dow));
  if (!dayOk) return [];
  const out = [];
  for (const h of [...parseField(f[1], 0, 23)].sort((a, b) => a - b)) for (const m of [...parseField(f[0], 0, 59)].sort((a, b) => a - b)) out.push(hhmm(h * 60 + m));
  return out;
}

/** Jadwal cron dalam bahasa manusia, untuk pola yang dipakai di server ini; selain itu ekspresinya apa adanya. */
export function humanCron(expr) {
  const [mi, ho, dm, mo, dw] = expr.trim().split(/\s+/);
  const every = /^\*\/(\d+)$/.exec(mi);
  if (every && ho === "*") return `tiap ${every[1]} menit`;
  if (/^\d+$/.test(mi) && ho === "*") return `tiap jam, menit ${mi.padStart(2, "0")}`;
  if (/^\d+$/.test(mi) && /^[\d,]+$/.test(ho) && dm === "*" && mo === "*") {
    const times = ho.split(",").map((h) => hhmm(Number(h) * 60 + Number(mi)));
    const days = { "*": "", 1: "Senin ", 2: "Selasa ", 3: "Rabu ", 4: "Kamis ", 5: "Jumat ", 6: "Sabtu ", 0: "Minggu ", 7: "Minggu " }[dw];
    if (days !== undefined) return `${days}${times.length > 1 ? `${times.length}x: ` : ""}${times.join(", ")}`;
  }
  return expr;
}

function parseCrontab(text) {
  const jobs = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
    if (!m) continue;
    const hash = m[2].indexOf("#");
    const command = (hash >= 0 ? m[2].slice(0, hash) : m[2]).trim();
    const note = hash >= 0 ? m[2].slice(hash + 1).trim() : "";
    const k = KNOWN.find((x) => x.re.test(command));
    const log = k ? (typeof k.log === "function" ? k.log() : join(REPOS, k.log)) : null;
    jobs.push({ schedule: m[1], command, note, log, prod: Boolean(k?.prod), channel: k?.channel || "Cron", what: k?.what || note || basename(command.split(/\s+/)[0]) });
  }
  return jobs;
}

/** Jalan-jalan produksi hari ini dari log berformat "=== YYYY-MM-DD HH:MM:SS" (blok) / "YYYY-MM-DD HH:MM:SS ... lewati". */
export function parseProdLog(text, day) {
  const runs = [];
  let cur = null;
  for (const line of text.split("\n")) {
    const block = /^=== (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/.exec(line);
    const single = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2} (.*)$/.exec(line);
    if (block) {
      cur = block[1] === day ? { at: block[2], status: "running", videos: 0, error: "" } : null;
      if (cur) runs.push(cur);
    } else if (single) {
      cur = null;
      if (single[1] === day) runs.push({ at: single[2], status: /lewati/.test(single[3]) ? "skipped" : "ok", detail: single[3] });
    } else if (cur) {
      if (/\] outbox: /.test(line)) cur.videos += 1;
      if (/^\w*(Error|Exception)\b.*: /.test(line)) cur.error = line.trim();
      if (/^Traceback/.test(line)) cur.status = "failed";
    }
  }
  for (const r of runs) {
    if (r.detail !== undefined) continue;
    if (r.status === "running" && r.videos) r.status = "ok";
    if (r.status === "failed" && r.videos) r.detail = `${r.videos} video ke outbox, lalu gagal: ${r.error}`;
    else r.detail = r.status === "failed" ? r.error || "Gagal (lihat log)" : r.videos ? `${r.videos} video ke outbox` : "Sedang berjalan";
  }
  return runs;
}

async function lastLog(file) {
  try {
    const st = await stat(file);
    const lines = (await readFile(file, "latin1")).split("\n").filter((l) => l.trim());
    return { last: st.mtime.toISOString(), line: (lines[lines.length - 1] || "").trim().slice(0, 240) };
  } catch {
    return { last: null, line: "" };
  }
}

// Produksi yang sudah lewat jam jalannya tapi tidak meninggalkan jejak di log: cron tidak jalan / skrip mati sebelum menulis.
const GRACE_MIN = 5;

async function cronTimeline(jobs, now) {
  const rows = [];
  for (const j of jobs) {
    const times = todayTimes(j.schedule, now);
    if (!times.length || times.length > MAX_TIMELINE) continue;
    const text = j.log ? await readFile(j.log, "latin1").catch(() => "") : "";
    const runs = j.prod ? parseProdLog(text, now.day) : [];
    const { last } = j.log ? await lastLog(j.log) : { last: null };
    for (const at of times) {
      const due = toMin(at);
      const run = runs.find((r) => toMin(r.at) >= due && toMin(r.at) <= due + 3);
      let status = "waiting";
      let detail = humanCron(j.schedule);
      if (run) ({ status, detail } = run);
      else if (now.minutes >= due + GRACE_MIN) {
        // Log tanpa format produksi: cukup lihat apakah log-nya ditulis sesudah jam jalan hari ini.
        const wrote = last && wib(new Date(last)).day === now.day && wib(new Date(last)).minutes >= due;
        status = j.prod || !wrote ? "missed" : "ok";
        detail = status === "missed" ? "Tidak ada jejak di log" : "Log diperbarui";
      }
      rows.push({ at, channel: j.channel, kind: "Produksi", what: j.what, status, detail, source: "cron" });
    }
  }
  return rows;
}

async function periodicJobs(jobs, now) {
  const out = [];
  for (const j of jobs) {
    const n = todayTimes(j.schedule, now).length;
    if (n && n <= MAX_TIMELINE) continue;
    const { last, line } = j.log ? await lastLog(j.log) : { last: null, line: "" };
    const status = !last ? "unknown" : /\b(gagal|error|failed|traceback)\b/i.test(line) ? "failed" : "ok";
    out.push({ name: j.what, channel: j.channel, schedule: humanCron(j.schedule), source: "cron", last, status, detail: line });
  }
  const { stdout } = await execFileAsync("systemctl", ["--user", "list-timers", "--all", "-o", "json"]).catch(() => ({ stdout: "[]" }));
  for (const t of JSON.parse(stdout || "[]")) {
    if (/launchpadlib/.test(t.unit)) continue; // timer bawaan Ubuntu, bukan otomasi kita
    const { stdout: show } = await execFileAsync("systemctl", ["--user", "show", t.activates, "-p", "Result", "-p", "Description"]).catch(() => ({ stdout: "" }));
    const p = Object.fromEntries(show.trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
    const { stdout: when } = await execFileAsync("systemctl", ["--user", "show", t.unit, "-p", "TimersCalendar", "-p", "TimersMonotonic"]).catch(() => ({ stdout: "" }));
    out.push({
      name: p.Description || t.activates,
      channel: "CCTV",
      schedule: humanTimer(when) || t.unit,
      source: "systemd",
      last: t.last ? new Date(t.last / 1000).toISOString() : null,
      next: t.next ? new Date(t.next / 1000).toISOString() : null,
      status: !t.last ? "unknown" : p.Result === "success" ? "ok" : "failed",
      detail: p.Result && p.Result !== "success" ? `Hasil terakhir: ${p.Result}` : "",
    });
  }
  return out;
}

/** Jadwal timer systemd dalam bahasa manusia: "harian 04:00", "tiap 1min"; selain pola itu kosong. */
export function humanTimer(show) {
  const cal = /OnCalendar=\*-\*-\* (\d{2}:\d{2}):00/.exec(show);
  if (cal) return `harian ${cal[1]}`;
  const every = /OnUnitActiveUSec=(\S+)/.exec(show);
  return every ? `tiap ${every[1]}` : "";
}

export async function automationStatus() {
  const now = wib();
  const { stdout } = await execFileAsync("crontab", ["-l"], { maxBuffer: 1 << 20 });
  const jobs = parseCrontab(stdout);
  const timeline = await cronTimeline(jobs, now);
  // Riset ide whatif jalan di scheduler service whatif mulai 00:00 dan menulis data/ideas/<hari>.json.
  const ideas = existsSync(join(WHATIF_IDEAS, `${now.day}.json`));
  timeline.push({ at: "00:00", channel: "Apa yang terjadi jika", kind: "Riset", what: "Riset ide 5 slot", status: ideas ? "ok" : now.minutes >= 60 ? "missed" : "running", detail: ideas ? "Ide hari ini tersimpan" : "Belum ada ide hari ini", source: "whatif" });
  return { day: now.day, minutes: now.minutes, timeline, periodic: await periodicJobs(jobs, now) };
}

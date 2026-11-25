// Monitoring cron + produksi Kai & Kak Ara untuk tab "Cron": daftar job crontab, eksekusi terakhir dari
// log masing-masing, jadwal berikutnya, dan status pipeline nostalgia-reels dari database MySQL nostalgia_reels.
// Semua read-only: crontab hanya dibaca, database hanya di-query.
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import mysql from "mysql2/promise";

const execFileAsync = promisify(execFile);
const HOME = homedir();

// Log yang dilacak tiap job, dicocokkan ke perintah cron-nya (dipakai untuk status "eksekusi terakhir").
const LOG_MATCHERS = [
  [/nostalgia-reels\/daily\.sh/, () => join(HOME, "github-repos/nostalgia-reels/runs/daily.log")],
  [/nostalgia-reels.*audit\.py/, () => join(HOME, "github-repos/nostalgia-reels/runs/audit.log")],
  [/gitgit_standup\/daily\.sh/, () => join(HOME, "github-repos/gitgit_standup/runs/daily.log")],
  [/konten-arsip\.py/, () => join(HOME, "cron/konten-arsip.log")],
  [/run_scrape\.sh/, () => join(HOME, "github-repos/scraper-data-gitgit/data/logs/scrape-" + new Date().toISOString().slice(0, 10) + ".log")],
  [/run-catalog-watch\.sh/, () => join(HOME, "cron/scraper/scraper.log")],
];

// ---------- jadwal cron ----------

function parseField(field, min, max) {
  const out = new Set();
  for (const part of field.split(",")) {
    const [lo, hi] = part.split("-");
    const step = Number((part.match(/\/(\d+)/) || [])[1] || 1);
    const open = lo === "*" || lo.startsWith("*/"); // "*" dan "*/n" mencakup rentang penuh
    const a = open ? min : Number(lo);
    const b = hi ? Number(hi) : (open ? max : a);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

// Jadwal berikutnya dari ekspresi cron 5 kolom (dicari sampai 8 hari ke depan).
function nextRun(expr, from = new Date()) {
  const f = expr.trim().split(/\s+/);
  if (f.length < 5) return null;
  const mi = parseField(f[0], 0, 59);
  const ho = parseField(f[1], 0, 23);
  const dm = parseField(f[2], 1, 31);
  const mo = parseField(f[3], 1, 12);
  const dw = new Set([...parseField(f[4], 0, 7)].map((d) => d % 7)); // 7 = Minggu
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    if (dm.has(d.getDate()) && mo.has(d.getMonth() + 1) && dw.has(d.getDay()) && ho.has(d.getHours()) && mi.has(d.getMinutes()))
      return d.toISOString();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
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
    const [, ...logMatch] = LOG_MATCHERS.find(([re]) => re.test(command)) || [];
    jobs.push({
      name: note || basename(command.split(/\s+/)[0]),
      note,
      schedule: m[1],
      command,
      next: nextRun(m[1]),
    });
    jobs[jobs.length - 1].logFile = logMatch[0] ? logMatch[0]() : null;
  }
  return jobs;
}

async function logStatus(file) {
  if (!file) return { lastRun: null, lastLine: "" };
  try {
    const st = await stat(file);
    const buf = await readFile(file, "latin1");
    const lines = buf.split("\n").filter((l) => l.trim());
    return { lastRun: st.mtime.toISOString(), lastLine: (lines[lines.length - 1] || "").trim().slice(0, 240) };
  } catch {
    return { lastRun: null, lastLine: "" };
  }
}

// ---------- status produksi Kai & Kak Ara (database MySQL nostalgia_reels) ----------

function kaiaraStatus() {
  const def = { episodes: 0, menunggu: 0, diposting: 0, rerataJuri: null, terakhir: [], audit: null };
  const cfg = {
    host: process.env.DB_MON_MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.DB_MON_MYSQL_PORT || 3306),
    user: process.env.DB_MON_MYSQL_USER,
    password: process.env.DB_MON_MYSQL_PASSWORD,
    database: "nostalgia_reels",
  };
  return mysql.createConnection(cfg).then(async (con) => {
    try {
      const one = async (q) => (await con.query(q))[0][0];
      const all = async (q) => (await con.query(q))[0];
      def.episodes = (await one("SELECT COUNT(*) AS n FROM episodes")).n;
      def.menunggu = (await one("SELECT COUNT(*) AS n FROM episodes WHERE status = 'menunggu'")).n;
      def.diposting = (await one("SELECT COUNT(*) AS n FROM episodes WHERE status = 'diposting'")).n;
      def.rerataJuri = (await one("SELECT ROUND(AVG(nilai_juri), 1) AS n FROM episodes WHERE nilai_juri IS NOT NULL")).n;
      def.terakhir = await all("SELECT run, date, judul, jenis, nilai_juri, seconds, status FROM episodes ORDER BY date DESC, run DESC LIMIT 6");
      def.audit = (await one("SELECT tanggal, auditor, naskah, laporan FROM audits ORDER BY tanggal DESC LIMIT 1")) || null;
    } finally {
      await con.end().catch(() => {});
    }
    return def;
  }).catch(() => def);
}

export async function cronStatus() {
  const { stdout } = await execFileAsync("crontab", ["-l"], { maxBuffer: 1 << 20 });
  const jobs = parseCrontab(stdout);
  for (const j of jobs) Object.assign(j, await logStatus(j.logFile));
  return { jobs, kaiara: await kaiaraStatus() };
}

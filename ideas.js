// Kartu "Ide & penjurian" di tab Sosmed: dari mana ide tiap video datang, kandidat yang dipertimbangkan, nilainya,
// dan yang terpilih. Dibaca langsung dari berkas pipeline di server ini (read-only).
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const REPOS = process.env.REPOS_DIR || join(homedir(), "github-repos");
const WHATIF = join(REPOS, "whatif-automation");
const KAIARA_RUNS = join(REPOS, "nostalgia-reels/runs");
const STANDUP_OUTBOX = join(REPOS, "gitgit_standup/data/outbox");
const LATEST = 5; // video terakhir yang ditampilkan untuk Kai & Kak Ara dan Stand-up

const readJson = async (f) => JSON.parse(await readFile(f, "utf8"));

/** Riset whatif terbaru (5 ide + pola yang sedang menang) dan kandidat hook tiap Short yang diproduksi dari ide itu. */
async function whatif() {
  const dir = join(WHATIF, "data/ideas");
  const files = existsSync(dir) ? (await readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : [];
  if (!files.length) return { date: null, insight: "", items: [], drafts: [], juri: null };
  const date = files.at(-1).slice(0, 10);
  const ideas = await readJson(join(dir, files.at(-1)));
  const researched = (await stat(join(dir, files.at(-1)))).mtimeMs;
  const runs = {};
  const db = new DatabaseSync(join(WHATIF, "data/whatif.db"), { readOnly: true });
  try {
    for (const r of db.prepare("SELECT id, slot, title, status, started_at FROM runs WHERE substr(started_at,1,10)=? ORDER BY started_at").all(date)) runs[r.slot] = r;
  } finally {
    db.close();
  }
  const items = [];
  for (const i of ideas.ideas || []) {
    // Produksi yang mulai sebelum riset ditulis tidak memakai ide ini (penulis memilih topik sendiri).
    const r = runs[i.slot];
    const run = r && Date.parse(r.started_at) >= researched ? r : null;
    let hooks = [];
    // Naskah jadi dari riset 19:00 sudah membawa kandidat hook-nya; tanpa itu dibaca dari produksinya.
    if (run || i.script) {
      const s = i.script || (await readJson(join(WHATIF, "runs", run.id, "script.json")).catch(() => null));
      const scores = s?.hook_scores || [];
      const best = scores.length ? scores.indexOf(Math.max(...scores)) : -1;
      hooks = (s?.hook_candidates || []).map((text, k) => ({ text, score: scores[k] ?? null, chosen: k === best }));
    }
    items.push({
      slot: i.slot, mode: i.mode, seri: i.seri, topic: i.topic, angle: i.angle, hook: i.hook, nilai: i.nilai ?? null, alasan: i.alasan || "",
      inspired: (i.inspired_by || []).map((v) => ({ title: v.title, views: v.views, why: v.why })),
      run: run ? { id: run.id, title: run.title, status: run.status } : null,
      unrelated: r && !run ? r.title : null,
      hooks,
    });
  }
  return { date, insight: ideas.insight || "", items, drafts: ideas.drafts || [], juri: ideas.juri || null };
}

/** Naskah Kai & Kak Ara terakhir: calon-calon naskah, nilai juri Opus, dan alasannya (tersimpan sejak 27 Nov 2026). */
async function kaiara() {
  const names = existsSync(KAIARA_RUNS) ? (await readdir(KAIARA_RUNS)).filter((n) => /^\d{8}-/.test(n)).sort().reverse() : [];
  const items = [];
  for (const n of names) {
    const s = await readJson(join(KAIARA_RUNS, n, "script.json")).catch(() => null);
    if (!s?.dialog) continue;
    items.push({ run: n, date: `${n.slice(0, 4)}-${n.slice(4, 6)}-${n.slice(6, 8)}`, judul: s.judul, nilai: s.nilai_juri ?? null, punchline: s.dialog.at(-1)?.t || "", juri: s.juri || null });
    if (items.length >= LATEST) break;
  }
  return { items };
}

/** Video Stand-up terakhir di outbox: kandidat topik yang dipertimbangkan riset, yang dipilih, dan sudutnya. */
async function standup() {
  const files = existsSync(STANDUP_OUTBOX) ? (await readdir(STANDUP_OUTBOX)).filter((f) => f.endsWith(".json")) : [];
  const all = (await Promise.all(files.map((f) => readJson(join(STANDUP_OUTBOX, f)).catch(() => null)))).filter(Boolean);
  const items = all
    .sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")))
    .slice(0, LATEST)
    .map((it) => ({ run: it.run, judul: it.judul, created: it.created, status: it.status || "menunggu", topic: it.topic, tema: it.tema, riset: it.riset || null, juri: it.juri || null }));
  return { items };
}

/** Performa channel whatif 30 hari (YouTube Analytics yang ditarik n8n tiap 05:30 ke data/analytics): per video
 *  views, % ditonton, dan detik penonton mulai pergi (saat yang masih menonton < 60%, rumus yang sama dengan riset). */
export async function whatifPerformance() {
  const dir = join(WHATIF, "data/analytics");
  const data = await readJson(join(dir, "videos.json")).catch(() => null);
  if (!data) return { at: null, videos: [] };
  const videos = await Promise.all(
    (data.videos || []).map(async (v) => {
      const curve = (await readJson(join(dir, "retention", `${v.video}.json`)).catch(() => null))?.curve || [];
      // Panjang video diturunkan dari durasi tonton rata-rata dan persentasenya.
      const length = v.averageViewPercentage ? v.averageViewDuration / (v.averageViewPercentage / 100) : null;
      const drop = curve.find((p) => p.watch != null && p.watch < 0.6);
      return {
        id: v.video, title: v.title, uploaded: v.uploaded, slot: v.slot, mode: v.mode, seri: v.seri,
        views: v.views ?? 0, pct: v.averageViewPercentage ?? null, avg: v.averageViewDuration ?? null,
        length: length ? Math.round(length) : null, drop: drop && length ? Math.round(drop.t * length) : null,
        likes: v.likes ?? 0, shares: v.shares ?? 0, comments: v.comments ?? 0, subs: v.subscribersGained ?? 0,
      };
    }),
  );
  return { at: data.at || null, videos };
}

export const IDEAS = { whatif, kaiara, standup };

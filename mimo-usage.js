// MiMo token usage, counted from the usage every API reply carries (the Token Plan has no usage/quota endpoint).
// One JSON line per model call in ~/.config/gitgit-studio/mimo-usage.jsonl, written by the dashboard's MiMo Chat
// and by other projects on this server (gitgit_standup's standup/mimo.py appends to the same file).
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const USAGE_FILE = join(homedir(), ".config", "gitgit-studio", "mimo-usage.jsonl");

export async function recordUsage(source, model, usage) {
  if (!usage) return;
  const row = {
    t: Date.now(), source, model,
    in: usage.prompt_tokens || 0, out: usage.completion_tokens || 0,
    cached: usage.prompt_tokens_details?.cached_tokens || 0, reasoning: usage.completion_tokens_details?.reasoning_tokens || 0,
  };
  await mkdir(dirname(USAGE_FILE), { recursive: true });
  await appendFile(USAGE_FILE, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

// day key in Jakarta time
const dayOf = (t) => new Date(t + 7 * 3600_000).toISOString().slice(0, 10);

export async function usageSummary(days = 30) {
  let text = "";
  try {
    text = await readFile(USAGE_FILE, "utf8");
  } catch {
    /* nothing recorded yet */
  }
  const now = Date.now(), today = dayOf(now);
  const since = now - days * 86400_000;
  const empty = () => ({ in: 0, out: 0, cached: 0, reasoning: 0, calls: 0 });
  const add = (a, r) => { a.in += r.in; a.out += r.out; a.cached += r.cached; a.reasoning += r.reasoning; a.calls++; };
  const total = { today: empty(), week: empty(), month: empty(), all: empty() };
  const perDay = new Map(), bySource = new Map(), byModel = new Map();
  let first = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    first ||= r.t;
    add(total.all, r);
    if (r.t < since) continue;
    const d = dayOf(r.t);
    add(total.month, r);
    if (now - r.t < 7 * 86400_000) add(total.week, r);
    if (d === today) add(total.today, r);
    if (!perDay.has(d)) perDay.set(d, empty());
    add(perDay.get(d), r);
    const src = String(r.source || "lain");
    if (!bySource.has(src)) bySource.set(src, empty());
    add(bySource.get(src), r);
    if (!byModel.has(r.model)) byModel.set(r.model, empty());
    add(byModel.get(r.model), r);
  }
  const daysList = [];
  for (let i = Math.min(days, 14) - 1; i >= 0; i--) {
    const d = dayOf(now - i * 86400_000);
    daysList.push({ day: d, ...(perDay.get(d) || empty()) });
  }
  const sorted = (m) => [...m].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.in + b.out - (a.in + a.out));
  return { total, days: daysList, bySource: sorted(bySource), byModel: sorted(byModel), since: first, limit: Number(process.env.MIMO_MONTHLY_TOKENS) || 0 };
}

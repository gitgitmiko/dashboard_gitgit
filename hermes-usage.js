import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HERMES_DB = join(homedir(), ".hermes", "state.db");

// day key in Jakarta time; state.db keeps totals per session, so a session counts on the day it was last active
const dayOf = (t) => new Date(t + 7 * 3600_000).toISOString().slice(0, 10);

export async function usageSummary(days = 30) {
  const empty = () => ({ in: 0, out: 0, cached: 0, reasoning: 0, calls: 0 });
  if (!existsSync(HERMES_DB)) {
    return { total: { today: empty(), week: empty(), month: empty(), all: empty() }, days: [], bySource: [], byModel: [], since: Date.now() };
  }
  const db = new DatabaseSync(HERMES_DB, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT model, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, api_call_count, first_seen, last_seen
      FROM session_model_usage
    `).all();

    const now = Date.now(), today = dayOf(now);
    const since = now - days * 86400_000;
    const add = (a, r) => {
      a.in += r.input_tokens || 0;
      a.out += r.output_tokens || 0;
      a.cached += r.cache_read_tokens || 0;
      a.reasoning += r.reasoning_tokens || 0;
      a.calls += r.api_call_count || 0;
    };

    const total = { today: empty(), week: empty(), month: empty(), all: empty() };
    const perDay = new Map(), byModel = new Map();
    let first = Date.now();

    for (const r of rows) {
      const t = (r.last_seen || r.first_seen || 0) * 1000;
      if (!t) continue;
      if (t < first) first = t;

      add(total.all, r);
      if (t < since) continue;

      const d = dayOf(t);
      add(total.month, r);
      if (now - t < 7 * 86400_000) add(total.week, r);
      if (d === today) add(total.today, r);

      if (!perDay.has(d)) perDay.set(d, empty());
      add(perDay.get(d), r);

      const modelName = r.model || "unknown";
      if (!byModel.has(modelName)) byModel.set(modelName, empty());
      add(byModel.get(modelName), r);
    }

    const daysList = [];
    for (let i = Math.min(days, 14) - 1; i >= 0; i--) {
      const d = dayOf(now - i * 86400_000);
      daysList.push({ day: d, ...(perDay.get(d) || empty()) });
    }

    const sorted = (m) => [...m].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.in + b.out - (a.in + a.out));

    return {
      total,
      days: daysList,
      byModel: sorted(byModel),
      bySource: [],
      since: first,
    };
  } catch (err) {
    return { total: { today: empty(), week: empty(), month: empty(), all: empty() }, days: [], bySource: [], byModel: [], since: Date.now(), error: err.message };
  } finally {
    db.close();
  }
}

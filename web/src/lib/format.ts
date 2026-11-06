export function fmtBytes(n: number | null | undefined) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let x = Number(n) || 0;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x.toFixed(x >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtDuration(sec: number) {
  const s = Math.floor(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d} hari ${h} jam ${m} menit`;
}

export function fmtDateTime(iso: string | number | null | undefined) {
  return iso ? new Date(iso).toLocaleString("id-ID") : "—";
}

export function fmtClock(iso: string) {
  return new Date(iso).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtShort(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString("id-ID", { day: "2-digit", month: "short" })} ${d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`;
}

export function fmtSpan(a: string, b: string) {
  const s = Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
  if (s < 60) return `${s} dtk`;
  return `${Math.floor(s / 60)} mnt ${s % 60} dtk`;
}

export function shellQuote(s: string) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Tingkat bahaya persentase: dipakai untuk warna bar (normal / hangat / panas), sama seperti UI lama. */
export function level(percent: number): "ok" | "warm" | "hot" {
  if (percent >= 90) return "hot";
  if (percent >= 70) return "warm";
  return "ok";
}

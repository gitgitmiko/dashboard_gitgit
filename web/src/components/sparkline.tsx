import { useId } from "react";

/** Grafik garis kecil berbasis SVG; nilai 0–max (default 100). */
export function Sparkline({ values, max = 100, className }: { values: number[]; max?: number; className?: string }) {
  const id = useId();
  const w = 120;
  const h = 32;
  if (values.length < 2) return <svg viewBox={`0 0 ${w} ${h}`} className={className} />;
  const top = Math.max(max, ...values) || 1;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, h - 2 - (Math.max(0, v) / top) * (h - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={className}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.28} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line} L${w},${h} L0,${h} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

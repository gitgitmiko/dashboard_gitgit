import { cn } from "@/lib/utils";
import { level } from "@/lib/format";

const tone = { ok: "bg-primary", warm: "bg-warning", hot: "bg-destructive" };

/** Bar persentase; warnanya berubah di 70% dan 90% seperti UI lama. */
export function Progress({ value, className }: { value: number; className?: string }) {
  const v = Math.max(0, Math.min(100, value || 0));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div className={cn("h-full rounded-full transition-[width] duration-500", tone[level(v)])} style={{ width: `${v}%` }} />
    </div>
  );
}

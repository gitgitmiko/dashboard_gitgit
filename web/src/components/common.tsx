import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export const PAGE_SIZES = [10, 25, 50, 100];

/** Kartu angka ringkas di baris atas tiap tab. */
export function StatCard({ label, value, detail, loading }: { label: ReactNode; value: ReactNode; detail?: ReactNode; loading?: boolean }) {
  return (
    <Card className="gap-2 py-4">
      <CardContent className="flex min-w-0 flex-col gap-1.5 px-4">
        <span className="truncate text-sm text-muted-foreground">{label}</span>
        {loading ? <Skeleton className="h-7 w-20" /> : <span className="tabular truncate text-2xl font-semibold tracking-tight">{value}</span>}
        {detail !== undefined && <span className="truncate text-xs text-muted-foreground">{loading ? <Skeleton className="h-3 w-28" /> : detail || " "}</span>}
      </CardContent>
    </Card>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">{children}</p>;
}

export function PageSizeSelect({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      Baris
      <NativeSelect value={value} onChange={(e) => onChange(Number(e.target.value) || 10)} className="w-20">
        {PAGE_SIZES.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
}

export function Pager({ page, totalPages, onPage, info }: { page: number; totalPages: number; onPage: (p: number) => void; info?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t px-4 pt-3 text-xs text-muted-foreground sm:px-5">
      <span className="tabular">
        Hal {page} / {totalPages}
        {info}
      </span>
      <div className="flex gap-1">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft /> <span className="hidden sm:inline">Sebelumnya</span>
        </Button>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          <span className="hidden sm:inline">Berikutnya</span> <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

export function RefreshButton({ onClick, busy, label = "Muat ulang" }: { onClick: () => void; busy?: boolean; label?: string }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={busy}>
      <RefreshCw className={cn(busy && "animate-spin")} />
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}

export type LogTone = "err" | "ok" | "";

/**
 * Penampil log mentah. Kalau pengguna sedang di dasar, tetap menempel ke dasar saat baris baru masuk;
 * kalau sedang menggulir ke atas untuk membaca, posisinya tidak diganggu.
 */
export function LogView({ lines, tone, empty = "Log kosong.", className }: { lines: string[]; tone: (line: string) => LogTone; empty?: string; className?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <pre
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className={cn("max-h-[60vh] overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap", className)}
    >
      {lines.length
        ? lines.map((l, i) => {
            const t = tone(l);
            return (
              <span key={i} className={cn("block", t === "err" && "text-destructive", t === "ok" && "text-success")}>
                {l || " "}
              </span>
            );
          })
        : <span className="text-muted-foreground">{empty}</span>}
    </pre>
  );
}

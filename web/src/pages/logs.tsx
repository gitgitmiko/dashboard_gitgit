import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { ErrorNote, LogView, PageSizeSelect, Pager, RefreshButton, StatCard } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, qs } from "@/lib/api";
import { fmtBytes, fmtClock, fmtSpan } from "@/lib/format";

type RunStatus = "synced" | "nochange" | "skipped" | "failed" | "partial" | "running";
type Run = { start: string; end: string; status: RunStatus; events: { ts: string; msg: string }[] };
type LogData = {
  size: number;
  runs: Run[];
  page: number;
  totalPages: number;
  runsTotal: number;
  summary: { last: Run | null; windowSize: number; synced: number; failed: number };
  lines: string[];
};

const RUN: Record<RunStatus, [string, "success" | "outline" | "warning" | "destructive"]> = {
  synced: ["Sync selesai", "success"],
  nochange: ["Tidak ada konten baru", "outline"],
  skipped: ["Dilewati (masih jalan)", "outline"],
  failed: ["Gagal", "destructive"],
  partial: ["Selesai sebagian", "warning"],
  running: ["Berjalan", "warning"],
};

export function RunBadge({ status }: { status: RunStatus }) {
  const [label, variant] = RUN[status] || [status, "outline"];
  return <Badge variant={variant}>{label}</Badge>;
}

// Scraper dijalankan cron tiap 30 menit (menit 00 dan 30).
function nextRun() {
  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(now.getMinutes() < 30 ? 30 : 60);
  return next.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

// Field hitungan error yang kosong/nol ("errors":[], "failed": 0, fail=0) bukan tanda masalah.
const ZERO_ERR = /"?\b(errors?|fail(ed|ures)?)"?\s*[:=]\s*(\[\]|0\b)/gi;
function logTone(l: string) {
  if (l.startsWith("[watch]")) return /gagal/.test(l) ? "err" : "ok";
  return /error|fail|gagal/i.test(l.replace(ZERO_ERR, "")) ? "err" : "";
}

export function Logs({ active }: { active: boolean }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [filter, setFilter] = useState("");
  const [watchOnly, setWatchOnly] = useState(false);
  const [auto, setAuto] = useState(true);

  const { data: d, error, isFetching, refetch } = useQuery({
    queryKey: ["logs", page, pageSize],
    queryFn: () => api<LogData>(`/api/logs${qs({ lines: 500, page, pageSize })}`),
    refetchInterval: active && auto ? 5000 : false,
    placeholderData: keepPreviousData,
  });

  const lines = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (d?.lines || []).filter((l) => (!watchOnly || l.startsWith("[watch]")) && (!q || l.toLowerCase().includes(q)));
  }, [d, filter, watchOnly]);

  const s = d?.summary;
  const win = s?.windowSize || 0;

  return (
    <div className="flex flex-col gap-5">
      <ErrorNote>{error?.message}</ErrorNote>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          loading={!d}
          label="Run terakhir"
          value={s?.last ? <RunBadge status={s.last.status} /> : "—"}
          detail={s?.last ? `${fmtClock(s.last.start)} · ${fmtSpan(s.last.start, s.last.end)}` : "Belum ada run"}
        />
        <StatCard loading={!d} label="Run berikutnya" value={nextRun()} detail="cron tiap 30 menit" />
        <StatCard loading={!d} label={`Sync (${win} run)`} value={s?.synced ?? "—"} detail={s ? `${win - s.synced - s.failed} tanpa perubahan` : ""} />
        <StatCard loading={!d} label={`Gagal (${win} run)`} value={<span className={s?.failed ? "text-destructive" : undefined}>{s?.failed ?? "—"}</span>} detail={d ? `log ${fmtBytes(d.size)}` : ""} />
      </div>

      <Card className="gap-3 pb-3">
        <CardHeader>
          <CardTitle>Riwayat run</CardTitle>
          <CardAction>
            <PageSizeSelect
              value={pageSize}
              onChange={(n) => {
                setPageSize(n);
                setPage(1);
              }}
            />
          </CardAction>
        </CardHeader>
        <CardContent className="px-2 sm:px-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mulai</TableHead>
                <TableHead>Durasi</TableHead>
                <TableHead>Hasil</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!d && <TableEmpty cols={3}>Memuat…</TableEmpty>}
              {d && !d.runs.length && <TableEmpty cols={3}>Belum ada run</TableEmpty>}
              {d?.runs.map((r) => (
                <TableRow key={r.start}>
                  <TableCell className="tabular whitespace-nowrap">{fmtClock(r.start)}</TableCell>
                  <TableCell className="tabular whitespace-nowrap text-muted-foreground">{fmtSpan(r.start, r.end)}</TableCell>
                  <TableCell>
                    <RunBadge status={r.status} />
                    {(r.status === "failed" || r.status === "partial") && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {r.events.filter((e) => /gagal/.test(e.msg)).map((e) => e.msg).join("; ") || r.events.at(-1)?.msg}
                      </p>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
        {d && <Pager page={d.page} totalPages={d.totalPages} onPage={setPage} info={` · ${d.runsTotal} run`} />}
      </Card>

      <Card className="gap-3">
        <CardHeader>
          <CardTitle>Log mentah</CardTitle>
          <CardAction>
            <RefreshButton onClick={() => refetch()} busy={isFetching} />
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="relative min-w-48 flex-1">
              <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Saring baris…" className="h-8 pl-8" />
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={watchOnly} onChange={(e) => setWatchOnly(e.target.checked)} />
              hanya [watch]
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
              otomatis (5 dtk)
            </label>
          </div>
          <LogView
            lines={lines}
            empty={d ? "Tidak ada baris." : "Memuat…"}
            tone={logTone}
          />
        </CardContent>
      </Card>
    </div>
  );
}

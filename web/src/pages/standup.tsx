import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { DateFilter, ErrText, ExtLink, fmtDayLong, PreviewLink, Thumb, VideoBadge } from "@/components/automation";
import { ErrorNote, LogView, PageSizeSelect, Pager, RefreshButton, StatCard } from "@/components/common";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, BASE, qs } from "@/lib/api";
import { fmtShort } from "@/lib/format";

type Run = {
  run: string;
  judul: string;
  status: string;
  youtube_id: string;
  created?: string | null;
  picked?: string | null;
  error?: string;
};
type Schedule = { slot: string; upload: string; produce?: string | null; status: string; run: Run | null };
type Overview = {
  pending: number;
  last: Run[];
  today: { uploaded: number; failed: number; planned: number };
  week: { uploaded: number; failed: number };
  next: { at: string; upload: string } | null;
  schedule: Schedule[];
};
type History = { runs: Run[]; total: number; page: number; totalPages: number };

const logTone = (l: string) => (/failed|error|gagal/i.test(l) ? "err" : /uploaded|rendered|picked|ok/.test(l) ? "ok" : "");
// Thumbnail video yang belum terupload diambil lewat dashboard (API outbox butuh kunci); sesudah terupload, dari YouTube.
const thumbOf = (r: Run) => (r.youtube_id ? `https://i.ytimg.com/vi/${r.youtube_id}/mqdefault.jpg` : `${BASE}/api/standup/thumb/${r.run}`);
const ytUrl = (r: Run) => (r.youtube_id ? `https://www.youtube.com/watch?v=${r.youtube_id}` : null);
// Yang belum terupload bisa ditonton langsung: dashboard meneruskan videonya dari API outbox (butuh login).
const previewUrl = (r: Run) => `${BASE}/api/standup/video/${r.run}.mp4`;
const watchHref = (r: Run) => ytUrl(r) ?? previewUrl(r);

export function Standup({ active }: { active: boolean }) {
  const [status, setStatus] = useState("");
  const [date, setDate] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const filter = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  const poll = active ? 30000 : false;
  const ov = useQuery({ queryKey: ["su-overview"], queryFn: () => api<Overview>("/api/standup/overview"), refetchInterval: poll });
  const hist = useQuery({
    queryKey: ["su-history", status, date, page, pageSize],
    queryFn: () => api<History>(`/api/standup/history${qs({ status, date, page, pageSize })}`),
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });
  const logs = useQuery({ queryKey: ["su-logs"], queryFn: () => api<{ lines: string[] }>("/api/standup/logs?lines=200"), refetchInterval: poll });
  const d = ov.data;
  // Field jadwal & statistik harian datang dari backend yang baru; selagi service belum di-restart, pakai nilai
  // kosong supaya tab tetap terbaca.
  const today = d?.today ?? { uploaded: 0, failed: 0, planned: 5 };
  const week = d?.week ?? { uploaded: 0, failed: 0 };
  const schedule = d?.schedule ?? [];
  const last = d && [...d.last].reverse().find((r) => r.status === "uploaded");

  return (
    <div className="flex flex-col gap-5">
      <ErrorNote>{ov.error?.message || hist.error?.message}</ErrorNote>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard loading={!d} label="Terupload hari ini" value={d && `${today.uploaded}/${today.planned}`} detail={d && `${today.failed} gagal hari ini`} />
        <StatCard
          loading={!d}
          label="Gagal (7 hari)"
          value={<span className={week.failed ? "text-destructive" : undefined}>{week.failed}</span>}
          detail={d && `${week.uploaded} terupload · 7 hari terakhir`}
        />
        <StatCard
          loading={!d}
          label="Upload berikutnya"
          value={d?.next?.upload || "—"}
          detail={d?.next ? `${fmtDayLong(d.next.at)} · ${d.pending ?? 0} menunggu di outbox` : "Tidak ada lagi hari ini"}
        />
        <StatCard
          loading={!d}
          label="Video terakhir"
          value={last ? <ExtLink href={ytUrl(last)} className="text-xl sm:text-2xl">{fmtShort(last.created)}</ExtLink> : "—"}
          detail={last ? last.judul : "Belum ada video terupload"}
        />
      </div>

      <Card className="gap-3">
        <CardHeader>
          <div>
            <CardTitle>Jadwal hari ini · Gitgit Stand-up</CardTitle>
            <CardDescription className="mt-1.5">Stand-up comedy animasi Gitgit · materi MiMo 5x sehari (mulai 23:00 WIB) · suara Gemini · animasi Remotion · diupload n8n 10:00, 12:00, 15:00, 18:00, 20:00 WIB</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="px-2 sm:px-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Upload</TableHead>
                <TableHead>Produksi</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Video</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!d && <TableEmpty cols={4}>Memuat…</TableEmpty>}
              {d && !schedule.length && <TableEmpty cols={4}>Tidak ada jadwal hari ini</TableEmpty>}
              {schedule.map((s) => (
                <TableRow key={s.slot}>
                  <TableCell className="align-top whitespace-nowrap">
                    <span className="tabular font-medium">{s.upload}</span> <span className="text-xs text-muted-foreground">WIB</span>
                  </TableCell>
                  <TableCell className="tabular align-top">{s.produce ? fmtShort(s.produce).slice(-5) : "—"}</TableCell>
                  <TableCell className="align-top">
                    <VideoBadge status={s.status} />
                    <div className="sm:hidden">
                      <ExtLink href={s.run && watchHref(s.run)} className="mt-1">
                        {s.run && ytUrl(s.run) ? "Tonton" : "Preview"}
                      </ExtLink>
                      <PreviewLink href={s.run && s.run.status !== "uploaded" ? previewUrl(s.run) : null} />
                    </div>
                    <ErrText>{s.run?.error}</ErrText>
                  </TableCell>
                  <TableCell className="hidden max-w-80 align-top sm:table-cell">
                    {s.run ? (
                      <>
                        <ExtLink href={watchHref(s.run)}>{ytUrl(s.run) ? "Tonton" : "Preview"}</ExtLink>
                        <p className="truncate text-xs text-muted-foreground">{s.run.judul}</p>
                        <PreviewLink href={s.run.status !== "uploaded" ? previewUrl(s.run) : null} />
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="gap-3 pb-3">
        <CardHeader>
          <CardTitle>Riwayat video</CardTitle>
          <CardAction>
            <RefreshButton
              busy={hist.isFetching || ov.isFetching}
              onClick={() => {
                ov.refetch();
                hist.refetch();
                logs.refetch();
              }}
            />
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <NativeSelect value={status} onChange={(e) => filter(setStatus)(e.target.value)} className="w-40">
            <option value="">Semua status</option>
            <option value="menunggu">Menunggu</option>
            <option value="uploaded">Terupload</option>
            <option value="failed">Gagal</option>
          </NativeSelect>
          <DateFilter value={date} onChange={filter(setDate)} />
          <div className="ml-auto">
            <PageSizeSelect value={pageSize} onChange={filter(setPageSize)} />
          </div>
        </CardContent>
        <CardContent className="px-2 sm:px-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="hidden sm:table-cell">Waktu</TableHead>
                <TableHead className="w-0" />
                <TableHead>Judul</TableHead>
                <TableHead className="hidden sm:table-cell">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!hist.data && <TableEmpty cols={4}>Memuat…</TableEmpty>}
              {hist.data && !hist.data.runs.length && <TableEmpty cols={4}>Belum ada video.</TableEmpty>}
              {hist.data?.runs.map((r) => (
                <TableRow key={r.run}>
                  <TableCell className="hidden align-top whitespace-nowrap sm:table-cell">
                    <span className="tabular">{fmtShort(r.created)}</span>
                    {r.picked && <p className="text-xs text-muted-foreground">diposting {fmtShort(r.picked)}</p>}
                  </TableCell>
                  <TableCell className="align-top">
                    <Thumb src={thumbOf(r)} href={watchHref(r)} className="h-[45px] w-20 sm:h-[63px] sm:w-28" />
                  </TableCell>
                  <TableCell className="min-w-44 align-top">
                    <a href={watchHref(r)} target="_blank" rel="noopener" className="font-medium hover:underline">
                      {r.judul}
                    </a>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      <span className="tabular sm:hidden">{fmtShort(r.created)}</span>
                      <span className="sm:hidden"> · </span>
                      {r.run}
                    </p>
                    <div className="mt-1.5 flex items-center gap-2 sm:hidden">
                      <VideoBadge status={r.status} />
                      <ExtLink href={watchHref(r)}>{ytUrl(r) ? "Tonton" : "Preview"}</ExtLink>
                    </div>
                    <ErrText>{r.error}</ErrText>
                  </TableCell>
                  <TableCell className="hidden align-top sm:table-cell">
                    <VideoBadge status={r.status} />
                    <div className="mt-1">
                      <ExtLink href={watchHref(r)}>{ytUrl(r) ? "Tonton" : "Preview"}</ExtLink>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
        {hist.data && <Pager page={hist.data.page} totalPages={hist.data.totalPages} onPage={setPage} info={` · ${hist.data.total} video`} />}
      </Card>

      <Card className="gap-3">
        <CardHeader>
          <CardTitle>Log service</CardTitle>
          <CardAction>
            <RefreshButton busy={logs.isFetching} onClick={() => logs.refetch()} />
          </CardAction>
        </CardHeader>
        <CardContent>
          <LogView lines={logs.data?.lines || []} tone={logTone} empty={logs.error?.message || (logs.data ? "Log kosong." : "Memuat…")} className="max-h-[50vh]" />
        </CardContent>
      </Card>
    </div>
  );
}

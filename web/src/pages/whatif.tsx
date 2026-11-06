import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Check, Copy, Download } from "lucide-react";
import { useState } from "react";
import { BusyBanner, DateFilter, ErrText, ExtLink, fmtDayLong, fmtMinSec, Thumb, VideoBadge } from "@/components/automation";
import { ErrorNote, LogView, PageSizeSelect, Pager, RefreshButton, StatCard } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, BASE, qs } from "@/lib/api";
import { fmtShort } from "@/lib/format";

type Run = {
  id: string;
  slot: string;
  topic?: string | null;
  title?: string | null;
  status: string;
  stage?: string | null;
  error?: string | null;
  started_at: string;
  finished_at?: string | null;
  duration_s?: number | null;
  video_s?: number | null;
  youtube_url?: string | null;
  thumb?: string | null;
  preview?: string | null;
};
type Overview = {
  service: { busy: boolean | null; stage?: string | null };
  today: { uploaded: number; failed: number; planned: number };
  week: { uploaded: number; failed: number };
  next: { at: string; upload: string; produce: string } | null;
  last: Run | null;
  schedule: { slot: string; produce: string; upload: string; status: string; run: Run | null }[];
};
type History = { runs: Run[]; total: number; page: number; totalPages: number };

const SLOT: Record<string, string> = { siang: "Siang", sore: "Sore" };
const logTone = (l: string) => (/failed|error|gagal/i.test(l) ? "err" : /rendered|uploaded|started/.test(l) ? "ok" : "");
const videoLen = (s?: number | null) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "");

// Link preview dibagikan ke orang lain tanpa login. Subdomain dashboard dilindungi Cloudflare Access,
// jadi link publik selalu memakai domain utama (dashboard.x → x) yang tidak melewati Access.
function publicPreviewUrl(preview: string) {
  const host = window.location.hostname.replace(/^dashboard\./, "");
  const origin = host === window.location.hostname ? window.location.origin : `https://${host}`;
  return `${origin}${BASE}/preview/whatif/${preview}`;
}

/** Link download preview; hilang sendiri setelah video terupload (service whatif berhenti mengirim "preview"). */
function PreviewLink({ r }: { r?: Run | null }) {
  const [copied, setCopied] = useState(false);
  if (!r?.preview) return null;
  const href = publicPreviewUrl(r.preview);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <a href={href} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
        <Download className="size-3" /> Preview
      </a>
      <Button
        variant="outline"
        size="xs"
        className="h-6 text-[11px]"
        onClick={() =>
          navigator.clipboard.writeText(href).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          })
        }
      >
        {copied ? <Check /> : <Copy />} {copied ? "Tersalin" : "Salin link publik"}
      </Button>
    </div>
  );
}

export function Whatif({ active }: { active: boolean }) {
  const [status, setStatus] = useState("");
  const [date, setDate] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const filter = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  const poll = active ? 15000 : false;
  const ov = useQuery({ queryKey: ["wi-overview"], queryFn: () => api<Overview>("/api/whatif/overview"), refetchInterval: poll });
  const hist = useQuery({
    queryKey: ["wi-history", status, date, page, pageSize],
    queryFn: () => api<History>(`/api/whatif/history${qs({ page, pageSize, status, date })}`),
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });
  const logs = useQuery({ queryKey: ["wi-logs"], queryFn: () => api<{ lines: string[] }>("/api/whatif/logs?lines=200"), refetchInterval: poll });
  const d = ov.data;

  return (
    <div className="flex flex-col gap-5">
      <ErrorNote>{ov.error?.message || hist.error?.message}</ErrorNote>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard loading={!d} label="Terupload hari ini" value={d && `${d.today.uploaded}/${d.today.planned}`} detail={d && `${d.today.failed} gagal hari ini`} />
        <StatCard
          loading={!d}
          label="Gagal (7 hari)"
          value={<span className={d?.week.failed ? "text-destructive" : undefined}>{d?.week.failed}</span>}
          detail={d && `${d.week.uploaded} terupload · 7 hari terakhir`}
        />
        <StatCard loading={!d} label="Upload berikutnya" value={d?.next?.upload || "—"} detail={d?.next ? `${fmtDayLong(d.next.at)} · produksi mulai ${d.next.produce}` : "—"} />
        <StatCard
          loading={!d}
          label="Video terakhir"
          value={
            d?.last ? (
              d.last.youtube_url ? (
                <ExtLink href={d.last.youtube_url} className="text-xl sm:text-2xl">
                  {fmtShort(d.last.finished_at)}
                </ExtLink>
              ) : (
                fmtShort(d.last.finished_at)
              )
            ) : (
              "—"
            )
          }
          detail={d && (d.last ? (d.last.title || "").slice(0, 70) : "Belum ada video")}
        />
      </div>

      {d?.service.busy && <BusyBanner stage={d.service.stage || "memulai"} />}

      <Card className="gap-3">
        <CardHeader>
          <div>
            <CardTitle>Jadwal hari ini · Apa yang terjadi jika</CardTitle>
            <CardDescription className="mt-1.5">Video 5-8 menit · naskah Claude Sonnet, diverifikasi Claude Opus · gambar Google Flow · edit Concat · diupload n8n</CardDescription>
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
              {d && !d.schedule.length && <TableEmpty cols={4}>Tidak ada jadwal hari ini</TableEmpty>}
              {d?.schedule.map((s) => {
                const r = s.run;
                return (
                  <TableRow key={s.slot}>
                    <TableCell className="align-top whitespace-nowrap">
                      <span className="tabular font-medium">{s.upload}</span> <span className="text-xs text-muted-foreground">{SLOT[s.slot] || s.slot}</span>
                    </TableCell>
                    <TableCell className="tabular align-top">{s.produce}</TableCell>
                    <TableCell className="align-top">
                      <VideoBadge status={s.status} />
                      {r?.status === "running" && r.stage && <p className="mt-1 text-xs text-muted-foreground">{r.stage}</p>}
                      <div className="sm:hidden">
                        <ExtLink href={r?.youtube_url} className="mt-1">
                          Tonton
                        </ExtLink>
                        <PreviewLink r={r} />
                      </div>
                      <ErrText>{r?.error}</ErrText>
                    </TableCell>
                    <TableCell className="hidden max-w-80 align-top sm:table-cell">
                      {r ? (
                        <>
                          <ExtLink href={r.youtube_url}>Tonton</ExtLink>
                          <p className="truncate text-xs text-muted-foreground">{r.title || r.topic}</p>
                          <PreviewLink r={r} />
                        </>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="gap-3 pb-3">
        <CardHeader>
          <CardTitle>Riwayat video</CardTitle>
          <CardAction>
            <RefreshButton
              busy={hist.isFetching}
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
            <option value="uploaded">Terupload</option>
            <option value="failed">Gagal</option>
            <option value="rendered">Belum diupload</option>
            <option value="running">Diproses</option>
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
                <TableRow key={r.id}>
                  <TableCell className="hidden align-top whitespace-nowrap sm:table-cell">
                    <span className="tabular">{fmtShort(r.started_at)}</span>
                    <p className="text-xs text-muted-foreground">
                      {SLOT[r.slot] || r.slot}
                      {r.duration_s ? ` · dibuat ${fmtMinSec(r.duration_s)}` : ""}
                    </p>
                  </TableCell>
                  <TableCell className="align-top">
                    <Thumb src={r.thumb} href={r.youtube_url} className="h-[45px] w-20 sm:h-[63px] sm:w-28" />
                  </TableCell>
                  <TableCell className="min-w-44 align-top">
                    {r.youtube_url ? (
                      <a href={r.youtube_url} target="_blank" rel="noopener" className="font-medium hover:underline">
                        {r.title || r.topic}
                      </a>
                    ) : (
                      <span className="font-medium">{r.title || r.topic || "Topik belum dipilih"}</span>
                    )}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      <span className="tabular sm:hidden">{fmtShort(r.started_at)}{r.video_s || r.stage ? " · " : ""}</span>
                      {[r.video_s ? `Durasi ${videoLen(r.video_s)}` : "", r.stage || ""].filter(Boolean).join(" · ")}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 sm:hidden">
                      <VideoBadge status={r.status} />
                      <ExtLink href={r.youtube_url}>Tonton</ExtLink>
                    </div>
                    <div className="sm:hidden">
                      <PreviewLink r={r} />
                    </div>
                    <ErrText>{r.error}</ErrText>
                  </TableCell>
                  <TableCell className="hidden align-top sm:table-cell">
                    <VideoBadge status={r.status} />
                    <div className="mt-1">
                      <ExtLink href={r.youtube_url}>Tonton</ExtLink>
                    </div>
                    <PreviewLink r={r} />
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

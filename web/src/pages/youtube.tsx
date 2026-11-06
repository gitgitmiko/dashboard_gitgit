import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { BusyBanner, DateFilter, ErrText, ExtLink, fmtDayLong, fmtMinSec, Thumb, VideoBadge, ytModel } from "@/components/automation";
import { ErrorNote, LogView, PageSizeSelect, Pager, RefreshButton, StatCard } from "@/components/common";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, qs } from "@/lib/api";
import { fmtShort } from "@/lib/format";

type Quiz = { question: string; answer: string; title: string; writer: string; verifier?: string | null; youtube_url?: string | null; thumb?: string | null };
type Run = {
  id: number;
  started_at: string;
  duration_s?: number | null;
  slot: string;
  topicLabel: string;
  status: string;
  stage?: string | null;
  error?: string | null;
  quiz: Quiz | null;
};
type Overview = {
  service: { busy: boolean; stage?: string | null };
  today: { uploaded: number; failed: number; planned: number };
  week: { uploaded: number; failed: number };
  next: { at: string; time: string; topicLabel: string } | null;
  last: { at: string; title?: string; question?: string; youtube_url?: string | null } | null;
  schedule: { time: string; slot: string; topicLabel: string; status: string; run: Run | null }[];
  rotation: { day: string; topicLabel: string }[];
  llm: { writers: string[]; verifiers: string[] };
  topics: Record<string, string>;
};
type History = { runs: Run[]; total: number; page: number; totalPages: number };

const logTone = (l: string) => (/failed|error|rejected|gagal/i.test(l) ? "err" : /accepted|done in|uploaded/.test(l) ? "ok" : "");

export function Youtube({ active }: { active: boolean }) {
  const [topic, setTopic] = useState("");
  const [status, setStatus] = useState("");
  const [date, setDate] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const filter = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  const poll = active ? 15000 : false;
  const ov = useQuery({ queryKey: ["yt-overview"], queryFn: () => api<Overview>("/api/youtube/overview"), refetchInterval: poll });
  const hist = useQuery({
    queryKey: ["yt-history", topic, status, date, page, pageSize],
    queryFn: () => api<History>(`/api/youtube/history${qs({ page, pageSize, topic, status, date })}`),
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });
  const logs = useQuery({ queryKey: ["yt-logs"], queryFn: () => api<{ lines: string[] }>("/api/youtube/logs?lines=200"), refetchInterval: poll });
  const d = ov.data;
  const refetchAll = () => {
    ov.refetch();
    hist.refetch();
    logs.refetch();
  };

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
        <StatCard loading={!d} label="Video berikutnya" value={d?.next?.time || "—"} detail={d?.next ? `${fmtDayLong(d.next.at)} · ${d.next.topicLabel}` : "—"} />
        <StatCard
          loading={!d}
          label="Video terakhir"
          value={d?.last ? (d.last.youtube_url ? <ExtLink href={d.last.youtube_url} className="text-xl sm:text-2xl">{fmtShort(d.last.at)}</ExtLink> : fmtShort(d.last.at)) : "—"}
          detail={d && (d.last ? (d.last.title || d.last.question || "").slice(0, 70) : "Belum ada video")}
        />
      </div>

      {d?.service.busy && <BusyBanner stage={d.service.stage} />}

      <Card className="gap-3">
        <CardHeader>
          <div>
            <CardTitle>Jadwal hari ini · KUISABON</CardTitle>
            {d && (
              <CardDescription className="mt-1.5">
                Rotasi topik: {d.rotation.map((r) => `${r.day} ${r.topicLabel.toLowerCase()}`).join(" · ")} · Penulis soal: {ytModel(d.llm.writers[0])}, pemeriksa: {ytModel(d.llm.verifiers[0])}
              </CardDescription>
            )}
          </div>
        </CardHeader>
        <CardContent className="px-2 sm:px-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Jam</TableHead>
                <TableHead>Topik</TableHead>
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
                      <span className="tabular font-medium">{s.time}</span> <span className="text-xs text-muted-foreground">{s.slot}</span>
                    </TableCell>
                    <TableCell className="align-top">{s.topicLabel}</TableCell>
                    <TableCell className="align-top">
                      <VideoBadge status={s.status} />
                      {r?.status === "running" && r.stage && <p className="mt-1 text-xs text-muted-foreground">{r.stage}</p>}
                      <div className="mt-1 sm:hidden">
                        <ExtLink href={r?.quiz?.youtube_url}>Tonton</ExtLink>
                      </div>
                      <ErrText>{r?.error}</ErrText>
                    </TableCell>
                    <TableCell className="hidden max-w-72 align-top sm:table-cell">
                      {r?.quiz ? (
                        <>
                          <ExtLink href={r.quiz.youtube_url}>Tonton</ExtLink>
                          <p className="truncate text-xs text-muted-foreground">{r.quiz.title}</p>
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
            <RefreshButton busy={hist.isFetching} onClick={refetchAll} />
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <NativeSelect value={topic} onChange={(e) => filter(setTopic)(e.target.value)} className="w-44">
            <option value="">Semua topik</option>
            {Object.entries(d?.topics || {}).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </NativeSelect>
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
                <TableHead>Soal</TableHead>
                <TableHead className="hidden sm:table-cell">Topik</TableHead>
                <TableHead className="hidden sm:table-cell">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!hist.data && <TableEmpty cols={5}>Memuat…</TableEmpty>}
              {hist.data && !hist.data.runs.length && <TableEmpty cols={5}>Belum ada video.</TableEmpty>}
              {hist.data?.runs.map((r) => {
                const q = r.quiz;
                return (
                  <TableRow key={r.id}>
                    <TableCell className="hidden align-top whitespace-nowrap sm:table-cell">
                      <span className="tabular">{fmtShort(r.started_at)}</span>
                      <p className="text-xs text-muted-foreground">
                        {r.slot}
                        {r.duration_s ? ` · ${fmtMinSec(r.duration_s)}` : ""}
                      </p>
                    </TableCell>
                    <TableCell className="align-top">
                      <Thumb src={q?.thumb} href={q?.youtube_url} className="h-20 w-[45px] sm:h-24 sm:w-[54px]" />
                    </TableCell>
                    <TableCell className="min-w-44 align-top">
                      {q ? (
                        q.youtube_url ? (
                          <a href={q.youtube_url} target="_blank" rel="noopener" className="font-medium hover:underline">
                            {q.question}
                          </a>
                        ) : (
                          <span className="font-medium">{q.question}</span>
                        )
                      ) : (
                        <>
                          <span className="text-muted-foreground">Soal belum dibuat</span>
                          <p className="tabular mt-0.5 text-xs text-muted-foreground sm:hidden">{fmtShort(r.started_at)}</p>
                        </>
                      )}
                      {q && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          <span className="tabular sm:hidden">{fmtShort(r.started_at)} · </span>
                          Jawaban: {q.answer} · {ytModel(q.writer)}
                          {q.verifier ? ` → ${ytModel(q.verifier)}` : ""}
                          <span className="sm:hidden"> · {r.topicLabel}</span>
                        </p>
                      )}
                      <div className="mt-1.5 flex items-center gap-2 sm:hidden">
                        <VideoBadge status={r.status} />
                        <ExtLink href={q?.youtube_url}>Tonton</ExtLink>
                      </div>
                      <ErrText>{r.error}</ErrText>
                    </TableCell>
                    <TableCell className="hidden align-top sm:table-cell">{r.topicLabel}</TableCell>
                    <TableCell className="hidden align-top sm:table-cell">
                      <VideoBadge status={r.status} />
                      <div className="mt-1">
                        <ExtLink href={q?.youtube_url}>Tonton</ExtLink>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
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

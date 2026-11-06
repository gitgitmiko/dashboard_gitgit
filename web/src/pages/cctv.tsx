import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, Play, Video } from "lucide-react";
import { useState } from "react";
import { ErrorNote, PageSizeSelect, Pager, RefreshButton } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, BASE, qs } from "@/lib/api";
import { fmtBytes, fmtDateTime } from "@/lib/format";

type Recording = { date: string; name: string; hour?: string; time?: string; size: number; mtime: string | null };
type Recordings = { date: string; recordings: Recording[]; page: number; totalPages: number; total: number };

const fileUrl = (r: Recording, download: boolean) => `${BASE}/api/cctv/file${qs({ date: r.date, name: r.name, download: download ? 1 : undefined })}`;

function fmtDay(date: string) {
  return new Date(`${date}T00:00:00`).toLocaleDateString("id-ID", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
}

// Berkas yang masih ditulis ffmpeg: rekaman terbaru yang baru saja berubah.
function isRecording(r: Recording, i: number, page: number) {
  return page === 1 && i === 0 && !!r.mtime && Date.now() - new Date(r.mtime).getTime() < 5 * 60 * 1000;
}

export function Cctv() {
  const [date, setDate] = useState(""); // kosong = biarkan server memilih (hari ini)
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [playing, setPlaying] = useState<Recording | null>(null);

  const dates = useQuery({ queryKey: ["cctv-dates"], queryFn: () => api<{ dates: string[] }>("/api/cctv/dates"), staleTime: 60000 });
  const { data: d, error, isFetching, refetch } = useQuery({
    queryKey: ["cctv", date, page, pageSize],
    queryFn: () => api<Recordings>(`/api/cctv/recordings${qs({ date, page, pageSize })}`),
    placeholderData: keepPreviousData,
  });

  const shown = d?.date || date;
  const list = dates.data?.dates || []; // terbaru di depan
  const idx = list.indexOf(shown);
  const pick = (v: string) => {
    setDate(v);
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-5">
      <ErrorNote>{error?.message}</ErrorNote>
      <Card className="gap-3 pb-3">
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2">
              <Video className="size-4 text-muted-foreground" /> Rekaman CCTV
            </CardTitle>
            <CardDescription className="mt-1.5">{d ? `${fmtDay(d.date)} · ${d.total} berkas · satu berkas per jam` : "Memuat…"}</CardDescription>
          </div>
          <CardAction>
            <RefreshButton
              busy={isFetching}
              onClick={() => {
                refetch();
                dates.refetch();
              }}
            />
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon-sm" title="Hari sebelumnya" disabled={idx < 0 || idx >= list.length - 1} onClick={() => pick(list[idx + 1])}>
              <ChevronLeft />
            </Button>
            <NativeSelect value={shown} onChange={(e) => pick(e.target.value)} className="w-48">
              {!list.includes(shown) && shown && <option value={shown}>{fmtDay(shown)}</option>}
              {list.map((x) => (
                <option key={x} value={x}>
                  {fmtDay(x)}
                </option>
              ))}
            </NativeSelect>
            <Button variant="outline" size="icon-sm" title="Hari berikutnya" disabled={idx <= 0} onClick={() => pick(list[idx - 1])}>
              <ChevronRight />
            </Button>
          </div>
          <Button variant="ghost" size="sm" disabled={!date} onClick={() => pick("")}>
            Hari ini
          </Button>
          <div className="ml-auto">
            <PageSizeSelect
              value={pageSize}
              onChange={(n) => {
                setPageSize(n);
                setPage(1);
              }}
            />
          </div>
        </CardContent>
        <CardContent className="px-2 sm:px-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Jam</TableHead>
                <TableHead className="text-right">Ukuran</TableHead>
                <TableHead className="hidden sm:table-cell">Diperbarui</TableHead>
                <TableHead className="text-right">Aksi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!d && <TableEmpty cols={4}>Memuat…</TableEmpty>}
              {d && !d.recordings.length && <TableEmpty cols={4}>Tidak ada rekaman.</TableEmpty>}
              {d?.recordings.map((r, i) => (
                <TableRow key={r.date + r.name}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="tabular font-medium">{r.time || (r.hour ? `${r.hour}:00` : "—")}</span>
                      {isRecording(r, i, d.page) && (
                        <Badge variant="destructive" className="gap-1.5">
                          <span className="size-1.5 animate-pulse rounded-full bg-destructive" /> Merekam
                        </Badge>
                      )}
                    </div>
                    <span className="font-mono text-xs text-muted-foreground">{r.name}</span>
                  </TableCell>
                  <TableCell className="tabular text-right whitespace-nowrap">{fmtBytes(r.size)}</TableCell>
                  <TableCell className="tabular hidden whitespace-nowrap text-muted-foreground sm:table-cell">{fmtDateTime(r.mtime)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="outline" size="sm" onClick={() => setPlaying(r)}>
                        <Play /> <span className="hidden sm:inline">Putar</span>
                      </Button>
                      <Button variant="outline" size="sm" asChild>
                        <a href={fileUrl(r, true)} title="Unduh">
                          <Download /> <span className="hidden sm:inline">Unduh</span>
                        </a>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
        {d && <Pager page={d.page} totalPages={d.totalPages} onPage={setPage} />}
      </Card>

      <Dialog open={!!playing} onOpenChange={(o) => !o && setPlaying(null)}>
        <DialogContent className="max-w-4xl gap-3 p-3 sm:p-4">
          {playing && (
            <>
              <DialogHeader>
                <DialogTitle>
                  CCTV {fmtDay(playing.date)} · {playing.time || playing.name}
                </DialogTitle>
                <DialogDescription>{fmtBytes(playing.size)} · diputar langsung dari server</DialogDescription>
              </DialogHeader>
              <video key={playing.name} src={fileUrl(playing, false)} controls autoPlay playsInline preload="metadata" className="aspect-video w-full rounded-md bg-black" />
              <div className="flex justify-end">
                <Button variant="outline" size="sm" asChild>
                  <a href={fileUrl(playing, true)}>
                    <Download /> Unduh berkas
                  </a>
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

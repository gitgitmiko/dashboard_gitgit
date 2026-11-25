import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ErrorNote, RefreshButton, StatCard } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";

type Job = {
  name: string;
  note: string;
  schedule: string;
  command: string;
  next: string | null;
  logFile: string | null;
  lastRun: string | null;
  lastLine: string;
};

type Episode = { run: string; date: string; judul: string; jenis: number | null; nilai_juri: number | null; seconds: number | null; status: string };

type CronData = {
  jobs: Job[];
  kaiara: {
    episodes: number;
    menunggu: number;
    diposting: number;
    rerataJuri: number | null;
    terakhir: Episode[];
    audit: { tanggal: string; auditor: string; naskah: number; laporan: string } | null;
  };
};

const STATUS: Record<string, [string, "success" | "warning" | "destructive" | "outline" | "secondary"]> = {
  menunggu: ["Menunggu tayang", "warning"],
  diposting: ["Sudah tayang", "success"],
  terproduksi: ["Baru diproduksi", "secondary"],
  riwayat: ["Riwayat", "outline"],
};

function fmtWaktu(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

// Penanda masalah di baris terakhir log job.
function jobBadge(j: Job) {
  if (!j.lastRun) return <Badge variant="outline">Belum pernah jalan</Badge>;
  if (/\b(gagal|error|failed|traceback)\b/i.test(j.lastLine)) return <Badge variant="destructive">Ada error di log</Badge>;
  return <Badge variant="success">Jalan normal</Badge>;
}

function EpisodeBadge({ status }: { status: string }) {
  const [label, variant] = STATUS[status] || [status, "outline"];
  return <Badge variant={variant}>{label}</Badge>;
}

export function Cron() {
  const [busy, setBusy] = useState(false);
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ["cron"],
    queryFn: () => api<CronData>("/api/cron"),
    refetchInterval: 60_000,
  });
  const k = data?.kaiara;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Cron & Produksi</h2>
        <RefreshButton onClick={() => { setBusy(true); refetch().finally(() => setBusy(false)); }} busy={busy || isLoading} />
      </div>
      {error && <ErrorNote>{String(error)}</ErrorNote>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Job cron aktif" value={data ? data.jobs.length : "—"} detail="crontab server" loading={isLoading} />
        <StatCard label="Video menunggu tayang" value={k ? k.menunggu : "—"} detail={k ? `${k.diposting} sudah tayang · ${k.episodes} total` : undefined} loading={isLoading} />
        <StatCard label="Rerata nilai juri" value={k?.rerataJuri ?? "—"} detail="penilaian Opus/Sonnet" loading={isLoading} />
        <StatCard label="Audit terakhir" value={k?.audit ? `${k.audit.tanggal}` : "—"} detail={k?.audit ? `Claude ${k.audit.auditor} · ${k.audit.naskah} naskah` : undefined} loading={isLoading} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Job terjadwal</CardTitle>
          <CardAction className="text-xs text-muted-foreground">dari crontab server</CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tugas</TableHead>
                <TableHead>Jadwal</TableHead>
                <TableHead>Berikutnya</TableHead>
                <TableHead>Eksekusi terakhir</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.jobs || []).map((j) => (
                <TableRow key={j.command}>
                  <TableCell>
                    <div className="font-medium">{j.name}</div>
                    <div className="max-w-[28rem] truncate text-xs text-muted-foreground">{j.command}</div>
                  </TableCell>
                  <TableCell className="tabular whitespace-nowrap">{j.schedule}</TableCell>
                  <TableCell className="whitespace-nowrap">{fmtWaktu(j.next)}</TableCell>
                  <TableCell>
                    <div className="whitespace-nowrap">{fmtWaktu(j.lastRun)}</div>
                    {j.lastLine && <div className="max-w-[28rem] truncate text-xs text-muted-foreground">{j.lastLine}</div>}
                  </TableCell>
                  <TableCell>{jobBadge(j)}</TableCell>
                </TableRow>
              ))}
              {data && !data.jobs.length && <TableEmpty cols={5}>Tidak ada job cron.</TableEmpty>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Produksi terakhir Kai &amp; Kak Ara</CardTitle>
          <CardAction className="text-xs text-muted-foreground">database nostalgia-reels</CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tanggal</TableHead>
                <TableHead>Judul</TableHead>
                <TableHead>Jenis</TableHead>
                <TableHead>Nilai juri</TableHead>
                <TableHead>Durasi</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(k?.terakhir || []).map((e) => (
                <TableRow key={e.run}>
                  <TableCell className="tabular whitespace-nowrap">{e.date || "—"}</TableCell>
                  <TableCell className="font-medium">{e.judul || e.run}</TableCell>
                  <TableCell className="tabular">{e.jenis ?? "—"}</TableCell>
                  <TableCell className="tabular">{e.nilai_juri ?? "—"}</TableCell>
                  <TableCell className="tabular whitespace-nowrap">{e.seconds ? `${Math.round(e.seconds)} dtk` : "—"}</TableCell>
                  <TableCell><EpisodeBadge status={e.status} /></TableCell>
                </TableRow>
              ))}
              {data && !k?.terakhir.length && <TableEmpty cols={6}>Belum ada episode.</TableEmpty>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

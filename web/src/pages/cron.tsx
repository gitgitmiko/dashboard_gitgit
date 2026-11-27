import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { ErrText } from "@/components/automation";
import { ErrorNote, RefreshButton, StatCard } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { fmtShort } from "@/lib/format";
import { kindLabel, type Overview as SosmedOverview, slotStatus } from "@/pages/sosmed";

// Tab Otomasi: satu linimasa hari ini dari semua otomasi (produksi, riset, upload, posting) lintas channel, supaya
// "apa yang gagal hari ini dan kapan" terjawab sekali lihat. Upload/posting memakai endpoint & cache tab Sosmed.

type St = "ok" | "failed" | "missed" | "running" | "waiting" | "skipped" | "unknown";
type Row = { at: string; channel: string; kind: string; status: St; detail?: string | null };
type Periodic = { name: string; channel: string; schedule: string; source: string; last: string | null; status: St; detail: string };
type Auto = { day: string; minutes: number; timeline: (Row & { what: string })[]; periodic: Periodic[] };
type YtRun = { status: string; title?: string | null; topic?: string | null; judul?: string; error?: string | null };
type YtOverview = { schedule: { slot: string; produce?: string | null; upload: string; status: string; run: YtRun | null }[] };

const BADGE: Record<St, [string, "success" | "destructive" | "warning" | "secondary" | "outline"]> = {
  ok: ["Berhasil", "success"],
  failed: ["Gagal", "destructive"],
  missed: ["Tidak jalan", "destructive"],
  running: ["Berjalan", "warning"],
  waiting: ["Terjadwal", "secondary"],
  skipped: ["Dilewati", "outline"],
  unknown: ["Belum pernah jalan", "outline"],
};
const bad = (s: St) => s === "failed" || s === "missed";
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
// Status posting Sosmed (PostBadge) ke status linimasa.
const POST: Record<string, St> = { posted: "ok", failed: "failed", skipped: "skipped", missed: "missed", prepared: "running", waiting: "waiting" };
const LATE = 45; // menit sesudah jam upload sebelum upload yang belum terjadi dianggap tidak jalan (sama dengan service whatif)

function ytUploads(channel: string, ov: YtOverview | undefined, now: number): Row[] {
  return (ov?.schedule ?? []).map((s) => ({
    at: s.upload,
    channel,
    kind: "Upload YouTube",
    status: s.status === "uploaded" ? "ok" : s.status === "missed" ? "missed" : now >= toMin(s.upload) + LATE ? "missed" : "waiting",
    detail: s.run?.title || s.run?.judul || s.run?.topic,
  }));
}

function whatifProductions(ov: YtOverview | undefined, now: number): Row[] {
  return (ov?.schedule ?? [])
    .filter((s) => s.produce)
    .map((s) => {
      const r = s.run;
      const status: St = !r ? (now >= toMin(s.produce!) + 5 ? "missed" : "waiting") : r.status === "running" ? "running" : r.status === "failed" ? "failed" : "ok";
      return { at: s.produce!, channel: "Apa yang terjadi jika", kind: "Produksi video", status, detail: r?.status === "failed" ? r.error : r?.title || r?.topic };
    });
}

function metaPosts(platform: string, ov: SosmedOverview | undefined): Row[] {
  return (ov?.accounts ?? []).flatMap((a) =>
    a.schedule.map((s) => {
      const p = s.platforms[0];
      return {
        at: s.time,
        channel: a.brand_name || a.key,
        kind: `Posting ${platform}`,
        status: POST[p?.status || slotStatus(s)] ?? "waiting",
        detail: p?.error || p?.title || s.forecast?.title || kindLabel(s),
      };
    }),
  );
}

type Roles = { settings: Record<string, Record<string, string>>; defaults: Record<string, string>; choices: string[] };
const AI: Record<string, string> = {
  "claude:sonnet": "Claude Sonnet",
  "claude:opus": "Claude Opus",
  "mimo:pro": "MiMo Pro",
  "mimo:flash": "MiMo Flash",
  hermes: "Hermes",
};
const CHANNEL: [string, string][] = [["standup", "Gitgit Stand-up"], ["kaiara", "Kai & Kak Ara"], ["whatif", "Apa yang terjadi jika"]];
const ROLE: [string, string][] = [["riset", "Riset"], ["penulis", "Penulis draf"], ["juri", "Juri"], ["cek", "Cek fakta"]];

/** Siapa yang meriset, menulis draf, menjuri, dan mengecek fakta tiap channel (lib/peran_ai.py membaca berkas yang sama). */
function RolesCard({ active }: { active: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["peran-ai"], queryFn: () => api<Roles>("/api/peran-ai"), enabled: active });
  const [busy, setBusy] = useState(false);
  async function change(ch: string, role: string, value: string) {
    if (!q.data) return;
    setBusy(true);
    try {
      const next = { ...q.data.settings, [ch]: { ...q.data.settings[ch], [role]: value } };
      const r = await api<Roles>("/api/peran-ai", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
      qc.setQueryData(["peran-ai"], r);
      toast.success(`${CHANNEL.find(([k]) => k === ch)?.[1]} · ${ROLE.find(([k]) => k === role)?.[1]}: ${AI[value]}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="gap-3">
      <CardHeader>
        <div>
          <CardTitle>Peran AI</CardTitle>
          <CardDescription className="mt-1.5">
            Siapa yang mengerjakan tiap tahap riset 19:00. Berlaku mulai riset berikutnya, tanpa restart. Kalau AI pilihan gagal (limit/error), tahap itu
            otomatis dikerjakan bawaannya lalu Claude Sonnet. MiMo tidak bisa web search: sebagai periset ia hanya mengolah daftar tren yang dikumpulkan
            skrip. Hermes memakai model yang dipilih di config Hermes.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!q.data && <p className="text-sm text-muted-foreground">{q.error?.message || "Memuat…"}</p>}
        {q.data &&
          CHANNEL.map(([ch, label]) => (
            <div key={ch} className="rounded-lg border p-3">
              <p className="mb-2 text-sm font-medium">{label}</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {ROLE.filter(([role]) => role !== "cek" || ch === "whatif").map(([role, roleLabel]) => (
                  <label key={role} className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                    {roleLabel}
                    <NativeSelect value={q.data.settings[ch][role]} disabled={busy} onChange={(e) => change(ch, role, e.target.value)} className="w-full">
                      {q.data.choices.map((c) => (
                        <option key={c} value={c}>
                          {AI[c] || c}
                          {c === q.data.defaults[role] ? " (bawaan)" : ""}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                ))}
              </div>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

export function Cron({ active }: { active: boolean }) {
  const [show, setShow] = useState<"all" | "bad" | "waiting">("all");
  const poll = active ? 30000 : false;
  // Kunci query sama dengan tab Sosmed, jadi datanya berbagi cache.
  const qs = {
    auto: useQuery({ queryKey: ["automation"], queryFn: () => api<Auto>("/api/cron"), refetchInterval: poll }),
    whatif: useQuery({ queryKey: ["wi-overview"], queryFn: () => api<YtOverview>("/api/whatif/overview"), refetchInterval: poll }),
    standup: useQuery({ queryKey: ["su-overview"], queryFn: () => api<YtOverview>("/api/standup/overview"), refetchInterval: poll }),
    ig: useQuery({ queryKey: ["sosmed-overview", "instagram", ""], queryFn: () => api<SosmedOverview>("/api/sosmed/overview?platform=instagram"), refetchInterval: poll }),
  };
  const auto = qs.auto.data;
  const now = auto?.minutes ?? 0;
  const rows: Row[] = auto
    ? [
        ...auto.timeline.map((r) => ({ ...r, kind: r.what })),
        ...whatifProductions(qs.whatif.data, now),
        ...ytUploads("Apa yang terjadi jika", qs.whatif.data, now),
        ...ytUploads("Gitgit Stand-up", qs.standup.data, now),
        ...metaPosts("Instagram", qs.ig.data),
      ].sort((a, b) => a.at.localeCompare(b.at) || a.channel.localeCompare(b.channel))
    : [];
  const shown = rows.filter((r) => show === "all" || (show === "bad" ? bad(r.status) : r.status === "waiting"));
  const done = rows.filter((r) => r.status !== "waiting" && r.status !== "running");
  const failed = rows.filter((r) => bad(r.status));
  const next = rows.find((r) => r.status === "waiting" && toMin(r.at) >= now);
  const periodic = auto?.periodic ?? [];
  const errors = Object.entries(qs).filter(([, q]) => q.error).map(([k, q]) => `${k}: ${q.error!.message}`);
  const nowIdx = shown.findIndex((r) => toMin(r.at) > now);
  const nowLabel = `${String(Math.floor(now / 60)).padStart(2, "0")}:${String(now % 60).padStart(2, "0")}`;

  return (
    <div className="flex flex-col gap-5">
      <ErrorNote>{errors.length ? `Sebagian sumber tidak terbaca: ${errors.join(" · ")}` : null}</ErrorNote>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard loading={!auto} label="Selesai hari ini" value={auto && `${done.length - failed.length}/${rows.length}`} detail={auto && `${rows.length - done.length} masih terjadwal/berjalan`} />
        <StatCard
          loading={!auto}
          label="Bermasalah hari ini"
          value={<span className={failed.length ? "text-destructive" : undefined}>{failed.length}</span>}
          detail={failed.length ? `terakhir ${failed[failed.length - 1].at} · ${failed[failed.length - 1].channel}` : "Semua lancar"}
        />
        <StatCard loading={!auto} label="Berikutnya" value={next?.at || "—"} detail={next ? `${next.channel} · ${next.kind}` : "Tidak ada lagi hari ini"} />
        <StatCard
          loading={!auto}
          label="Job berkala"
          value={auto && `${periodic.filter((p) => p.status === "ok").length}/${periodic.length}`}
          detail={periodic.some((p) => p.status === "failed") ? <span className="text-destructive">ada yang gagal</span> : "cron & timer systemd"}
        />
      </div>

      <Card className="gap-3">
        <CardHeader>
          <div>
            <CardTitle>Linimasa hari ini</CardTitle>
            <CardDescription className="mt-1.5">Semua produksi, riset, upload, dan posting otomatis lintas channel, diurutkan per jam (WIB)</CardDescription>
          </div>
          <CardAction>
            <RefreshButton busy={Object.values(qs).some((q) => q.isFetching)} onClick={() => Object.values(qs).forEach((q) => q.refetch())} />
          </CardAction>
        </CardHeader>
        <CardContent>
          <NativeSelect value={show} onChange={(e) => setShow(e.target.value as typeof show)} className="w-44">
            <option value="all">Semua ({rows.length})</option>
            <option value="bad">Bermasalah ({failed.length})</option>
            <option value="waiting">Terjadwal ({rows.filter((r) => r.status === "waiting").length})</option>
          </NativeSelect>
        </CardContent>
        <CardContent className="px-2 sm:px-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Jam</TableHead>
                <TableHead>Kegiatan</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Keterangan</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!auto && <TableEmpty cols={4}>Memuat…</TableEmpty>}
              {auto && !shown.length && <TableEmpty cols={4}>{show === "bad" ? "Tidak ada yang bermasalah hari ini." : "Tidak ada kegiatan."}</TableEmpty>}
              {shown.map((r, i) => (
                <Fragment key={`${r.at}-${r.channel}-${r.kind}-${i}`}>
                  {i === nowIdx && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={4} className="py-1 text-xs font-medium text-primary">
                        ── Sekarang {nowLabel} ──
                      </TableCell>
                    </TableRow>
                  )}
                  <TableRow className={bad(r.status) ? "bg-destructive/5" : undefined}>
                    <TableCell className="tabular align-top font-medium whitespace-nowrap">{r.at}</TableCell>
                    <TableCell className="align-top">
                      <span className="font-medium">{r.channel}</span>
                      <p className="text-xs text-muted-foreground">{r.kind}</p>
                    </TableCell>
                    <TableCell className="max-w-56 align-top">
                      <Badge variant={BADGE[r.status][1]}>{BADGE[r.status][0]}</Badge>
                      <div className="sm:hidden">{bad(r.status) ? <ErrText>{r.detail}</ErrText> : <p className="mt-1 truncate text-xs text-muted-foreground">{r.detail}</p>}</div>
                    </TableCell>
                    <TableCell className="hidden max-w-96 align-top sm:table-cell">
                      {bad(r.status) ? <ErrText>{r.detail}</ErrText> : <p className="truncate text-xs text-muted-foreground">{r.detail || "—"}</p>}
                    </TableCell>
                  </TableRow>
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <RolesCard active={active} />

      <Card className="gap-3">
        <CardHeader>
          <div>
            <CardTitle>Job berkala</CardTitle>
            <CardDescription className="mt-1.5">Job yang jalan sering atau mingguan: cron di server dan timer systemd</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="px-2 sm:px-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead className="hidden sm:table-cell">Jadwal</TableHead>
                <TableHead>Terakhir</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!auto && <TableEmpty cols={4}>Memuat…</TableEmpty>}
              {periodic.map((p) => (
                <TableRow key={p.name}>
                  <TableCell className="max-w-72 align-top">
                    <span className="font-medium">{p.name}</span>
                    <p className="text-xs text-muted-foreground">
                      {p.channel} · {p.source}
                      <span className="sm:hidden"> · {p.schedule}</span>
                    </p>
                  </TableCell>
                  <TableCell className="hidden align-top text-sm sm:table-cell">{p.schedule}</TableCell>
                  <TableCell className="tabular align-top whitespace-nowrap">{p.last ? fmtShort(p.last) : "—"}</TableCell>
                  <TableCell className="max-w-64 align-top">
                    <Badge variant={BADGE[p.status][1]}>{BADGE[p.status][0]}</Badge>
                    {p.status === "failed" && <ErrText>{p.detail}</ErrText>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

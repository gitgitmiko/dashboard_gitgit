import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Check, Clapperboard, Copy, Download, Play } from "lucide-react";
import { toast } from "sonner";
import { fmtMinSec } from "@/components/automation";
import { ErrorNote, RefreshButton } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BASE, api, postJson } from "@/lib/api";
import { fmtShort } from "@/lib/format";
import { cn } from "@/lib/utils";

type Episode = {
  id: string;
  series: string;
  ep: number;
  title: string;
  part_title: string;
  caption: string;
  seconds: number | null;
  size: number;
  created_at: string;
  uploaded_at: string | null;
};
type ParodiData = {
  episodes: Episode[];
  producing: { id: string; title: string; stalled?: boolean } | null;
  log: string[];
  schedule?: string[];
};

function copyText(text: string, what: string) {
  const ok = () => toast.success(`${what} disalin`);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(ok, () => fallbackCopy(text) && ok());
  } else if (fallbackCopy(text)) ok();
}

// Clipboard API butuh konteks aman; cadangan untuk browser lama/HP tertentu.
function fallbackCopy(text: string) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) toast.error("Gagal menyalin, salin manual dari kotak caption");
  return ok;
}

function EpisodeRow({ e, onChanged }: { e: Episode; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const video = `${BASE}/api/parodi/${e.id}/video`;
  const toggleUploaded = async () => {
    setBusy(true);
    try {
      await postJson(`/api/parodi/${e.id}/uploaded`, { uploaded: !e.uploaded_at });
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("flex flex-col gap-3 rounded-lg border p-3 sm:flex-row", e.uploaded_at && "opacity-70")}>
      <a href={video} target="_blank" rel="noreferrer" className="relative shrink-0 self-start" title="Putar video">
        <img src={`${BASE}/api/parodi/${e.id}/thumb`} alt="" loading="lazy" className="h-40 w-[90px] rounded-md object-cover" />
        <span className="absolute inset-0 grid place-items-center">
          <Play className="size-8 rounded-full bg-black/55 p-1.5 text-white" />
        </span>
      </a>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{e.title}</span>
          {e.uploaded_at ? <Badge variant="success">Sudah diunggah</Badge> : <Badge variant="warning">Belum diunggah</Badge>}
        </div>
        <div className="text-xs text-muted-foreground">
          {fmtMinSec(e.seconds == null ? null : Math.round(e.seconds))} · {(e.size / 1048576).toFixed(0)} MB · dibuat {fmtShort(e.created_at)}
          {e.uploaded_at && <> · diunggah {fmtShort(e.uploaded_at)}</>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <a href={`${video}?download=1`} download>
              <Download className="size-4" /> Unduh video
            </a>
          </Button>
          <Button size="sm" variant="outline" onClick={() => copyText(e.caption, "Caption")}>
            <Copy className="size-4" /> Salin caption
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? "Sembunyikan caption" : "Lihat caption"}
          </Button>
          <Button size="sm" variant={e.uploaded_at ? "ghost" : "secondary"} onClick={toggleUploaded} disabled={busy}>
            <Check className="size-4" /> {e.uploaded_at ? "Batalkan tanda" : "Tandai sudah diunggah"}
          </Button>
        </div>
        {open && (
          <textarea
            readOnly
            value={e.caption}
            onFocus={(ev) => ev.currentTarget.select()}
            className="min-h-40 w-full rounded-md border bg-muted/40 p-2 font-mono text-xs"
          />
        )}
      </div>
    </div>
  );
}

export function ParodiManual({ active }: { active: boolean }) {
  const q = useQuery({
    queryKey: ["parodi"],
    queryFn: () => api<ParodiData>("/api/parodi"),
    refetchInterval: active ? 30000 : false,
  });
  const d = q.data;
  const pending = d?.episodes.filter((e) => !e.uploaded_at).length ?? 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clapperboard className="size-4" /> Konten Reels untuk FB Pro (unggah manual)
        </CardTitle>
        <CardDescription>
          Video parodi anime dibuat otomatis {d?.schedule ? `setiap hari pukul ${d.schedule.join(" & ")} WIB` : "2x sehari"}.
          Facebook tidak mengizinkan posting otomatis ke profil pribadi, jadi unduh video + salin caption lalu unggah
          sebagai Reel dari aplikasi Facebook.
          {d && ` ${pending} video menunggu diunggah.`}
        </CardDescription>
        <CardAction>
          <RefreshButton onClick={() => q.refetch()} busy={q.isFetching} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {q.error && <ErrorNote>{(q.error as Error).message}</ErrorNote>}
        {d?.producing && (
          <div className="rounded-md border border-dashed p-2 text-sm text-muted-foreground">
            {d.producing.stalled ? "Produksi terakhir belum selesai/gagal: " : "Sedang diproduksi: "}
            <span className="font-medium text-foreground">{d.producing.title}</span>
          </div>
        )}
        {d && d.episodes.length === 0 && <p className="text-sm text-muted-foreground">Belum ada video yang selesai.</p>}
        {d?.episodes.map((e) => <EpisodeRow key={e.id} e={e} onChanged={() => q.refetch()} />)}
        {d && d.log.length > 0 && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Log produksi</summary>
            <pre className="mt-1 whitespace-pre-wrap">{d.log.join("\n")}</pre>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

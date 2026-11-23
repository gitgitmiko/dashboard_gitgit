import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ErrorNote, RefreshButton } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { BASE, api } from "@/lib/api";

// TikTok via GitGit Studio (TikTok for Developers app). Every post is reviewed and confirmed here, following TikTok's
// Content Sharing Guidelines for Direct Post: the creator's nickname, a preview, an editable caption, a privacy level
// picked by hand from the creator's own options, interaction settings off by default, commercial-content disclosure
// and the Music Usage Confirmation notice.

type Creator = {
  creator_nickname?: string; creator_username?: string; creator_avatar_url?: string;
  privacy_level_options?: string[]; comment_disabled?: boolean; duet_disabled?: boolean; stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
};
type Post = { publish_id: string; status: string; privacy_level: string; at: string; fail_reason?: string | null; post_ids?: string[] };
type Item = { id: string; title: string; format: string; size: number; caption: string; post: Post | null; scheduled: string | null };
type Status = {
  configured: boolean; connected: boolean; user: { display_name?: string; avatar_url?: string } | null;
  creator?: Creator | null; creatorError?: string | null; queue: Item[];
  slots?: string[]; dailyCap?: number; nextSlot?: string | null;
};

const when = (iso: string) => new Date(iso).toLocaleString("id-ID", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" }) + " WIB";

const PRIVACY: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Publik (semua orang)", MUTUAL_FOLLOW_FRIENDS: "Teman (saling mengikuti)",
  FOLLOWER_OF_CREATOR: "Pengikut", SELF_ONLY: "Hanya saya (privat)",
};
const STATUS: Record<string, [string, "success" | "warning" | "destructive" | "secondary"]> = {
  PROCESSING_UPLOAD: ["Mengunggah", "warning"], PROCESSING_DOWNLOAD: ["Diproses", "warning"],
  SEND_TO_USER_INBOX: ["Di inbox", "secondary"], PUBLISH_COMPLETE: ["Terposting", "success"], FAILED: ["Gagal", "destructive"],
};

function Composer({ item, creator, nextSlot, onDone }: { item: Item; creator: Creator; nextSlot?: string | null; onDone: () => void }) {
  const [title, setTitle] = useState(item.caption);
  const [privacy, setPrivacy] = useState("");
  const [allow, setAllow] = useState({ comment: false, duet: false, stitch: false });
  const [disclose, setDisclose] = useState(false);
  const [brand, setBrand] = useState({ own: false, paid: false });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const paidPrivate = disclose && brand.paid && privacy === "SELF_ONLY";
  const ready = privacy && !paidPrivate && (!disclose || brand.own || brand.paid) && !busy;
  const post = async (mode: "publish" | "schedule") => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ at?: string }>(`/api/tiktok/${mode}/${item.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, privacy_level: privacy, allow_comment: allow.comment, allow_duet: allow.duet, allow_stitch: allow.stitch,
          brand_organic: disclose && brand.own, brand_content: disclose && brand.paid }),
      });
      setMsg(mode === "publish" ? "Terkirim ke TikTok. Video sedang diproses dan biasanya muncul di profil dalam beberapa menit."
        : `Disetujui. Akan diposting ${r.at ? when(r.at) : "di slot berikutnya"}.`);
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const box = (key: "comment" | "duet" | "stitch", label: string, off?: boolean) => (
    <label className={`flex items-center gap-2 text-sm ${off ? "opacity-50" : ""}`}>
      <input type="checkbox" disabled={off} checked={!off && allow[key]} onChange={(e) => setAllow({ ...allow, [key]: e.target.checked })} />
      {label}{off && " (dimatikan di akun)"}
    </label>
  );
  return (
    <div className="grid min-w-0 gap-4 sm:grid-cols-[220px_minmax(0,1fr)]">
      <video src={`${BASE}/api/tiktok/video/${item.id}`} controls playsInline preload="metadata" className="aspect-[9/16] w-full max-w-[220px] rounded-lg bg-black" />
      <div className="flex min-w-0 flex-col gap-3">
        <p className="text-sm text-muted-foreground">Diposting ke <span className="font-medium text-foreground">{creator.creator_nickname || creator.creator_username}</span></p>
        <label className="text-sm font-medium">Caption
          <textarea value={title} maxLength={2200} onChange={(e) => setTitle(e.target.value)} rows={4}
            className="mt-1 w-full rounded-md border bg-background p-2 text-sm font-normal" />
        </label>
        <label className="text-sm font-medium">Siapa yang bisa menonton video ini
          <NativeSelect value={privacy} onChange={(e) => setPrivacy(e.target.value)} className="mt-1 w-full">
            <option value="" disabled>Pilih privasi…</option>
            {(creator.privacy_level_options ?? []).map((p) => <option key={p} value={p}>{PRIVACY[p] ?? p}</option>)}
          </NativeSelect>
        </label>
        <div className="flex flex-wrap gap-4">
          {box("comment", "Izinkan komentar", creator.comment_disabled)}
          {box("duet", "Izinkan Duet", creator.duet_disabled)}
          {box("stitch", "Izinkan Stitch", creator.stitch_disabled)}
        </div>
        <div className="rounded-md border p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={disclose} onChange={(e) => setDisclose(e.target.checked)} /> Ungkapkan konten video (konten komersial)
          </label>
          {disclose && (
            <div className="mt-2 flex flex-col gap-1.5 pl-6 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={brand.own} onChange={(e) => setBrand({ ...brand, own: e.target.checked })} /> Merek Anda sendiri</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={brand.paid} onChange={(e) => setBrand({ ...brand, paid: e.target.checked })} /> Konten bermerek (kerja sama berbayar)</label>
              <p className="text-xs text-muted-foreground">
                {brand.paid ? "Video akan diberi label \"Paid partnership\"." : brand.own ? "Video akan diberi label \"Promotional content\"." : "Pilih minimal satu."}
              </p>
              {paidPrivate && <p className="text-xs text-destructive">Konten bermerek tidak bisa berstatus "Hanya saya".</p>}
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Dengan memposting, Anda menyetujui{" "}
          {disclose && brand.paid && <><a className="underline" href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noopener">Kebijakan Konten Bermerek</a> dan </>}
          <a className="underline" href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener">Konfirmasi Penggunaan Musik</a> TikTok.
        </p>
        <div className="flex flex-col items-start gap-2">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => post("publish")} disabled={!ready}>{busy ? "Mengirim…" : "Posting sekarang"}</Button>
            <Button variant="outline" onClick={() => post("schedule")} disabled={!ready || !nextSlot}>Jadwalkan{nextSlot ? ` (${when(nextSlot)})` : ""}</Button>
          </div>
          {msg && <span className="text-sm break-words text-muted-foreground [overflow-wrap:anywhere]">{msg}</span>}
        </div>
      </div>
    </div>
  );
}

export function TikTok({ active }: { active: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["tiktok"], queryFn: () => api<Status>("/api/tiktok"), refetchInterval: active ? 30000 : false });
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tiktok");
    if (t) {
      setNote(t === "ok" ? "Akun TikTok berhasil dihubungkan." : t);
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    }
  }, []);
  const d = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ["tiktok"] });
  const check = async (id: string) => {
    try { await api(`/api/tiktok/status/${id}`, { method: "POST" }); } finally { refresh(); }
  };
  const c = d?.creator;
  return (
    <div className="flex flex-col gap-5">
      <ErrorNote>{q.error?.message || d?.creatorError}</ErrorNote>
      {note && <p className="rounded-md border bg-card p-3 text-sm">{note}</p>}
      <Card className="gap-3">
        <CardHeader>
          <div className="flex min-w-0 items-center gap-3">
            {c?.creator_avatar_url && <img src={c.creator_avatar_url} alt="" className="size-10 rounded-full" />}
            <div className="min-w-0">
              <CardTitle className="truncate">{d?.connected ? (c?.creator_nickname || d.user?.display_name || "Akun TikTok") : "Akun TikTok"}</CardTitle>
              <CardDescription className="mt-1">
                {!d ? "Memuat…" : !d.configured ? "Client key TikTok belum di-set di server." : d.connected
                  ? `@${c?.creator_username ?? ""} · terhubung lewat GitGit Studio` : "Belum terhubung. Hubungkan akun TikTok yang akan diisi video."}
              </CardDescription>
            </div>
          </div>
          <CardAction className="flex gap-2">
            {d?.connected
              ? <Button variant="outline" size="sm" onClick={async () => { await api("/api/tiktok/disconnect", { method: "POST" }); refresh(); }}>Putuskan</Button>
              : d?.configured && <Button size="sm" asChild><a href={`${BASE}/api/tiktok/login`}>Login with TikTok</a></Button>}
            <RefreshButton busy={q.isFetching} onClick={refresh} />
          </CardAction>
        </CardHeader>
        {d?.connected && (
          <CardContent className="text-xs text-muted-foreground">
            Jadwal {d.slots?.join(", ")} WIB · maks {d.dailyCap} posting/hari{d.dailyCap === 1 ? " (akun baru, 14 hari pertama)" : ""}
            {d.nextSlot && ` · slot kosong berikutnya ${when(d.nextSlot)}`}
            {c?.max_video_post_duration_sec ? ` · durasi maks ${Math.floor(c.max_video_post_duration_sec / 60)} menit` : ""}
          </CardContent>
        )}
      </Card>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Video siap diposting</h2>
        <div className="flex flex-col gap-3">
          {d?.queue.map((it) => {
            const st = it.post ? STATUS[it.post.status] ?? [it.post.status, "secondary"] : null;
            return (
              <Card key={it.id} className="gap-3">
                <CardHeader>
                  <div className="min-w-0">
                    <CardTitle className="truncate">{it.title}</CardTitle>
                    <CardDescription className="mt-1">{it.id.slice(0, 8)} · {it.format} · {(it.size / 1048576).toFixed(1)} MB
                      {it.post && ` · ${PRIVACY[it.post.privacy_level] ?? it.post.privacy_level}`}</CardDescription>
                  </div>
                  <CardAction className="flex items-center gap-2">
                    {st && <Badge variant={st[1]}>{st[0]}</Badge>}
                    {it.scheduled && <><Badge variant="warning">Terjadwal {when(it.scheduled)}</Badge>
                      <Button variant="outline" size="sm" onClick={async () => { await api(`/api/tiktok/unschedule/${it.id}`, { method: "POST" }); refresh(); }}>Batal</Button></>}
                    {it.post && it.post.status !== "PUBLISH_COMPLETE" && it.post.status !== "FAILED" &&
                      <Button variant="outline" size="sm" onClick={() => check(it.id)}>Cek status</Button>}
                    {d.connected && c && <Button variant={open === it.id ? "secondary" : "outline"} size="sm" onClick={() => setOpen(open === it.id ? null : it.id)}>
                      {open === it.id ? "Tutup" : it.post ? "Posting lagi" : "Tinjau & posting"}</Button>}
                  </CardAction>
                </CardHeader>
                {it.post?.fail_reason && <CardContent className="text-sm text-destructive">Gagal: {it.post.fail_reason}</CardContent>}
                {open === it.id && c && <CardContent><Composer item={it} creator={c} nextSlot={d.nextSlot} onDone={refresh} /></CardContent>}
              </Card>
            );
          })}
          {d && !d.queue.length && <p className="text-sm text-muted-foreground">Belum ada video.</p>}
        </div>
      </div>
    </div>
  );
}

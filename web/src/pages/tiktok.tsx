import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { CalendarClock, ExternalLink, Globe, Lock, Music2, RefreshCw, Repeat, Send, Unplug, X } from "lucide-react";
import { DateFilter, ExtLink, PostBadge, fmtDayLong } from "@/components/automation";
import { ErrorNote, LogView, PageSizeSelect, Pager, RefreshButton, StatCard } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BASE, api } from "@/lib/api";
import { fmtShort } from "@/lib/format";

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

// WIB "YYYY-MM-DD HH:MM:SS"; TikTok menyimpan semua waktunya dalam ISO UTC.
const wib = (iso: string) => new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" });
const hhmmMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const logTone = (l: string) => (/gagal|error/i.test(l) ? "err" : /diposting|dijadwalkan|dihubungkan|diunggah/.test(l) ? "ok" : "");

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

// Id video diawali tanggal (YYYYMMDD); tampilkan sebagai tanggal biasa kalau cocok.
const idDate = (id: string) => {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(id);
  if (!m) return id.slice(0, 8);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(d.getTime()) ? id.slice(0, 8) : d.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

function VideoRow({ it, d, open, setOpen, refresh }: { it: Item; d: Status; open: boolean; setOpen: (v: boolean) => void; refresh: () => void }) {
  const c = d.creator;
  const st = it.post ? STATUS[it.post.status] ?? [it.post.status, "secondary"] : null;
  const pending = it.post && it.post.status !== "PUBLISH_COMPLETE" && it.post.status !== "FAILED";
  const postId = it.post?.post_ids?.[0];
  const check = async () => {
    try { await api(`/api/tiktok/status/${it.id}`, { method: "POST" }); } finally { refresh(); }
  };
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex gap-3 p-3 sm:p-4">
        <video src={`${BASE}/api/tiktok/video/${it.id}#t=0.5`} preload="metadata" muted playsInline tabIndex={-1}
          className="pointer-events-none aspect-[9/16] w-14 shrink-0 rounded-md bg-black object-cover sm:w-16" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="line-clamp-2 leading-snug font-semibold">{it.title}</div>
          <div className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
            <span>{idDate(it.id)}</span><span>·</span><span>{it.format}</span><span>·</span><span>{(it.size / 1048576).toFixed(1)} MB</span>
          </div>
          <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
            {it.scheduled && <Badge variant="warning"><CalendarClock /> {when(it.scheduled)}</Badge>}
            {st && <Badge variant={st[1]}>{st[0]}</Badge>}
            {it.post && <Badge variant="outline">{it.post.privacy_level === "SELF_ONLY" ? <Lock /> : <Globe />}{PRIVACY[it.post.privacy_level] ?? it.post.privacy_level}</Badge>}
            {!it.post && !it.scheduled && <Badge variant="outline">Belum diposting</Badge>}
          </div>
        </div>
      </div>
      {it.post?.fail_reason && <p className="mx-3 mb-3 rounded-md bg-destructive/10 p-2 text-sm text-destructive sm:mx-4">Gagal: {it.post.fail_reason}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-muted/20 px-3 py-2 sm:px-4">
        {postId && c?.creator_username && (
          <Button variant="ghost" size="sm" asChild className="mr-auto">
            <a href={`https://www.tiktok.com/@${c.creator_username}/video/${postId}`} target="_blank" rel="noopener"><ExternalLink /> Lihat di TikTok</a>
          </Button>
        )}
        {it.scheduled && <Button variant="ghost" size="sm" onClick={async () => { await api(`/api/tiktok/unschedule/${it.id}`, { method: "POST" }); refresh(); }}>Batalkan jadwal</Button>}
        {pending && <Button variant="outline" size="sm" onClick={check}><RefreshCw /> Cek status</Button>}
        {d.connected && c && (
          <Button variant={open ? "secondary" : it.post || it.scheduled ? "outline" : "default"} size="sm" onClick={() => setOpen(!open)}>
            {open ? <><X /> Tutup</> : it.post ? <><Repeat /> Posting lagi</> : <><Send /> Tinjau & posting</>}
          </Button>
        )}
      </div>
      {open && c && <div className="border-t p-3 sm:p-4"><Composer item={it} creator={c} nextSlot={d.nextSlot} onDone={refresh} /></div>}
    </Card>
  );
}

export function TikTok({ active }: { active: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["tiktok"], queryFn: () => api<Status>("/api/tiktok"), refetchInterval: active ? 30000 : false });
  const logs = useQuery({ queryKey: ["tiktok-logs"], queryFn: () => api<{ lines: string[] }>("/api/tiktok/logs?lines=200"), refetchInterval: active ? 60000 : false });
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [date, setDate] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const filter = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tiktok");
    if (t) {
      setNote(t === "ok" ? "Akun TikTok berhasil dihubungkan." : t);
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    }
  }, []);
  const d = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ["tiktok"] });
  const disconnect = async () => {
    if (!window.confirm("Putuskan akun TikTok? Video terjadwal tidak akan diposting sampai akun dihubungkan lagi.")) return;
    await api("/api/tiktok/disconnect", { method: "POST" });
    refresh();
  };
  const c = d?.creator;
  const name = d?.connected ? (c?.creator_nickname || d.user?.display_name || "Akun TikTok") : "Akun TikTok";
  const avatar = c?.creator_avatar_url || d?.user?.avatar_url;
  const queue = d?.queue ?? [];
  const review = queue.filter((it) => !it.post && !it.scheduled);
  const posted = queue.filter((it) => it.post && !it.scheduled);
  // Riwayat seperti tab YouTube: terbaru dulu (id diawali YYYYMMDD), disaring status/tanggal lalu dipaginasi.
  const statusOf = (it: Item) => (it.scheduled ? "scheduled" : !it.post ? "review" : it.post.status === "FAILED" ? "failed" : "posted");
  const list = queue
    .filter((it) => (!status || statusOf(it) === status) && (!date || it.id.startsWith(date.replaceAll("-", ""))))
    .sort((a, b) => b.id.localeCompare(a.id));
  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  const curPage = Math.min(page, totalPages);
  const shown = list.slice((curPage - 1) * pageSize, curPage * pageSize);

  // Statistik harian/mingguan dihitung dari waktu posting menurut WIB, bukan UTC.
  const nowWib = wib(new Date().toISOString());
  const today = nowWib.slice(0, 10);
  const dayOf = (iso?: string | null) => (iso ? wib(iso).slice(0, 10) : "");
  const weekAgo = wib(new Date(Date.now() - 6 * 864e5).toISOString()).slice(0, 10);
  const postedToday = posted.filter((it) => dayOf(it.post?.at) === today);
  const posted7 = posted.filter((it) => dayOf(it.post?.at) >= weekAgo);
  const failed7 = posted7.filter((it) => it.post!.status === "FAILED");
  const lastPosted = [...posted].sort((a, b) => String(b.post?.at).localeCompare(String(a.post?.at)))[0];
  const postUrl = (it?: Item | null) => (c?.creator_username && it?.post?.post_ids?.[0] ? `https://www.tiktok.com/@${c.creator_username}/video/${it.post.post_ids[0]}` : null);
  // Tiap slot menampung video yang dijadwalkan atau sudah terposting di rentang 20 menit pertama slot itu.
  const slotRows = (d?.slots ?? []).map((t) => {
    const from = hhmmMin(t);
    const hit = (iso?: string | null) => {
      if (!iso) return false;
      const w = wib(iso);
      const m = hhmmMin(w.slice(11, 16));
      return w.slice(0, 10) === today && m >= from && m < from + 20;
    };
    const done = queue.find((it) => hit(it.post?.at));
    const planned = queue.find((it) => hit(it.scheduled));
    const item = done || planned;
    const status = done ? (done.post!.status === "FAILED" ? "failed" : "posted") : planned ? "prepared" : hhmmMin(nowWib.slice(11, 16)) >= from + 20 ? "missed" : "waiting";
    return { slot: t, status, item };
  });
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <ErrorNote>{q.error?.message || d?.creatorError}</ErrorNote>
      {note && <p className="rounded-md border bg-card p-3 text-sm">{note}</p>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard loading={!d} label="Terposting hari ini" value={d && `${postedToday.length}/${d.dailyCap ?? "—"}`} detail={d && `${review.length} perlu ditinjau`} />
        <StatCard
          loading={!d}
          label="Gagal (7 hari)"
          value={<span className={failed7.length ? "text-destructive" : undefined}>{failed7.length}</span>}
          detail={d && `${posted7.length} terposting · 7 hari terakhir`}
        />
        <StatCard
          loading={!d}
          label="Posting berikutnya"
          value={d?.nextSlot ? wib(d.nextSlot).slice(11, 16) : "Penuh"}
          detail={d?.nextSlot ? `${fmtDayLong(d.nextSlot)} · batas ${d.dailyCap}/hari` : `Slot ${d?.slots?.join(" · ") ?? "-"} WIB`}
        />
        <StatCard
          loading={!d}
          label="Video terakhir"
          value={lastPosted ? (postUrl(lastPosted) ? <ExtLink href={postUrl(lastPosted)} className="text-xl sm:text-2xl">{fmtShort(lastPosted.post!.at)}</ExtLink> : fmtShort(lastPosted.post!.at)) : "—"}
          detail={lastPosted ? lastPosted.title : "Belum ada video terposting"}
        />
      </div>

      <Card className="gap-3">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Jadwal hari ini · TikTok</CardTitle>
            <CardDescription className="mt-1.5">
              Slot {d?.slots?.join(" · ") ?? "-"} WIB · batas {d?.dailyCap ?? "—"} posting/hari
              {c?.max_video_post_duration_sec ? ` · durasi maks ${Math.floor(c.max_video_post_duration_sec / 60)} menit` : ""} · tiap posting ditinjau sebelum dikirim
            </CardDescription>
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-sm">
              {avatar
                ? <img src={avatar} alt="" className="size-7 shrink-0 rounded-full object-cover ring-2 ring-border" />
                : <div className="grid size-7 shrink-0 place-items-center rounded-full bg-muted"><Music2 className="size-3.5 text-muted-foreground" /></div>}
              <span className="truncate font-medium">{name}</span>
              {d?.connected && <Badge variant="success">Terhubung</Badge>}
              <span className="truncate text-xs text-muted-foreground">
                {!d ? "Memuat…" : !d.configured ? "Client key TikTok belum di-set di server." : d.connected ? `@${c?.creator_username ?? ""} · via GitGit Studio` : "Belum terhubung"}
              </span>
            </div>
          </div>
          <CardAction>
            <RefreshButton busy={q.isFetching} onClick={refresh} />
            {d?.connected ? (
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={disconnect}>
                <Unplug /> Putuskan akun
              </Button>
            ) : d?.configured ? (
              <Button size="sm" asChild><a href={`${BASE}/api/tiktok/login`}>Login with TikTok</a></Button>
            ) : null}
          </CardAction>
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
              {d && !d.connected && <TableEmpty cols={4}>Hubungkan akun TikTok untuk melihat jadwal hari ini.</TableEmpty>}
              {d?.connected && !slotRows.length && <TableEmpty cols={4}>Tidak ada jadwal hari ini</TableEmpty>}
              {d?.connected && slotRows.map(({ slot, status, item }) => (
                <TableRow key={slot}>
                  <TableCell className="align-top whitespace-nowrap">
                    <span className="tabular font-medium">{slot}</span>
                  </TableCell>
                  <TableCell className="tabular align-top">{item ? idDate(item.id).replace(/ \d{4}$/, "") : "—"}</TableCell>
                  <TableCell className="align-top">
                    <PostBadge status={status} />
                    <div className="mt-1.5 sm:hidden">
                      <ExtLink href={postUrl(item)}>{postUrl(item) ? "Tonton" : "Lihat"}</ExtLink>
                    </div>
                  </TableCell>
                  <TableCell className="hidden max-w-80 align-top sm:table-cell">
                    {item ? (
                      <>
                        <ExtLink href={postUrl(item)}>{postUrl(item) ? "Tonton" : "Lihat"}</ExtLink>
                        <p className="truncate text-xs text-muted-foreground">{item.title}</p>
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
            <RefreshButton busy={q.isFetching} onClick={refresh} />
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <NativeSelect value={status} onChange={(e) => filter(setStatus)(e.target.value)} className="w-40">
            <option value="">Semua status</option>
            <option value="review">Perlu ditinjau</option>
            <option value="scheduled">Terjadwal</option>
            <option value="posted">Terposting</option>
            <option value="failed">Gagal</option>
          </NativeSelect>
          <DateFilter value={date} onChange={filter(setDate)} />
          <div className="ml-auto">
            <PageSizeSelect value={pageSize} onChange={filter(setPageSize)} />
          </div>
        </CardContent>
        <CardContent className="flex min-w-0 flex-col gap-3">
          {shown.map((it) => (
            <VideoRow key={it.id} it={it} d={d!} open={open === it.id} setOpen={(v) => setOpen(v ? it.id : null)} refresh={refresh} />
          ))}
          {d && !list.length && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Belum ada video.</p>}
          {!d && !q.error && <div className="h-40 animate-pulse rounded-xl border bg-muted/30" />}
        </CardContent>
        {d && <Pager page={curPage} totalPages={totalPages} onPage={setPage} info={` · ${list.length} video`} />}
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

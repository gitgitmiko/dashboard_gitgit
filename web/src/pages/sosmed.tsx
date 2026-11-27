import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Camera, Drama, Gamepad2, Clapperboard, Mic, SquarePlay } from "lucide-react";
import { DateFilter, ErrText, ExtLink, PostBadge, PreviewLink, publicPreviewUrl, Thumb } from "@/components/automation";
import { SubTabs, type SubTabDef } from "@/components/subtabs";
import { IdeasCard } from "@/components/ideas";
import { ErrorNote, LogView, PageSizeSelect, Pager, RefreshButton, StatCard } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, qs } from "@/lib/api";
import { fmtShort } from "@/lib/format";
import { Whatif } from "@/pages/whatif";
import { Standup } from "@/pages/standup";

type Slot = {
  time: string;
  kind: string;
  label?: string;
  past: boolean;
  // Video duo yang sudah diproduksi (outbox nostalgia-reels) dan diperkirakan mengisi slot ini.
  forecast?: { run: string; title?: string | null; created?: string | null; seconds?: number | null } | null;
  platforms: {
    platform: string;
    status: string | null;
    permalink: string | null;
    error: string | null;
    title?: string | null;
    image_url?: string | null;
    created_at?: string | null;
  }[];
};
type Account = { key: string; category: string; brand_name: string; handle: string; enabled: boolean; connected: boolean; platforms: string[]; schedule: Slot[] };
type Post = {
  id: number;
  account: string;
  slot: string;
  platform: string;
  kind: string;
  label?: string;
  status: string;
  attempts: number;
  title: string;
  image_url: string | null;
  permalink: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};
export type Overview = {
  today: { posted: number; failed: number; skipped: number };
  week: { posted: number; failed: number; skipped: number };
  next: { at: string; account: string; kind: string; label?: string } | null;
  last: Post | null;
  accounts: Account[];
};
type Posts = { posts: Post[]; total: number; page: number; totalPages: number };

const KIND: Record<string, string> = { news: "Berita", steam_deals: "Promo Steam", recap_saham: "Rekap saham", recap_crypto: "Rekap crypto" };
// Menit sejak tengah malam WIB; jadwal di overview selalu untuk hari ini (WIB).
const wibMinutes = () => {
  const [h, m] = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Jakarta" }).split(":").map(Number);
  return h * 60 + m;
};
// Slot lewat tanpa catatan sama sekali berarti tidak pernah dipicu (mis. jadwal n8n tidak termuat), bukan dilewati
// oleh scraper; beri jeda 10 menit karena posting biasanya baru tercatat semenit-dua setelah jam slot.
export const slotStatus = (s: Slot) => {
  if (!s.past) return "waiting";
  const [h, m] = s.time.split(":").map(Number);
  return Number.isNaN(h) || wibMinutes() - (h * 60 + (m || 0)) >= 10 ? "missed" : "prepared";
};
export const kindLabel = (x: { label?: string; kind: string }) => x.label || KIND[x.kind] || x.kind;
const logTone = (l: string) => (/gagal|error|traceback/i.test(l) ? "err" : /posted|siap|diperbarui/.test(l) ? "ok" : "");
// Tanggal produksi video outbox (mis. "2026-11-24") ditampilkan pendek, sejajar jam produksi konten.
const fmtDay = (d?: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("id-ID", { day: "numeric", month: "short" }) : "—");

// Satu kartu jadwal seperti tab YouTube; kolom Akun hanya muncul bila ada lebih dari satu akun.
function ScheduleCard({ title, accounts }: { title: string; accounts: Account[] }) {
  const duo = accounts.some((a) => a.schedule.some((s) => s.kind === "duo_reel"));
  const many = accounts.length > 1;
  const state = (a: Account) =>
    !a.enabled ? <Badge variant="outline">Nonaktif</Badge> : !a.connected ? <Badge variant="destructive">Belum terhubung</Badge> : <Badge variant="success">Aktif</Badge>;
  const rows = accounts.flatMap((a) => a.schedule.map((s) => ({ a, s })));
  return (
    <Card className="gap-3">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>Jadwal hari ini · {title}</CardTitle>
          <CardDescription className="mt-1.5">
            {accounts.map((a) => `${a.brand_name} (${a.handle || a.key}) · kategori ${a.category}`).join(" · ")} ·{" "}
            {duo
              ? "produksi video 5x sehari (23:30, 01:30, 03:30, 05:30, 07:30 WIB) ke outbox nostalgia-reels, diunggah n8n saat slot"
              : "konten dibuat scraper saat slot, diunggah n8n"}
          </CardDescription>
        </div>
        {!many && accounts[0] && <CardAction>{state(accounts[0])}</CardAction>}
      </CardHeader>
      <CardContent className="px-2 sm:px-3">
        <Table>
          <TableHeader>
            <TableRow>
              {many && <TableHead className="hidden sm:table-cell">Akun</TableHead>}
              <TableHead>Upload</TableHead>
              <TableHead>Produksi</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden sm:table-cell">Konten</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!rows.length && <TableEmpty cols={many ? 5 : 4}>Tidak ada jadwal hari ini</TableEmpty>}
            {rows.map(({ a, s }) => {
              // Konten yang sudah diproduksi (baris postingan) menampilkan judulnya; slot yang belum
              // jalan memakai perkiraan video outbox yang bisa dipratinjau.
              const post = s.platforms.find((p) => p.status === "posted") || s.platforms.find((p) => p.created_at);
              const content = post?.title || s.forecast?.title || kindLabel(s);
              const link = post?.permalink || post?.image_url || null;
              const preview = s.forecast ? publicPreviewUrl(`/preview/duo/${s.forecast.run}.mp4`) : null;
              const produce = post?.created_at ? fmtShort(post.created_at).slice(-5).replace(".", ":") : s.forecast ? fmtDay(s.forecast.created) : s.past ? "—" : "saat slot";
              const err = s.platforms.find((p) => p.error)?.error || (!s.platforms.some((p) => p.status) && slotStatus(s) === "missed" ? "Slot tidak dipicu oleh n8n" : null);
              return (
                <TableRow key={`${a.key}-${s.time}-${s.kind}`}>
                  {many && (
                    <TableCell className="hidden align-top sm:table-cell">
                      <span className="text-sm">{a.handle || a.key}</span>
                    </TableCell>
                  )}
                  <TableCell className="align-top whitespace-nowrap">
                    <span className="tabular font-medium">{s.time}</span>
                  </TableCell>
                  <TableCell className="tabular align-top text-muted-foreground">{produce}</TableCell>
                  <TableCell className="max-w-56 min-w-24 align-top">
                    <p className="text-xs text-muted-foreground sm:hidden">{many ? `${a.handle || a.key} · ` : ""}{kindLabel(s)}</p>
                    {s.platforms.map((p) => (
                      <div key={p.platform} className="flex flex-wrap items-center gap-1.5">
                        {s.platforms.length > 1 && <span className="text-xs text-muted-foreground">{p.platform.replace(/_reel$/, " Reel")}</span>}
                        <PostBadge status={p.status || slotStatus(s)} />
                        <ExtLink href={p.permalink} />
                      </div>
                    ))}
                    <ErrText>{err}</ErrText>
                    <div className="mt-1.5 sm:hidden">
                      <ExtLink href={link}>Tonton</ExtLink>
                      <PreviewLink href={preview} />
                    </div>
                  </TableCell>
                  <TableCell className="hidden max-w-80 align-top sm:table-cell">
                    <ExtLink href={link}>{post?.permalink ? "Tonton" : "Lihat"}</ExtLink>
                    <p className="truncate text-xs text-muted-foreground">{content === kindLabel(s) ? content : `${kindLabel(s)} · ${content}`}</p>
                    <PreviewLink href={preview} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** Posting otomatis satu platform Meta (Instagram/Facebook) dari scraper-social-api. `account` mengunci satu akun (sub-tab per konten). */
function MetaPosts({ platform, account: fixedAccount, title, active }: { platform: string; account?: string; title: string; active: boolean }) {
  const [accountPick, setAccountPick] = useState("");
  const account = fixedAccount || accountPick;
  const [status, setStatus] = useState("");
  const [date, setDate] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const filter = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  const poll = active ? 30000 : false;
  const ov = useQuery({ queryKey: ["sosmed-overview", platform, account], queryFn: () => api<Overview>(`/api/sosmed/overview${qs({ platform, account })}`), refetchInterval: poll });
  const posts = useQuery({
    queryKey: ["sosmed-posts", platform, account, status, date, page, pageSize],
    queryFn: () => api<Posts>(`/api/sosmed/posts${qs({ page, pageSize, platform, account, status, date })}`),
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });
  const logs = useQuery({
    queryKey: ["sosmed-logs", fixedAccount || ""],
    queryFn: () => api<{ lines: string[] }>(`/api/sosmed/logs?lines=200${fixedAccount ? `&account=${fixedAccount}` : ""}`),
    enabled: active,
    refetchInterval: poll,
  });
  const d = ov.data;
  const planned = d?.accounts.reduce((n, a) => n + a.schedule.length, 0) ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <ErrorNote>{ov.error?.message || posts.error?.message}</ErrorNote>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard loading={!d} label="Terposting hari ini" value={d && `${d.today.posted}/${planned}`} detail={d && `${d.today.failed} gagal · ${d.today.skipped} dilewati`} />
        <StatCard
          loading={!d}
          label="Gagal (7 hari)"
          value={<span className={d?.week.failed ? "text-destructive" : undefined}>{d?.week.failed}</span>}
          detail={d && `${d.week.posted} terposting · ${d.week.skipped} dilewati`}
        />
        <StatCard loading={!d} label="Posting berikutnya" value={d?.next ? d.next.at.slice(11, 16) : "—"} detail={d && (d.next ? `${d.next.account} · ${kindLabel(d.next)}` : "Tidak ada lagi hari ini")} />
        <StatCard
          loading={!d}
          label="Posting terakhir"
          value={d?.last ? (d.last.permalink ? <ExtLink href={d.last.permalink} className="text-xl sm:text-2xl">{fmtShort(d.last.updated_at)}</ExtLink> : fmtShort(d.last.updated_at)) : "—"}
          detail={d && (d.last ? `${d.last.account} · ${(d.last.title || "").slice(0, 60)}` : "Belum ada posting")}
        />
      </div>

      {!d && !ov.error && <div className="h-60 animate-pulse rounded-xl border bg-card" />}
      {d && <ScheduleCard title={title} accounts={d.accounts} />}
      {fixedAccount === "kaiara" && <IdeasCard channel="kaiara" active={active} />}

      <Card className="gap-3 pb-3">
        <CardHeader>
          <CardTitle>Riwayat posting</CardTitle>
          <CardAction>
            <RefreshButton
              busy={posts.isFetching || ov.isFetching}
              onClick={() => {
                ov.refetch();
                posts.refetch();
                logs.refetch();
              }}
            />
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          {!fixedAccount && (
            <NativeSelect value={accountPick} onChange={(e) => filter(setAccountPick)(e.target.value)} className="w-40">
              <option value="">Semua akun</option>
              {d?.accounts.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.handle || a.key}
                </option>
              ))}
            </NativeSelect>
          )}
          <NativeSelect value={status} onChange={(e) => filter(setStatus)(e.target.value)} className="w-36">
            <option value="">Semua status</option>
            <option value="posted">Terposting</option>
            <option value="failed">Gagal</option>
            <option value="skipped">Dilewati</option>
            <option value="prepared">Diproses</option>
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
                <TableHead>Konten</TableHead>
                <TableHead className="hidden sm:table-cell">Akun</TableHead>
                <TableHead className="hidden sm:table-cell">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!posts.data && <TableEmpty cols={5}>Memuat…</TableEmpty>}
              {posts.data && !posts.data.posts.length && <TableEmpty cols={5}>Belum ada posting.</TableEmpty>}
              {posts.data?.posts.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="hidden align-top whitespace-nowrap sm:table-cell">
                    <span className="tabular">{fmtShort(p.updated_at || p.created_at)}</span>
                    <p className="text-xs text-muted-foreground">{p.slot.replace(/-(news|steam_deals|recap_saham|recap_crypto)(-[a-z0-9]+)?$/, "")}</p>
                  </TableCell>
                  <TableCell className="align-top">
                    <Thumb src={p.image_url} href={p.image_url} className="h-16 w-12 sm:h-[68px] sm:w-[54px]" />
                  </TableCell>
                  <TableCell className="min-w-44 align-top">
                    {p.permalink ? (
                      <a href={p.permalink} target="_blank" rel="noopener" className="font-medium hover:underline">
                        {p.title || "—"}
                      </a>
                    ) : (
                      <span className="font-medium">{p.title || "—"}</span>
                    )}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      <span className="tabular sm:hidden">{fmtShort(p.updated_at || p.created_at)} · </span>
                      {kindLabel(p)}
                      {p.attempts > 1 && ` · percobaan ${p.attempts}`}
                      <span className="sm:hidden"> · {p.account}</span>
                    </p>
                    <div className="mt-1.5 flex items-center gap-2 sm:hidden">
                      <PostBadge status={p.status} />
                      <ExtLink href={p.permalink} />
                    </div>
                    <ErrText>{p.error}</ErrText>
                  </TableCell>
                  <TableCell className="hidden align-top sm:table-cell">{p.account}</TableCell>
                  <TableCell className="hidden align-top sm:table-cell">
                    <PostBadge status={p.status} />
                    <div className="mt-1">
                      <ExtLink href={p.permalink} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
        {posts.data && <Pager page={posts.data.page} totalPages={posts.data.totalPages} onPage={setPage} info={` · ${posts.data.total} posting`} />}
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

// Tab Instagram dibagi per konten: dua akun fokus punya jadwal dan gaya posting sendiri.
const INSTAGRAMS: SubTabDef<"game" | "kaiara">[] = [
  { id: "game", label: "Info Game", icon: Gamepad2, Page: ({ active }) => <MetaPosts platform="instagram" account="game" title="Info Game" active={active} /> },
  { id: "kaiara", label: "Kai & Kak Ara", icon: Drama, Page: ({ active }) => <MetaPosts platform="instagram" account="kaiara" title="Kai & Kak Ara" active={active} /> },
];

function Instagram({ active }: { active: boolean }) {
  return <SubTabs tabs={INSTAGRAMS} storageKey="dg-sosmed-instagram" active={active} />;
}

// Isi tab YouTube: tiap channel/pipeline punya pemantauannya sendiri (jadwal, riwayat video, log service).
const YOUTUBES: SubTabDef<"whatif" | "standup">[] = [
  { id: "whatif", label: "Apa yang terjadi jika", icon: Clapperboard, Page: Whatif },
  { id: "standup", label: "Gitgit Stand-up", icon: Mic, Page: Standup },
];

function Youtube({ active }: { active: boolean }) {
  return <SubTabs tabs={YOUTUBES} storageKey="dg-sosmed-youtube" active={active} />;
}

const SUBTABS: SubTabDef<"instagram" | "youtube">[] = [
  { id: "instagram", label: "Instagram", icon: Camera, Page: Instagram },
  { id: "youtube", label: "YouTube", icon: SquarePlay, Page: Youtube },
];
export function Sosmed({ active }: { active: boolean }) {
  return <SubTabs tabs={SUBTABS} storageKey="dg-sosmed-tab" active={active} />;
}

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { DateFilter, ErrText, ExtLink, PostBadge, Thumb } from "@/components/automation";
import { ErrorNote, PageSizeSelect, Pager, RefreshButton, StatCard } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, qs } from "@/lib/api";
import { fmtShort } from "@/lib/format";

type Slot = {
  time: string;
  kind: string;
  label?: string;
  past: boolean;
  platforms: { platform: string; status: string | null; permalink: string | null; error: string | null }[];
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
type Overview = {
  today: { posted: number; failed: number; skipped: number };
  week: { posted: number; failed: number; skipped: number };
  next: { at: string; account: string; kind: string; label?: string } | null;
  last: Post | null;
  accounts: Account[];
};
type Posts = { posts: Post[]; total: number; page: number; totalPages: number };

const KIND: Record<string, string> = { news: "Berita", steam_deals: "Promo Steam", recap_saham: "Rekap saham", recap_crypto: "Rekap crypto" };
const kindLabel = (x: { label?: string; kind: string }) => x.label || KIND[x.kind] || x.kind;
const PLATFORM: Record<string, string> = { instagram: "Instagram", facebook: "Facebook" };

function AccountSchedule({ a }: { a: Account }) {
  return (
    <Card className="gap-3 pb-2">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle className="truncate">{a.handle || a.key}</CardTitle>
          <CardDescription className="mt-1 truncate">
            {a.brand_name} · kategori {a.category}
          </CardDescription>
        </div>
        <CardAction>
          {!a.enabled ? <Badge variant="outline">Nonaktif</Badge> : !a.connected ? <Badge variant="destructive">Belum terhubung</Badge> : <Badge variant="success">Aktif</Badge>}
        </CardAction>
      </CardHeader>
      <CardContent className="px-2">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Jam</TableHead>
              <TableHead className="hidden sm:table-cell">Konten</TableHead>
              {a.platforms.map((p) => (
                <TableHead key={p}>{PLATFORM[p] || p}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {a.schedule.map((s) => (
              <TableRow key={s.time + s.kind}>
                <TableCell className="align-top">
                  <span className="tabular font-medium">{s.time}</span>
                  <p className="text-xs text-muted-foreground sm:hidden">{kindLabel(s)}</p>
                </TableCell>
                <TableCell className="hidden align-top text-muted-foreground sm:table-cell">{kindLabel(s)}</TableCell>
                {s.platforms.map((p) => (
                  <TableCell key={p.platform} className="max-w-56 min-w-24 align-top">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <PostBadge status={p.status || (s.past ? "skipped" : "waiting")} />
                      <ExtLink href={p.permalink} />
                    </div>
                    <ErrText>{p.error}</ErrText>
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {!a.schedule.length && <TableEmpty cols={2 + a.platforms.length}>Tidak ada jadwal hari ini</TableEmpty>}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function Sosmed({ active }: { active: boolean }) {
  const [account, setAccount] = useState("");
  const [status, setStatus] = useState("");
  const [date, setDate] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const filter = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  const poll = active ? 30000 : false;
  const ov = useQuery({ queryKey: ["sosmed-overview"], queryFn: () => api<Overview>("/api/sosmed/overview"), refetchInterval: poll });
  const posts = useQuery({
    queryKey: ["sosmed-posts", account, status, date, page, pageSize],
    queryFn: () => api<Posts>(`/api/sosmed/posts${qs({ page, pageSize, account, status, date })}`),
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });
  const d = ov.data;

  return (
    <div className="flex flex-col gap-5">
      <ErrorNote>{ov.error?.message || posts.error?.message}</ErrorNote>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard loading={!d} label="Terposting hari ini" value={d?.today.posted} detail={d && `${d.today.failed} gagal · ${d.today.skipped} dilewati`} />
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

      <div>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Jadwal hari ini</h2>
        <div className="grid gap-4 xl:grid-cols-2">
          {d?.accounts.map((a) => (
            <AccountSchedule key={a.key} a={a} />
          ))}
          {d && !d.accounts.length && <p className="text-sm text-muted-foreground">Belum ada akun.</p>}
          {!d && !ov.error && <div className="h-60 animate-pulse rounded-xl border bg-card" />}
        </div>
      </div>

      <Card className="gap-3 pb-3">
        <CardHeader>
          <CardTitle>Riwayat posting</CardTitle>
          <CardAction>
            <RefreshButton
              busy={posts.isFetching || ov.isFetching}
              onClick={() => {
                ov.refetch();
                posts.refetch();
              }}
            />
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <NativeSelect value={account} onChange={(e) => filter(setAccount)(e.target.value)} className="w-40">
            <option value="">Semua akun</option>
            {d?.accounts.map((a) => (
              <option key={a.key} value={a.key}>
                {a.handle || a.key}
              </option>
            ))}
          </NativeSelect>
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
                      {kindLabel(p)} · {PLATFORM[p.platform] || p.platform}
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
    </div>
  );
}

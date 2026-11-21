import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ErrorNote, Pager, RefreshButton, StatCard } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, postJson } from "@/lib/api";
import { useAsk } from "@/lib/dialogs";
import { fmtShort } from "@/lib/format";

type Country = { code: string; name: string };
type Jail = { id: string; label: string; failed: number; totalFailed: number; banned: number; totalBanned: number };
type Ban = { ip: string; jail: string; start: string; end: string; bantime: number; country: Country; attempts: number };
type Kind = "fail" | "ban" | "unban";
type Event = { time: string; jail: string; kind: Kind; ip: string; country: Country };
type Report = {
  generated: string;
  days: number;
  jails: Jail[];
  bans: Ban[];
  events: Event[];
  daily: { date: string; fail: number; ban: number }[];
  top: { ip: string; attempts: number; country: Country }[];
};

const KIND: Record<Kind, { label: string; variant: "warning" | "destructive" | "success" }> = {
  fail: { label: "Gagal login", variant: "warning" },
  ban: { label: "Diblokir", variant: "destructive" },
  unban: { label: "Dibuka", variant: "success" },
};
const PAGE = 25;

function flag(code: string) {
  return /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "";
}

function Where({ c }: { c: Country }) {
  if (!c.name) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="whitespace-nowrap">
      {flag(c.code)} {c.name}
    </span>
  );
}

/** Sisa waktu blokir, mis. "23 jam 10 mnt". */
function remaining(end: string) {
  const s = Math.max(0, Math.round((new Date(end).getTime() - Date.now()) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} hari ${h} jam`;
  if (h) return `${h} jam ${m} mnt`;
  return `${m} mnt`;
}

export function Security({ active }: { active: boolean }) {
  const ask = useAsk();
  const qc = useQueryClient();
  const [days, setDays] = useState(7);
  const [jail, setJail] = useState("");
  const [kind, setKind] = useState<"" | Kind>("");
  const [page, setPage] = useState(1);
  const [busyIp, setBusyIp] = useState("");

  const { data: d, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["security", days],
    queryFn: () => api<Report>(`/api/security?days=${days}`),
    enabled: active,
    refetchInterval: active ? 30_000 : false,
  });

  const label = useMemo(() => Object.fromEntries((d?.jails || []).map((j) => [j.id, j.label])), [d]);
  const events = useMemo(() => (d?.events || []).filter((e) => (!jail || e.jail === jail) && (!kind || e.kind === kind)), [d, jail, kind]);
  const totalPages = Math.max(1, Math.ceil(events.length / PAGE));
  const shown = events.slice((Math.min(page, totalPages) - 1) * PAGE, Math.min(page, totalPages) * PAGE);

  const fails = d?.daily.reduce((n, x) => n + x.fail, 0) ?? 0;
  const bans = d?.daily.reduce((n, x) => n + x.ban, 0) ?? 0;
  const attackers = new Set((d?.events || []).filter((e) => e.kind === "fail").map((e) => e.ip)).size;
  const period = days === 1 ? "24 jam terakhir" : `${days} hari terakhir`;

  async function unban(ip: string) {
    const yes = await ask({
      title: `Buka blokir ${ip}?`,
      description: "IP ini akan bisa mengakses semua subdomain lagi. Kalau masih mencoba menebak password, akan otomatis diblokir ulang.",
      confirmLabel: "Buka blokir",
    });
    if (!yes) return;
    setBusyIp(ip);
    try {
      await postJson("/api/security/unban", { ip });
      toast.success(`Blokir ${ip} dibuka`);
      await qc.invalidateQueries({ queryKey: ["security"] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusyIp("");
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Card className="gap-3">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5" /> Keamanan
          </CardTitle>
          <CardDescription className="mt-1.5">
            Login gagal berulang di Home Assistant, CCTV, gitgit3d, dan SSH diblokir otomatis di Cloudflare untuk semua subdomain (24 jam; pelanggar
            berulang 7 hari). n8n dan 9router memakai pembatas bawaannya sendiri dan tidak tercatat di sini.
          </CardDescription>
          <CardAction className="flex items-center gap-2">
            <NativeSelect
              value={days}
              onChange={(e) => {
                setDays(Number(e.target.value));
                setPage(1);
              }}
              className="w-32"
            >
              <option value={1}>24 jam</option>
              <option value={7}>7 hari</option>
              <option value={30}>30 hari</option>
            </NativeSelect>
            <RefreshButton onClick={() => refetch()} busy={isFetching} />
          </CardAction>
        </CardHeader>
      </Card>

      <ErrorNote>{error ? (error as Error).message : null}</ErrorNote>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Diblokir sekarang" value={d?.bans.length ?? "—"} detail="IP aktif di Cloudflare" loading={isLoading} />
        <StatCard label="Login gagal" value={fails} detail={period} loading={isLoading} />
        <StatCard label="Blokir baru" value={bans} detail={period} loading={isLoading} />
        <StatCard label="IP penyerang" value={attackers} detail={`unik, ${period}`} loading={isLoading} />
      </div>

      <Card className="gap-3 pb-3">
        <CardHeader>
          <CardTitle>IP yang sedang diblokir</CardTitle>
          <CardDescription>Blokir berlaku di semua subdomain lewat Cloudflare. Jaringan rumah (192.168.18.x) tidak pernah diblokir.</CardDescription>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>IP</TableHead>
              <TableHead className="hidden sm:table-cell">Asal</TableHead>
              <TableHead>Aplikasi</TableHead>
              <TableHead className="hidden md:table-cell">Sejak</TableHead>
              <TableHead>Sisa</TableHead>
              <TableHead className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && <TableEmpty cols={6}>Memuat…</TableEmpty>}
            {d && !d.bans.length && <TableEmpty cols={6}>Tidak ada IP yang sedang diblokir.</TableEmpty>}
            {d?.bans.map((b) => (
              <TableRow key={`${b.jail}-${b.ip}`}>
                <TableCell className="font-mono text-xs">
                  {b.ip}
                  <div className="text-muted-foreground sm:hidden">
                    <Where c={b.country} />
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <Where c={b.country} />
                </TableCell>
                <TableCell>
                  {label[b.jail] || b.jail}
                  {b.attempts > 0 && <div className="text-xs text-muted-foreground">{b.attempts}× gagal</div>}
                </TableCell>
                <TableCell className="hidden md:table-cell">{fmtShort(b.start)}</TableCell>
                <TableCell className="tabular whitespace-nowrap">{remaining(b.end)}</TableCell>
                <TableCell className="text-right">
                  <Button variant="outline" size="sm" disabled={busyIp === b.ip} onClick={() => unban(b.ip)}>
                    <ShieldOff /> <span className="hidden sm:inline">Buka blokir</span>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="gap-3 pb-3">
          <CardHeader>
            <CardTitle>Per aplikasi</CardTitle>
            <CardDescription>Angka total dihitung sejak fail2ban terakhir dijalankan ulang.</CardDescription>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Aplikasi</TableHead>
                <TableHead className="text-right">Gagal (10 mnt)</TableHead>
                <TableHead className="text-right">Total gagal</TableHead>
                <TableHead className="text-right">Diblokir</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d?.jails.map((j) => (
                <TableRow key={j.id}>
                  <TableCell>{j.label}</TableCell>
                  <TableCell className="tabular text-right">{j.failed}</TableCell>
                  <TableCell className="tabular text-right">{j.totalFailed}</TableCell>
                  <TableCell className="tabular text-right">{j.banned}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        <Card className="gap-3 pb-3">
          <CardHeader>
            <CardTitle>Penyerang teratas</CardTitle>
            <CardDescription>IP dengan login gagal terbanyak, {period}.</CardDescription>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>IP</TableHead>
                <TableHead>Asal</TableHead>
                <TableHead className="text-right">Gagal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d && !d.top.length && <TableEmpty cols={3}>Belum ada percobaan login gagal.</TableEmpty>}
              {d?.top.map((t) => (
                <TableRow key={t.ip}>
                  <TableCell className="font-mono text-xs">{t.ip}</TableCell>
                  <TableCell>
                    <Where c={t.country} />
                  </TableCell>
                  <TableCell className="tabular text-right">{t.attempts}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>

      <Card className="gap-3 pb-3">
        <CardHeader>
          <CardTitle>Per hari</CardTitle>
          <CardDescription>Jumlah login gagal dan blokir baru, {period}.</CardDescription>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tanggal</TableHead>
              <TableHead className="text-right">Login gagal</TableHead>
              <TableHead className="text-right">Blokir baru</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...(d?.daily || [])].reverse().map((x) => (
              <TableRow key={x.date}>
                <TableCell>{new Date(`${x.date}T00:00:00`).toLocaleDateString("id-ID", { weekday: "short", day: "2-digit", month: "short" })}</TableCell>
                <TableCell className="tabular text-right">{x.fail}</TableCell>
                <TableCell className="tabular text-right">{x.ban}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Card className="gap-3 pb-3">
        <CardHeader>
          <CardTitle>Riwayat kejadian</CardTitle>
          <CardDescription>Setiap login gagal yang terdeteksi, blokir, dan pembukaan blokir (maks. 500 terbaru).</CardDescription>
          <CardAction className="flex flex-wrap items-center gap-2">
            <NativeSelect
              value={jail}
              onChange={(e) => {
                setJail(e.target.value);
                setPage(1);
              }}
              className="w-40"
            >
              <option value="">Semua aplikasi</option>
              {d?.jails.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.label}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as "" | Kind);
                setPage(1);
              }}
              className="w-36"
            >
              <option value="">Semua jenis</option>
              <option value="fail">Gagal login</option>
              <option value="ban">Diblokir</option>
              <option value="unban">Dibuka</option>
            </NativeSelect>
          </CardAction>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Waktu</TableHead>
              <TableHead>Jenis</TableHead>
              <TableHead>IP</TableHead>
              <TableHead className="hidden sm:table-cell">Asal</TableHead>
              <TableHead className="hidden md:table-cell">Aplikasi</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && <TableEmpty cols={5}>Memuat…</TableEmpty>}
            {d && !events.length && <TableEmpty cols={5}>Tidak ada kejadian pada periode ini.</TableEmpty>}
            {shown.map((e, i) => (
              <TableRow key={`${e.time}-${e.ip}-${e.kind}-${i}`}>
                <TableCell className="whitespace-nowrap">{fmtShort(e.time)}</TableCell>
                <TableCell>
                  <Badge variant={KIND[e.kind].variant}>{KIND[e.kind].label}</Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {e.ip}
                  <div className="font-sans text-muted-foreground md:hidden">{label[e.jail] || e.jail}</div>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <Where c={e.country} />
                </TableCell>
                <TableCell className="hidden md:table-cell">{label[e.jail] || e.jail}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {events.length > PAGE && <Pager page={Math.min(page, totalPages)} totalPages={totalPages} onPage={setPage} info={` · ${events.length} kejadian`} />}
      </Card>
    </div>
  );
}

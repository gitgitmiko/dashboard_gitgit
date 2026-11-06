import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Bot, Boxes, ChevronRight, Cpu, ExternalLink, Gauge, Globe, HardDrive, MemoryStick, Network, Plug, Router, Wifi } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Sparkline } from "@/components/sparkline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { fmtBytes, fmtDuration, level } from "@/lib/format";
import { useStats } from "@/lib/stats";
import { cn } from "@/lib/utils";

const HISTORY = 40; // 40 sampel × 3 dtk ≈ 2 menit terakhir

type FreeUsage = {
  combo: string;
  usedToday: number;
  totalModels: number;
  percentToday: number;
  usedAll: number;
  percentAll: number;
  requestsToday: number;
  models: { model: string; provider: string; today: number; total: number; tokens?: number; state: "ok" | "limit" | "off"; note?: string }[];
};

type Addresses = {
  interfaces: { name: string; address: string; info: string }[];
  domains: { hostname: string; path: string; service: string; info: string }[];
  listeners: { address: string; port: number; process: string; info: string; scope: string }[];
  docker: { name: string; image: string; network: string; ip: string }[];
  lan: { ip: string; dev: string; mac: string; state: string; info: string }[];
};

const toneText = { ok: "text-primary", warm: "text-warning", hot: "text-destructive" };

function Metric({
  className,
  icon: Icon,
  label,
  value,
  detail,
  percent,
  history,
  onClick,
}: {
  className?: string;
  icon: typeof Cpu;
  label: string;
  value: ReactNode;
  detail: ReactNode;
  percent?: number;
  history?: number[];
  onClick?: () => void;
}) {
  return (
    <Card
      className={cn("relative gap-3 overflow-hidden py-4", onClick && "cursor-pointer transition-colors hover:border-primary/40", className)}
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >
      <CardContent className="flex flex-col gap-3 px-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon className="size-4" />
          {label}
          {onClick && <ChevronRight className="ml-auto size-4" />}
        </div>
        <div className="flex items-end justify-between gap-2">
          <span className="tabular text-2xl font-semibold tracking-tight">{value}</span>
          {history && <Sparkline values={history} className={cn("h-8 w-24 shrink-0", toneText[level(percent ?? 0)])} />}
        </div>
        {percent !== undefined && <Progress value={percent} />}
        <p className="truncate text-xs text-muted-foreground" title={typeof detail === "string" ? detail : undefined}>
          {detail}
        </p>
      </CardContent>
    </Card>
  );
}

function MetricSkeleton() {
  return (
    <Card className="py-4">
      <CardContent className="flex flex-col gap-3 px-4">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-1.5 w-full" />
        <Skeleton className="h-3 w-32" />
      </CardContent>
    </Card>
  );
}

function FreeUsageDialog({ open, onOpenChange, data }: { open: boolean; onOpenChange: (v: boolean) => void; data?: FreeUsage }) {
  const ST = { ok: ["Aktif", "success"], limit: ["Limit", "warning"], off: ["Nonaktif", "outline"] } as const;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Pemakaian Model Free Hermes</DialogTitle>
          <DialogDescription>
            {data
              ? `Pool "${data.combo}": ${data.usedToday} dari ${data.totalModels} model free dipakai hari ini (${data.percentToday.toFixed(0)}%), ${data.usedAll} pernah dipakai sejak awal (${data.percentAll.toFixed(0)}%).`
              : "Memuat…"}
          </DialogDescription>
        </DialogHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead className="text-right">Hari ini / Total</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.models.map((m) => (
              <TableRow key={`${m.provider}/${m.model}`}>
                <TableCell className="max-w-56 font-medium break-all">{m.model}</TableCell>
                <TableCell className="text-muted-foreground">{m.provider}</TableCell>
                <TableCell className="tabular text-right">
                  {m.today} / {m.total}
                  {!!m.tokens && <div className="text-xs text-muted-foreground">{m.tokens.toLocaleString("id-ID")} token</div>}
                </TableCell>
                <TableCell>
                  <Badge variant={ST[m.state][1]}>{ST[m.state][0]}</Badge>
                  {m.note && <div className="mt-1 max-w-48 truncate text-xs text-muted-foreground" title={m.note}>{m.note}</div>}
                </TableCell>
              </TableRow>
            )) ?? <TableEmpty cols={4}>Memuat…</TableEmpty>}
          </TableBody>
        </Table>
      </DialogContent>
    </Dialog>
  );
}

const ADDR_TABS = [
  { id: "domains", label: "Domain", icon: Globe },
  { id: "interfaces", label: "IP Server", icon: Wifi },
  { id: "listeners", label: "Port", icon: Plug },
  { id: "docker", label: "Docker", icon: Boxes },
  { id: "lan", label: "Perangkat LAN", icon: Router },
] as const;

function scopeVariant(scope: string) {
  if (scope.startsWith("Lokal")) return "outline" as const;
  if (scope === "Docker") return "secondary" as const;
  return "warning" as const; // terbuka ke LAN
}

function AddressesCard() {
  const [sub, setSub] = useState<(typeof ADDR_TABS)[number]["id"]>("domains");
  const { data, error, isPending } = useQuery({ queryKey: ["addresses"], queryFn: () => api<Addresses>("/api/addresses"), refetchInterval: 60000 });

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <Network className="size-4 text-muted-foreground" /> Alamat IP &amp; Domain
          </CardTitle>
          <CardDescription className="mt-1.5">Dikumpulkan langsung dari server: Cloudflare Tunnel, antarmuka, port, Docker, dan tabel ARP.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
          {ADDR_TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSub(id)}
              className={cn(
                "flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors",
                sub === id ? "border-primary/40 bg-primary/10 text-foreground" : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
              {data && <span className="tabular rounded-full bg-muted px-1.5 text-xs text-muted-foreground">{data[id].length}</span>}
            </button>
          ))}
        </div>

        {error && <p className="text-sm text-destructive">{error.message}</p>}
        {isPending && <Skeleton className="h-40 w-full" />}

        {data && sub === "domains" && (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {data.domains.map((d) => (
              <a
                key={d.hostname + d.path}
                href={`https://${d.hostname}${d.path}`}
                target="_blank"
                rel="noopener"
                className="group flex flex-col gap-2 rounded-lg border bg-background/40 p-4 transition-colors hover:border-primary/40 hover:bg-accent/40"
              >
                <div className="flex items-center gap-2">
                  <Globe className="size-4 shrink-0 text-primary" />
                  <span className="truncate font-medium">
                    {d.hostname}
                    {d.path}
                  </span>
                  <ExternalLink className="ml-auto size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </div>
                <p className="text-sm text-muted-foreground">{d.info || "—"}</p>
                <code className="mt-auto w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{d.service}</code>
              </a>
            ))}
            {!data.domains.length && <p className="text-sm text-muted-foreground">Tidak ada data</p>}
          </div>
        )}

        {data && sub === "interfaces" && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Antarmuka</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>Keterangan</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.interfaces.map((r) => (
                <TableRow key={r.name + r.address}>
                  <TableCell className="font-mono text-xs">{r.name}</TableCell>
                  <TableCell className="font-mono font-medium">{r.address}</TableCell>
                  <TableCell className="text-muted-foreground">{r.info}</TableCell>
                </TableRow>
              ))}
              {!data.interfaces.length && <TableEmpty cols={3}>Tidak ada data</TableEmpty>}
            </TableBody>
          </Table>
        )}

        {data && sub === "listeners" && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Alamat</TableHead>
                <TableHead>Jangkauan</TableHead>
                <TableHead>Keterangan</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.listeners.map((r) => (
                <TableRow key={`${r.address}:${r.port}`}>
                  <TableCell className="font-mono text-xs whitespace-nowrap">
                    {r.address.includes(":") ? `[${r.address}]` : r.address}:<span className="font-semibold text-foreground">{r.port}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={scopeVariant(r.scope)}>{r.scope}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.info}</TableCell>
                </TableRow>
              ))}
              {!data.listeners.length && <TableEmpty cols={3}>Tidak ada data</TableEmpty>}
            </TableBody>
          </Table>
        )}

        {data && sub === "docker" && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Container</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>Image</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.docker.map((r) => (
                <TableRow key={r.name}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="font-mono text-xs">{r.ip}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{r.image}</TableCell>
                </TableRow>
              ))}
              {!data.docker.length && <TableEmpty cols={3}>Tidak ada data</TableEmpty>}
            </TableBody>
          </Table>
        )}

        {data && sub === "lan" && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>IP</TableHead>
                <TableHead>MAC</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Keterangan</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.lan.map((r) => (
                <TableRow key={r.ip}>
                  <TableCell className="font-mono font-medium">{r.ip}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{r.mac}</TableCell>
                  <TableCell>
                    <Badge variant={r.state === "REACHABLE" ? "success" : "outline"}>{r.state}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.info}</TableCell>
                </TableRow>
              ))}
              {!data.lan.length && <TableEmpty cols={4}>Tidak ada data</TableEmpty>}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function Overview() {
  const { data: s, error } = useStats();
  const free = useQuery({ queryKey: ["free-usage"], queryFn: () => api<FreeUsage>("/api/free-usage"), refetchInterval: 30000 });
  const [freeOpen, setFreeOpen] = useState(false);
  const [showVeth, setShowVeth] = useState(false);
  const vethCount = s?.network.filter((n) => n.name.startsWith("veth")).length ?? 0;
  const [hist, setHist] = useState<{ cpu: number[]; ram: number[]; net: Record<string, number[]> }>({ cpu: [], ram: [], net: {} });

  // Riwayat singkat untuk sparkline, dikumpulkan di browser dari polling /api/stats.
  useEffect(() => {
    if (!s) return;
    setHist((h) => {
      const net: Record<string, number[]> = {};
      for (const n of s.network) net[n.name] = [...(h.net[n.name] || []), n.rx_bps + n.tx_bps].slice(-HISTORY);
      return { cpu: [...h.cpu, s.cpu.percent].slice(-HISTORY), ram: [...h.ram, s.memory.percent].slice(-HISTORY), net };
    });
  }, [s?.time]); // eslint-disable-line react-hooks/exhaustive-deps

  const swapPct = s?.memory.swap_total ? (s.memory.swap_used / s.memory.swap_total) * 100 : 0;
  const loadPct = s ? (s.load.one / Math.max(1, s.cpu.cores)) * 100 : 0;

  return (
    <div className="flex flex-col gap-5">
      {error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error.message}</p>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {!s ? (
          Array.from({ length: 5 }, (_, i) => <MetricSkeleton key={i} />)
        ) : (
          <>
            <Metric icon={Cpu} label="CPU" value={`${s.cpu.percent.toFixed(1)}%`} percent={s.cpu.percent} history={hist.cpu} detail={`${s.cpu.model} (${s.cpu.cores} core)`} />
            <Metric
              icon={MemoryStick}
              label="RAM"
              value={`${s.memory.percent.toFixed(1)}%`}
              percent={s.memory.percent}
              history={hist.ram}
              detail={`${fmtBytes(s.memory.used)} / ${fmtBytes(s.memory.total)}`}
            />
            <Metric
              icon={HardDrive}
              label="Swap"
              value={s.memory.swap_total ? `${swapPct.toFixed(1)}%` : "Tidak ada"}
              percent={s.memory.swap_total ? swapPct : undefined}
              detail={s.memory.swap_total ? `${fmtBytes(s.memory.swap_used)} / ${fmtBytes(s.memory.swap_total)}` : "Swap tidak aktif"}
            />
            <Metric
              icon={Gauge}
              label="Load"
              value={s.load.one.toFixed(2)}
              percent={loadPct}
              detail={`${s.load.one.toFixed(2)} · ${s.load.five.toFixed(2)} · ${s.load.fifteen.toFixed(2)} · hidup ${fmtDuration(s.uptime_sec)}`}
            />
            <Metric
              className="col-span-2 md:col-span-1"
              icon={Bot}
              label="Model Free Usage"
              value={free.data ? `${free.data.percentToday.toFixed(0)}%` : "—"}
              percent={free.data?.percentToday ?? 0}
              detail={free.data ? `${free.data.usedToday} / ${free.data.totalModels} model hari ini · ${free.data.requestsToday} request` : free.error ? "Gagal memuat" : "Memuat…"}
              onClick={() => {
                setFreeOpen(true);
                free.refetch();
              }}
            />
          </>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="size-4 text-muted-foreground" /> Penyimpanan
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {!s && <Skeleton className="h-24 w-full" />}
            {s?.disks.map((d) => (
              <div key={d.mount} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate font-mono text-xs font-medium" title={d.source}>
                    {d.mount}
                  </span>
                  <span className="tabular shrink-0 text-xs text-muted-foreground">
                    {fmtBytes(d.used)} / {fmtBytes(d.size)} · <span className={cn("font-medium", toneText[level(d.percent)])}>{d.percent}%</span>
                  </span>
                </div>
                <Progress value={d.percent} />
                <p className="text-xs text-muted-foreground">{fmtBytes(d.avail)} kosong</p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wifi className="size-4 text-muted-foreground" /> Jaringan
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {!s && <Skeleton className="h-24 w-full" />}
            {s && !s.network.length && <p className="text-sm text-muted-foreground">Tidak ada antarmuka</p>}
            {s?.network
              .filter((n) => showVeth || !n.name.startsWith("veth"))
              .map((n) => (
                <div key={n.name} className="flex items-center gap-3 rounded-lg border bg-background/40 px-3 py-2.5 sm:px-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs font-medium">{n.name}</p>
                    <div className="tabular mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm whitespace-nowrap">
                      <span className="flex items-center gap-1">
                        <ArrowDown className="size-3.5 text-success" />
                        {fmtBytes(n.rx_bps)}/dtk
                      </span>
                      <span className="flex items-center gap-1">
                        <ArrowUp className="size-3.5 text-primary" />
                        {fmtBytes(n.tx_bps)}/dtk
                      </span>
                    </div>
                  </div>
                  <Sparkline values={hist.net[n.name] || []} max={1} className="h-8 w-16 shrink-0 text-primary sm:w-28" />
                </div>
              ))}
            {!!vethCount && (
              <Button variant="ghost" size="sm" className="self-start text-muted-foreground" onClick={() => setShowVeth((v) => !v)}>
                {showVeth ? "Sembunyikan" : "Tampilkan"} {vethCount} antarmuka virtual Docker (veth)
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      <AddressesCard />
      <FreeUsageDialog open={freeOpen} onOpenChange={setFreeOpen} data={free.data} />
    </div>
  );
}

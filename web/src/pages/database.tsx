import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Copy, Database as DbIcon, KeyRound, ListTree, Search, Activity } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ClientPager, ErrorNote, PAGE_SIZES, Pager, RefreshButton, usePaged } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, qs } from "@/lib/api";
import { fmtBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

type Kind = "mysql" | "postgres" | "sqlite";
type Source = {
  id: string;
  kind: Kind;
  label: string;
  status: "ok" | "error" | "unconfigured";
  message?: string;
  version?: string;
  uptime?: number | null;
  size?: number;
  databases?: number;
  tables?: number;
  connections?: number | null;
  maxConnections?: number | null;
  active?: number | null;
  qps?: number | null;
  slowQueries?: number;
  file?: string;
  modified?: string;
};
type DbInfo = { name: string; size: number; tables: number | null };
type TableInfo = { name: string; rows: number; rowsApprox: boolean; size: number | null; indexSize: number | null; engine: string | null; updated: string | null };
type QueryRow = { id: string; user: string; client: string; db: string | null; state: string; seconds: number; query: string | null };
type Cell = string | number | boolean | null | { binary: number } | { text: string; truncated: number };
type Rows = {
  columns: { name: string; type: string; pk: boolean }[];
  rows: Cell[][];
  total: number;
  approx: boolean;
  sort: { col: string; dir: "ASC" | "DESC" } | null;
  page: number;
  pageSize: number;
  totalPages: number;
};

const KIND_LABEL: Record<Kind, string> = { mysql: "MySQL", postgres: "PostgreSQL", sqlite: "SQLite" };

function shortUptime(sec: number | null | undefined) {
  if (sec == null) return "";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} hr ${h} j` : h ? `${h} j ${m} mnt` : `${m} mnt`;
}

const fmtNum = (n: number | null | undefined) => (n == null ? "—" : Number(n).toLocaleString("id-ID"));

function cellText(c: Cell): string {
  if (c === null) return "NULL";
  if (typeof c === "object") return "binary" in c ? `<biner ${fmtBytes(c.binary)}>` : c.text;
  return String(c);
}

function fmtSecs(s: number) {
  if (s < 60) return `${s} dtk`;
  if (s < 3600) return `${Math.floor(s / 60)} mnt ${s % 60} dtk`;
  return `${Math.floor(s / 3600)} j ${Math.floor((s % 3600) / 60)} mnt`;
}

function StatusDot({ status }: { status: Source["status"] }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", status === "ok" ? "bg-success" : status === "error" ? "bg-destructive" : "bg-muted-foreground/50")} />;
}

function SourceCard({ s, selected, onSelect }: { s: Source; selected: boolean; onSelect: () => void }) {
  const connPct = s.connections != null && s.maxConnections ? Math.round((s.connections / s.maxConnections) * 100) : null;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-xl border bg-card p-4 text-left shadow-xs transition-colors hover:border-primary/50",
        selected && "border-primary ring-2 ring-primary/30",
      )}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        <StatusDot status={s.status} />
        <span className="truncate">{s.label}</span>
        <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">{KIND_LABEL[s.kind]}</span>
      </span>
      {s.status === "ok" ? (
        <>
          <span className="tabular text-xl font-semibold tracking-tight sm:text-2xl">{fmtBytes(s.size)}</span>
          <span className="truncate text-xs text-muted-foreground">
            {s.kind === "sqlite"
              ? `${s.tables} tabel · diubah ${s.modified ? new Date(s.modified).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}`
              : `${s.databases} database · koneksi ${s.connections}/${s.maxConnections ?? "?"}${connPct != null && connPct >= 80 ? " ⚠" : ""}`}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {s.kind === "sqlite"
              ? s.version
              : `${s.active ?? 0} query aktif${s.qps != null ? ` · ${s.qps.toFixed(1)} ${s.kind === "mysql" ? "q" : "tx"}/dtk` : ""} · hidup ${shortUptime(s.uptime)}`}
          </span>
        </>
      ) : s.status === "unconfigured" ? (
        <span className="text-xs text-muted-foreground">
          Belum dikonfigurasi. Jalankan di Terminal:
          <code className="mt-1 block rounded bg-muted px-1.5 py-1 font-mono text-[11px] break-all text-foreground">bash ~/github-repos/dashboard_gitgit/scripts/setup-db-monitor.sh {s.kind}</code>
        </span>
      ) : (
        <span className="line-clamp-3 text-xs break-words text-destructive">{s.message}</span>
      )}
    </button>
  );
}

/** Isi lengkap satu sel (sampai 2000 karakter), dengan tombol salin. */
function CellDialog({ value, onClose }: { value: { col: string; cell: Cell } | null; onClose: () => void }) {
  const text = value ? cellText(value.cell) : "";
  let pretty = text;
  if (value && typeof value.cell === "string" && /^[[{]/.test(text.trim())) {
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* bukan JSON */
    }
  }
  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85svh] max-w-2xl flex-col gap-3">
        <DialogTitle className="truncate pr-6 font-mono text-sm">{value?.col}</DialogTitle>
        {value && typeof value.cell === "object" && value.cell && "truncated" in value.cell && (
          <p className="text-xs text-warning">Dipotong: menampilkan 2.000 dari {fmtNum(value.cell.truncated)} karakter.</p>
        )}
        <pre className="min-h-0 flex-1 overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs break-words whitespace-pre-wrap">{pretty}</pre>
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => navigator.clipboard?.writeText(text).then(() => toast.success("Disalin"), () => toast.error("Gagal menyalin"))}
        >
          <Copy /> Salin
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function TableBrowser({ source, db, table, onClose }: { source: Source; db: string; table: string | null; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" } | null>(null);
  const [cell, setCell] = useState<{ col: string; cell: Cell } | null>(null);

  useEffect(() => {
    setPage(1);
    setSort(null);
  }, [table]);

  const { data: d, error, isFetching, refetch } = useQuery({
    queryKey: ["db", "rows", source.id, db, table, page, pageSize, sort?.col, sort?.dir],
    queryFn: () => api<Rows>(`/api/db/${encodeURIComponent(source.id)}/rows${qs({ db, table, page, pageSize, sort: sort?.col, dir: sort?.dir })}`),
    enabled: !!table,
    placeholderData: keepPreviousData,
  });

  function toggleSort(col: string) {
    setPage(1);
    setSort((s) => {
      const cur = s?.col === col ? s.dir : d?.sort?.col === col ? (d.sort.dir.toLowerCase() as "asc" | "desc") : null;
      return { col, dir: cur === "desc" ? "asc" : "desc" };
    });
  }

  return (
    <Dialog open={!!table} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[92svh] max-h-[92svh] w-[calc(100%-1rem)] max-w-7xl flex-col gap-0 overflow-hidden p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="flex flex-wrap items-center gap-2 border-b p-3 pr-12">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate font-mono text-sm">{table}</DialogTitle>
            <p className="truncate text-xs text-muted-foreground">
              {source.label}
              {source.kind !== "sqlite" && ` · ${db}`}
              {d && ` · ${d.approx ? "±" : ""}${fmtNum(d.total)} baris · ${d.columns.length} kolom`}
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Baris
            <NativeSelect value={pageSize} onChange={(e) => (setPageSize(Number(e.target.value)), setPage(1))} className="w-20">
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </NativeSelect>
          </label>
          <RefreshButton onClick={() => refetch()} busy={isFetching} />
        </div>
        <ErrorNote>{error?.message}</ErrorNote>
        <div className="min-h-0 flex-1 overflow-auto">
          {!d ? (
            <div className="flex flex-col gap-2 p-4">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-5 w-full" />
              ))}
            </div>
          ) : (
            <table className={cn("w-max min-w-full border-separate border-spacing-0 text-xs", isFetching && "opacity-60")}>
              <thead className="sticky top-0 z-10 bg-popover">
                <tr>
                  {d.columns.map((c) => {
                    const active = d.sort?.col === c.name ? d.sort.dir : null;
                    return (
                      <th key={c.name} className="border-b px-3 py-2 text-left align-bottom font-medium whitespace-nowrap">
                        <button type="button" onClick={() => toggleSort(c.name)} className="inline-flex cursor-pointer items-center gap-1 hover:text-primary" title={`Urutkan menurut ${c.name}`}>
                          {c.pk && <KeyRound className="size-3 text-warning" />}
                          <span className="font-mono">{c.name}</span>
                          {active === "DESC" && <ArrowDown className="size-3" />}
                          {active === "ASC" && <ArrowUp className="size-3" />}
                        </button>
                        <span className="block text-[10px] font-normal text-muted-foreground">{c.type}</span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {!d.rows.length && (
                  <tr>
                    <td colSpan={d.columns.length} className="p-6 text-center text-muted-foreground">
                      Tabel kosong.
                    </td>
                  </tr>
                )}
                {d.rows.map((r, i) => (
                  <tr key={i} className="hover:bg-muted/40">
                    {r.map((c, j) => {
                      const t = cellText(c);
                      return (
                        <td
                          key={j}
                          onClick={() => setCell({ col: d.columns[j].name, cell: c })}
                          className={cn("max-w-[22rem] cursor-pointer truncate border-b px-3 py-1.5 font-mono", (c === null || typeof c === "object") && "text-muted-foreground italic")}
                          title={t.length > 200 ? `${t.slice(0, 200)}…` : t}
                        >
                          {t}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {d && (
          <div className="pb-3">
            <Pager page={d.page} totalPages={d.totalPages} onPage={setPage} info={` · ketuk sel untuk lihat isi lengkap`} />
          </div>
        )}
        <CellDialog value={cell} onClose={() => setCell(null)} />
      </DialogContent>
    </Dialog>
  );
}

function TablesPanel({ source }: { source: Source }) {
  const [db, setDb] = useState("");
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const dbs = useQuery({
    queryKey: ["db", "databases", source.id],
    queryFn: () => api<{ databases: DbInfo[] }>(`/api/db/${encodeURIComponent(source.id)}/databases`),
  });
  const list = dbs.data?.databases || [];
  useEffect(() => {
    if (list.length && !list.some((x) => x.name === db)) setDb(list[0].name);
  }, [list, db]);

  const tables = useQuery({
    queryKey: ["db", "tables", source.id, db],
    queryFn: () => api<{ tables: TableInfo[] }>(`/api/db/${encodeURIComponent(source.id)}/tables${qs({ db })}`),
    enabled: !!db,
  });
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (tables.data?.tables || []).filter((t) => !q || t.name.toLowerCase().includes(q));
  }, [tables.data, filter]);
  const totalSize = (tables.data?.tables || []).reduce((n, t) => n + (t.size || 0), 0);
  const tp = usePaged(rows, `${db}|${filter}`);

  return (
    <div className="flex flex-col gap-3">
      <ErrorNote>{dbs.error?.message || tables.error?.message}</ErrorNote>
      <div className="flex flex-wrap items-center gap-2">
        {source.kind !== "sqlite" && (
          <NativeSelect value={db} onChange={(e) => setDb(e.target.value)} className="w-full sm:w-64">
            {list.map((x) => (
              <option key={x.name} value={x.name}>
                {x.name} ({fmtBytes(x.size)})
              </option>
            ))}
          </NativeSelect>
        )}
        <div className="relative min-w-40 flex-1">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Cari tabel…" className="h-8 pl-8" />
        </div>
        <RefreshButton onClick={() => (dbs.refetch(), tables.refetch())} busy={tables.isFetching} />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tabel</TableHead>
            <TableHead className="text-right">Baris</TableHead>
            <TableHead className="text-right">Ukuran</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Indeks</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(tables.isLoading || (!db && dbs.isLoading)) && <TableEmpty cols={4}>Memuat…</TableEmpty>}
          {tables.data && !rows.length && <TableEmpty cols={4}>Tidak ada tabel.</TableEmpty>}
          {tp.rows.map((t) => (
            <TableRow key={t.name} className="cursor-pointer" onClick={() => setOpen(t.name)}>
              <TableCell className="max-w-[14rem] truncate font-mono text-xs sm:max-w-none">
                {t.name}
                {t.size != null && totalSize > 0 && (
                  <span className="mt-1 block h-1 rounded-full bg-muted">
                    <span className="block h-1 rounded-full bg-primary/70" style={{ width: `${Math.max(1, (t.size / totalSize) * 100)}%` }} />
                  </span>
                )}
              </TableCell>
              <TableCell className="tabular text-right whitespace-nowrap">
                {t.rowsApprox ? "±" : ""}
                {fmtNum(t.rows)}
              </TableCell>
              <TableCell className="tabular text-right whitespace-nowrap">{fmtBytes(t.size)}</TableCell>
              <TableCell className="tabular hidden text-right whitespace-nowrap text-muted-foreground sm:table-cell">{fmtBytes(t.indexSize)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ClientPager p={tp} unit="tabel" />
      {tables.data && (
        <p className="text-xs text-muted-foreground">
          {tables.data.tables.length} tabel · {fmtBytes(totalSize)}
          {tables.data.tables.some((t) => t.rowsApprox) && " · ± = perkiraan dari statistik database"} · ketuk tabel untuk melihat isinya (hanya baca)
        </p>
      )}
      <TableBrowser source={source} db={db} table={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function QueriesPanel({ source, active }: { source: Source; active: boolean }) {
  const [auto, setAuto] = useState(true);
  const [open, setOpen] = useState<QueryRow | null>(null);
  const { data: d, error, isFetching, refetch } = useQuery({
    queryKey: ["db", "queries", source.id],
    queryFn: () => api<{ active: QueryRow[]; idle: { user: string; count: number }[] }>(`/api/db/${encodeURIComponent(source.id)}/queries`),
    refetchInterval: active && auto ? 3000 : false,
  });
  return (
    <div className="flex flex-col gap-3">
      <ErrorNote>{error?.message}</ErrorNote>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-sm text-muted-foreground">{d ? `${d.active.length} query sedang berjalan` : "Memuat…"}</span>
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          otomatis (3 dtk)
        </label>
        <RefreshButton onClick={() => refetch()} busy={isFetching} />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Durasi</TableHead>
            <TableHead>Query</TableHead>
            <TableHead className="hidden sm:table-cell">User / DB</TableHead>
            <TableHead className="hidden md:table-cell">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {d && !d.active.length && <TableEmpty cols={4}>Tidak ada query yang sedang berjalan. Semua koneksi sedang diam.</TableEmpty>}
          {d?.active.map((q) => (
            <TableRow key={q.id} className="cursor-pointer" onClick={() => setOpen(q)}>
              <TableCell className="tabular align-top whitespace-nowrap">
                <span className={cn(q.seconds >= 30 && "font-semibold text-destructive", q.seconds >= 5 && q.seconds < 30 && "text-warning")}>{fmtSecs(q.seconds)}</span>
              </TableCell>
              <TableCell className="align-top">
                <code className="line-clamp-2 font-mono text-xs break-all">{q.query || <span className="text-muted-foreground">({q.state})</span>}</code>
                <span className="text-xs text-muted-foreground sm:hidden">
                  {q.user}
                  {q.db ? ` · ${q.db}` : ""}
                </span>
              </TableCell>
              <TableCell className="hidden align-top text-xs sm:table-cell">
                {q.user}
                <span className="block text-muted-foreground">{q.db || "—"}</span>
              </TableCell>
              <TableCell className="hidden align-top text-xs text-muted-foreground md:table-cell">{q.state}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {d && d.idle.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          Koneksi diam:
          {d.idle.map((i) => (
            <Badge key={i.user} variant="outline">
              {i.user} × {i.count}
            </Badge>
          ))}
        </div>
      )}
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="flex max-h-[85svh] max-w-3xl flex-col gap-3">
          <DialogTitle className="pr-6 text-sm">
            {open?.user}
            {open?.db ? ` · ${open.db}` : ""} · {open && fmtSecs(open.seconds)}
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            ID {open?.id} · {open?.client} · {open?.state}
          </p>
          <pre className="min-h-0 flex-1 overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs break-words whitespace-pre-wrap">{open?.query || "(tanpa teks query)"}</pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const SEL_KEY = "dg-db-source";

export function Database({ active }: { active: boolean }) {
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["db", "overview"],
    queryFn: () => api<{ sources: Source[] }>("/api/db"),
    refetchInterval: active ? 10_000 : false,
    placeholderData: keepPreviousData,
  });
  const [selId, setSelId] = useState<string>(() => {
    try {
      return localStorage.getItem(SEL_KEY) || "";
    } catch {
      return "";
    }
  });
  const [panel, setPanel] = useState<"tables" | "queries">("tables");
  const sources = data?.sources || [];
  const usable = sources.filter((s) => s.status === "ok");
  const sel = usable.find((s) => s.id === selId) || usable[0];

  function select(s: Source) {
    if (s.status !== "ok") return;
    setSelId(s.id);
    if (s.kind === "sqlite") setPanel("tables");
    try {
      localStorage.setItem(SEL_KEY, s.id);
    } catch {
      /* storage opsional */
    }
  }

  const servers = sources.filter((s) => s.kind !== "sqlite");
  const files = sources.filter((s) => s.kind === "sqlite");

  return (
    <div className="flex flex-col gap-5">
      <ErrorNote>{error?.message}</ErrorNote>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Server database</h2>
        <RefreshButton onClick={() => refetch()} busy={isFetching} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {!data && Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
        {servers.map((s) => (
          <SourceCard key={s.id} s={s} selected={sel?.id === s.id} onSelect={() => select(s)} />
        ))}
      </div>
      {files.length > 0 && (
        <>
          <h2 className="text-sm font-medium text-muted-foreground">Berkas SQLite</h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
            {files.map((s) => (
              <SourceCard key={s.id} s={s} selected={sel?.id === s.id} onSelect={() => select(s)} />
            ))}
          </div>
        </>
      )}

      {sel && (
        <Card className="gap-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DbIcon className="size-4" /> {sel.label}
            </CardTitle>
            <CardDescription className="truncate">{sel.kind === "sqlite" ? sel.file : sel.version}</CardDescription>
            {sel.kind !== "sqlite" && (
              <CardAction>
                <div role="tablist" className="inline-flex gap-1 rounded-lg border bg-card p-1">
                  {(
                    [
                      ["tables", "Tabel", ListTree],
                      ["queries", "Query aktif", Activity],
                    ] as const
                  ).map(([id, label, Icon]) => (
                    <button
                      key={id}
                      role="tab"
                      aria-selected={panel === id}
                      onClick={() => setPanel(id)}
                      className={cn(
                        "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
                        panel === id && "bg-muted text-foreground",
                      )}
                    >
                      <Icon className="size-4" /> <span className="hidden sm:inline">{label}</span>
                      {id === "queries" && !!sel.active && <Badge variant="warning">{sel.active}</Badge>}
                    </button>
                  ))}
                </div>
              </CardAction>
            )}
          </CardHeader>
          <CardContent className="px-3 sm:px-6">
            {panel === "queries" && sel.kind !== "sqlite" ? <QueriesPanel key={sel.id} source={sel} active={active} /> : <TablesPanel key={sel.id} source={sel} />}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

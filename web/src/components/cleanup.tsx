import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Eraser, LoaderCircle, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, postJson } from "@/lib/api";
import { fmtBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

type Item = {
  pid: number;
  start: number;
  name: string;
  cmd: string;
  ageSec: number;
  rssBytes: number;
  processes: number;
  listens: string[];
  kind?: "safe" | "unknown";
  reason: string;
};
type Scan = { candidates: Item[]; protected: Item[]; protectedGroups: { label: string; count: number }[] };
type KillResult = { pid: number; name?: string; ok: boolean; rssBytes?: number; message: string };

function fmtAge(sec: number) {
  if (sec < 3600) return `${Math.round(sec / 60)} menit`;
  if (sec < 86400) return `${Math.round(sec / 3600)} jam`;
  return `${Math.round(sec / 86400)} hari`;
}

function Row({ item, checked, onToggle }: { item: Item; checked?: boolean; onToggle?: (v: boolean) => void }) {
  return (
    <label className={cn("flex gap-3 rounded-lg border p-3", onToggle && "cursor-pointer hover:bg-accent/40", checked && "border-primary/40 bg-primary/5")}>
      {onToggle && <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={checked} onChange={(e) => onToggle(e.target.checked)} />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{item.name}</span>
          <span className="font-mono text-xs text-muted-foreground">PID {item.pid}</span>
          {item.processes > 1 && <span className="text-xs text-muted-foreground">+{item.processes - 1} anak</span>}
          <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground">
            {fmtBytes(item.rssBytes)} · {fmtAge(item.ageSec)}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{item.reason}</p>
        <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground/80" title={item.cmd}>
          {item.cmd}
        </p>
      </div>
    </label>
  );
}

export function CleanupButton() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [killing, setKilling] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showProtected, setShowProtected] = useState(false);
  const [results, setResults] = useState<KillResult[] | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const d = await api<Scan>("/api/cleanup");
      setScan(d);
      setSelected(new Set(d.candidates.filter((c) => c.kind === "safe").map((c) => c.pid)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function kill() {
    if (!scan) return;
    const targets = scan.candidates.filter((c) => selected.has(c.pid)).map(({ pid, start }) => ({ pid, start }));
    setKilling(true);
    try {
      const d = await postJson<{ results: KillResult[] }>("/api/cleanup/kill", { targets });
      setResults(d.results);
      const freed = d.results.filter((r) => r.ok).reduce((n, r) => n + (r.rssBytes || 0), 0);
      const okCount = d.results.filter((r) => r.ok).length;
      if (okCount) toast.success(`${okCount} proses dihentikan, ±${fmtBytes(freed)} RAM dibebaskan`);
      if (okCount < d.results.length) toast.warning(`${d.results.length - okCount} proses tidak dihentikan, lihat rinciannya`);
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setKilling(false);
    }
  }

  const safe = scan?.candidates.filter((c) => c.kind === "safe") || [];
  const unknown = scan?.candidates.filter((c) => c.kind !== "safe") || [];
  const chosen = scan?.candidates.filter((c) => selected.has(c.pid)) || [];
  const chosenBytes = chosen.reduce((n, c) => n + c.rssBytes, 0);
  const protectedTotal = (scan?.protectedGroups.reduce((n, g) => n + g.count, 0) || 0) + (scan?.protected.length || 0);
  const toggle = (pid: number, v: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (v) n.add(pid);
      else n.delete(pid);
      return n;
    });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(true);
          setResults(null);
          setShowProtected(false);
          load();
        }}
      >
        <Eraser /> Bersihkan proses
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[88svh] max-w-2xl flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Bersihkan proses tak terpakai</DialogTitle>
            <DialogDescription>
              Hanya proses yatim (sisa terminal atau skrip yang sudah selesai) yang tidak dipakai atau dirujuk sistem lain. Service, timer, cron, container, dan terminal web tidak pernah
              disentuh.
            </DialogDescription>
          </DialogHeader>

          <div className="-mx-1 flex-1 overflow-y-auto px-1">
            {loading && !scan && (
              <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" /> Memeriksa proses dan pemakaian CPU…
              </div>
            )}
            {error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

            {results && (
              <div className="mb-4 flex flex-col gap-1 rounded-lg border bg-muted/30 p-3 text-sm">
                <p className="font-medium">Hasil</p>
                {results.map((r) => (
                  <p key={r.pid} className={r.ok ? "text-success" : "text-warning"}>
                    {r.ok ? "✓" : "•"} {r.name || `PID ${r.pid}`}: {r.message}
                  </p>
                ))}
              </div>
            )}

            {scan && (
              <div className="flex flex-col gap-5">
                <section className="flex flex-col gap-2">
                  <h3 className="text-sm font-semibold">Aman dibersihkan ({safe.length})</h3>
                  {safe.map((c) => (
                    <Row key={c.pid} item={c} checked={selected.has(c.pid)} onToggle={(v) => toggle(c.pid, v)} />
                  ))}
                  {!safe.length && <p className="text-sm text-muted-foreground">Tidak ada. Server sudah bersih dari sisa proses yang dikenal.</p>}
                </section>

                {unknown.length > 0 && (
                  <section className="flex flex-col gap-2">
                    <h3 className="flex items-center gap-2 text-sm font-semibold">
                      Perlu diperiksa ({unknown.length}) <Badge variant="warning">tidak dicentang otomatis</Badge>
                    </h3>
                    {unknown.map((c) => (
                      <Row key={c.pid} item={c} checked={selected.has(c.pid)} onToggle={(v) => toggle(c.pid, v)} />
                    ))}
                  </section>
                )}

                <section>
                  <button type="button" className="flex w-full cursor-pointer items-center gap-2 text-left text-sm font-semibold" onClick={() => setShowProtected((v) => !v)}>
                    <ShieldCheck className="size-4 text-success" /> Dilindungi ({protectedTotal})
                    <ChevronDown className={cn("ml-auto size-4 transition-transform", showProtected && "rotate-180")} />
                  </button>
                  {showProtected && (
                    <div className="mt-2 flex flex-col gap-2">
                      {scan.protected.map((c) => (
                        <Row key={c.pid} item={c} />
                      ))}
                      <div className="grid gap-x-4 gap-y-1 rounded-lg border p-3 text-sm sm:grid-cols-2">
                        {scan.protectedGroups.map((g) => (
                          <div key={g.label} className="flex justify-between gap-2">
                            <span className="truncate text-muted-foreground">{g.label}</span>
                            <span className="tabular">{g.count}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Tutup
            </Button>
            <Button variant="destructive" disabled={!chosen.length || killing || loading} onClick={kill}>
              {killing && <LoaderCircle className="animate-spin" />}
              {chosen.length ? `Hentikan ${chosen.length} proses · ±${fmtBytes(chosenBytes)}` : "Pilih proses"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

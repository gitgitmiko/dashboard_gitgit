import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, GitBranch, LoaderCircle, Play, Search, Smartphone, Square, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorNote, RefreshButton } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, postJson } from "@/lib/api";
import { useAsk } from "@/lib/dialogs";
import { requestFocusTerminal } from "@/lib/terminal-bus";
import { cn } from "@/lib/utils";

type Active = {
  pid: number | null;
  terminalId: string | null;
  terminalTitle: string | null;
  startedHere: boolean;
  starting?: boolean;
  link: string | null;
  capacity: { used: number; max: number } | null;
};
type Repo = { name: string; path: string; branch: string; active: Active[] };
type Status = { repos: Repo[]; terminals: number; maxTerm: number };

function RepoCard({ repo, onStart, onStop, busy }: { repo: Repo; onStart: () => void; onStop: () => void; busy: boolean }) {
  const a = repo.active[0];
  const on = Boolean(a);
  const starting = on && (a.starting || !a.link);
  return (
    <Card className={cn("gap-3 py-4 transition-colors", on && "border-success/40")}>
      <CardContent className="flex flex-col gap-3 px-4">
        <div className="flex items-start gap-3">
          <div className={cn("mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg", on ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")}>
            <Smartphone className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold" title={repo.name}>
              {repo.name}
            </p>
            <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
              <GitBranch className="size-3 shrink-0" />
              {repo.branch || "—"}
            </p>
          </div>
          {on ? (
            starting ? (
              <Badge variant="warning" className="gap-1.5">
                <LoaderCircle className="animate-spin" /> Memulai
              </Badge>
            ) : (
              <Badge variant="success" className="gap-1.5">
                <span className="size-1.5 rounded-full bg-success" /> Aktif
              </Badge>
            )
          ) : (
            <Badge variant="outline">Tidak aktif</Badge>
          )}
        </div>

        {on && (
          <p className="text-xs text-muted-foreground">
            {a.capacity ? `${a.capacity.used} sesi dipakai dari ${a.capacity.max}` : starting ? "Menunggu link sesi dari Claude…" : ""}
            {a.terminalTitle ? ` · ${a.terminalTitle}` : " · dijalankan di luar dashboard"}
            {repo.active.length > 1 && ` · ${repo.active.length} proses`}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {!on && (
            <Button size="sm" onClick={onStart} disabled={busy}>
              {busy ? <LoaderCircle className="animate-spin" /> : <Play />} Mulai sesi remote
            </Button>
          )}
          {on && a.link && (
            <Button size="sm" asChild>
              <a href={a.link} target="_blank" rel="noopener">
                Buka di Claude <ArrowUpRight />
              </a>
            </Button>
          )}
          {on && a.terminalId && (
            <Button size="sm" variant="outline" onClick={() => requestFocusTerminal(a.terminalId!)}>
              <SquareTerminal /> Lihat terminal
            </Button>
          )}
          {on && (
            <Button size="sm" variant="outline-destructive" onClick={onStop} disabled={busy}>
              {busy ? <LoaderCircle className="animate-spin" /> : <Square />} Matikan
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function RemoteClaude({ active }: { active: boolean }) {
  const ask = useAsk();
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["remote-claude"],
    queryFn: () => api<Status>("/api/remote-claude"),
    // Lebih rapat selama ada sesi yang sedang memulai (menunggu link muncul).
    refetchInterval: (q) => (!active ? false : q.state.data?.repos.some((r) => r.active.some((a) => a.starting || !a.link)) ? 2000 : 8000),
  });

  async function start(repo: Repo) {
    setBusy(repo.name);
    try {
      await postJson("/api/remote-claude/start", { repo: repo.name });
      toast.success(`Sesi remote ${repo.name} dimulai. Sebentar lagi muncul di aplikasi Claude.`);
      await refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function stop(repo: Repo) {
    const a = repo.active[0];
    const yes = await ask({
      title: `Matikan sesi remote ${repo.name}?`,
      description:
        "Sesi Claude yang sedang dipakai dari HP untuk project ini akan terputus." +
        (a?.startedHere ? "\nTerminalnya ikut ditutup." : "\nTerminal tempat sesi ini berjalan tidak ditutup, hanya proses claude-nya yang dihentikan."),
      confirmLabel: "Matikan",
      destructive: true,
    });
    if (!yes) return;
    setBusy(repo.name);
    try {
      await postJson("/api/remote-claude/stop", { repo: repo.name });
      toast.success(`Sesi remote ${repo.name} dimatikan`);
      setTimeout(() => refetch(), 2000);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const q = filter.trim().toLowerCase();
  const repos = (data?.repos || []).filter((r) => !q || r.name.toLowerCase().includes(q));
  const activeRepos = repos.filter((r) => r.active.length);
  const idleRepos = repos.filter((r) => !r.active.length);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <p className="flex-1 text-sm text-muted-foreground">
          Satu klik = buka terminal di root project lalu jalankan <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">claude remote-control</code>. Sesinya bisa langsung dipakai
          dari aplikasi Claude di HP.
        </p>
        <div className="flex items-center gap-2">
          <div className="relative w-full sm:w-56">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Cari project…" className="h-8 pl-8" />
          </div>
          <RefreshButton onClick={() => refetch()} busy={isFetching} />
        </div>
      </div>
      <ErrorNote>{error?.message}</ErrorNote>
      {data && (
        <p className="text-xs text-muted-foreground">
          {data.repos.filter((r) => r.active.length).length} project aktif · terminal terbuka {data.terminals}/{data.maxTerm}
        </p>
      )}

      {!data && !error && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      )}

      {activeRepos.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-muted-foreground">Aktif</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {activeRepos.map((r) => (
              <RepoCard key={r.name} repo={r} busy={busy === r.name} onStart={() => start(r)} onStop={() => stop(r)} />
            ))}
          </div>
        </section>
      )}

      {idleRepos.length > 0 && (
        <section className="flex flex-col gap-3">
          {activeRepos.length > 0 && <h2 className="text-sm font-semibold text-muted-foreground">Project lain</h2>}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {idleRepos.map((r) => (
              <RepoCard key={r.name} repo={r} busy={busy === r.name} onStart={() => start(r)} onStop={() => stop(r)} />
            ))}
          </div>
        </section>
      )}

      {data && !repos.length && <p className="py-10 text-center text-sm text-muted-foreground">{q ? "Tidak ada project yang cocok." : "Tidak ada repo git di github-repos."}</p>}
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Gamepad2, GitCommitHorizontal, LoaderCircle, Megaphone, Send, Smartphone, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorNote, RefreshButton } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, BASE, postJson } from "@/lib/api";
import { useAsk } from "@/lib/dialogs";
import { fmtDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type AnnType = "update" | "bugfix" | "info";
type Announcement = { id: string; title: string; body: string; type: AnnType; version: string | null; publishedAt: string | null };
type Commit = { hash: string; date: string; subject: string; body: string; kind: string; userFacing: boolean };
type PlayTrack = "closed" | "none" | "private";
type AppSummary = {
  id: string;
  name: string;
  kind: "app" | "game";
  platform: string;
  packageName: string;
  repo: string;
  playTrack: PlayTrack;
  hasIcon: boolean;
  hasAnnouncements: boolean;
  versionName: string | null;
  versionCode: number | null;
  lastCommit: { hash: string; date: string; subject: string } | null;
};
type App = AppSummary & {
  announcements: Announcement[];
  announcementsError: string | null;
  lastAnnouncement: Announcement | null;
  commits: Commit[];
};
type Draft = { type: AnnType; title: string; body: string; version: string };

const TYPE_LABEL: Record<AnnType, string> = { update: "Update", bugfix: "Perbaikan", info: "Info" };

const PLAY_TRACK: Record<PlayTrack, { label: string; variant: "success" | "outline" | "secondary" }> = {
  closed: { label: "Play: uji tertutup", variant: "success" },
  none: { label: "Belum di Play Store", variant: "outline" },
  private: { label: "Pribadi, tidak dirilis", variant: "secondary" },
};

function AppIcon({ app, className }: { app: AppSummary; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (app.hasIcon && !broken)
    return <img src={`${BASE}/api/apps/${app.id}/icon`} alt="" onError={() => setBroken(true)} className={cn("rounded-2xl object-cover", className)} />;
  const Icon = app.kind === "game" ? Gamepad2 : Smartphone;
  return (
    <div className={cn("flex items-center justify-center rounded-2xl bg-muted text-muted-foreground", className)}>
      <Icon className="size-1/2" />
    </div>
  );
}

function versionLabel(app: AppSummary) {
  if (!app.versionName) return null;
  return `v${app.versionName}${app.versionCode ? ` (${app.versionCode})` : ""}`;
}

function AppRow({ app, onOpen }: { app: AppSummary; onOpen: () => void }) {
  const pending = "commits" in app ? (app as App).commits.filter((c) => c.userFacing).length : 0;
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50">
      <AppIcon app={app} className="size-10 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{app.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {[versionLabel(app), PLAY_TRACK[app.playTrack].label].filter(Boolean).join(" · ")}
        </p>
      </div>
      {pending > 0 && <Badge variant="warning">{pending} baru</Badge>}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function AppList({ title, apps, onOpen }: { title: string; apps: AppSummary[]; onOpen: (id: string) => void }) {
  if (!apps.length) return null;
  const closed = apps.filter((a) => a.playTrack === "closed").length;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        {title} ({apps.length}){closed ? ` · ${closed} uji tertutup` : ""}
      </p>
      <Card className="gap-0 divide-y overflow-hidden py-0">
        {apps.map((a) => (
          <AppRow key={a.id} app={a} onOpen={() => onOpen(a.id)} />
        ))}
      </Card>
    </div>
  );
}

function AppDetail({ app, refetch }: { app: AppSummary | App; refetch: () => void }) {
  const track = PLAY_TRACK[app.playTrack];
  const version = versionLabel(app);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <DialogHeader className="flex-row items-center gap-3">
        <AppIcon app={app} className="size-14 shrink-0" />
        <div className="min-w-0">
          <DialogTitle className="leading-tight break-words">{app.name}</DialogTitle>
          <DialogDescription className="mt-1 text-xs break-all sm:text-sm">
            {app.platform} · {app.packageName}
          </DialogDescription>
        </div>
      </DialogHeader>
      <div className="flex flex-wrap gap-1.5">
        <Badge variant={track.variant}>{track.label}</Badge>
        {version && <Badge variant="secondary">{version}</Badge>}
      </div>
      <dl className="grid grid-cols-1 gap-x-3 gap-y-0.5 text-sm sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-y-1">
        <dt className="text-muted-foreground">Repo</dt>
        <dd className="mb-2 font-mono text-xs leading-5 break-all sm:mb-0">{app.repo}</dd>
        <dt className="text-muted-foreground">Commit terakhir</dt>
        <dd className="min-w-0">
          {app.lastCommit ? (
            <>
              <p className="break-words">{app.lastCommit.subject}</p>
              <p className="text-xs text-muted-foreground">
                {app.lastCommit.hash} · {fmtDateTime(app.lastCommit.date)}
              </p>
            </>
          ) : (
            <span className="text-muted-foreground">Belum pakai git</span>
          )}
        </dd>
      </dl>
      {app.hasAnnouncements && <AppPanel app={app as App} refetch={refetch} />}
    </div>
  );
}

/** Meniru kartu Info developer di tab Hub aplikasi, supaya hasilnya terlihat sebelum diposting. */
function AnnouncementPreview({ a, footer }: { a: Pick<Announcement, "title" | "body" | "type" | "version" | "publishedAt">; footer?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[#FFD23F]/40 bg-[#1E1C26] p-4 text-[#F2EFE6]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold tracking-wide text-[#FFD23F]">INFO DEVELOPER</span>
        <span className="shrink-0 rounded-full bg-[#3A3220] px-2.5 py-0.5 text-xs text-[#FFD23F]">{TYPE_LABEL[a.type] ?? a.type}</span>
      </div>
      <p className="font-semibold break-words">{a.title || "Judul"}</p>
      <p className="mt-1 text-sm break-words whitespace-pre-line text-[#CAC4D6]">{a.body || "Isi info developer…"}</p>
      <div className="mt-3 flex items-center justify-between gap-2 text-xs text-[#9a93ab]">
        <span>
          {a.version ? `v${a.version} · ` : ""}
          {a.publishedAt ? fmtDateTime(a.publishedAt) : "baru"}
        </span>
        {footer}
      </div>
    </div>
  );
}

function kindVariant(kind: string): "success" | "warning" | "outline" {
  return kind === "feat" ? "success" : kind === "fix" ? "warning" : "outline";
}

function AppPanel({ app, refetch }: { app: App; refetch: () => void }) {
  const ask = useAsk();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [posting, setPosting] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const userFacing = app.commits.filter((c) => c.userFacing).length;

  async function makeDraft() {
    setDrafting(true);
    try {
      const res = await postJson<{ draft: Draft & { warning?: string } }>(`/api/apps/${app.id}/draft`, {});
      setDraft({ type: res.draft.type, title: res.draft.title, body: res.draft.body, version: res.draft.version ?? app.versionName ?? "" });
      if (res.draft.warning) toast.warning(res.draft.warning);
      else toast.success("Draf siap. Periksa dulu sebelum diposting.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDrafting(false);
    }
  }

  async function post() {
    if (!draft) return;
    const yes = await ask({
      title: "Posting ke Info developer?",
      description: `Kartu "${draft.title}" langsung tampil di tab Hub untuk semua pengguna ${app.name}, termasuk yang belum update aplikasi.`,
      confirmLabel: "Posting",
    });
    if (!yes) return;
    setPosting(true);
    try {
      await postJson(`/api/apps/${app.id}/announcements`, draft);
      toast.success("Info developer sudah tayang");
      setDraft(null);
      refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPosting(false);
    }
  }

  async function remove(a: Announcement) {
    const yes = await ask({
      title: "Hapus kartu ini?",
      description: `"${a.title}" hilang dari tab Hub semua pengguna.`,
      confirmLabel: "Hapus",
      destructive: true,
    });
    if (!yes) return;
    setDeleting(a.id);
    try {
      await postJson(`/api/apps/${app.id}/announcements/delete`, { id: a.id });
      toast.success("Kartu dihapus");
      refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="flex items-center gap-1.5 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        <Megaphone className="size-3.5" /> Info developer
      </p>
      <div className="flex flex-wrap gap-2">
        {app.lastAnnouncement ? (
          <Badge variant="outline">Info terakhir: {app.lastAnnouncement.version ? `v${app.lastAnnouncement.version}` : fmtDateTime(app.lastAnnouncement.publishedAt)}</Badge>
        ) : (
          <Badge variant="outline">Belum ada info</Badge>
        )}
        {userFacing > 0 && <Badge variant="warning">{userFacing} perubahan belum diumumkan</Badge>}
      </div>
      <ErrorNote>{app.announcementsError}</ErrorNote>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="gap-3 py-4">
            <CardContent className="flex flex-col gap-3 px-4">
              <div className="flex items-center gap-2">
                <GitCommitHorizontal className="size-4 text-muted-foreground" />
                <p className="min-w-0 flex-1 leading-snug font-semibold">Perubahan sejak info terakhir</p>
                <span className="shrink-0 text-xs text-muted-foreground">{app.commits.length} commit</span>
              </div>
              {app.commits.length === 0 ? (
                <p className="text-sm text-muted-foreground">Semua perubahan sudah diumumkan.</p>
              ) : (
                <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
                  {app.commits.map((c) => (
                    <li key={c.hash} className={cn("flex items-start gap-2 text-sm", !c.userFacing && "opacity-60")}>
                      <Badge variant={kindVariant(c.kind)} className="mt-0.5 shrink-0 font-mono">
                        {c.kind}
                      </Badge>
                      <div className="min-w-0">
                        <p className="break-words">{c.subject.replace(/^\w+(\(.+\))?!?:\s*/, "")}</p>
                        <p className="text-xs text-muted-foreground">
                          {c.hash} · {fmtDateTime(c.date)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <Button onClick={makeDraft} disabled={drafting || app.commits.length === 0} className="w-full sm:w-auto sm:self-start">
                {drafting ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
                {drafting ? "Claude sedang menulis…" : draft ? "Buat ulang draf" : "Buat draf Info developer"}
              </Button>
            </CardContent>
          </Card>

          {draft && (
            <Card className="gap-3 py-4">
              <CardContent className="flex flex-col gap-3 px-4">
                <p className="font-semibold">Draf</p>
                <div className="flex flex-wrap gap-2">
                  <NativeSelect value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as AnnType })} className="w-36">
                    <option value="update">Update</option>
                    <option value="bugfix">Perbaikan</option>
                    <option value="info">Info</option>
                  </NativeSelect>
                  <Input value={draft.version} onChange={(e) => setDraft({ ...draft, version: e.target.value })} placeholder="Versi" className="h-8 w-28" />
                </div>
                <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Judul" maxLength={120} />
                <textarea
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  rows={6}
                  maxLength={2000}
                  className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
                />
                <div className="flex flex-wrap gap-2">
                  <Button onClick={post} disabled={posting || !draft.title.trim() || !draft.body.trim()}>
                    {posting ? <LoaderCircle className="animate-spin" /> : <Send />} Posting ke Firestore
                  </Button>
                  <Button variant="ghost" onClick={() => setDraft(null)} disabled={posting}>
                    Batal
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {draft && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Pratinjau di aplikasi</p>
              <AnnouncementPreview a={{ ...draft, publishedAt: null }} />
            </div>
          )}
          <div className="flex flex-col gap-2">
            <p className="flex items-center gap-1.5 text-xs font-medium tracking-wider text-muted-foreground uppercase">
              <Megaphone className="size-3.5" /> Sedang tayang ({app.announcements.length})
            </p>
            {app.announcements.length === 0 && <p className="text-sm text-muted-foreground">Belum ada kartu.</p>}
            {app.announcements.map((a) => (
              <AnnouncementPreview
                key={a.id}
                a={a}
                footer={
                  <button
                    type="button"
                    onClick={() => remove(a)}
                    disabled={deleting === a.id}
                    className="flex items-center gap-1 text-[#ff8a8a] hover:underline disabled:opacity-50"
                  >
                    {deleting === a.id ? <LoaderCircle className="size-3 animate-spin" /> : <Trash2 className="size-3" />} Hapus
                  </button>
                }
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Apps({ active }: { active: boolean }) {
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["apps"],
    queryFn: () => api<{ apps: (AppSummary | App)[] }>("/api/apps"),
    enabled: active,
    refetchInterval: active ? 60_000 : false,
  });

  const [openId, setOpenId] = useState<string | null>(null);
  const apps = data?.apps ?? [];
  const openApp = apps.find((a) => a.id === openId) ?? null;
  // Uji tertutup dulu, lalu yang belum rilis, terakhir yang pribadi.
  const order: PlayTrack[] = ["closed", "none", "private"];
  const sorted = [...apps].sort((a, b) => order.indexOf(a.playTrack) - order.indexOf(b.playTrack));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-sm text-muted-foreground">
          Aplikasi dan game milikmu: versi terbaru, status Play Store, dan kartu Info developer. Draf ditulis Claude dari commit, lalu sekali klik langsung tayang di aplikasi.
        </p>
        <RefreshButton onClick={() => refetch()} busy={isFetching} />
      </div>
      <ErrorNote>{error?.message}</ErrorNote>
      {!data && !error && <Skeleton className="h-64 w-full" />}
      <AppList title="Aplikasi" apps={sorted.filter((a) => a.kind === "app")} onOpen={setOpenId} />
      <AppList title="Game" apps={sorted.filter((a) => a.kind === "game")} onOpen={setOpenId} />
      <Dialog open={!!openApp} onOpenChange={(o) => !o && setOpenId(null)}>
        <DialogContent className={cn("max-h-[90dvh] w-[calc(100%-1.5rem)] p-4 sm:p-5", openApp?.hasAnnouncements && "max-w-5xl")}>{openApp && <AppDetail app={openApp} refetch={() => refetch()} />}</DialogContent>
      </Dialog>
    </div>
  );
}

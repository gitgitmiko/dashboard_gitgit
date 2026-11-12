import { useQuery } from "@tanstack/react-query";
import { GitCommitHorizontal, LoaderCircle, Megaphone, Send, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorNote, RefreshButton } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
type App = {
  id: string;
  name: string;
  platform: string;
  packageName: string;
  versionName: string | null;
  versionCode: number | null;
  announcements: Announcement[];
  announcementsError: string | null;
  lastAnnouncement: Announcement | null;
  commits: Commit[];
};
type Draft = { type: AnnType; title: string; body: string; version: string };

const TYPE_LABEL: Record<AnnType, string> = { update: "Update", bugfix: "Perbaikan", info: "Info" };

/** Meniru kartu Info developer di tab Hub aplikasi, supaya hasilnya terlihat sebelum diposting. */
function AnnouncementPreview({ a, footer }: { a: Pick<Announcement, "title" | "body" | "type" | "version" | "publishedAt">; footer?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[#FFD23F]/40 bg-[#1E1C26] p-4 text-[#F2EFE6]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold tracking-wide text-[#FFD23F]">INFO DEVELOPER</span>
        <span className="rounded-full bg-[#3A3220] px-2.5 py-0.5 text-xs text-[#FFD23F]">{TYPE_LABEL[a.type] ?? a.type}</span>
      </div>
      <p className="font-semibold">{a.title || "Judul"}</p>
      <p className="mt-1 text-sm whitespace-pre-line text-[#CAC4D6]">{a.body || "Isi info developer…"}</p>
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
    <div className="flex flex-col gap-4">
      <Card className="py-4">
        <CardContent className="flex flex-wrap items-center gap-4 px-4">
          <img src={`${BASE}/api/apps/${app.id}/icon`} alt="" className="size-14 rounded-2xl" />
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold">{app.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {app.platform} · {app.packageName}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">
              v{app.versionName} ({app.versionCode})
            </Badge>
            {app.lastAnnouncement ? (
              <Badge variant="outline">Info terakhir: {app.lastAnnouncement.version ? `v${app.lastAnnouncement.version}` : fmtDateTime(app.lastAnnouncement.publishedAt)}</Badge>
            ) : (
              <Badge variant="outline">Belum ada info</Badge>
            )}
            {userFacing > 0 && <Badge variant="warning">{userFacing} perubahan belum diumumkan</Badge>}
          </div>
        </CardContent>
      </Card>
      <ErrorNote>{app.announcementsError}</ErrorNote>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <Card className="gap-3 py-4">
            <CardContent className="flex flex-col gap-3 px-4">
              <div className="flex items-center gap-2">
                <GitCommitHorizontal className="size-4 text-muted-foreground" />
                <p className="flex-1 font-semibold">Perubahan sejak info terakhir</p>
                <span className="text-xs text-muted-foreground">{app.commits.length} commit</span>
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
              <Button onClick={makeDraft} disabled={drafting || app.commits.length === 0} className="self-start">
                {drafting ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
                {drafting ? "Claude sedang menulis…" : draft ? "Buat ulang draf" : "Buat draf Info developer"}
              </Button>
            </CardContent>
          </Card>

          {draft && (
            <Card className="gap-3 py-4">
              <CardContent className="flex flex-col gap-3 px-4">
                <p className="font-semibold">Draf</p>
                <div className="flex gap-2">
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

        <div className="flex flex-col gap-4">
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
    queryFn: () => api<{ apps: App[] }>("/api/apps"),
    enabled: active,
    refetchInterval: active ? 60_000 : false,
  });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-sm text-muted-foreground">
          Aplikasi milikmu: versi terbaru, perubahan yang belum diumumkan, dan kartu Info developer. Draf ditulis Claude dari commit, lalu sekali klik langsung tayang di aplikasi.
        </p>
        <RefreshButton onClick={() => refetch()} busy={isFetching} />
      </div>
      <ErrorNote>{error?.message}</ErrorNote>
      {!data && !error && <Skeleton className="h-64 w-full" />}
      {data?.apps.map((app) => <AppPanel key={app.id} app={app} refetch={() => refetch()} />)}
    </div>
  );
}

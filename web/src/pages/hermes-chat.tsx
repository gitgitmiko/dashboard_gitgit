import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, BarChart3, BookOpen, Brain, Check, ChevronRight, Cpu, FilePen, FilePlus, FileText, FolderTree, GitBranch, Globe, ListTodo, LoaderCircle,
  MessageSquarePlus, Paperclip, Search, SendHorizontal, ShieldAlert, Square, SquareTerminal, Trash2, TriangleAlert, Users, X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ErrorNote } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, BASE, postJson, qs } from "@/lib/api";
import { useAsk } from "@/lib/dialogs";
import { useMedia } from "@/lib/use-media";
import { cn } from "@/lib/utils";

// Tab "Hermes Chat": the Hermes agent (same one as on Telegram/WhatsApp: memory, skills, tools, free-model fallback)
// per repo. Hermes runs the turn through its API server; hermes-chat.js follows it and this page follows hermes-chat.js
// over Server-Sent Events.

type Repo = { name: string; branch: string; conversations: number; running: boolean; updated: number };
type Att = { path: string; name: string; size: number; image: boolean };
type Pending = Partial<Att> & { key: string; name: string; preview?: string; busy: boolean };

type Conv = { id: string; title: string; updated: number; running: boolean; tokens?: number };
type Ev =
  | { t: "user"; text: string; model?: string; files?: Att[] }
  | { t: "thinking" | "text" | "note" | "error"; text: string }
  | { t: "tool"; id: string; name: string; label: string; status: "run" | "ok" | "err"; output?: string; diff?: { old: string; new: string } }
  | { t: "approval"; requestId: string; command: string; text: string; choices: string[]; status: string }
  | { t: "done" };

const LS_REPO = "dg-hermes-repo";

function ago(ms: number) {
  if (!ms) return "";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "baru saja";
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return new Date(ms).toLocaleDateString("id-ID", { day: "numeric", month: "short" });
}

const fileUrl = (path: string) => `${BASE}/api/hermes/file${qs({ path })}`;
const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Phone photos are shrunk before upload (long side 1600 px, JPEG) so the model can look at them. */
async function shrinkImage(file: File): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1_200_000) return file;
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise<Blob>((ok) => c.toBlob((b) => ok(b || file), "image/jpeg", 0.85));
  } catch {
    return file;
  }
}

function FileChips({ files }: { files: Att[] }) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {files.map((f) =>
        f.image ? (
          <a key={f.path} href={fileUrl(f.path)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border">
            <img src={fileUrl(f.path)} alt={f.name} className="h-28 max-w-[200px] object-cover" />
          </a>
        ) : (
          <a key={f.path} href={fileUrl(f.path)} className="flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-xs">
            <FileText className="size-3.5 text-muted-foreground" /> <span className="max-w-[180px] truncate">{f.name}</span>
            <span className="text-muted-foreground">{kb(f.size)}</span>
          </a>
        ),
      )}
    </div>
  );
}

// ------------------------------------------------------------------ light markdown: code blocks, inline code, bold, headings, lists
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|_[^_\n]+_)/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) out.push(<code key={`${key}-${k++}`} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**")) out.push(<strong key={`${key}-${k++}`}>{tok.slice(2, -2)}</strong>);
    else out.push(<em key={`${key}-${k++}`}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ text }: { text: string }) {
  const parts = text.split(/```/);
  return (
    <div className="space-y-2 text-sm leading-relaxed break-words">
      {parts.map((part, i) => {
        if (i % 2 === 1) {
          const nl = part.indexOf("\n");
          const code = nl >= 0 ? part.slice(nl + 1) : part;
          return <pre key={i} className="overflow-x-auto rounded-lg border bg-muted/60 p-3 font-mono text-xs leading-relaxed">{code.replace(/\n$/, "")}</pre>;
        }
        const blocks = part.split(/\n{2,}/).filter((b) => b.trim());
        return (
          <Fragment key={i}>
            {blocks.map((b, j) => {
              const lines = b.split("\n");
              if (lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l) || !l.trim())) {
                const ordered = /^\s*\d+\./.test(lines[0]);
                const L = ordered ? "ol" : "ul";
                return (
                  <L key={j} start={ordered ? Number(/\d+/.exec(lines[0])![0]) : undefined} className={cn("space-y-1 pl-5", ordered ? "list-decimal" : "list-disc")}>
                    {lines.filter((l) => l.trim()).map((l, k) => <li key={k}>{inline(l.replace(/^\s*([-*]|\d+\.)\s/, ""), `${i}-${j}-${k}`)}</li>)}
                  </L>
                );
              }
              const h = /^(#{1,4})\s+(.*)/.exec(lines[0]);
              if (h && lines.length === 1) return <p key={j} className="font-semibold">{inline(h[2], `${i}-${j}`)}</p>;
              return <p key={j} className="whitespace-pre-wrap">{inline(b, `${i}-${j}`)}</p>;
            })}
          </Fragment>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ one event
const TOOL_ICON: Record<string, typeof FileText> = {
  read_file: FileText, write_file: FilePlus, patch: FilePen, edit_file: FilePen, search_files: Search, list_dir: FolderTree,
  terminal: SquareTerminal, process: SquareTerminal, execute_code: SquareTerminal, web_search: Globe, web_extract: Globe,
  vision_analyze: FileText, todo: ListTodo, memory: Brain, skill_view: BookOpen, skills_list: BookOpen, delegate_task: Users,
};
const TOOL_VERB: Record<string, string> = {
  read_file: "Membaca", write_file: "Menulis", patch: "Mengubah", edit_file: "Mengubah", search_files: "Mencari", list_dir: "Melihat folder",
  terminal: "Menjalankan", process: "Proses", execute_code: "Menjalankan kode", web_search: "Mencari di web", web_extract: "Membuka web",
  vision_analyze: "Melihat gambar", todo: "Daftar tugas", memory: "Memori", skill_view: "Membuka skill", skills_list: "Daftar skill",
  delegate_task: "Mendelegasikan",
};
const toolIcon = (name: string) => TOOL_ICON[name] || (name.startsWith("browser_") ? Globe : SquareTerminal);
const toolVerb = (name: string) => TOOL_VERB[name] || (name.startsWith("browser_") ? `Browser · ${name.slice(8)}` : name);

function ToolCard({ ev }: { ev: Extract<Ev, { t: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(ev.name);
  return (
    <div className={cn("rounded-lg border bg-card text-xs", ev.status === "err" && "border-destructive/40")}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">{toolVerb(ev.name)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{ev.label}</span>
        {ev.status === "run" ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" />
          : ev.status === "ok" ? <Check className="size-3.5 shrink-0 text-success" /> : <X className="size-3.5 shrink-0 text-destructive" />}
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          {ev.name === "terminal" && <pre className="overflow-x-auto font-mono whitespace-pre-wrap text-foreground">$ {ev.label}</pre>}
          {ev.diff && (
            <div className="overflow-x-auto rounded border font-mono">
              <pre className="bg-destructive/10 px-2 py-1 whitespace-pre-wrap text-destructive">{ev.diff.old.split("\n").map((l) => `- ${l}`).join("\n")}</pre>
              <pre className="bg-success/10 px-2 py-1 whitespace-pre-wrap text-success">{ev.diff.new.split("\n").map((l) => `+ ${l}`).join("\n")}</pre>
            </div>
          )}
          {ev.output && <pre className="max-h-80 overflow-auto font-mono whitespace-pre-wrap text-muted-foreground">{ev.output}</pre>}
          {!ev.output && ev.status === "run" && <p className="text-muted-foreground">Berjalan…</p>}
        </div>
      )}
    </div>
  );
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs text-muted-foreground">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 hover:text-foreground">
        <Brain className={cn("size-3.5", live && "animate-pulse text-primary")} />
        {live ? "Berpikir…" : "Proses berpikir"}
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
      </button>
      {open && <p className="mt-1 border-l-2 pl-3 whitespace-pre-wrap">{text}</p>}
    </div>
  );
}

const CHOICE_LABEL: Record<string, string> = { once: "Izinkan sekali", session: "Izinkan di percakapan ini", always: "Selalu izinkan", deny: "Tolak" };

function ApprovalCard({ ev, onAnswer }: { ev: Extract<Ev, { t: "approval" }>; onAnswer?: (choice: string, requestId: string) => Promise<void> }) {
  const [busy, setBusy] = useState("");
  const pending = ev.status === "pending";
  return (
    <div className={cn("space-y-2 rounded-lg border px-3 py-2.5 text-sm", pending ? "border-warning/50 bg-warning/10" : "bg-card")}>
      <p className="flex items-center gap-2 font-medium"><ShieldAlert className="size-4 shrink-0 text-warning" /> Hermes minta persetujuan</p>
      {ev.text && <p className="text-muted-foreground">{ev.text}</p>}
      {ev.command && <pre className="overflow-x-auto rounded border bg-muted/60 p-2 font-mono text-xs whitespace-pre-wrap">{ev.command}</pre>}
      {pending && onAnswer ? (
        <div className="flex flex-wrap gap-2">
          {ev.choices.map((c) => (
            <Button key={c} size="sm" variant={c === "deny" ? "outline-destructive" : c === "once" ? "default" : "outline"} disabled={Boolean(busy)}
              onClick={async () => { setBusy(c); try { await onAnswer(c, ev.requestId); } finally { setBusy(""); } }}>
              {busy === c && <LoaderCircle className="animate-spin" />} {CHOICE_LABEL[c] || c}
            </Button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{ev.status === "deny" ? "Ditolak" : ev.status === "expired" ? "Tidak dijawab" : `Dijawab: ${CHOICE_LABEL[ev.status] || ev.status}`}</p>
      )}
    </div>
  );
}

function EventView({ ev, live, onAnswer }: { ev: Ev; live: boolean; onAnswer?: (choice: string, requestId: string) => Promise<void> }) {
  switch (ev.t) {
    case "user":
      return (
        <div className="flex flex-col items-end gap-2">
          {ev.files?.length ? <FileChips files={ev.files} /> : null}
          <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm whitespace-pre-wrap text-primary-foreground">{ev.text}</div>
        </div>
      );
    case "thinking":
      return <Thinking text={ev.text} live={live} />;
    case "text":
      return <Markdown text={ev.text} />;
    case "tool":
      return <ToolCard ev={ev} />;
    case "approval":
      return <ApprovalCard ev={ev} onAnswer={onAnswer} />;
    case "error":
      return (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {ev.text}
        </div>
      );
    case "note":
      return <p className="text-xs text-muted-foreground italic">{ev.text}</p>;
    default:
      return null;
  }
}

// ------------------------------------------------------------------ token usage
type Tally = { in: number; out: number; cached: number; reasoning: number; calls: number };
type Usage = {
  total: { today: Tally; week: Tally; month: Tally; all: Tally };
  days: { day: string; in: number; out: number; cached: number; reasoning: number; calls: number }[];
  byModel: { name: string; in: number; out: number; cached: number; reasoning: number; calls: number }[];
};

export function fmtTok(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(".", ",")} M`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(".", ",")} jt`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(".", ",")} rb`;
  return String(n);
}
const sum = (t?: Tally) => (t ? t.in + t.out : 0);

function UsageDialog({ open, onOpenChange, data }: { open: boolean; onOpenChange: (o: boolean) => void; data?: Usage }) {
  const max = Math.max(1, ...(data?.days || []).map(sum));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Pemakaian token Hermes</DialogTitle>
          <DialogDescription>
            Dihitung di server ini dari setiap panggilan agen Hermes (semua sesi di state.db). Hermes mencatat token per
            sesi, jadi sesi yang berjalan lintas hari dihitung seluruhnya di hari terakhir sesi itu aktif.
          </DialogDescription>
        </DialogHeader>
        {!data ? <p className="text-sm text-muted-foreground">Memuat…</p> : (
          <div className="space-y-5 text-sm">
            <div className="grid grid-cols-3 gap-2">
              {([["Hari ini", data.total.today], ["7 hari", data.total.week], ["30 hari", data.total.month]] as const).map(([label, t]) => (
                <div key={label} className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="text-lg font-semibold tabular-nums">{fmtTok(sum(t))}</p>
                  <p className="text-[11px] text-muted-foreground">{t.calls} panggilan</p>
                </div>
              ))}
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">14 hari terakhir</p>
              <div className="flex h-28 items-end gap-1">
                {data.days.map((d) => (
                  <div key={d.day} className="group relative flex h-full flex-1 flex-col justify-end" title={`${d.day}: ${fmtTok(sum(d))} token (${d.calls} panggilan)`}>
                    <div className="rounded-t bg-primary/80" style={{ height: `${(sum(d) / max) * 100}%`, minHeight: sum(d) ? 2 : 0 }} />
                    <span className="mt-1 text-center text-[9px] text-muted-foreground tabular-nums">{Number(d.day.slice(8))}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Per model (30 hari)</p>
              {data.byModel.length === 0 ? <p className="text-xs text-muted-foreground">Belum ada.</p> : (
                <div className="space-y-1">
                  {data.byModel.map((r) => (
                    <div key={r.name} className="flex justify-between gap-2 text-xs">
                      <span className="truncate">{r.name}</span>
                      <span className="shrink-0 tabular-nums">{fmtTok(sum(r))} ({r.calls} panggil)</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
              30 hari: masuk {fmtTok(data.total.month.in)}{data.total.month.cached ? ` (cache ${fmtTok(data.total.month.cached)})` : ""} · keluar {fmtTok(data.total.month.out)}
              {data.total.month.reasoning ? ` (berpikir ${fmtTok(data.total.month.reasoning)})` : ""}. Total sejak pencatatan dimulai: {fmtTok(sum(data.total.all))}.
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function UsageStrip({ active }: { active: boolean }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ["hermes-usage"], queryFn: () => api<Usage>("/api/hermes/usage"), enabled: active, refetchInterval: active ? 20000 : false });
  const t = q.data?.total;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="flex w-full items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-left text-xs hover:bg-accent">
        <BarChart3 className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="block text-muted-foreground">Token Hermes hari ini</span>
          <span className="font-semibold tabular-nums">{t ? fmtTok(sum(t.today)) : "…"}</span>
          <span className="text-muted-foreground tabular-nums">{t ? ` · 30 hari ${fmtTok(sum(t.month))}` : ""}</span>
        </span>
        <ChevronRight className="size-3.5 text-muted-foreground" />
      </button>
      <UsageDialog open={open} onOpenChange={setOpen} data={q.data} />
    </>
  );
}
// ------------------------------------------------------------------ live conversation
function useConversation(repo: string, id: string | null) {
  const [events, setEvents] = useState<Ev[]>([]);
  const [running, setRunning] = useState(false);
  const [tokens, setTokens] = useState(0);
  const esRef = useRef<EventSource | null>(null);
  const qc = useQueryClient();

  const follow = useCallback(() => {
    esRef.current?.close();
    if (!id) return;
    const es = new EventSource(`${BASE}/api/hermes/stream${qs({ repo, id })}`);
    esRef.current = es;
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "snapshot") {
        setEvents(e.events);
        setRunning(e.running);
        setTokens(e.tokens || 0);
        if (!e.running) es.close();
      } else if (e.type === "event") {
        setEvents((list) => {
          const next = list.slice();
          next[e.index] = { ...e.event };
          return next;
        });
      } else if (e.type === "delta") {
        setEvents((list) => {
          const next = list.slice();
          const cur = next[e.index] as { text?: string } | undefined;
          if (cur && "text" in cur) next[e.index] = { ...cur, text: (cur.text || "") + e.text } as Ev;
          return next;
        });
      } else if (e.type === "tokens") {
        setTokens(e.tokens);
      } else if (e.type === "done") {
        es.close();
        // reload the saved conversation so the view matches the file exactly
        api<{ events: Ev[] }>(`/api/hermes/conversation${qs({ repo, id })}`).then((d) => setEvents(d.events)).catch(() => {});
        setRunning(false);
        qc.invalidateQueries({ queryKey: ["hermes-convs", repo] });
        qc.invalidateQueries({ queryKey: ["hermes-repos"] });
      } else if (e.type === "error") {
        es.close();
        setRunning(false);
      }
    };
    es.onerror = () => {
      // connection dropped (phone asleep, server restart): ask again for where the run is
      es.close();
      setTimeout(() => {
        if (esRef.current === es) follow();
      }, 3000);
    };
  }, [repo, id, qc]);

  useEffect(() => {
    setEvents([]);
    setRunning(false);
    follow();
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, [follow]);

  return { events, running, tokens, follow, setEvents, setRunning };
}

function Chat({ repo, id, onCreated, onBack, showBack }: { repo: Repo; id: string | null; onCreated: (id: string) => void; onBack: () => void; showBack: boolean }) {
  const { events, running, tokens, follow, setEvents, setRunning } = useConversation(repo.name, id);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [drag, setDrag] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const attach = async (list: FileList | File[]) => {
    for (const f of Array.from(list).slice(0, 10)) {
      const key = `${Date.now()}-${Math.random()}`;
      const preview = f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined;
      setPending((p) => [...p, { key, name: f.name || "gambar.png", preview, busy: true }]);
      try {
        const body = await shrinkImage(f);
        const name = body !== f ? (f.name || "gambar").replace(/\.\w+$/, "") + ".jpg" : f.name || "gambar.png";
        const res = await fetch(`${BASE}/api/hermes/upload${qs({ repo: repo.name, name })}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || d.ok === false) throw new Error(d.message || `Gagal unggah (${res.status})`);
        setPending((p) => p.map((x) => (x.key === key ? { ...x, ...d, busy: false } : x)));
      } catch (err) {
        toast.error(`${f.name}: ${(err as Error).message}`);
        setPending((p) => p.filter((x) => x.key !== key));
      }
    }
  };
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const wide = useMedia("(min-width: 768px)");
  const qc = useQueryClient();

  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [events]);
  useEffect(() => {
    stick.current = true;
  }, [id]);

  const send = async () => {
    const msg = text.trim();
    const files = pending.filter((p) => !p.busy && p.path) as unknown as Att[];
    if ((!msg && !files.length) || sending || running || pending.some((p) => p.busy)) return;
    setSending(true);
    try {
      const r = await postJson<{ id: string }>("/api/hermes/send", { repo: repo.name, id, text: msg, attachments: files.map((f) => ({ path: f.path })) });
      setText("");
      setPending([]);
      stick.current = true;
      if (r.id !== id) onCreated(r.id);
      else {
        setEvents((list) => [...list.filter((e) => e.t !== "done"), { t: "user", text: msg || "Lihat file terlampir.", files: files.length ? files : undefined }]);
        setRunning(true);
        follow();
      }
      qc.invalidateQueries({ queryKey: ["hermes-convs", repo.name] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    try {
      await postJson("/api/hermes/stop", { repo: repo.name, id });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const answer = async (choice: string, requestId: string) => {
    try {
      await postJson("/api/hermes/approval", { repo: repo.name, id, choice, requestId });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const shown = events.filter((e) => e.t !== "done");
  const lastIdx = shown.length - 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        {showBack && (
          <Button variant="ghost" size="icon-sm" onClick={onBack}>
            <ArrowLeft />
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{repo.name}</p>
          <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
            <GitBranch className="size-3" /> {repo.branch || "—"}
          </p>
        </div>
        {tokens > 0 && <span className="text-xs text-muted-foreground tabular-nums" title="Token yang dipakai percakapan ini">{fmtTok(tokens)} token</span>}
        {running && (
          <Badge variant="warning" className="gap-1.5">
            <LoaderCircle className="animate-spin" /> Bekerja
          </Badge>
        )}
      </div>

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {shown.length === 0 ? (
          <div className="grid h-full place-items-center text-center text-sm text-muted-foreground">
            <div className="max-w-sm space-y-2">
              <Cpu className="mx-auto size-8 text-primary" />
              <p className="font-medium text-foreground">Ngobrol dengan Hermes di repo {repo.name}</p>
              <p>Hermes yang sama dengan di Telegram: ingat memori dan skill-nya, bisa membaca dan mengubah kode, menjalankan perintah, mencari di web, sampai commit dan push kalau diminta.</p>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {shown.map((ev, i) => (
              <EventView key={i} ev={ev} live={running && i === lastIdx} onAnswer={running ? answer : undefined} />
            ))}
            {running && shown[lastIdx]?.t !== "thinking" && shown[lastIdx]?.t !== "text" && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" /> Hermes sedang bekerja…
              </p>
            )}
            <div ref={bottom} />
          </div>
        )}
      </div>

      <div
        className={cn("border-t p-3", drag && "bg-primary/5")}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDrag(true);
          }
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (e.dataTransfer.files.length) attach(e.dataTransfer.files);
        }}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          {pending.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {pending.map((p) => (
                <div key={p.key} className="relative flex items-center gap-2 rounded-lg border bg-muted/40 py-1 pr-7 pl-1 text-xs">
                  {p.preview ? <img src={p.preview} alt="" className="size-10 rounded object-cover" /> : <FileText className="ml-1 size-4 text-muted-foreground" />}
                  <span className="max-w-[140px] truncate">{p.name}</span>
                  {p.busy ? <LoaderCircle className="size-3.5 animate-spin text-primary" /> : p.size ? <span className="text-muted-foreground">{kb(p.size)}</span> : null}
                  <button type="button" className="absolute top-1 right-1 rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => setPending((l) => l.filter((x) => x.key !== p.key))}>
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <input ref={picker} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) attach(e.target.files); e.target.value = ""; }} />
          <textarea
            onPaste={(e) => {
              const imgs = Array.from(e.clipboardData.files);
              if (imgs.length) {
                e.preventDefault();
                attach(imgs);
              }
            }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && wide && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            rows={wide ? 3 : 2}
            placeholder={running ? "Hermes sedang bekerja… (tunggu atau hentikan)" : `Minta sesuatu di ${repo.name}…`}
            className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon-sm" onClick={() => picker.current?.click()} title="Lampirkan file atau gambar">
              <Paperclip />
            </Button>
            <span className="hidden text-xs text-muted-foreground sm:inline">{wide ? "Enter kirim · Shift+Enter baris baru · tempel/seret file" : ""}</span>
            <div className="ml-auto flex gap-2">
              {running ? (
                <Button variant="outline-destructive" size="sm" onClick={stop}>
                  <Square /> Hentikan
                </Button>
              ) : (
                <Button size="sm" onClick={send} disabled={(!text.trim() && !pending.some((p) => p.path)) || sending || pending.some((p) => p.busy)}>
                  {sending ? <LoaderCircle className="animate-spin" /> : <SendHorizontal />} Kirim
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ page
export function HermesChat({ active }: { active: boolean }) {
  const wide = useMedia("(min-width: 1024px)");
  const [repoName, setRepoName] = useState<string>(() => localStorage.getItem(LS_REPO) || "");
  const [convId, setConvId] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "chat">("list");
  const [filter, setFilter] = useState("");
  const ask = useAsk();
  const qc = useQueryClient();

  const repos = useQuery({ queryKey: ["hermes-repos"], queryFn: () => api<{ repos: Repo[] }>("/api/hermes/repos"), enabled: active, refetchInterval: active ? 15000 : false });
  const repo = repos.data?.repos.find((r) => r.name === repoName) || null;
  const convs = useQuery({
    queryKey: ["hermes-convs", repoName],
    queryFn: () => api<{ conversations: Conv[] }>(`/api/hermes/conversations${qs({ repo: repoName })}`),
    enabled: active && Boolean(repo),
    refetchInterval: active ? 10000 : false,
  });

  const pickRepo = (name: string) => {
    setRepoName(name);
    setConvId(null);
    localStorage.setItem(LS_REPO, name);
  };
  const openConv = (id: string | null) => {
    setConvId(id);
    setView("chat");
  };
  const remove = async (c: Conv) => {
    if (!(await ask({ title: "Hapus percakapan?", description: c.title, confirmLabel: "Hapus", destructive: true }))) return;
    try {
      await postJson("/api/hermes/delete", { repo: repoName, id: c.id });
      if (convId === c.id) setConvId(null);
      qc.invalidateQueries({ queryKey: ["hermes-convs", repoName] });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const list = useMemo(
    () => (repos.data?.repos || []).filter((r) => r.name.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => b.updated - a.updated || a.name.localeCompare(b.name)),
    [repos.data, filter],
  );

  const side = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b p-3">
        <UsageStrip active={active} />
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Cari repo…" className="h-8 pl-8 text-sm" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {repos.isError && <ErrorNote>{(repos.error as Error).message}</ErrorNote>}
        {list.map((r) => (
          <div key={r.name} className="mb-0.5">
            <button
              type="button"
              onClick={() => pickRepo(r.name === repoName ? "" : r.name)}
              className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent", r.name === repoName && "bg-accent")}
            >
              <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", r.name === repoName && "rotate-90")} />
              <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
              {r.running && <LoaderCircle className="size-3.5 animate-spin text-primary" />}
              {r.conversations > 0 && <span className="text-xs text-muted-foreground tabular-nums">{r.conversations}</span>}
            </button>
            {r.name === repoName && (
              <div className="mt-0.5 mb-2 ml-4 space-y-0.5 border-l pl-2">
                <button type="button" onClick={() => openConv(null)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium text-primary hover:bg-accent", convId === null && view === "chat" && "bg-accent")}>
                  <MessageSquarePlus className="size-3.5" /> Percakapan baru
                </button>
                {(convs.data?.conversations || []).map((c) => (
                  <div key={c.id} className={cn("group flex items-center rounded-md hover:bg-accent", c.id === convId && "bg-accent")}>
                    <button type="button" onClick={() => openConv(c.id)} className="min-w-0 flex-1 px-2 py-1.5 text-left">
                      <p className="flex items-center gap-1.5 truncate text-xs">
                        {c.running && <LoaderCircle className="size-3 shrink-0 animate-spin text-primary" />}
                        <span className="truncate">{c.title}</span>
                      </p>
                      <p className="text-[11px] text-muted-foreground">{ago(c.updated)}{c.tokens ? ` · ${fmtTok(c.tokens)} token` : ""}</p>
                    </button>
                    <button type="button" onClick={() => remove(c)} className="mr-1 rounded p-1 text-muted-foreground opacity-60 hover:text-destructive group-hover:opacity-100" title="Hapus">
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  const chat = repo ? (
    <Chat key={`${repo.name}/${convId}`} repo={repo} id={convId} onCreated={(id) => setConvId(id)} onBack={() => setView("list")} showBack={!wide} />
  ) : (
    <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">
      <div className="space-y-2">
        <Cpu className="mx-auto size-8 text-primary" />
        <p>Pilih repo di kiri untuk mulai ngobrol dengan Hermes.</p>
      </div>
    </div>
  );

  return (
    <div className="flex h-[calc(100svh-56px-2.5rem)] overflow-hidden rounded-xl border bg-card sm:h-[calc(100svh-56px-3rem)]">
      {wide ? (
        <>
          <aside className="w-72 shrink-0 border-r">{side}</aside>
          <section className="min-w-0 flex-1">{chat}</section>
        </>
      ) : (
        <section className="min-w-0 flex-1">{view === "list" || !repo ? side : chat}</section>
      )}
    </div>
  );
}

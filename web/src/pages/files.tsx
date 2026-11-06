import {
  ArrowUp,
  ClipboardPaste,
  Copy,
  CornerDownLeft,
  Download,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderPlus,
  FilePlus,
  HardDrive,
  House,
  Link2,
  LoaderCircle,
  Pencil,
  Scissors,
  Search,
  SquareTerminal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, BASE, postJson, qs } from "@/lib/api";
import { useAsk } from "@/lib/dialogs";
import { fmtBytes } from "@/lib/format";
import { useSession } from "@/lib/session";
import { requestCd } from "@/lib/terminal-bus";
import { useMedia } from "@/lib/use-media";
import { cn } from "@/lib/utils";

type Entry = { name: string; path: string; type: "dir" | "file" | "link" | "other" | "unknown"; size: number | null; mtime: string | null; mode: string | null };
type Listing = { path: string; parent: string | null; truncated: boolean; entries: Entry[] };
type Preview =
  | { kind: "dir"; path: string }
  | { kind: "loading"; path: string }
  | { kind: "error"; path: string; message: string }
  | { kind: "image"; path: string; name: string; size: number }
  | { kind: "binary"; path: string; size: number }
  | { kind: "text"; path: string; size: number; content: string; truncated: boolean };
type Clip = { mode: "copy" | "cut"; paths: string[] };

const nameOf = (p: string) => p.split("/").pop() || p;
const fileUrl = (path: string, download: boolean) => `${BASE}/api/fs/file${qs({ path, download: download ? 1 : undefined })}`;

const EXT_ICON: [RegExp, typeof File][] = [
  [/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i, FileImage],
  [/\.(mp4|mkv|webm|mov|avi|m4v)$/i, FileVideo],
  [/\.(zip|tar|gz|tgz|bz2|xz|7z|rar|zst)$/i, FileArchive],
  [/\.(js|mjs|cjs|ts|tsx|jsx|py|sh|rb|go|rs|java|c|cpp|h|php|css|html|json|ya?ml|toml|sql)$/i, FileCode],
  [/\.(txt|md|log|csv|env|conf|ini|cfg)$/i, FileText],
];

function EntryIcon({ entry }: { entry: Entry }) {
  if (entry.type === "dir") return <Folder className="size-4 shrink-0 fill-primary/20 text-primary" />;
  if (entry.type === "link") return <Link2 className="size-4 shrink-0 text-muted-foreground" />;
  const Icon = EXT_ICON.find(([re]) => re.test(entry.name))?.[1] || File;
  return <Icon className="size-4 shrink-0 text-muted-foreground" />;
}

/** Satu berkas per request (badan mentah), pakai XHR supaya ada progres. */
function uploadOne(file: globalThis.File, dir: string, overwrite: boolean, onProgress: (loaded: number) => void) {
  return new Promise<{ status: number; data: { message?: string } }>((done) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}/api/fs/upload${qs({ dir, name: file.name, overwrite: overwrite ? 1 : undefined })}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* bukan JSON */
      }
      done({ status: xhr.status, data });
    };
    xhr.onerror = () => done({ status: 0, data: { message: "Koneksi terputus" } });
    xhr.send(file);
  });
}

function PreviewBody({ preview }: { preview: Preview | null }) {
  if (!preview) return <p className="p-6 text-center text-sm text-muted-foreground">Pilih folder atau berkas.</p>;
  if (preview.kind === "loading")
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  if (preview.kind === "dir") return <p className="p-6 text-center text-sm text-muted-foreground">Folder {preview.path}</p>;
  if (preview.kind === "error") return <p className="p-6 text-center text-sm text-destructive">{preview.message}</p>;
  if (preview.kind === "image")
    return (
      <div className="grid place-items-center p-4">
        <img alt={preview.name} src={fileUrl(preview.path, false)} className="max-h-[60vh] max-w-full rounded-md" />
      </div>
    );
  if (preview.kind === "binary") return <p className="p-6 text-center text-sm text-muted-foreground">Berkas biner ({fmtBytes(preview.size)}). Unduh untuk membukanya.</p>;
  return (
    <pre className="p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
      {preview.truncated && <span className="mb-3 block text-warning">[Pratinjau dipotong — berkas lebih dari 512 KB]</span>}
      {preview.content || <span className="text-muted-foreground">(berkas kosong)</span>}
    </pre>
  );
}

export function Files() {
  const { home } = useSession();
  const ask = useAsk();
  const isDesktop = useMedia("(min-width: 1024px)");
  const [listing, setListing] = useState<Listing | null>(null);
  const [pathInput, setPathInput] = useState(home);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mobilePreview, setMobilePreview] = useState(false);
  const [clip, setClip] = useState<Clip | null>(null);
  const [upload, setUpload] = useState<{ label: string; percent: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const pathRef = useRef("");
  const crumbRef = useRef<HTMLElement>(null);
  const currentPath = listing?.path ?? home;

  const load = useCallback(async (path: string) => {
    setError("");
    setLoading(true);
    try {
      const data = await api<Listing>(`/api/fs${qs({ path })}`);
      // Pindah folder: kosongkan centang; muat ulang folder yang sama: buang centang yang berkasnya sudah hilang.
      if (pathRef.current !== data.path) setChecked(new Set());
      else setChecked((c) => new Set([...c].filter((p) => data.entries.some((e) => e.path === p))));
      pathRef.current = data.path;
      setListing(data);
      setPathInput(data.path);
      if (data.truncated) setError("Daftar dipotong karena terlalu banyak berkas.");
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError((e as Error).message || "Gagal membaca folder");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(home);
  }, [home, load]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (listing?.entries || []).filter((e) => !q || e.name.toLowerCase().includes(q));
  }, [listing, filter]);

  // Yang dikenai aksi: berkas yang dicentang, atau kalau tidak ada, berkas yang sedang dipratinjau di folder ini.
  const targets = useMemo(() => {
    if (checked.size) return [...checked];
    return selected && listing?.entries.some((e) => e.path === selected) ? [selected] : [];
  }, [checked, selected, listing]);

  const allChecked = rows.length > 0 && rows.every((e) => checked.has(e.path));
  const someChecked = !allChecked && rows.some((e) => checked.has(e.path));

  async function openPreview(entry: Entry) {
    setSelected(entry.path);
    if (!isDesktop) setMobilePreview(true);
    if (entry.type === "dir") {
      setPreview({ kind: "dir", path: entry.path });
      return;
    }
    setPreview({ kind: "loading", path: entry.path });
    try {
      const d = await api<{ type: "image" | "binary" | "text"; name: string; size: number; content: string | null; truncated?: boolean }>(`/api/fs/preview${qs({ path: entry.path })}`);
      setPreview((cur) => {
        if (cur?.path !== entry.path) return cur; // pengguna sudah memilih berkas lain
        if (d.type === "image") return { kind: "image", path: entry.path, name: d.name, size: d.size };
        if (d.type === "binary") return { kind: "binary", path: entry.path, size: d.size };
        return { kind: "text", path: entry.path, size: d.size, content: d.content || "", truncated: !!d.truncated };
      });
    } catch (e) {
      setPreview({ kind: "error", path: entry.path, message: (e as Error).message || "Tidak bisa dibuka" });
    }
  }

  function clickEntry(entry: Entry) {
    if (entry.type === "dir") load(entry.path);
    else openPreview(entry);
  }

  function toggleCheck(path: string, on: boolean) {
    setChecked((c) => {
      const n = new Set(c);
      if (on) n.add(path);
      else n.delete(path);
      return n;
    });
  }

  async function fsOp(body: Record<string, unknown>) {
    setError("");
    try {
      return await postJson<{ path?: string }>("/api/fs/op", body);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) {
        setError((e as Error).message);
        toast.error((e as Error).message);
      }
      return null;
    }
  }

  async function uploadFiles(list: FileList | globalThis.File[]) {
    const files = [...list].filter((f) => f.name);
    if (!files.length || upload) return;
    const dir = currentPath;
    const total = files.reduce((n, f) => n + f.size, 0) || 1;
    let sent = 0;
    let done = 0;
    const errors: string[] = [];
    try {
      for (const [i, file] of files.entries()) {
        const paint = (loaded: number) =>
          setUpload({ label: `Mengunggah ${i + 1}/${files.length}: ${file.name} (${fmtBytes(loaded)} / ${fmtBytes(file.size)})`, percent: ((sent + loaded) / total) * 100 });
        paint(0);
        let r = await uploadOne(file, dir, false, paint);
        let skipped = false;
        if (r.status === 409) {
          const yes = await ask({ title: "Berkas sudah ada", description: `"${file.name}" sudah ada di ${dir}. Timpa berkas itu?`, confirmLabel: "Timpa", destructive: true });
          if (yes) r = await uploadOne(file, dir, true, paint);
          else skipped = true;
        }
        if (r.status === 401) {
          window.location.reload();
          return;
        }
        if (r.status === 200) done += 1;
        else if (!skipped) errors.push(`${file.name}: ${r.data.message || "Gagal"}`);
        sent += file.size;
      }
    } finally {
      setUpload(null);
      if (errors.length) setError(`Gagal mengunggah: ${errors.join("; ")}`);
      if (done) toast.success(`${done} berkas terunggah ke ${nameOf(dir) || "/"}`);
      await load(dir);
    }
  }

  async function newItem(kind: "mkdir" | "newfile") {
    const name = await ask({ title: kind === "mkdir" ? "Folder baru" : "Berkas baru", input: { placeholder: kind === "mkdir" ? "nama-folder" : "nama-berkas.txt" }, confirmLabel: "Buat" });
    if (!name) return;
    const r = await fsOp({ op: kind, dir: currentPath, name });
    if (!r) return;
    await load(currentPath);
    if (kind === "newfile" && r.path) openPreview({ name, path: r.path, type: "file", size: 0, mtime: null, mode: null });
  }

  async function rename() {
    if (targets.length !== 1) return;
    const from = targets[0];
    const name = await ask({ title: "Ganti nama", input: { defaultValue: nameOf(from) }, confirmLabel: "Simpan" });
    if (!name || name === nameOf(from)) return;
    const r = await fsOp({ op: "rename", path: from, name });
    if (!r) return;
    toggleCheck(from, false);
    if (selected === from && r.path) {
      setSelected(r.path);
      setPreview((p) => (p ? { ...p, path: r.path! } : p));
    }
    await load(currentPath);
  }

  function toClip(mode: Clip["mode"]) {
    if (!targets.length) return;
    setClip({ mode, paths: targets });
    setChecked(new Set());
    toast(`${targets.length} item ${mode === "cut" ? "dipotong" : "disalin"} ke papan klip`);
  }

  async function paste() {
    if (!clip) return;
    const r = await fsOp({ op: clip.mode === "cut" ? "move" : "copy", paths: clip.paths, dest: currentPath });
    if (!r) return;
    if (clip.mode === "cut") setClip(null);
    toast.success(`${clip.paths.length} item ${clip.mode === "cut" ? "dipindah" : "disalin"}`);
    await load(currentPath);
  }

  async function remove() {
    const sel = targets;
    if (!sel.length) return;
    const list = sel.slice(0, 10).map(nameOf).join("\n") + (sel.length > 10 ? `\n… dan ${sel.length - 10} lagi` : "");
    const yes = await ask({ title: `Hapus ${sel.length} item?`, description: `Dihapus permanen, tidak bisa dibatalkan.\n\n${list}`, confirmLabel: "Hapus permanen", destructive: true });
    if (!yes) return;
    const r = await fsOp({ op: "delete", paths: sel });
    if (!r) return;
    if (sel.includes(selected)) {
      setSelected("");
      setPreview(null);
      setMobilePreview(false);
    }
    setClip((c) => {
      if (!c) return c;
      const paths = c.paths.filter((p) => !sel.includes(p));
      return paths.length ? { ...c, paths } : null;
    });
    setChecked(new Set());
    toast.success(`${sel.length} item dihapus`);
    await load(currentPath);
  }

  const crumbs = useMemo(() => {
    const parts = currentPath.split("/").filter(Boolean);
    return parts.map((part, i) => ({ part, path: `/${parts.slice(0, i + 1).join("/")}` }));
  }, [currentPath]);

  // Breadcrumb panjang digeser ke ujung supaya folder yang sedang dibuka selalu terlihat (penting di HP).
  useEffect(() => {
    const el = crumbRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [crumbs]);

  const hasFiles = (e: React.DragEvent) => [...(e.dataTransfer?.types || [])].includes("Files");

  const previewActions = (
    <>
      <Button variant="outline" size="sm" disabled={!selected || preview?.kind === "dir"} onClick={() => (window.location.href = fileUrl(selected, true))}>
        <Download /> Unduh
      </Button>
      <Button variant="outline" size="sm" onClick={() => requestCd(selected && preview?.kind === "dir" ? selected : currentPath)}>
        <SquareTerminal /> Buka di terminal
      </Button>
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Bilah lokasi */}
      <Card className="gap-3 py-3">
        <div className="flex flex-col gap-3 px-3 sm:px-4">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              load(pathInput.trim() || home);
            }}
          >
            <div className="flex gap-1">
              <Button type="button" variant="ghost" size="icon-sm" title="Home" onClick={() => load(home)}>
                <House />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" title="Root /" onClick={() => load("/")}>
                <HardDrive />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" title="Naik satu folder" disabled={!listing?.parent} onClick={() => listing?.parent && load(listing.parent)}>
                <ArrowUp />
              </Button>
            </div>
            <Input value={pathInput} onChange={(e) => setPathInput(e.target.value)} spellCheck={false} className="h-8 font-mono text-xs" />
            <Button type="submit" size="sm" variant="secondary" title="Buka">
              {loading ? <LoaderCircle className="animate-spin" /> : <CornerDownLeft />}
              <span className="hidden sm:inline">Buka</span>
            </Button>
          </form>
          <nav ref={crumbRef} className="-mx-1 flex items-center gap-0.5 overflow-x-auto px-1 text-sm whitespace-nowrap">
            <button type="button" className="cursor-pointer rounded px-1.5 py-0.5 font-medium text-primary hover:bg-accent" onClick={() => load("/")}>
              /
            </button>
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex items-center gap-0.5">
                {i > 0 && <span className="text-muted-foreground">/</span>}
                <button
                  type="button"
                  className={cn("cursor-pointer rounded px-1.5 py-0.5 hover:bg-accent", i === crumbs.length - 1 ? "font-semibold" : "text-primary")}
                  onClick={() => load(c.path)}
                >
                  {c.part}
                </button>
              </span>
            ))}
          </nav>
        </div>
      </Card>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          <span className="flex-1">{error}</span>
          <button type="button" className="cursor-pointer" onClick={() => setError("")}>
            <X className="size-4" />
          </button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        {/* Daftar berkas */}
        <Card className="min-w-0 gap-0 py-0">
          <div className="flex flex-col gap-2 border-b p-3">
            <div className="relative">
              <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Saring nama…" className="h-8 pl-8" />
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <Button variant="ghost" size="xs" onClick={() => newItem("mkdir")}>
                <FolderPlus /> Folder
              </Button>
              <Button variant="ghost" size="xs" onClick={() => newItem("newfile")}>
                <FilePlus /> Berkas
              </Button>
              <Button variant="ghost" size="xs" disabled={!!upload} onClick={() => fileInput.current?.click()}>
                <Upload /> Unggah
              </Button>
              <span className="mx-1 h-4 w-px bg-border" />
              <Button variant="ghost" size="xs" disabled={targets.length !== 1} onClick={rename}>
                <Pencil /> Ganti nama
              </Button>
              <Button variant="ghost" size="xs" disabled={!targets.length} onClick={() => toClip("copy")}>
                <Copy /> Salin
              </Button>
              <Button variant="ghost" size="xs" disabled={!targets.length} onClick={() => toClip("cut")}>
                <Scissors /> Potong
              </Button>
              <Button variant="ghost" size="xs" disabled={!clip} onClick={paste}>
                <ClipboardPaste /> Tempel{clip ? ` (${clip.paths.length})` : ""}
              </Button>
              <Button variant="ghost" size="xs" className="text-destructive hover:text-destructive" disabled={!targets.length} onClick={remove}>
                <Trash2 /> Hapus
              </Button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  const files = [...(e.target.files || [])];
                  e.target.value = "";
                  uploadFiles(files);
                }}
              />
            </div>
            {(checked.size > 0 || targets.length > 0 || clip) && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {checked.size ? <span>{checked.size} dipilih</span> : targets.length ? <span>1 dipilih (pratinjau)</span> : null}
                {clip && (
                  <span className="flex items-center gap-1">
                    {clip.paths.length} di papan klip ({clip.mode === "cut" ? "potong" : "salin"})
                    <button type="button" className="cursor-pointer rounded p-0.5 hover:bg-accent" title="Kosongkan papan klip" onClick={() => setClip(null)}>
                      <X className="size-3" />
                    </button>
                  </span>
                )}
              </div>
            )}
            {upload && (
              <div className="flex flex-col gap-1.5">
                <p className="truncate text-xs text-muted-foreground">{upload.label}</p>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-primary transition-[width]" style={{ width: `${upload.percent}%` }} />
                </div>
              </div>
            )}
          </div>

          <div
            className={cn("relative max-h-[65vh] min-h-48 overflow-auto", dragging && "outline-2 -outline-offset-4 outline-primary outline-dashed")}
            onDragEnter={(e) => {
              if (!hasFiles(e)) return;
              e.preventDefault();
              dragDepth.current += 1;
              setDragging(true);
            }}
            onDragOver={(e) => hasFiles(e) && e.preventDefault()}
            onDragLeave={() => {
              dragDepth.current -= 1;
              if (dragDepth.current <= 0) {
                dragDepth.current = 0;
                setDragging(false);
              }
            }}
            onDrop={(e) => {
              if (!hasFiles(e)) return;
              e.preventDefault();
              dragDepth.current = 0;
              setDragging(false);
              uploadFiles(e.dataTransfer.files);
            }}
          >
            {dragging && (
              <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-background/70 text-sm font-medium text-primary">
                Lepas untuk mengunggah ke {nameOf(currentPath) || "/"}
              </div>
            )}
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-[1] bg-card">
                <tr className="border-b text-left text-xs tracking-wide text-muted-foreground uppercase">
                  <th className="py-2 pr-3 pl-3">
                    <input
                      type="checkbox"
                      className="size-4 cursor-pointer accent-[var(--primary)]"
                      title="Pilih semua"
                      checked={allChecked}
                      ref={(el) => {
                        if (el) el.indeterminate = someChecked;
                      }}
                      onChange={(e) => setChecked((c) => {
                        const n = new Set(c);
                        for (const r of rows) {
                          if (e.target.checked) n.add(r.path);
                          else n.delete(r.path);
                        }
                        return n;
                      })}
                    />
                  </th>
                  <th className="w-full py-2 font-medium">Nama</th>
                  <th className="py-2 pr-3 text-right font-medium">Ukuran</th>
                  <th className="hidden py-2 pr-3 font-medium sm:table-cell">Diubah</th>
                </tr>
              </thead>
              <tbody>
                {!listing &&
                  Array.from({ length: 8 }, (_, i) => (
                    <tr key={i} className="border-b">
                      <td colSpan={4} className="px-3 py-2.5">
                        <Skeleton className="h-4 w-full" />
                      </td>
                    </tr>
                  ))}
                {listing && !rows.length && (
                  <tr>
                    <td colSpan={4} className="py-10 text-center text-muted-foreground">
                      {filter ? "Tidak ada yang cocok" : "Folder kosong"}
                    </td>
                  </tr>
                )}
                {rows.map((e) => (
                  <tr
                    key={e.path}
                    onClick={() => clickEntry(e)}
                    className={cn(
                      "cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/50",
                      e.path === selected && "bg-primary/10 hover:bg-primary/15",
                      clip?.mode === "cut" && clip.paths.includes(e.path) && "opacity-50",
                    )}
                  >
                    <td className="py-2 pr-3 pl-3" onClick={(ev) => ev.stopPropagation()}>
                      <input type="checkbox" className="size-4 cursor-pointer accent-[var(--primary)]" checked={checked.has(e.path)} onChange={(ev) => toggleCheck(e.path, ev.target.checked)} />
                    </td>
                    <td className="w-full max-w-0 py-2 pr-2">
                      <div className="flex items-center gap-2.5">
                        <EntryIcon entry={e} />
                        <span className={cn("truncate", e.type === "dir" && "font-medium")} title={e.name}>
                          {e.name}
                        </span>
                      </div>
                    </td>
                    <td className="tabular py-2 pr-3 text-right whitespace-nowrap text-muted-foreground">{e.type === "dir" ? "—" : fmtBytes(e.size)}</td>
                    <td className="tabular hidden py-2 pr-3 whitespace-nowrap text-muted-foreground sm:table-cell">
                      {e.mtime ? new Date(e.mtime).toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {listing && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              {listing.entries.filter((e) => e.type === "dir").length} folder · {listing.entries.filter((e) => e.type !== "dir").length} berkas · seret berkas ke daftar untuk mengunggah
            </p>
          )}
        </Card>

        {/* Pratinjau (desktop) */}
        {isDesktop && (
          <Card className="sticky top-20 max-h-[calc(100svh-6rem)] min-w-0 gap-0 self-start py-0">
            <div className="flex flex-wrap items-center gap-2 border-b p-3">
              <p className="min-w-0 flex-1 truncate font-mono text-xs font-medium" title={selected}>
                {selected || "Pratinjau"}
              </p>
              {previewActions}
            </div>
            <div className="min-h-60 overflow-auto">
              <PreviewBody preview={preview} />
            </div>
          </Card>
        )}
      </div>

      {/* Pratinjau (HP): layar penuh */}
      {!isDesktop && (
        <Dialog open={mobilePreview} onOpenChange={setMobilePreview}>
          <DialogContent className="flex h-[90svh] max-w-none flex-col gap-0 p-0">
            <div className="flex flex-col gap-2 border-b p-4 pr-12">
              <DialogTitle className="truncate font-mono text-sm">{selected ? nameOf(selected) : "Pratinjau"}</DialogTitle>
              <div className="flex flex-wrap gap-2">{previewActions}</div>
            </div>
            <div className="flex-1 overflow-auto">
              <PreviewBody preview={preview} />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

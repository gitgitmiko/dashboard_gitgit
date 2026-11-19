import { Braces, LoaderCircle, Save, WrapText } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ApiError, postJson } from "@/lib/api";
import { useAsk } from "@/lib/dialogs";
import { cn } from "@/lib/utils";

export type EditTarget = { path: string; content: string; mtime: string | null };

const LANG: [RegExp, string][] = [
  [/\.json$/i, "JSON"],
  [/\.(js|mjs|cjs|jsx)$/i, "JavaScript"],
  [/\.(ts|tsx)$/i, "TypeScript"],
  [/\.py$/i, "Python"],
  [/\.(sh|bash|zsh)$|(^|\/)\.?(bashrc|profile|zshrc)$/i, "Shell"],
  [/\.ya?ml$/i, "YAML"],
  [/\.toml$/i, "TOML"],
  [/\.(env|ini|cfg|conf)$|(^|\/)\.env[^/]*$/i, "Konfigurasi"],
  [/\.(md|markdown)$/i, "Markdown"],
  [/\.(html?|css|xml|svg)$/i, "Web"],
  [/\.sql$/i, "SQL"],
];
const langOf = (path: string) => LANG.find(([re]) => re.test(path))?.[1] || "Teks";
const isJson = (path: string) => /\.json$/i.test(path);

/** Posisi karakter dari pesan error JSON.parse → nomor baris (1-based). */
function jsonErrorLine(text: string, message: string) {
  const m = /position (\d+)/i.exec(message);
  if (m) return text.slice(0, Number(m[1])).split("\n").length;
  const l = /line (\d+)/i.exec(message);
  return l ? Number(l[1]) : null;
}

function checkJson(text: string): { ok: true } | { ok: false; message: string; line: number | null } {
  if (!text.trim()) return { ok: true };
  try {
    JSON.parse(text);
    return { ok: true };
  } catch (e) {
    const message = (e as Error).message;
    return { ok: false, message, line: jsonErrorLine(text, message) };
  }
}

/** Indentasi yang sudah dipakai berkas (tab atau N spasi), dipakai ulang saat Tab & Rapikan. */
function detectIndent(text: string) {
  if (/^\t/m.test(text)) return "\t";
  const m = /^( {2,8})\S/m.exec(text);
  return m ? m[1] : "  ";
}

export function FileEditor({ target, onClose, onSaved }: { target: EditTarget | null; onClose: () => void; onSaved: (t: EditTarget & { size: number }) => void }) {
  const ask = useAsk();
  const [text, setText] = useState("");
  const [base, setBase] = useState<EditTarget | null>(null);
  const [saving, setSaving] = useState(false);
  const [wrap, setWrap] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!target) return;
    setText(target.content);
    setBase(target);
  }, [target]);

  const path = base?.path || "";
  const dirty = !!base && text !== base.content;
  const json = isJson(path);
  const jsonState = useMemo(() => (json ? checkJson(text) : null), [json, text]);
  const indent = useMemo(() => detectIndent(base?.content || ""), [base]);
  const lineCount = useMemo(() => text.split("\n").length, [text]);

  async function save(force = false): Promise<void> {
    if (!base || saving) return;
    if (jsonState && !jsonState.ok && !force) {
      const yes = await ask({
        title: "JSON tidak valid",
        description: `${jsonState.line ? `Baris ${jsonState.line}: ` : ""}${jsonState.message}\n\nTetap simpan?`,
        confirmLabel: "Tetap simpan",
        destructive: true,
      });
      if (!yes) return;
    }
    setSaving(true);
    try {
      const r = await postJson<{ path: string; size: number; mtime: string }>("/api/fs/op", { op: "write", path: base.path, content: text, mtime: base.mtime, force });
      const next = { path: base.path, content: text, mtime: r.mtime };
      setBase(next);
      onSaved({ ...next, size: r.size });
      toast.success("Tersimpan");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setSaving(false);
        const yes = await ask({
          title: "Berkas berubah di tempat lain",
          description: "Berkas ini sudah diubah (oleh program lain atau tab lain) sejak dibuka. Timpa dengan isi editor?",
          confirmLabel: "Timpa",
          destructive: true,
        });
        if (yes) return save(true);
        return;
      }
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message || "Gagal menyimpan");
    } finally {
      setSaving(false);
    }
  }

  async function requestClose() {
    if (dirty) {
      const yes = await ask({ title: "Buang perubahan?", description: "Perubahan yang belum disimpan akan hilang.", confirmLabel: "Buang", destructive: true });
      if (!yes) return;
    }
    onClose();
  }

  function format() {
    try {
      setText(`${JSON.stringify(JSON.parse(text), null, indent)}\n`);
    } catch (e) {
      toast.error(`Tidak bisa dirapikan: ${(e as Error).message}`);
    }
  }

  // Ganti teks lewat execCommand supaya Undo (Ctrl+Z) bawaan browser tetap jalan.
  function replaceSelection(el: HTMLTextAreaElement, start: number, end: number, insert: string, select?: [number, number]) {
    el.focus();
    el.setSelectionRange(start, end);
    if (!document.execCommand("insertText", false, insert)) {
      el.setRangeText(insert, start, end, "end");
      setText(el.value);
    }
    if (select) el.setSelectionRange(select[0], select[1]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
      return;
    }
    if (e.key !== "Tab" || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: en, value } = el;
    const lineStart = value.lastIndexOf("\n", s - 1) + 1;
    if (s === en && !e.shiftKey) {
      replaceSelection(el, s, en, indent);
      return;
    }
    // Blok terpilih: indent / un-indent tiap baris.
    const lineEnd = value.indexOf("\n", en - (en > s && value[en - 1] === "\n" ? 1 : 0));
    const blockEnd = lineEnd === -1 ? value.length : lineEnd;
    const lines = value.slice(lineStart, blockEnd).split("\n");
    const out = lines.map((l) => {
      if (!e.shiftKey) return indent + l;
      if (l.startsWith(indent)) return l.slice(indent.length);
      return l.replace(/^[ \t]{1,8}/, (m) => m.slice(0, Math.max(0, m.length - indent.length)));
    });
    const joined = out.join("\n");
    replaceSelection(el, lineStart, blockEnd, joined, [lineStart, lineStart + joined.length]);
  }

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && requestClose()}>
      <DialogContent
        className="flex h-[92svh] max-h-[92svh] w-[calc(100%-1rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0"
        onEscapeKeyDown={(e) => {
          if (dirty) {
            e.preventDefault();
            requestClose();
          }
        }}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-2 border-b p-3 pr-12 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate font-mono text-sm" title={path}>
              {dirty && <span className="mr-1 text-warning">●</span>}
              {path.split("/").pop()}
            </DialogTitle>
            <p className="truncate font-mono text-xs text-muted-foreground" title={path}>{path}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant={wrap ? "secondary" : "outline"} size="sm" onClick={() => setWrap((w) => !w)} title="Bungkus baris panjang">
              <WrapText /> Bungkus
            </Button>
            {json && (
              <Button variant="outline" size="sm" onClick={format} disabled={!jsonState?.ok}>
                <Braces /> Rapikan
              </Button>
            )}
            <Button size="sm" onClick={() => save()} disabled={!dirty || saving}>
              {saving ? <LoaderCircle className="animate-spin" /> : <Save />} Simpan
            </Button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 bg-muted/30">
          {!wrap && (
            <div
              ref={gutter}
              aria-hidden
              className="tabular shrink-0 overflow-hidden border-r px-2 py-3 text-right font-mono text-xs leading-5 text-muted-foreground/70 select-none"
            >
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i} className={cn(jsonState && !jsonState.ok && jsonState.line === i + 1 && "text-destructive font-semibold")}>
                  {i + 1}
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={area}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onScroll={(e) => {
              if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            wrap={wrap ? "soft" : "off"}
            className={cn(
              "min-w-0 flex-1 resize-none bg-transparent px-3 py-3 font-mono text-xs leading-5 outline-none",
              wrap ? "break-words whitespace-pre-wrap" : "overflow-x-auto whitespace-pre",
            )}
          />
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1.5 text-xs text-muted-foreground">
          <span>{langOf(path)}</span>
          <span className="tabular">{lineCount} baris</span>
          {jsonState &&
            (jsonState.ok ? (
              <span className="text-success">JSON valid</span>
            ) : (
              <span className="min-w-0 truncate text-destructive" title={jsonState.message}>
                JSON tidak valid{jsonState.line ? ` (baris ${jsonState.line})` : ""}: {jsonState.message}
              </span>
            ))}
          <span className="ml-auto hidden sm:inline">Ctrl+S simpan · Tab indentasi</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

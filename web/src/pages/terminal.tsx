import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Maximize2, Minimize2, Plus, RefreshCw, SquareTerminal, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAsk } from "@/lib/dialogs";
import { shellQuote } from "@/lib/format";
import { onPendingCd, takePendingCd, takePendingFocus } from "@/lib/terminal-bus";
import { TermSession, type TermStatus } from "@/lib/terminal-session";
import { cn } from "@/lib/utils";

const DOT: Record<TermStatus, string> = {
  connected: "bg-success",
  connecting: "bg-warning animate-pulse",
  reconnecting: "bg-warning animate-pulse",
  exited: "bg-muted-foreground",
  gone: "bg-muted-foreground",
  error: "bg-destructive",
};

// Tombol yang tidak ada di keyboard HP.
const KEYS: { label: string; title: string; send?: string; arrow?: "A" | "B" | "C" | "D"; icon?: typeof ChevronUp }[] = [
  { label: "Esc", title: "Escape", send: "\x1b" },
  { label: "Tab", title: "Tab", send: "\t" },
  { label: "^C", title: "Ctrl+C (hentikan)", send: "\x03" },
  { label: "^D", title: "Ctrl+D (keluar)", send: "\x04" },
  { label: "^L", title: "Ctrl+L (bersihkan layar)", send: "\x0c" },
  { label: "↑", title: "Panah atas", arrow: "A", icon: ChevronUp },
  { label: "↓", title: "Panah bawah", arrow: "B", icon: ChevronDown },
  { label: "←", title: "Panah kiri", arrow: "D", icon: ChevronLeft },
  { label: "→", title: "Panah kanan", arrow: "C", icon: ChevronRight },
];

export function TerminalPage({ active }: { active: boolean }) {
  const ask = useAsk();
  const sessions = useRef(new Map<string, TermSession>());
  const [order, setOrder] = useState<string[]>([]);
  const [current, setCurrent] = useState("");
  const [full, setFull] = useState(false);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const restored = useRef<Promise<void> | null>(null);

  const open = useCallback((serverId = "", title = "") => {
    if (serverId) {
      const existing = [...sessions.current.values()].find((s) => s.serverId === serverId);
      if (existing) return existing;
    }
    const s = new TermSession(serverId, title, rerender);
    sessions.current.set(s.key, s);
    setOrder((o) => [...o, s.key]);
    setCurrent(s.key);
    return s;
  }, []);

  // Pulihkan sesi shell yang masih hidup di server (mis. setelah refresh atau dari perangkat lain).
  const restore = useCallback(() => {
    restored.current ??= api<{ terminals: { id: string; title: string }[] }>("/api/terminals")
      .then((d) => d.terminals.forEach((t) => open(t.id, t.title)))
      .catch(() => {});
    return restored.current;
  }, [open]);

  useEffect(() => {
    restore();
    const map = sessions.current;
    // Halaman dilepas (logout): putuskan koneksi saja, shell di server tetap hidup.
    return () => {
      map.forEach((s) => s.detach());
      map.clear();
      restored.current = null;
      setOrder([]);
      setCurrent("");
    };
  }, [restore]);

  // Ambil sesi yang dibuat di luar tab ini (mis. dari tab Remote Claude) tanpa membuat ulang yang sudah ada.
  const sync = useCallback(async () => {
    await restore();
    try {
      const d = await api<{ terminals: { id: string; title: string }[] }>("/api/terminals");
      d.terminals.forEach((t) => open(t.id, t.title));
    } catch {
      /* abaikan: dicoba lagi saat tab dibuka berikutnya */
    }
  }, [restore, open]);

  // Saat tab Terminal dibuka: pastikan ada terminal, pilih terminal titipan tab Remote Claude,
  // dan jalankan "cd" titipan dari tab Folder.
  const handlePending = useCallback(async () => {
    await sync();
    const focus = takePendingFocus();
    if (focus) {
      const s = [...sessions.current.values()].find((x) => x.serverId === focus);
      if (s) {
        setCurrent(s.key);
        return;
      }
    }
    const cd = takePendingCd();
    const live = [...sessions.current.values()].filter((s) => !s.isDead);
    let target = sessions.current.get(current);
    if (!target || target.isDead) target = live.at(-1);
    if (!target) target = open();
    if (cd) {
      target.send(`cd ${shellQuote(cd)}\n`);
      setCurrent(target.key);
    }
  }, [sync, current, open]);

  useEffect(() => {
    if (active) handlePending();
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => (active ? onPendingCd(() => handlePending()) : undefined), [active, handlePending]);

  // Ukuran terminal mengikuti penampung: saat ganti terminal, masuk/keluar layar penuh, atau jendela berubah.
  const cur = sessions.current.get(current);
  useEffect(() => {
    if (!active || !cur) return;
    const id = requestAnimationFrame(() => {
      cur.refit();
      cur.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [active, cur, full]);

  useEffect(() => {
    if (!active) return;
    let t = 0;
    const onResize = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => sessions.current.get(current)?.refit(), 150);
    };
    const onVisible = () => {
      if (document.hidden) return;
      sessions.current.forEach((s) => s.connect());
      sessions.current.get(current)?.refit();
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, current]);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && e.shiftKey && setFull(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  function remove(key: string) {
    sessions.current.delete(key);
    const next = order.filter((k) => k !== key);
    setOrder(next);
    if (key === current) setCurrent(next.at(-1) || "");
  }

  // Terminal baru yang ditolak server (mis. sudah 8 sesi): buang tabnya dan tampilkan alasannya.
  useEffect(() => {
    for (const key of order) {
      const s = sessions.current.get(key);
      if (s && s.status === "error" && !s.serverId) {
        toast.error(s.statusText);
        s.detach();
        remove(key);
        return;
      }
    }
  });

  async function closeTerm(s: TermSession) {
    if (!s.isDead) {
      const yes = await ask({
        title: `Tutup ${s.title}?`,
        description: "Shell dan semua proses yang berjalan di dalamnya akan dihentikan.",
        confirmLabel: "Tutup terminal",
        destructive: true,
      });
      if (!yes) return;
      s.close();
    } else s.detach();
    remove(s.key);
  }

  return (
    <div className={cn("flex flex-col overflow-hidden rounded-xl border bg-[#0b0b0e] shadow-sm", full && "fixed inset-0 z-50 rounded-none border-0")}>
      {/* Bilah tab terminal */}
      <div className="flex items-center gap-1 border-b border-white/10 bg-[#141418] px-2 py-1.5 text-zinc-300">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {order.map((key) => {
            const s = sessions.current.get(key);
            if (!s) return null;
            return (
              <div
                key={key}
                className={cn(
                  "group flex shrink-0 items-center gap-2 rounded-md py-1 pr-1 pl-2.5 text-xs transition-colors",
                  key === current ? "bg-white/10 text-white" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200",
                )}
              >
                <button type="button" className="flex cursor-pointer items-center gap-2" onClick={() => setCurrent(key)} title={s.statusText}>
                  <span className={cn("size-1.5 rounded-full", DOT[s.status])} />
                  {s.title}
                </button>
                <button
                  type="button"
                  className="cursor-pointer rounded p-0.5 opacity-60 hover:bg-white/10 hover:opacity-100"
                  title="Tutup terminal (matikan shell)"
                  onClick={() => closeTerm(s)}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            );
          })}
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0 text-zinc-400 hover:bg-white/10 hover:text-white"
            title="Terminal baru"
            onClick={() => open()}
          >
            <Plus />
          </Button>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7 text-zinc-400 hover:bg-white/10 hover:text-white"
          title="Sambungkan ulang"
          onClick={() => {
            sessions.current.forEach((s) => s.connect());
            toast("Menyambungkan ulang terminal…");
          }}
        >
          <RefreshCw />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7 text-zinc-400 hover:bg-white/10 hover:text-white"
          title={full ? "Keluar layar penuh (Shift+Esc)" : "Layar penuh"}
          onClick={() => setFull((f) => !f)}
        >
          {full ? <Minimize2 /> : <Maximize2 />}
        </Button>
      </div>

      {/* Isi terminal: semua tetap ter-mount supaya xterm tidak dibuat ulang, hanya yang aktif terlihat */}
      <div className={cn("relative", full ? "flex-1" : "h-[calc(100svh-12.5rem)] min-h-80 lg:h-[calc(100svh-10rem)]")}>
        {order.map((key) => {
          const s = sessions.current.get(key);
          if (!s) return null;
          return (
            <div key={key} className={cn("absolute inset-0 p-2", key !== current && "invisible")}>
              <div className="h-full w-full" ref={(el) => {
                  if (el) s.mount(el);
                }} />
              {s.status !== "connected" && (
                <div className="pointer-events-none absolute top-3 right-4 rounded-md bg-black/70 px-2 py-1 text-xs text-zinc-300">{s.statusText}</div>
              )}
            </div>
          );
        })}
        {!order.length && (
          <div className="grid h-full place-items-center text-center text-zinc-400">
            <div>
              <SquareTerminal className="mx-auto mb-3 size-8" />
              <p className="text-sm">Tidak ada terminal yang terbuka.</p>
              <Button className="mt-4" size="sm" onClick={() => open()}>
                <Plus /> Terminal baru
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Tombol tambahan untuk HP / layar sentuh */}
      {cur && (
        <div className="flex gap-1 overflow-x-auto border-t border-white/10 bg-[#141418] p-1.5 [@media(pointer:fine)]:hidden">
          {KEYS.map((k) => (
            <button
              key={k.label}
              type="button"
              title={k.title}
              className="flex h-9 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-md bg-white/5 px-2.5 font-mono text-xs text-zinc-200 active:bg-white/20"
              // Jangan ambil fokus dari terminal supaya keyboard HP tidak tertutup.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (k.arrow) cur.arrow(k.arrow);
                else if (k.send) cur.send(k.send);
                cur.focus();
              }}
            >
              {k.icon ? <k.icon className="size-4" /> : k.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

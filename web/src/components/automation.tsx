import { ArrowUpRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Variant = "success" | "warning" | "destructive" | "outline" | "secondary";

const POST_STATUS: Record<string, [string, Variant]> = {
  posted: ["Terposting", "success"],
  failed: ["Gagal", "destructive"],
  skipped: ["Dilewati", "outline"],
  prepared: ["Diproses", "warning"],
  waiting: ["Menunggu", "secondary"],
};

const VIDEO_STATUS: Record<string, [string, Variant]> = {
  uploaded: ["Terupload", "success"],
  rendered: ["Belum diupload", "warning"],
  running: ["Diproses", "warning"],
  failed: ["Gagal", "destructive"],
  missed: ["Terlewat", "destructive"],
  waiting: ["Menunggu", "secondary"],
};

export function PostBadge({ status }: { status?: string | null }) {
  const s = status || "waiting";
  const [label, variant] = POST_STATUS[s] || [s, "outline"];
  return <Badge variant={variant}>{label}</Badge>;
}

export function VideoBadge({ status }: { status: string }) {
  const [label, variant] = VIDEO_STATUS[status] || [status, "outline"];
  return (
    <Badge variant={variant} className={cn(status === "running" && "gap-1.5")}>
      {status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-warning" />}
      {label}
    </Badge>
  );
}

export function ExtLink({ href, children = "Lihat", className }: { href?: string | null; children?: ReactNode; className?: string }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener" className={cn("inline-flex items-center gap-0.5 text-xs font-medium whitespace-nowrap text-primary hover:underline", className)}>
      {children}
      <ArrowUpRight className="size-3" />
    </a>
  );
}

/** Gambar mini; kalau gagal dimuat, kotaknya tetap ada supaya baris tabel tidak loncat. */
export function Thumb({ src, href, className }: { src?: string | null; href?: string | null; className: string }) {
  const [broken, setBroken] = useState(false);
  // max-w-none + shrink-0: tanpa ini max-width:100% bawaan Tailwind membuat gambar menyusut habis di kolom tabel yang sempit.
  if (!src) return <div className={cn("max-w-none shrink-0 rounded-md border bg-muted", className)} />;
  const img = (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
      className={cn("max-w-none shrink-0 rounded-md border bg-muted object-cover", broken && "invisible", className)}
    />
  );
  return href ? (
    <a href={href} target="_blank" rel="noopener" className="block w-fit">
      {img}
    </a>
  ) : (
    img
  );
}

/** Pesan error; yang panjang (mis. JSON dari API Facebook) dipotong 2 baris dan bisa diketuk untuk dibuka. */
export function ErrText({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!children) return null;
  return (
    <p
      title={open ? undefined : "Ketuk untuk lihat lengkap"}
      onClick={() => setOpen((o) => !o)}
      // overflow-wrap:anywhere (bukan break-words) supaya "kata" JSON panjang tidak memaksa tabel melebar.
      className={cn("mt-1 cursor-pointer text-xs [overflow-wrap:anywhere] text-destructive", !open && "line-clamp-2")}
    >
      {children}
    </p>
  );
}

export function DateFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <Input type="date" value={value} onChange={(e) => onChange(e.target.value)} className="h-8 w-auto" />;
}

/** Pita "sedang membuat video" saat service sedang bekerja. */
export function BusyBanner({ stage }: { stage?: string | null }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm text-warning">
      <span className="relative flex size-2.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-warning opacity-60" />
        <span className="relative inline-flex size-2.5 rounded-full bg-warning" />
      </span>
      Sedang membuat video: {stage || "memproses"}…
    </div>
  );
}

export function ytModel(m?: string | null) {
  return m ? m.replace(/^claude:/, "Claude ").replace(/^openrouter\//, "").replace(/:free$/, "") : "—";
}

export function fmtMinSec(s?: number | null) {
  return s ? `${Math.floor(s / 60)}m ${s % 60}d` : "";
}

export function fmtDayLong(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", { weekday: "long", day: "2-digit", month: "short" });
}

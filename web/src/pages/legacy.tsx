import { ArrowUpRight, Construction, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { BASE } from "@/lib/api";
import { shellQuote } from "@/lib/format";
import { onPendingCd, peekPendingCd } from "@/lib/terminal-bus";
import { NAV, type TabId } from "@/nav";

/** Penampung sementara untuk tab yang belum dipindah ke UI baru. */
export function Legacy({ tab }: { tab: TabId }) {
  const item = NAV.find((n) => n.id === tab)!;
  // Selama tab Terminal belum pindah, "Buka di terminal" dari tab Folder ditampilkan sebagai perintah untuk disalin.
  const [cd, setCd] = useState(() => (tab === "terminal" ? peekPendingCd() : ""));
  useEffect(() => (tab === "terminal" ? onPendingCd(() => setCd(peekPendingCd())) : undefined), [tab]);
  const cmd = cd ? `cd ${shellQuote(cd)}` : "";
  return (
    <div className="grid place-items-center rounded-xl border border-dashed px-6 py-20 text-center">
      <div className="mb-4 grid size-12 place-items-center rounded-full bg-muted">
        <Construction className="size-5 text-muted-foreground" />
      </div>
      <h2 className="text-lg font-semibold">Tab {item.label} sedang dipindahkan</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">Selama masa transisi, tab ini masih bisa dipakai lengkap di tampilan lama.</p>
      {cmd && (
        <div className="mt-5 flex max-w-full items-center gap-2 rounded-lg border bg-muted/50 py-1.5 pr-1.5 pl-3">
          <code className="truncate font-mono text-xs">{cmd}</code>
          <Button
            size="xs"
            variant="secondary"
            onClick={() => navigator.clipboard.writeText(cmd).then(() => toast.success("Perintah disalin"), () => toast.error("Gagal menyalin"))}
          >
            <Copy /> Salin
          </Button>
        </div>
      )}
      <Button asChild className="mt-5">
        <a href={`${BASE}/#${tab}`}>
          Buka {item.label} di tampilan lama <ArrowUpRight />
        </a>
      </Button>
    </div>
  );
}

import { ArrowUpRight, Construction } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BASE } from "@/lib/api";
import { NAV, type TabId } from "@/nav";

/** Penampung sementara untuk tab yang belum dipindah ke UI baru. */
export function Legacy({ tab }: { tab: TabId }) {
  const item = NAV.find((n) => n.id === tab)!;
  return (
    <div className="grid place-items-center rounded-xl border border-dashed px-6 py-20 text-center">
      <div className="mb-4 grid size-12 place-items-center rounded-full bg-muted">
        <Construction className="size-5 text-muted-foreground" />
      </div>
      <h2 className="text-lg font-semibold">Tab {item.label} sedang dipindahkan</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">Selama masa transisi, tab ini masih bisa dipakai lengkap di tampilan lama.</p>
      <Button asChild className="mt-5">
        <a href={`${BASE}/#${tab}`}>
          Buka {item.label} di tampilan lama <ArrowUpRight />
        </a>
      </Button>
    </div>
  );
}

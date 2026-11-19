import { type ComponentType, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type SubTabDef<T extends string> = { id: T; label: string; icon: LucideIcon; Page: ComponentType<{ active: boolean }> };

/** Sub-tab di dalam satu halaman; pilihan terakhir diingat di localStorage. */
export function SubTabs<T extends string>({ tabs, storageKey, active }: { tabs: SubTabDef<T>[]; storageKey: string; active: boolean }) {
  const [sub, setSub] = useState<T>(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(storageKey);
    } catch {
      /* storage opsional */
    }
    return tabs.some((t) => t.id === saved) ? (saved as T) : tabs[0].id;
  });
  // Sama seperti tab utama: sub-tab yang pernah dibuka tetap ter-mount supaya filter/halamannya awet.
  const [visited, setVisited] = useState<Set<T>>(() => new Set([sub]));
  const pick = (id: T) => {
    setSub(id);
    setVisited((v) => (v.has(id) ? v : new Set(v).add(id)));
    try {
      localStorage.setItem(storageKey, id);
    } catch {
      /* storage opsional */
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div role="tablist" className="inline-flex w-fit gap-1 rounded-lg border bg-card p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={sub === t.id}
            onClick={() => pick(t.id)}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
              sub === t.id && "bg-muted text-foreground",
            )}
          >
            <t.icon className="size-4" /> {t.label}
          </button>
        ))}
      </div>
      {tabs.filter((t) => visited.has(t.id)).map((t) => (
        <div key={t.id} hidden={t.id !== sub}>
          <t.Page active={active && t.id === sub} />
        </div>
      ))}
    </div>
  );
}

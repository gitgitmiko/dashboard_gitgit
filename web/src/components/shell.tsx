import * as DialogPrimitive from "@radix-ui/react-dialog";
import { LogOut, Menu, Moon, Server, Sun, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/session";
import { useStats } from "@/lib/stats";
import { cn } from "@/lib/utils";
import { NAV, type TabId } from "@/nav";

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("dg-theme", dark ? "dark" : "light");
    } catch {
      /* mode privat */
    }
  }, [dark]);
  return [dark, () => setDark((d) => !d)] as const;
}

function NavList({ tab, onPick }: { tab: TabId; onPick?: () => void }) {
  return (
    <nav className="flex flex-col gap-5">
      {(["server", "otomasi"] as const).map((group) => (
        <div key={group}>
          <p className="mb-1.5 px-3 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{group === "server" ? "Server" : "Otomasi"}</p>
          <div className="flex flex-col gap-0.5">
            {NAV.filter((n) => n.group === group).map(({ id, label, icon: Icon }) => (
              <a
                key={id}
                href={`#/${id}`}
                onClick={onPick}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                  tab === id && "bg-accent text-foreground",
                )}
              >
                <Icon className={cn("size-4", tab === id && "text-primary")} />
                {label}
              </a>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

function Brand() {
  const { data } = useStats();
  return (
    <div className="flex items-center gap-3">
      <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
        <Server className="size-4.5" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">{data?.hostname || "Server"}</p>
        <p className="truncate text-xs text-muted-foreground">Dashboard Gitgit</p>
      </div>
    </div>
  );
}

export function Shell({ tab, children }: { tab: TabId; children: ReactNode }) {
  const { logout } = useSession();
  const [dark, toggleTheme] = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const { data } = useStats();
  const current = NAV.find((n) => n.id === tab)!;

  const footer = (
    <div className="flex items-center gap-1 border-t pt-3">
      <Button variant="ghost" size="sm" className="flex-1 justify-start text-muted-foreground" onClick={logout}>
        <LogOut /> Keluar
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={toggleTheme} title={dark ? "Mode terang" : "Mode gelap"}>
        {dark ? <Sun /> : <Moon />}
      </Button>
    </div>
  );

  return (
    <div className="min-h-svh lg:pl-60">
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col gap-6 border-r bg-sidebar p-4 lg:flex">
        <Brand />
        <div className="flex-1 overflow-y-auto">
          <NavList tab={tab} />
        </div>
        {footer}
      </aside>

      <DialogPrimitive.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 lg:hidden" />
          <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col gap-6 border-r bg-sidebar p-4 shadow-xl lg:hidden">
            <DialogPrimitive.Title className="sr-only">Menu</DialogPrimitive.Title>
            <div className="flex items-center justify-between">
              <Brand />
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="icon-sm">
                  <X />
                </Button>
              </DialogPrimitive.Close>
            </div>
            <div className="flex-1 overflow-y-auto">
              <NavList tab={tab} onPick={() => setMenuOpen(false)} />
            </div>
            {footer}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 sm:px-6">
        <Button variant="ghost" size="icon-sm" className="-ml-1 lg:hidden" onClick={() => setMenuOpen(true)}>
          <Menu />
          <span className="sr-only">Buka menu</span>
        </Button>
        <current.icon className="hidden size-4 text-muted-foreground sm:block" />
        <h1 className="text-sm font-semibold">{current.label}</h1>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span className={cn("size-2 rounded-full", data ? "bg-success" : "bg-muted-foreground")} />
          <span className="tabular hidden sm:inline">{data ? new Date(data.time).toLocaleString("id-ID") : "Menghubungkan…"}</span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6 sm:py-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">{children}</main>
    </div>
  );
}

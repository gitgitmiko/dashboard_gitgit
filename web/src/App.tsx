import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useState, type ComponentType } from "react";
import { Login } from "@/components/login";
import { Shell } from "@/components/shell";
import { api, BASE, setUnauthorizedHandler } from "@/lib/api";
import { DialogsProvider } from "@/lib/dialogs";
import { SessionContext } from "@/lib/session";
import { tabFromHash, type TabId } from "@/nav";
import { Cctv } from "@/pages/cctv";
import { Files } from "@/pages/files";
import { Logs } from "@/pages/logs";
import { Sosmed } from "@/pages/sosmed";
import { Whatif } from "@/pages/whatif";
import { Youtube } from "@/pages/youtube";
import { Overview } from "@/pages/overview";
import { RemoteClaude } from "@/pages/remote-claude";

// xterm cukup besar, jadi kode terminal baru diunduh saat tab Terminal pertama kali dibuka.
const TerminalPage = lazy(() => import("@/pages/terminal").then((m) => ({ default: m.TerminalPage })));

const PAGES: Record<TabId, ComponentType<{ tab: TabId; active: boolean }>> = {
  overview: Overview,
  files: Files,
  terminal: TerminalPage,
  remote: RemoteClaude,
  logs: Logs,
  cctv: Cctv,
  sosmed: Sosmed,
  youtube: Youtube,
  whatif: Whatif,
};

export default function App() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<"loading" | "out" | "in">("loading");
  const [home, setHome] = useState("/");
  const [tab, setTab] = useState<TabId>(tabFromHash);
  // Halaman yang pernah dibuka tetap ter-mount (disembunyikan) supaya state-nya awet saat pindah tab.
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set([tabFromHash()]));

  useEffect(() => {
    setUnauthorizedHandler(() => setState("out"));
    api<{ home: string }>("/api/session")
      .then((d) => {
        setHome(d.home || "/");
        setState("in");
      })
      .catch(() => setState("out"));
  }, []);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab)));
  }, [tab]);

  const logout = useCallback(async () => {
    await fetch(`${BASE}/logout`, { method: "POST" }).catch(() => {});
    queryClient.clear();
    setVisited(new Set([tab]));
    setState("out");
  }, [queryClient, tab]);

  if (state === "loading") return <div className="min-h-svh" />;
  if (state === "out")
    return (
      <Login
        onSuccess={(h) => {
          setHome(h || home);
          setState("in");
        }}
      />
    );

  return (
    <SessionContext.Provider value={{ home, logout }}>
      <DialogsProvider>
      <Shell tab={tab}>
        {[...visited].map((id) => {
          const Page = PAGES[id];
          return (
            <div key={id} hidden={id !== tab}>
              <Suspense fallback={<div className="h-80 animate-pulse rounded-xl border bg-card" />}>
                <Page tab={id} active={id === tab} />
              </Suspense>
            </div>
          );
        })}
      </Shell>
      </DialogsProvider>
    </SessionContext.Provider>
  );
}

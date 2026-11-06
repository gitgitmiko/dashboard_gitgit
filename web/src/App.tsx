import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState, type ComponentType } from "react";
import { Login } from "@/components/login";
import { Shell } from "@/components/shell";
import { api, BASE, setUnauthorizedHandler } from "@/lib/api";
import { SessionContext } from "@/lib/session";
import { tabFromHash, type TabId } from "@/nav";
import { Legacy } from "@/pages/legacy";
import { Overview } from "@/pages/overview";

// Tab yang belum dipindah ke UI baru diarahkan ke UI lama (lihat pages/legacy.tsx).
const PAGES: Record<TabId, ComponentType<{ tab: TabId }>> = {
  overview: Overview,
  files: Legacy,
  terminal: Legacy,
  logs: Legacy,
  cctv: Legacy,
  sosmed: Legacy,
  youtube: Legacy,
  whatif: Legacy,
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
      <Shell tab={tab}>
        {[...visited].map((id) => {
          const Page = PAGES[id];
          return (
            <div key={id} hidden={id !== tab}>
              <Page tab={id} />
            </div>
          );
        })}
      </Shell>
    </SessionContext.Provider>
  );
}

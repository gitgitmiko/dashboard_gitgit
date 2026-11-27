import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { fmtShort } from "@/lib/format";
import { cn } from "@/lib/utils";

// Kartu "Performa channel" di tab whatif: YouTube Analytics 30 hari yang ditarik n8n tiap 05:30 (data/analytics).

type Video = {
  id: string; title: string; uploaded: string | null; slot: string | null; mode: string | null; seri: string | null;
  views: number; pct: number | null; avg: number | null; length: number | null; drop: number | null;
  likes: number; shares: number; comments: number; subs: number;
};
type Perf = { at: string | null; videos: Video[] };

const SORT: Record<string, [string, (a: Video, b: Video) => number]> = {
  views: ["Views terbanyak", (a, b) => b.views - a.views],
  pct: ["% ditonton tertinggi", (a, b) => (b.pct ?? 0) - (a.pct ?? 0)],
  low: ["Views tersedikit", (a, b) => a.views - b.views],
  new: ["Terbaru", (a, b) => String(b.uploaded).localeCompare(String(a.uploaded))],
};
const num = (n: number) => n.toLocaleString("id-ID");
// Warna % ditonton: hijau kalau mayoritas penonton bertahan, merah kalau kebanyakan pergi.
const pctTone = (p: number | null) => (p == null ? "" : p >= 70 ? "text-success" : p < 50 ? "text-destructive" : "");

export function PerformanceCard({ active }: { active: boolean }) {
  const [sort, setSort] = useState("views");
  const [all, setAll] = useState(false);
  const q = useQuery({ queryKey: ["wi-performance"], queryFn: () => api<Perf>("/api/analytics/whatif"), enabled: active, refetchInterval: active ? 300000 : false });
  const vids = [...(q.data?.videos ?? [])].sort(SORT[sort][1]);
  const shown = all ? vids : vids.slice(0, 10);
  const total = vids.reduce((n, v) => n + v.views, 0);
  const withPct = vids.filter((v) => v.pct != null);
  const avgPct = withPct.length ? withPct.reduce((n, v) => n + (v.pct ?? 0) * v.views, 0) / Math.max(1, withPct.reduce((n, v) => n + v.views, 0)) : null;
  const subs = vids.reduce((n, v) => n + v.subs, 0);

  return (
    <Card className="gap-3 pb-3">
      <CardHeader>
        <div>
          <CardTitle>Performa channel · 30 hari</CardTitle>
          <CardDescription className="mt-1.5">
            YouTube Analytics, ditarik n8n tiap 05:30{q.data?.at ? ` · diperbarui ${fmtShort(q.data.at)}` : ""}. Riset 19:00 memakai data ini: variasi dari
            yang paling laku, dan pembuka yang lebih kuat bila penonton cepat pergi.
          </CardDescription>
        </div>
        <CardAction>
          <NativeSelect value={sort} onChange={(e) => setSort(e.target.value)} className="w-44">
            {Object.entries(SORT).map(([k, [label]]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </CardAction>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(
          [
            ["Views", num(total)],
            ["Rata-rata ditonton", avgPct == null ? "—" : `${avgPct.toFixed(0)}%`],
            ["Subscriber baru", num(subs)],
            ["Video", num(vids.length)],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-lg font-semibold tabular-nums">{q.data ? value : "…"}</p>
          </div>
        ))}
      </CardContent>
      <CardContent className="px-2 sm:px-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Video</TableHead>
              <TableHead className="text-right">Views</TableHead>
              <TableHead className="text-right">Ditonton</TableHead>
              <TableHead className="hidden text-right sm:table-cell" title="Detik saat penonton yang tersisa kurang dari 60%">
                Penonton pergi
              </TableHead>
              <TableHead className="hidden text-right sm:table-cell">Like · share · subs</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!q.data && <TableEmpty cols={5}>{q.error?.message || "Memuat…"}</TableEmpty>}
            {q.data && !vids.length && <TableEmpty cols={5}>Belum ada data analytics.</TableEmpty>}
            {shown.map((v) => (
              <TableRow key={v.id}>
                <TableCell className="max-w-80 min-w-44 align-top">
                  <a href={`https://www.youtube.com/shorts/${v.id}`} target="_blank" rel="noopener" className="line-clamp-2 font-medium hover:underline">
                    {v.title || v.id}
                  </a>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {[v.uploaded && fmtShort(v.uploaded), v.mode, v.seri].filter(Boolean).join(" · ")}
                    <span className="sm:hidden">
                      {v.drop != null && ` · pergi di ${v.drop} dtk`} · {v.likes} like · {v.shares} share
                    </span>
                  </p>
                </TableCell>
                <TableCell className="tabular text-right align-top font-medium">{num(v.views)}</TableCell>
                <TableCell className="tabular text-right align-top">
                  <span className={cn("font-medium", pctTone(v.pct))}>{v.pct == null ? "—" : `${v.pct.toFixed(0)}%`}</span>
                  {v.avg != null && v.length != null && <p className="text-xs text-muted-foreground">{v.avg}/{v.length} dtk</p>}
                </TableCell>
                <TableCell className="tabular hidden text-right align-top sm:table-cell">{v.drop == null ? "—" : `${v.drop} dtk`}</TableCell>
                <TableCell className="tabular hidden text-right align-top text-muted-foreground sm:table-cell">
                  {v.likes} · {v.shares} · {v.subs}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      {vids.length > 10 && (
        <div className="flex justify-center border-t pt-3">
          <Button variant="ghost" size="sm" onClick={() => setAll(!all)}>
            {all ? "Tampilkan 10 teratas" : `Tampilkan semua (${vids.length})`}
          </Button>
        </div>
      )}
    </Card>
  );
}

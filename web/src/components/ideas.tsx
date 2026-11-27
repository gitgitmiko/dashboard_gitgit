import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { fmtShort } from "@/lib/format";
import { cn } from "@/lib/utils";

// Kartu "Ide & penjurian" di tab Sosmed: kandidat yang dipertimbangkan tiap video, nilainya, dan yang terpilih.

type Cand = { text: string; score?: number | null; chosen: boolean };
type WhatifData = {
  date: string | null;
  insight: string;
  juri: string | null;
  drafts: { topic: string; mode: string; title: string; nilai: number | null; alasan: string; slot: string | null; status: string | null }[];
  items: {
    slot: string; mode: string; seri: string; topic: string; angle: string; hook: string; nilai: number | null; alasan: string;
    inspired: { title: string; views: number; why: string }[];
    run: { id: string; title: string | null; status: string } | null;
    unrelated: string | null;
    hooks: Cand[];
  }[];
};
type KaiaraData = { items: { run: string; date: string; judul: string; nilai: number | null; punchline: string; juri: { nilai: number[]; terpilih: number; alasan: string; kandidat: { judul: string; punchline: string }[] } | null }[] };
type Juri = { nilai: (number | null)[]; terpilih: number; alasan: string; oleh?: string; kandidat: { judul: string; punchline: string }[] };
type StandupData = { items: { run: string; judul: string; created: string; status: string; topic: string; tema: string; riset: { sumber: string; kandidat: string[]; pilih: string; sudut: string } | null; juri: Juri | null }[] };

const UPLOAD: Record<string, string> = { slot1: "10:00", slot2: "12:00", slot3: "15:00", slot4: "18:00", slot5: "20:00" };
const DESC = {
  whatif: "Jam 19:00 Sonnet meriset Shorts yang sedang meledak dan menulis 10 naskah untuk besok; Opus menilai peluang views-nya, 4 fakta + 1 horor terbaik dicek fakta lalu diproduksi",
  kaiara: "Jam 19:30 Sonnet mencari yang sedang ramai (web search) dan menulis 10 naskah; Opus menilai peluang views-nya, yang terbaik diproduksi malam itu",
  standup: "Jam 19:00 Sonnet mencari topik viral (web search) dan menulis 8 naskah; Opus menilai peluang views-nya, yang terbaik diproduksi malam itu",
};

/** Daftar kandidat; yang terpilih ditandai. */
function Candidates({ items }: { items: Cand[] }) {
  return (
    <ul className="mt-1.5 flex flex-col gap-1">
      {items.map((c, i) => (
        <li key={i} className={cn("flex items-start gap-2 rounded-md px-2 py-1 text-sm", c.chosen ? "bg-primary/10 font-medium" : "text-muted-foreground")}>
          {c.score != null && <span className={cn("tabular w-6 shrink-0 text-right font-semibold", c.chosen ? "text-primary" : "")}>{c.score}</span>}
          <span className="min-w-0 flex-1">{c.text}</span>
          {c.chosen && <Badge variant="success" className="shrink-0">Terpilih</Badge>}
        </li>
      ))}
    </ul>
  );
}

function Item({ title, meta, open, children }: { title: ReactNode; meta: ReactNode; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="group rounded-lg border px-3 py-2">
      <summary className="flex cursor-pointer list-none items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="font-medium">{title}</span>
          <span className="block text-xs text-muted-foreground">{meta}</span>
        </span>
        <span className="text-xs text-muted-foreground group-open:hidden">Lihat</span>
      </summary>
      <div className="mt-2 flex flex-col gap-2 text-sm">{children}</div>
    </details>
  );
}

const Label = ({ children }: { children: ReactNode }) => <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{children}</p>;
const Missing = ({ children }: { children: ReactNode }) => <p className="text-xs text-muted-foreground italic">{children}</p>;

function Whatif({ d }: { d: WhatifData }) {
  return (
    <>
      {d.insight && (
        <div className="rounded-lg bg-muted/50 p-3 text-sm">
          <Label>Pola yang sedang menang · riset {d.date}</Label>
          <p className="mt-1">{d.insight}</p>
        </div>
      )}
      {d.drafts.length > 0 && (
        <div>
          <Label>Draf naskah dan nilai juri {d.juri === "opus" ? "Opus" : d.juri || ""}</Label>
          <Candidates
            items={[...d.drafts]
              .sort((a, b) => (b.nilai ?? 0) - (a.nilai ?? 0))
              .map((x) => ({ text: `${x.title || x.topic} · ${x.mode}${x.slot ? ` · tayang ${UPLOAD[x.slot]}` : x.status ? ` · ${x.status}` : ""}`, score: x.nilai, chosen: Boolean(x.slot) }))}
          />
        </div>
      )}
      {d.items.map((i, k) => (
        <Item key={i.slot} open={k === 0} title={`${UPLOAD[i.slot] || i.slot} · ${i.topic}`} meta={`${i.mode} · seri ${i.seri}${i.run?.title ? ` · ${i.run.title}` : i.unrelated ? "" : " · belum diproduksi"}`}>
          <p>{i.angle}</p>
          {i.alasan && <p className="text-xs text-muted-foreground">Alasan juri ({i.nilai}): {i.alasan}</p>}
          {i.unrelated && <Missing>Slot ini sudah diproduksi sebelum riset selesai, tanpa ide ini: "{i.unrelated}".</Missing>}
          {i.hooks.length ? (
            <div>
              <Label>Kandidat kalimat pembuka (nilai penulis)</Label>
              <Candidates items={i.hooks} />
            </div>
          ) : (
            <Missing>Draf hook dari riset: "{i.hook}"</Missing>
          )}
          {i.inspired.length > 0 && (
            <div>
              <Label>Terinspirasi dari</Label>
              <ul className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
                {i.inspired.map((v, j) => (
                  <li key={j}>
                    <span className="text-foreground">{v.title}</span> · {v.views?.toLocaleString("id-ID")} views · {v.why}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Item>
      ))}
    </>
  );
}

function Kaiara({ d }: { d: KaiaraData }) {
  return (
    <>
      {d.items.map((e, k) => (
        <Item key={e.run} open={k === 0} title={e.judul} meta={`${e.date}${e.nilai != null ? ` · nilai juri ${e.nilai}` : ""}`}>
          {e.juri ? (
            <>
              <div>
                <Label>Calon naskah (judul · punchline) dan nilai juri Opus</Label>
                <Candidates items={e.juri.kandidat.map((c, j) => ({ text: `${c.judul} · "${c.punchline}"`, score: e.juri!.nilai[j] ?? null, chosen: j === e.juri!.terpilih }))} />
              </div>
              {e.juri.alasan && <p className="text-xs text-muted-foreground">Alasan juri: {e.juri.alasan}</p>}
            </>
          ) : (
            <>
              <p className="text-muted-foreground">Punchline: "{e.punchline}"</p>
              <Missing>Calon naskah lain dan alasan juri tidak tersimpan untuk naskah ini (dicatat mulai 27 Nov 2026).</Missing>
            </>
          )}
        </Item>
      ))}
    </>
  );
}

function Standup({ d }: { d: StandupData }) {
  return (
    <>
      {d.items.map((v, k) => (
        <Item key={v.run} open={k === 0} title={v.judul} meta={`diproduksi ${fmtShort(v.created)} · ${v.riset?.sumber || v.tema}`}>
          {v.juri ? (
            <>
              <div>
                <Label>Draf naskah (judul · punchline) dan nilai juri {v.juri.oleh === "opus" ? "Opus" : v.juri.oleh || ""}</Label>
                <Candidates items={v.juri.kandidat.map((c, j) => ({ text: `${c.judul} · "${c.punchline}"`, score: v.juri!.nilai[j] ?? null, chosen: j === v.juri!.terpilih }))} />
              </div>
              {v.juri.alasan && <p className="text-xs text-muted-foreground">Alasan juri: {v.juri.alasan}</p>}
              {v.riset?.sudut && <p className="text-xs text-muted-foreground">Topik: {v.riset.sudut}</p>}
            </>
          ) : v.riset ? (
            <>
              {v.riset.kandidat.length > 0 && (
                <div>
                  <Label>Kandidat topik</Label>
                  <Candidates items={v.riset.kandidat.map((t) => ({ text: t, chosen: t === v.riset!.pilih }))} />
                </div>
              )}
              {v.riset.sudut && <p className="text-xs text-muted-foreground">Sudut: {v.riset.sudut}</p>}
            </>
          ) : (
            <>
              <p className="text-muted-foreground">Topik: {v.topic}</p>
              <Missing>Kandidat topik lain tidak tersimpan untuk video ini (dicatat mulai produksi 27 Nov 2026 malam).</Missing>
            </>
          )}
        </Item>
      ))}
    </>
  );
}

export function IdeasCard({ channel, active }: { channel: "whatif" | "kaiara" | "standup"; active: boolean }) {
  const q = useQuery({
    queryKey: ["ideas", channel],
    queryFn: () => api<WhatifData & KaiaraData & StandupData>(`/api/ideas/${channel}`),
    enabled: active,
    refetchInterval: active ? 120000 : false,
  });
  const d = q.data;
  return (
    <Card className="gap-3">
      <CardHeader>
        <div>
          <CardTitle>Ide & penjurian</CardTitle>
          <CardDescription className="mt-1.5">{DESC[channel]}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {q.error && <p className="text-sm text-destructive">{q.error.message}</p>}
        {!d && !q.error && <p className="text-sm text-muted-foreground">Memuat…</p>}
        {d && !d.items.length && <p className="text-sm text-muted-foreground">Belum ada data.</p>}
        {d && channel === "whatif" && <Whatif d={d} />}
        {d && channel === "kaiara" && <Kaiara d={d} />}
        {d && channel === "standup" && <Standup d={d} />}
      </CardContent>
    </Card>
  );
}

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type Stats = {
  hostname: string;
  time: string;
  uptime_sec: number;
  home: string;
  load: { one: number; five: number; fifteen: number };
  cpu: { percent: number; model: string; cores: number };
  memory: { total: number; used: number; available: number; percent: number; swap_total: number; swap_used: number };
  disks: { source: string; size: number; used: number; avail: number; percent: number; mount: string }[];
  network: { name: string; rx_bps: number; tx_bps: number }[];
};

export function useStats() {
  return useQuery({ queryKey: ["stats"], queryFn: () => api<Stats>("/api/stats"), refetchInterval: 3000 });
}

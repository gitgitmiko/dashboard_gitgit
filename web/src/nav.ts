import { FolderOpen, Gamepad2, LayoutDashboard, type LucideIcon, ScrollText, Share2, Smartphone, SquareTerminal, Video } from "lucide-react";

export type TabId = "overview" | "files" | "terminal" | "remote" | "logs" | "cctv" | "sosmed" | "apps";

export type NavGroup = "server" | "otomasi" | "produk";

export const NAV_GROUPS: { id: NavGroup; label: string }[] = [
  { id: "server", label: "Server" },
  { id: "otomasi", label: "Otomasi" },
  { id: "produk", label: "Produk" },
];

export const NAV: { id: TabId; label: string; icon: LucideIcon; group: NavGroup }[] = [
  { id: "overview", label: "Ringkasan", icon: LayoutDashboard, group: "server" },
  { id: "files", label: "Folder", icon: FolderOpen, group: "server" },
  { id: "terminal", label: "Terminal", icon: SquareTerminal, group: "server" },
  { id: "remote", label: "Remote Claude", icon: Smartphone, group: "server" },
  { id: "logs", label: "Log", icon: ScrollText, group: "server" },
  { id: "cctv", label: "CCTV", icon: Video, group: "server" },
  { id: "sosmed", label: "Sosmed", icon: Share2, group: "otomasi" },
  { id: "apps", label: "Apps and Games", icon: Gamepad2, group: "produk" },
];

export function tabFromHash(): TabId {
  const id = window.location.hash.replace(/^#\/?/, "") as TabId;
  return NAV.some((n) => n.id === id) ? id : "overview";
}

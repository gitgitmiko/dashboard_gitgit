import { FolderOpen, LayoutDashboard, type LucideIcon, ScrollText, Share2, Smartphone, Sparkles, SquareTerminal, SquarePlay, Video } from "lucide-react";

export type TabId = "overview" | "files" | "terminal" | "remote" | "logs" | "cctv" | "sosmed" | "youtube" | "whatif";

export const NAV: { id: TabId; label: string; icon: LucideIcon; group: "server" | "otomasi" }[] = [
  { id: "overview", label: "Ringkasan", icon: LayoutDashboard, group: "server" },
  { id: "files", label: "Folder", icon: FolderOpen, group: "server" },
  { id: "terminal", label: "Terminal", icon: SquareTerminal, group: "server" },
  { id: "remote", label: "Remote Claude", icon: Smartphone, group: "server" },
  { id: "logs", label: "Log", icon: ScrollText, group: "server" },
  { id: "cctv", label: "CCTV", icon: Video, group: "server" },
  { id: "sosmed", label: "Sosmed", icon: Share2, group: "otomasi" },
  { id: "youtube", label: "YouTube", icon: SquarePlay, group: "otomasi" },
  { id: "whatif", label: "What If", icon: Sparkles, group: "otomasi" },
];

export function tabFromHash(): TabId {
  const id = window.location.hash.replace(/^#\/?/, "") as TabId;
  return NAV.some((n) => n.id === id) ? id : "overview";
}

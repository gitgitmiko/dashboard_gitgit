import { Bot, CalendarClock, MessagesSquare, Database, FolderOpen, Gamepad2, LayoutDashboard, type LucideIcon, ShieldCheck, Share2, Smartphone, SquareTerminal, Video } from "lucide-react";

export type TabId = "overview" | "files" | "terminal" | "remote" | "mimo" | "database" | "scraper" | "cron" | "cctv" | "sosmed" | "apps" | "security";

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
  { id: "mimo", label: "MiMo Chat", icon: MessagesSquare, group: "server" },
  { id: "database", label: "Database", icon: Database, group: "server" },
  { id: "cctv", label: "CCTV", icon: Video, group: "server" },
  { id: "security", label: "Keamanan", icon: ShieldCheck, group: "server" },
  { id: "scraper", label: "Scraper", icon: Bot, group: "otomasi" },
  { id: "cron", label: "Cron & Produksi", icon: CalendarClock, group: "otomasi" },
  { id: "sosmed", label: "Sosmed", icon: Share2, group: "otomasi" },
  { id: "apps", label: "Apps and Games", icon: Gamepad2, group: "produk" },
];

export function tabFromHash(): TabId {
  const raw = window.location.hash.replace(/^#\/?/, "");
  // Bookmark lama "#/logs" (sebelum digabung ke menu Scraper).
  const id = (raw === "logs" ? "scraper" : raw) as TabId;
  return NAV.some((n) => n.id === id) ? id : "overview";
}

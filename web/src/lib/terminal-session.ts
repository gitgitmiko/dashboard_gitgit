import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { api, BASE } from "@/lib/api";

export type TermStatus = "connecting" | "connected" | "reconnecting" | "exited" | "gone" | "error";

const THEME = {
  background: "#0b0b0e",
  foreground: "#e4e4e7",
  cursor: "#b6e36a",
  cursorAccent: "#0b0b0e",
  selectionBackground: "#3f4a2e",
  black: "#18181b",
  brightBlack: "#52525b",
  green: "#9ed36a",
  brightGreen: "#b6e36a",
};

function b64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Satu terminal di browser: xterm + WebSocket ke sesi shell di server.
 * Shell di server tetap hidup saat koneksi putus/halaman di-refresh; hanya close() yang mematikannya.
 */
export class TermSession {
  readonly key: string;
  serverId: string;
  title: string;
  status: TermStatus = "connecting";
  statusText = "Menyambung…";
  readonly term: Terminal;
  private readonly fit = new FitAddon();
  private ws: WebSocket | null = null;
  private dead = false;
  private opened = false;
  private retryTimer = 0;
  private failures = 0;
  private queued: string[] = [];

  constructor(
    serverId: string,
    title: string,
    private readonly onChange: () => void,
  ) {
    this.serverId = serverId;
    this.key = serverId || `baru-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.title = title || (serverId ? "Terminal" : "Terminal baru");
    this.term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      scrollback: 5000,
      theme: THEME,
      allowProposedApi: false,
    });
    this.term.loadAddon(this.fit);
    this.term.onData((data) => this.sendRaw(data));
    this.connect();
  }

  get isDead() {
    return this.dead;
  }

  /** Dipanggil sekali saat elemen penampungnya sudah ada di DOM. */
  mount(el: HTMLElement) {
    if (this.opened) return;
    this.opened = true;
    this.term.open(el);
    this.refit();
  }

  private setStatus(status: TermStatus, text: string) {
    this.status = status;
    this.statusText = text;
    this.onChange();
  }

  connect() {
    if (this.dead) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    window.clearTimeout(this.retryTimer);
    this.setStatus(this.failures ? "reconnecting" : "connecting", this.failures ? "Menyambung ulang…" : "Menyambung…");
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const q = this.serverId ? `?id=${encodeURIComponent(this.serverId)}` : "";
    const ws = new WebSocket(`${proto}://${window.location.host}${BASE}/ws/terminal${q}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") {
        this.term.write(new Uint8Array(ev.data as ArrayBuffer));
        return;
      }
      let msg: { type?: string; id?: string; title?: string; replay?: string; message?: string };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        this.term.write(ev.data);
        return;
      }
      if (msg.type === "session") {
        this.failures = 0;
        this.serverId = msg.id || this.serverId;
        if (msg.title) this.title = msg.title;
        // Riwayat layar diputar ulang dari server, jadi isi lama di browser dibuang dulu.
        this.term.reset();
        if (msg.replay) this.term.write(b64ToBytes(msg.replay));
        this.setStatus("connected", "Tersambung");
        this.refit();
        for (const data of this.queued.splice(0)) ws.send(data);
      } else if (msg.type === "gone" || msg.type === "exit") {
        this.dead = true;
        this.setStatus(msg.type === "exit" ? "exited" : "gone", msg.type === "exit" ? "Shell selesai" : "Sesi sudah tidak ada");
        ws.close();
      } else if (msg.type === "error") {
        // Terminal baru yang ditolak (mis. sudah 8 sesi) tidak dicoba ulang terus-menerus.
        if (!this.serverId) this.dead = true;
        this.setStatus("error", msg.message || "Gagal");
      }
    };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (this.dead) return;
      this.failures += 1;
      // Koneksi gagal berulang biasanya berarti sesi login habis (upgrade ditolak 401):
      // cek /api/session supaya aplikasi kembali ke halaman login alih-alih mencoba terus.
      if (this.failures % 3 === 0) api("/api/session").catch(() => {});
      this.setStatus("reconnecting", "Menyambung ulang…");
      this.retryTimer = window.setTimeout(() => this.connect(), 1000);
    };
  }

  private sendRaw(data: string) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  /** Kirim masukan; kalau belum tersambung, ditahan sampai sesi siap (dipakai untuk perintah cd). */
  send(data: string) {
    if (this.ws?.readyState === WebSocket.OPEN && this.status === "connected") this.ws.send(data);
    else this.queued.push(data);
  }

  /** Urutan tombol panah mengikuti mode kursor aplikasi (vim, less, dst.). */
  arrow(dir: "A" | "B" | "C" | "D") {
    this.sendRaw(`${this.term.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b["}${dir}`);
  }

  /** Sesuaikan ukuran ke penampung; diabaikan kalau penampungnya sedang tersembunyi. */
  refit() {
    const el = this.term.element;
    if (!el || !el.offsetParent) return;
    try {
      this.fit.fit();
    } catch {
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "resize", cols: this.term.cols, rows: this.term.rows }));
  }

  focus() {
    this.term.focus();
  }

  /** Lepas dari browser saja; shell di server tetap hidup. */
  detach() {
    this.dead = true;
    window.clearTimeout(this.retryTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      try {
        this.ws.close();
      } catch {
        /* abaikan */
      }
      this.ws = null;
    }
    this.term.dispose();
  }

  /** Matikan shell di server lalu lepas. */
  close() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "close" }));
      } catch {
        /* abaikan */
      }
    }
    if (this.serverId) fetch(`${BASE}/api/terminals/${encodeURIComponent(this.serverId)}`, { method: "DELETE" }).catch(() => {});
    this.detach();
  }
}

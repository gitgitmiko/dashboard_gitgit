// Jembatan kecil antar tab: tab Folder menitipkan folder yang ingin dibuka, tab Remote Claude menitipkan
// terminal yang ingin dilihat; tab Terminal mengambilnya saat dibuka.
let pendingCd = "";
let pendingFocus = "";
const listeners = new Set<() => void>();

export function requestCd(path: string) {
  pendingCd = path;
  listeners.forEach((fn) => fn());
  window.location.hash = "#/terminal";
}

/** Buka tab Terminal dan pilih terminal dengan id server ini (mis. sesi Remote Claude). */
export function requestFocusTerminal(serverId: string) {
  pendingFocus = serverId;
  listeners.forEach((fn) => fn());
  window.location.hash = "#/terminal";
}

export function takePendingFocus() {
  const id = pendingFocus;
  pendingFocus = "";
  return id;
}

export function takePendingCd() {
  const p = pendingCd;
  pendingCd = "";
  return p;
}

export function onPendingCd(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// Jembatan kecil antar tab: tab Folder menitipkan folder yang ingin dibuka, tab Terminal mengambilnya.
let pendingCd = "";
const listeners = new Set<() => void>();

export function requestCd(path: string) {
  pendingCd = path;
  listeners.forEach((fn) => fn());
  window.location.hash = "#/terminal";
}

export function takePendingCd() {
  const p = pendingCd;
  pendingCd = "";
  return p;
}

export function peekPendingCd() {
  return pendingCd;
}

export function onPendingCd(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

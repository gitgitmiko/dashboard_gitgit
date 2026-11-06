// Dashboard bisa disajikan di /agen/v2/ (masa transisi) atau /agen/; API selalu di BASE (/agen).
export const BASE = (() => {
  const path = window.location.pathname;
  const m = path.match(/^(.*?)\/v2(\/|$)/);
  return (m ? m[1] : path).replace(/\/+$/, "") || "/agen";
})();

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { cache: "no-store", ...init });
  } catch {
    throw new ApiError(0, "Koneksi ke server terputus");
  }
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, "Belum masuk");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new ApiError(res.status, data.message || `Gagal (${res.status})`);
  return data as T;
}

export function postJson<T = any>(path: string, body: unknown) {
  return api<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export function qs(params: Record<string, string | number | undefined | null>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

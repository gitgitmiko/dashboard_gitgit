import { LoaderCircle, LockKeyhole, Server } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BASE } from "@/lib/api";

export function Login({ onSuccess }: { onSuccess: (home: string) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${BASE}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password }),
      });
      if (!res.ok) {
        setError("Kata sandi salah");
        return;
      }
      const data = await res.json().catch(() => ({}));
      onSuccess(data.home || "");
    } catch {
      setError("Tidak bisa menghubungi server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative grid min-h-svh place-items-center overflow-hidden px-4">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[48rem] -translate-x-1/2 rounded-full bg-primary/15 blur-3xl" />
      <form onSubmit={submit} className="relative w-full max-w-sm rounded-2xl border bg-card/80 p-7 shadow-xl backdrop-blur">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Server className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Dashboard Gitgit</h1>
            <p className="text-sm text-muted-foreground">Pantau server, folder, dan otomasi.</p>
          </div>
        </div>
        <label htmlFor="password" className="mb-2 block text-sm font-medium">
          Kata sandi
        </label>
        <div className="relative">
          <LockKeyhole className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-10 pl-9"
          />
        </div>
        <p className="mt-2 min-h-5 text-sm text-destructive">{error}</p>
        <Button type="submit" size="lg" className="mt-2 w-full" disabled={busy}>
          {busy && <LoaderCircle className="animate-spin" />}
          Masuk
        </Button>
      </form>
    </div>
  );
}

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type AskOptions = {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  /** Kalau diisi, dialog menampilkan kolom teks dan mengembalikan isinya. */
  input?: { defaultValue?: string; placeholder?: string };
};

type Ask = {
  (opts: AskOptions & { input: NonNullable<AskOptions["input"]> }): Promise<string | null>;
  (opts: AskOptions): Promise<boolean>;
};

const DialogsContext = createContext<Ask>((() => Promise.resolve(false)) as unknown as Ask);
export const useAsk = () => useContext(DialogsContext);

/** Pengganti prompt()/confirm() bawaan browser, dengan tampilan shadcn dan berbasis Promise. */
export function DialogsProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<AskOptions | null>(null);
  const [value, setValue] = useState("");
  const resolver = useRef<(v: string | boolean | null) => void>(() => {});

  const ask = useCallback((o: AskOptions) => {
    setOpts(o);
    setValue(o.input?.defaultValue ?? "");
    return new Promise<string | boolean | null>((resolve) => {
      resolver.current = resolve;
    });
  }, []) as unknown as Ask;

  function close(result: string | boolean | null) {
    resolver.current(result);
    resolver.current = () => {};
    setOpts(null);
  }

  return (
    <DialogsContext.Provider value={ask}>
      {children}
      <Dialog open={!!opts} onOpenChange={(open) => !open && close(opts?.input ? null : false)}>
        {opts && (
          <DialogContent className="max-w-md">
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (opts.input) {
                  if (value.trim()) close(value.trim());
                } else close(true);
              }}
            >
              <DialogHeader>
                <DialogTitle>{opts.title}</DialogTitle>
                {opts.description && <DialogDescription asChild><div className="whitespace-pre-line">{opts.description}</div></DialogDescription>}
              </DialogHeader>
              {opts.input && (
                <Input
                  autoFocus
                  value={value}
                  placeholder={opts.input.placeholder}
                  onChange={(e) => setValue(e.target.value)}
                  onFocus={(e) => {
                    // Pilih nama tanpa ekstensi, seperti pengelola berkas desktop.
                    const dot = e.target.value.lastIndexOf(".");
                    e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
                  }}
                />
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => close(opts.input ? null : false)}>
                  Batal
                </Button>
                <Button type="submit" variant={opts.destructive ? "destructive" : "default"} autoFocus={!opts.input} disabled={!!opts.input && !value.trim()}>
                  {opts.confirmLabel || "OK"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </DialogsContext.Provider>
  );
}

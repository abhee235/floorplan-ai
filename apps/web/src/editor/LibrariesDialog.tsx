// The catalog's libraries (ADR-010 D10, PRD P3-8): what this installation offers, a library's zip to add,
// and a version to take away. A library changes the catalog of every project on the host, which is why it
// is here, among the things a person decides, and not among the agent's tools.

import { Library, Loader2, Package } from "lucide-react";
import type { JSX } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** A library as the host lists it. */
export interface LibraryRow {
  id: string;
  version: string;
  name: string;
  provider: string | null;
  licence: string;
  installedAt: string;
  productCount: number;
  textureCount: number;
  assetCount: number;
  builtIn: boolean;
}

/** "12 products · 4 materials", leaving out what a library has none of. */
export function contentsOf(row: Pick<LibraryRow, "productCount" | "textureCount" | "assetCount">): string {
  const parts = [
    [row.productCount, "product", "products"],
    [row.textureCount, "material", "materials"],
    [row.assetCount, "model", "models"],
  ] as const;
  const said = parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return said.length ? said.join(" · ") : "empty";
}

/** Licence ids as a person reads them. */
const LICENCE_WORDS: Readonly<Record<string, string>> = {
  "CC0-1.0": "CC0",
  "CC-BY-3.0": "CC BY 3.0",
  "CC-BY-4.0": "CC BY 4.0",
  generated: "drawn by the app",
  own: "your own",
};

export interface LibrariesDialogProps {
  open: boolean;
  /** Null while the list is on its way. */
  libraries: readonly LibraryRow[] | null;
  /** Something is being installed or removed. */
  busy: boolean;
  /** What the last attempt was refused for, in the host's words. */
  error: string | null;
  /** What the last change did. */
  notice: string | null;
  onOpenChange: (open: boolean) => void;
  /** Ask for a library's zip. */
  onInstall: () => void;
  onUninstall: (id: string, version: string) => void;
}

export function LibrariesDialog({
  open,
  libraries,
  busy,
  error,
  notice,
  onOpenChange,
  onInstall,
  onUninstall,
}: LibrariesDialogProps): JSX.Element {
  // The row whose removal is being confirmed, as id@version.
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setConfirming(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[80vh] max-w-lg flex-col gap-4 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Libraries</DialogTitle>
          <DialogDescription>
            The catalogs of products and materials offered here. A project keeps every product it placed from
            a library that is removed; materials from it show plain until it is installed again.
          </DialogDescription>
        </DialogHeader>
        <ul
          className="-mx-1 flex min-h-0 flex-col gap-1 overflow-y-auto px-1"
          aria-label="Installed libraries"
        >
          {libraries === null ? (
            <li className="flex items-center gap-2 py-3 text-[12px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Reading what is installed…
            </li>
          ) : (
            libraries.map((l) => {
              const key = `${l.id}@${l.version}`;
              const asking = confirming === key;
              return (
                <li key={key} className="flex items-start gap-3 rounded-md border border-border px-3 py-2.5">
                  {l.builtIn ? (
                    <Package className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  ) : (
                    <Library className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-[13px] font-medium">{l.name}</span>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {l.version}
                      </span>
                    </div>
                    <span className="text-[12px] text-muted-foreground">
                      {[l.provider, LICENCE_WORDS[l.licence] ?? l.licence, contentsOf(l)]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    {asking ? (
                      <span className="mt-1 text-[12px]">
                        Remove {l.name} {l.version}? Its files go from this installation.
                      </span>
                    ) : null}
                  </div>
                  {l.builtIn ? (
                    <span className="shrink-0 self-center rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      Built in
                    </span>
                  ) : asking ? (
                    <div className="flex shrink-0 gap-1.5 self-center">
                      <Button
                        variant="ghost"
                        className="h-7 px-2 text-[12px]"
                        onClick={() => setConfirming(null)}
                      >
                        Keep
                      </Button>
                      <Button
                        variant="destructive"
                        className="h-7 px-2 text-[12px]"
                        disabled={busy}
                        onClick={() => {
                          setConfirming(null);
                          onUninstall(l.id, l.version);
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      className="h-7 shrink-0 self-center px-2 text-[12px]"
                      disabled={busy}
                      aria-label={`Remove ${l.name} ${l.version}`}
                      onClick={() => setConfirming(key)}
                    >
                      Remove…
                    </Button>
                  )}
                </li>
              );
            })
          )}
        </ul>
        {error ? (
          <p role="alert" className="text-[12px] text-destructive">
            {error}
          </p>
        ) : notice ? (
          <p role="status" className="text-[12px] text-muted-foreground">
            {notice}
          </p>
        ) : null}
        <DialogFooter className="gap-2">
          <Button variant="outline" className="h-8" disabled={busy} onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button className="h-8 gap-1.5" disabled={busy} onClick={onInstall}>
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            Install a library…
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

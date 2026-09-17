// A strip saying the host is running code older than what is written, or that the app has not been built
// since its source changed (see apps/host/src/staleness.ts for how that is decided).
//
// It takes a row of its own rather than floating over the plan, because the point is to be read before
// anything else is believed: a stale host makes a correct change look broken, which is an expensive way
// to spend an afternoon. It can be dismissed, and it comes back on the next connection if it is still
// true.

import { cn } from "cn";
import { TriangleAlert, X } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export function StaleNote({ note, className }: { note: string | null; className?: string }): JSX.Element {
  const [dismissed, setDismissed] = useState<string | null>(null);
  // A different sentence is a different piece of news, so dismissing one does not silence the next.
  useEffect(() => setDismissed(null), [note]);
  if (!note || dismissed === note) return <></>;
  return (
    <div
      role="status"
      className={cn(
        "flex h-7 items-center gap-2 border-b border-[#e0c48a] bg-[#fdf4e0] px-3 text-xs text-[#6b4d0f]",
        className,
      )}
    >
      <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{note}</span>
      <span className="grow" />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss"
        className="text-[#6b4d0f] hover:bg-[#f3e4c4]"
        onClick={() => setDismissed(note)}
      >
        <X aria-hidden />
      </Button>
    </div>
  );
}

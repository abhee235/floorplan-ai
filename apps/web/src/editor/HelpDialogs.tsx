// Help ▸ Keyboard shortcuts, and Help ▸ About.
//
// Both are read from something that already exists rather than written out by hand. The shortcut sheet
// comes off the command registry, so it says what the keys actually do and cannot go stale; About comes
// off the host's welcome message, which is what the tab was told when it connected.

import type { JSX } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { RegisteredCommand } from "./commands.js";

/** The chord as separate keys, so each is drawn as a key rather than the whole thing as one wide one. */
function keys(shortcut: string): string[] {
  return shortcut.split("+");
}

export interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: readonly RegisteredCommand[];
}

export function ShortcutsDialog({ open, onOpenChange, commands }: ShortcutsDialogProps): JSX.Element {
  // Only what a key actually fires. A list padded with commands that have no shortcut would be a list
  // of commands, which is what the palette is for.
  const withKeys = commands.filter((c) => c.shortcut);
  const groups = [...new Set(withKeys.map((c) => c.group))];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Every key the editor listens for. Press <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd> for the full list of commands, including those without a key.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] pr-3">
          {groups.map((group) => (
            <section key={group} className="mb-4 last:mb-0">
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">{group}</h3>
              <dl className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1">
                {withKeys
                  .filter((c) => c.group === group)
                  .map((c) => (
                    <div key={c.id} className="contents">
                      <dt className="truncate text-sm">{c.title}</dt>
                      <dd className="flex gap-0.5 justify-self-end">
                        {keys(c.shortcut as string).map((k) => (
                          <Kbd key={k}>{k}</Kbd>
                        ))}
                      </dd>
                    </div>
                  ))}
              </dl>
            </section>
          ))}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

export interface AboutFacts {
  appVersion: string;
  hostVersion: string | null;
  protocolVersion: number | null;
  projectName: string | null;
  projectPath: string | null;
  /** The host's own warning that it is running code older than what is on disk, or null. */
  stale: string | null;
  bridge: string;
}

export interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  facts: AboutFacts;
}

/** The things worth knowing when something is wrong and you are about to say so to someone. */
export function AboutDialog({ open, onOpenChange, facts }: AboutDialogProps): JSX.Element {
  const rows: [string, string][] = [
    ["Editor", facts.appVersion],
    ["Host", facts.hostVersion ?? "not connected"],
    ["Bridge", `${facts.bridge}${facts.protocolVersion ? ` · protocol ${facts.protocolVersion}` : ""}`],
    ["Project", facts.projectName ?? "—"],
    ["File", facts.projectPath ?? "not saved to a file"],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>About floorplan-ai</DialogTitle>
          <DialogDescription>
            What is running, and where this project lives. Worth copying into a defect report.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-1.5 text-sm">
          {rows.map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-muted-foreground">{name}</dt>
              <dd className="min-w-0 break-all font-mono text-xs leading-5">{value}</dd>
            </div>
          ))}
        </dl>
        {facts.stale ? (
          <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">{facts.stale}</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// The command palette (ADR-017 D4): every command with its shortcut, which is how shortcuts stay
// discoverable. cmdk does the filtering, the roving and the aria-activedescendant that palette.ts used to
// do by hand; the registry still decides what exists, what it is called and whether it applies now.

import type { JSX } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import type { CommandRegistry } from "./commands.js";
import { describeChord } from "./keys.js";
import { paletteSections } from "./status.js";

export interface CommandPaletteProps {
  commands: CommandRegistry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRun: (id: string) => void;
}

export function CommandPalette({ commands, open, onOpenChange, onRun }: CommandPaletteProps): JSX.Element {
  // cmdk filters as the person types, so the palette hands it every command and lets it choose. The
  // grouping still comes from the registry, so sections stay in registration order.
  const sections = paletteSections(commands.match(""));

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Commands"
      description="Every command, with its shortcut"
    >
      <CommandInput placeholder="Search commands" />
      <CommandList>
        <CommandEmpty>No command matches that.</CommandEmpty>
        {sections.map((section) => (
          <CommandGroup key={section.group} heading={section.group}>
            {section.items.map(({ command }) => {
              const enabled = command.enabled?.() ?? true;
              return (
                <CommandItem
                  key={command.id}
                  value={`${command.title} ${command.group} ${command.detail ?? ""}`}
                  disabled={!enabled}
                  onSelect={() => {
                    onOpenChange(false);
                    onRun(command.id);
                  }}
                >
                  <span className="grow">
                    {command.title}
                    {command.detail ? (
                      <span className="text-muted-foreground text-xs"> · {command.detail}</span>
                    ) : null}
                  </span>
                  {command.chord ? <CommandShortcut>{describeChord(command.chord)}</CommandShortcut> : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}

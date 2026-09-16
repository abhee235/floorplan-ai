// The app bar (ADR-017 D1): what is open, which level, the history, what is on screen, and the two file
// actions. Every button runs a registered command rather than calling the bridge itself, so the palette,
// the keyboard and the mouse all take one path (ADR-018 D3).

import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Replica } from "../replica.js";
import type { ViewMode } from "./useEditor.js";
import { useEditor } from "./useEditor.js";
import { useProject } from "./useReplica.js";

export interface AppBarProps {
  replica: Replica;
  level: string | null;
  onLevel: (levelId: string) => void;
  onImport: () => void;
}

const VIEWS: [ViewMode, string][] = [
  ["plan", "Plan"],
  ["both", "Plan + 3D"],
  ["3d", "3D"],
];

/** 28px, one step under the registry's `sm` (h-8). Set here rather than in the theme because a height is
 *  an ordinary utility, not a responsive variant, so it beats the component's own h-8/h-9 from a call site
 *  — unlike the text size, which had to be changed at the token. */
const CONTROL = "h-7 px-2.5 font-normal";

export function AppBar({ replica, level, onLevel, onImport }: AppBarProps): JSX.Element {
  const editor = useEditor();
  const project = useProject(replica);
  const levels = [...(project?.levels ?? [])].sort((a, b) => a.index - b.index);
  const run = (id: string) => void editor.commands.run(id);

  return (
    <header className="flex h-10 items-center gap-2 border-b bg-card px-3">
      <strong className="truncate font-semibold">{project?.meta.name ?? "floorplan-viz"}</strong>

      <Separator orientation="vertical" className="mx-1 h-4" />

      <Select value={level ?? ""} onValueChange={onLevel}>
        <SelectTrigger size="sm" aria-label="Level" className="h-7 w-[104px] gap-1">
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          {levels.map((l) => (
            <SelectItem key={l.id} value={l.id}>
              {l.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex gap-0.5" role="group" aria-label="History">
        <Button variant="ghost" className={CONTROL} onClick={() => run("edit.undo")}>
          Undo
        </Button>
        <Button variant="ghost" className={CONTROL} onClick={() => run("edit.redo")}>
          Redo
        </Button>
      </div>

      <span className="grow" />

      <ToggleGroup
        type="single"
        value={editor.view}
        onValueChange={(v) => {
          if (v) editor.setView(v as ViewMode);
        }}
        variant="outline"
        aria-label="What is on screen"
        className="h-7"
      >
        {VIEWS.map(([mode, label]) => (
          <ToggleGroupItem
            key={mode}
            value={mode}
            className="h-7 px-2.5 aria-checked:bg-accent aria-checked:text-accent-foreground"
          >
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <Separator orientation="vertical" className="mx-1 h-4" />

      <Button variant="outline" className={CONTROL} onClick={onImport}>
        Import plan…
      </Button>
      <Button className={CONTROL} onClick={() => run("file.export")}>
        Export
      </Button>
    </header>
  );
}

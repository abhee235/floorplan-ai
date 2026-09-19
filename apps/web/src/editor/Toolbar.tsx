// The toolbar (ADR-017 D1 amendment, D2): the row under the menu bar.
//
// The menu bar above holds menus and nothing else, the way a desktop application separates the two: the
// things you press live here, the things you browse live up there. Left to right the row goes from the
// most general to the most particular — the level, then the history, then whatever the active tool
// offers, which is the only part that changes as you work — and what is on screen sits at the far right,
// away from the document controls, because it describes the workspace rather than the project.
//
// Control sizing is not set here. The density block in styles.css puts every input, select and label on
// the chrome's scale at once, because the registry's own `md:text-sm` cannot be overridden from a call
// site. Only what genuinely differs from that scale is stated below.

import { Box, Columns2, type LucideIcon, Map as MapIcon, Redo2, Undo2 } from "lucide-react";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Replica } from "../replica.js";
import { Keyed } from "./Phrase.js";
import type { ToolOption } from "./tools.js";
import { toolReady } from "./tools.js";
import type { ViewMode } from "./useEditor.js";
import { useEditor } from "./useEditor.js";
import { useProject } from "./useReplica.js";

const VIEWS: [ViewMode, string, LucideIcon][] = [
  ["plan", "Plan", MapIcon],
  ["both", "Plan + 3D", Columns2],
  ["3d", "3D", Box],
];

/** 28px, one step under the registry's `sm` (h-8), matching the rest of the chrome. */
const CONTROL = "h-7 gap-1.5 px-2.5 font-normal";

export interface ToolbarProps {
  replica: Replica | null;
  level: string | null;
  onLevel: (levelId: string) => void;
}

export function Toolbar({ replica, level, onLevel }: ToolbarProps): JSX.Element {
  const editor = useEditor();
  const tool = editor.tool;
  const ready = toolReady(tool);
  const project = useProject(replica);
  const levels = [...(project?.levels ?? [])].sort((a, b) => a.index - b.index);
  const run = (id: string) => void editor.commands.run(id);

  return (
    <div
      role="toolbar"
      aria-label="Toolbar"
      className="flex h-9 items-center gap-2 overflow-hidden border-b bg-muted/30 px-3 whitespace-nowrap"
    >
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
        <Button variant="outline" className={CONTROL} onClick={() => run("edit.undo")}>
          <Undo2 aria-hidden />
          Undo
        </Button>
        <Button variant="outline" className={CONTROL} onClick={() => run("edit.redo")}>
          <Redo2 aria-hidden />
          Redo
        </Button>
      </div>

      <Separator orientation="vertical" className="mx-1 h-4" />

      {/* The only part of the row that changes as you work, so it keeps its own name for a screen
          reader even though it no longer has the row to itself. */}
      <div role="group" aria-label="Settings for the active tool" className="flex items-center gap-3">
        <span className="font-semibold">{tool.title}</span>
        {tool.options.length > 0 ? <Separator orientation="vertical" className="h-4" /> : null}
        <div className="flex items-center gap-4">
          {tool.options.map((option) => (
            <OptionField key={option.id} option={option} />
          ))}
        </div>
      </div>

      <span className="grow" />

      {/* The modifier sentence is guidance, so it is the first thing allowed to go when the row is
          narrow — every control beside it keeps its full width. */}
      <span
        className={`min-w-0 truncate ${ready ? "text-muted-foreground" : "text-[#a05a00]"}`}
        title={ready ? undefined : "Not built yet"}
      >
        {ready ? <Keyed phrase={tool.modifiers} /> : "Not built yet: this tool changes nothing on the plan."}
      </span>

      <Separator orientation="vertical" className="mx-1 h-4 shrink-0" />

      <ToggleGroup
        type="single"
        value={editor.view}
        onValueChange={(v) => {
          if (v) editor.setView(v as ViewMode);
        }}
        variant="outline"
        aria-label="What is on screen"
        className="h-7 shrink-0"
      >
        {VIEWS.map(([mode, label, Icon]) => (
          <ToggleGroupItem
            key={mode}
            value={mode}
            className="h-7 gap-1.5 px-2.5 aria-checked:bg-accent aria-checked:text-accent-foreground"
          >
            <Icon aria-hidden />
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function OptionField({ option }: { option: ToolOption }): JSX.Element {
  const editor = useEditor();
  const toolId = editor.tool.id;
  const value = editor.option(toolId, option.id);
  const id = `tool-option-${toolId}-${option.id}`;

  if (option.kind === "toggle") {
    return (
      <div className="flex items-center gap-1.5">
        <Checkbox
          id={id}
          checked={value === true}
          onCheckedChange={(next) => editor.setOption(toolId, option.id, next === true)}
        />
        <Label htmlFor={id} className="text-muted-foreground">
          {option.label}
        </Label>
      </div>
    );
  }

  if (option.kind === "number") {
    return (
      <div className="flex items-center gap-1.5">
        <Label htmlFor={id} className="text-muted-foreground">
          {option.label}
        </Label>
        <Input
          id={id}
          type="number"
          value={String(value ?? "")}
          onChange={(e) => editor.setOption(toolId, option.id, Number(e.target.value))}
          className="h-7 w-20 text-right tabular-nums"
        />
        {option.unit ? <span className="text-muted-foreground">{option.unit}</span> : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={id} className="text-muted-foreground">
        {option.label}
      </Label>
      <Select value={String(value ?? "")} onValueChange={(next) => editor.setOption(toolId, option.id, next)}>
        <SelectTrigger id={id} size="sm" className="h-7 gap-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(option.choices ?? []).map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

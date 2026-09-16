// The active tool's own options bar (ADR-017 D2): its settings, the snapping switches the modifier keys
// invert (W-082), and a plain sentence naming those modifiers. A tool with nothing behind it says so here
// rather than leaving a person clicking at a canvas that will not answer.

import type { JSX } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { ToolOption } from "./tools.js";
import { toolReady } from "./tools.js";
import { useEditor } from "./useEditor.js";

export function ToolOptionsBar(): JSX.Element {
  const editor = useEditor();
  const tool = editor.tool;
  const ready = toolReady(tool);
  return (
    <div
      role="toolbar"
      aria-label="Settings for the active tool"
      className="flex h-[30px] items-center gap-2.5 overflow-hidden border-b bg-muted/40 px-3 whitespace-nowrap"
    >
      <span className="font-semibold">{tool.title}</span>
      <Separator orientation="vertical" className="h-4" />
      <div className="flex items-center gap-3">
        {tool.options.map((option) => (
          <OptionField key={option.id} option={option} />
        ))}
      </div>
      <span className="grow" />
      <span className={ready ? "text-muted-foreground" : "text-[#a05a00]"}>
        {ready ? tool.modifiers : "Not built yet: this tool changes nothing on the plan so far."}
      </span>
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
        <Label htmlFor={id} className="text-muted-foreground font-normal">
          {option.label}
        </Label>
      </div>
    );
  }

  if (option.kind === "number") {
    return (
      <div className="flex items-center gap-1.5">
        <Label htmlFor={id} className="text-muted-foreground font-normal">
          {option.label}
        </Label>
        <Input
          id={id}
          type="number"
          value={String(value ?? "")}
          onChange={(e) => editor.setOption(toolId, option.id, Number(e.target.value))}
          className="h-6 w-[68px] px-1.5 py-0 text-right tabular-nums"
        />
        {option.unit ? <span className="text-muted-foreground">{option.unit}</span> : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={id} className="text-muted-foreground font-normal">
        {option.label}
      </Label>
      <Select value={String(value ?? "")} onValueChange={(next) => editor.setOption(toolId, option.id, next)}>
        <SelectTrigger id={id} size="sm" className="h-6 py-0">
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

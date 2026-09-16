// The tool rail (ADR-017 D1, D2). Radix owns the roving tabindex now, which is why roving.ts is gone:
// a single-select ToggleGroup is one tab stop with arrow keys inside it, which is what the hand-written
// version was for. The icons are the same paths the design canvas used, inlined as JSX.

import type { JSX } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TOOLS, type ToolId, toolReady } from "./tools.js";
import { useEditor } from "./useEditor.js";

export function ToolRail(): JSX.Element {
  const editor = useEditor();
  return (
    <ToggleGroup
      type="single"
      value={editor.tool.id}
      onValueChange={(value) => {
        // Radix clears the value when the pressed item is pressed again; a tool is always active, so an
        // empty value means "stay where you are" rather than "no tool".
        if (value) editor.setTool(value as ToolId);
      }}
      orientation="vertical"
      aria-label="Tools"
      className="flex w-11 flex-col items-center gap-0.5 border-r bg-card py-1.5"
    >
      {TOOLS.map((tool) => {
        const ready = toolReady(tool);
        return (
          <Tooltip key={tool.id}>
            <TooltipTrigger asChild>
              <ToggleGroupItem
                value={tool.id}
                aria-label={`${tool.title}, ${tool.shortcut}${ready ? "" : ", not built yet"}`}
                data-tool={tool.id}
                className={`size-[34px] rounded-md ${ready ? "" : "opacity-45"}`}
              >
                <ToolIcon id={tool.id} />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent side="right">
              {tool.title} ({tool.shortcut}){ready ? "" : " — not built yet"}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </ToggleGroup>
  );
}

/** 18px line icons, the same geometry the design canvas drew. */
function ToolIcon({ id }: { id: ToolId }): JSX.Element {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    "aria-hidden": true,
  } as const;
  switch (id) {
    case "select":
      return (
        <svg {...common} strokeLinejoin="round">
          <path d="M5 3l14 8-6 1.6L10 19z" />
        </svg>
      );
    case "wall":
      return (
        <svg {...common}>
          <path d="M3 15h18M3 9h18" strokeLinecap="round" />
          <path d="M8 9v6M16 9v6" />
        </svg>
      );
    case "room":
      return (
        <svg {...common} strokeLinejoin="round">
          <path d="M4 5h16v14H4z" />
          <path d="M4 12h8v7" />
        </svg>
      );
    case "opening":
      return (
        <svg {...common}>
          <path d="M3 12h5M16 12h5" strokeLinecap="round" />
          <path d="M8 12a8 8 0 0 1 8 0" />
          <path d="M8 12v-6" />
        </svg>
      );
    case "item":
      return (
        <svg {...common} strokeLinejoin="round">
          <path d="M4 9h16v9H4z" />
          <path d="M7 9V6h10v3" />
        </svg>
      );
    case "measure":
      return (
        <svg {...common} strokeLinejoin="round">
          <path d="M3 14l11-11 7 7-11 11z" />
          <path d="M8 9l2 2M11 6l2 2M5 12l2 2" />
        </svg>
      );
    case "annotate":
      return (
        <svg {...common} strokeLinecap="round">
          <path d="M5 6h14M12 6v13M9 19h6" />
        </svg>
      );
    case "pan":
      return (
        <svg {...common} strokeLinejoin="round">
          <path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11m0-1.5a1.5 1.5 0 0 1 3 0V12m0-1a1.5 1.5 0 0 1 3 0v4a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5v-3a1.5 1.5 0 0 1 3 0" />
        </svg>
      );
  }
}

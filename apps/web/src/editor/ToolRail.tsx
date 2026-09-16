// The tool rail (ADR-017 D1, D2). Radix owns the roving tabindex now, which is why roving.ts is gone:
// a single-select ToggleGroup is one tab stop with arrow keys inside it, which is what the hand-written
// version was for. The icons are the same paths the design canvas used, inlined as JSX.

import type { JSX } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TOOLS, type ToolId, toolReady } from "./tools.js";
import { useEditor } from "./useEditor.js";

// toggle-group rounds its first and last child for a HORIZONTAL row, which on a vertical rail came out as
// `8px 0 0 8px`: rounded down one side only. `rounded-lg!` overrides that rule on every item.
// The selected state keys off aria-checked, NOT data-state. TooltipTrigger asChild merges its props onto
// this same element, and both it and the toggle write data-state — the tooltip's "closed" wins, so
// `data-[state=on]:` never matched and the active tool had no visible state at all. aria-checked is the
// toggle's own, and is what assistive technology reads anyway.
//
// 40px targets, which is the rail's own scale rather than the 32px of a bar button: these are the one
// control a person aims at all day, and they sit alone in a column with nothing to line up against.
const ITEM =
  "size-10 rounded-lg! text-muted-foreground transition-colors hover:bg-muted hover:text-foreground " +
  "aria-checked:bg-accent aria-checked:text-accent-foreground";

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
      className="flex w-14 flex-col items-center gap-1 border-r bg-card py-2"
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
                className={ready ? ITEM : `${ITEM} opacity-40`}
              >
                <ToolIcon id={tool.id} />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent side="right">
              {tool.title}
              <span className="ml-1.5 opacity-60">{tool.shortcut}</span>
              {ready ? "" : " · not built yet"}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </ToggleGroup>
  );
}

/** 22px line icons, the same geometry the design canvas drew.
 *
 * The size is a CLASS, not the width/height attributes, and that is the whole point. toggleVariants ends
 * with `[&_svg:not([class*='size-'])]:size-4`, and a CSS rule beats a presentational attribute no matter
 * what the attribute says — so these painted at 16px however large the width= claimed to be. The `:not()`
 * is the registry's own opt-out: any class containing "size-" takes the rule out of the running. Measured,
 * not assumed — `getComputedStyle(svg).width` said 16px while the attribute said 22.
 *
 * The 24-unit viewBox scales the stroke with the icon, so weight is not automatic either: at 22px a 1.7
 * stroke renders about 1.56 device px, which is what made these read as faint. 1.9 lands just over 1.7px. */
function ToolIcon({ id }: { id: ToolId }): JSX.Element {
  const common = {
    className: "size-5.5",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
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

// The tool rail (ADR-017 D1, D2). Radix owns the roving tabindex now, which is why roving.ts is gone:
// a single-select ToggleGroup is one tab stop with arrow keys inside it, which is what the hand-written
// version was for.
//
// The icons are lucide's, not ours. Every tool found a real match, so nothing is hand drawn any more: a
// set someone else maintains stays consistent as it grows, and lucide's own geometry is better resolved
// at 20px than the paths that were here. It also happens to be a drop-in — lucide draws at stroke 2 on a
// 24-unit viewBox, which is the exact weight the hand-rolled set had been tuned to.

import {
  Armchair,
  BrickWall,
  DoorOpen,
  Frame,
  Hand,
  type LucideIcon,
  MousePointer2,
  Ruler,
  Type,
} from "lucide-react";
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
// 32px targets: the rail sits at the chrome's density rather than above it. They still read as the largest
// thing in the chrome because they are square and hold a 20px icon, where a bar control is 28px of mostly
// text.
const ITEM =
  "size-8 rounded-lg! text-muted-foreground transition-colors hover:bg-muted hover:text-foreground " +
  "aria-checked:bg-accent aria-checked:text-accent-foreground";

/** One lucide icon per tool. Keyed by ToolId rather than looked up by string, so adding a tool without an
 *  icon is a type error rather than a blank button. */
const ICONS: Record<ToolId, LucideIcon> = {
  select: MousePointer2,
  wall: BrickWall,
  // Frame rather than Square: a room is an area defined by its edges, and the crop-mark corners say that
  // where a plain square just says "shape". SquareDashed would have been the obvious alternative, but a
  // dashed rectangle is the marquee idiom and would read as a second select tool.
  room: Frame,
  opening: DoorOpen,
  item: Armchair,
  measure: Ruler,
  annotate: Type,
  pan: Hand,
};

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
      className="flex w-12 flex-col items-center gap-0.5 border-r bg-card py-1.5"
    >
      {TOOLS.map((tool) => {
        const ready = toolReady(tool);
        const Icon = ICONS[tool.id];
        return (
          <Tooltip key={tool.id}>
            <TooltipTrigger asChild>
              <ToggleGroupItem
                value={tool.id}
                aria-label={`${tool.title}, ${tool.shortcut}${ready ? "" : ", not built yet"}`}
                data-tool={tool.id}
                className={ready ? ITEM : `${ITEM} opacity-40`}
              >
                {/* The size is a CLASS, never the width/height props. toggleVariants ends with
                    `[&_svg:not([class*='size-'])]:size-4` and a CSS rule beats a presentational
                    attribute, so a sized prop would silently render at 16px — which is exactly what
                    happened to the hand-rolled icons this replaced. */}
                <Icon className="size-5" aria-hidden />
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

/** 20px line icons, the same geometry the design canvas drew.
 *
 * The size is a CLASS, not the width/height attributes, and that is the whole point. toggleVariants ends
 * with `[&_svg:not([class*='size-'])]:size-4`, and a CSS rule beats a presentational attribute no matter
 * what the attribute says — so these painted at 16px however large the width= claimed to be. The `:not()`
 * is the registry's own opt-out: any class containing "size-" takes the rule out of the running. Measured,
 * not assumed — `getComputedStyle(svg).width` said 16px while the attribute said 22.
 *
 * The 24-unit viewBox scales the stroke with the icon, so shrinking one thins the other: at 20px a 1.9
 * stroke would render 1.58 device px, lighter than the 1.74 it had at 22px. 2.0 holds it at 1.67. */
function ToolIcon({ id }: { id: ToolId }): JSX.Element {
  const common = {
    className: "size-5",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
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

// The tool rail (ADR-017 D1, D2). Radix owns the roving tabindex now, which is why roving.ts is gone:
// a single-select ToggleGroup is one tab stop with arrow keys inside it, which is what the hand-written
// version was for.
//
// The icons are lucide's, not ours. Every tool found a real match, so nothing is hand drawn any more: a
// set someone else maintains stays consistent as it grows, and lucide's own geometry is better resolved
// at 20px than the paths that were here.
//
// Stroke is 1.5, not lucide's default 2. Lucide draws on a 24-unit grid and scales stroke WITH size, so a
// 2 renders 1.67 device px at our 20px — heavy for a glyph this small, and it made the rail the densest
// ink in the chrome. 1.5 lands at 1.25. Note that `absoluteStrokeWidth` is the wrong lever here: it pins
// the stroke at a constant 2px regardless of size, which is heavier still.

import {
  Armchair,
  BrickWall,
  DoorOpen,
  Grid2x2,
  Hand,
  type LucideIcon,
  MousePointer2,
  RulerDimensionLine,
  SquareDimensions,
  Type,
} from "lucide-react";
import type { JSX } from "react";
import { Kbd } from "@/components/ui/kbd";
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
//
// The selected tool is a SOLID primary fill with a white glyph, not the pale accent tint it used to be.
// The active tool is the single most important piece of state in the whole editor — it decides what the
// next click does — and a 4% tint of blue is not a strong enough signal to carry that. A filled swatch
// reads instantly at the edge of vision, which is where the rail actually lives while you are drawing.
const ITEM =
  "size-8 rounded-lg! text-muted-foreground transition-colors hover:bg-muted hover:text-foreground " +
  "aria-checked:bg-primary aria-checked:text-primary-foreground aria-checked:hover:bg-primary";

/** One lucide icon per tool. Keyed by ToolId rather than looked up by string, so adding a tool without an
 *  icon is a type error rather than a blank button.
 *
 *  Each is chosen to say what the tool DOES, not what it is about, because an icon you have to hover to
 *  understand has failed at the only job it has. SquareDimensions is a rectangle carrying its measurements
 *  — a room with a size — where the plain Frame it replaces said only "shape". RulerDimensionLine is a
 *  ruler against a dimension line, which is the act of measuring rather than the object. */
const ICONS: Record<ToolId, LucideIcon> = {
  select: MousePointer2,
  wall: BrickWall,
  room: SquareDimensions,
  opening: DoorOpen,
  item: Armchair,
  // A grid of four: what a cluster lays down, rather than a desk, which would repeat the item tool.
  zone: Grid2x2,
  measure: RulerDimensionLine,
  annotate: Type,
  pan: Hand,
};

/** Where a new band of tools starts, in TOOLS order: select · draw · document · navigate.
 *
 *  Grouping is what actually buys the breathing space, and it does more than spacing: a tool's neighbours
 *  say what kind of thing it is before you hover it. PatternFly's toolbar spec is 4px within a group and
 *  16px between, which is what `gap-1` plus this 12px top margin comes to. */
const GROUP_STARTS: ReadonlySet<ToolId> = new Set<ToolId>(["wall", "measure", "pan"]);

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
      className="flex w-12 flex-col items-center gap-1 border-r bg-card py-2"
    >
      {TOOLS.map((tool) => {
        const ready = toolReady(tool);
        const Icon = ICONS[tool.id];
        // The margin rides on the item rather than on a wrapper: Radix registers the ITEMS for its roving
        // tabindex, so wrapping each band in a div would put a node between the group and what it tracks.
        const className = [ITEM, ready ? "" : "opacity-40", GROUP_STARTS.has(tool.id) ? "mt-3" : ""]
          .filter(Boolean)
          .join(" ");
        return (
          <Tooltip key={tool.id}>
            <TooltipTrigger asChild>
              <ToggleGroupItem
                value={tool.id}
                aria-label={`${tool.title}, ${tool.shortcut}${ready ? "" : ", not built yet"}`}
                data-tool={tool.id}
                className={className}
              >
                {/* The size is a CLASS, never the width/height props. toggleVariants ends with
                    `[&_svg:not([class*='size-'])]:size-4` and a CSS rule beats a presentational
                    attribute, so a sized prop would silently render at 16px — which is exactly what
                    happened to the hand-rolled icons this replaced. strokeWidth has no such problem;
                    it is a real SVG presentation attribute with no competing utility. */}
                <Icon className="size-5" strokeWidth={1.5} aria-hidden />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent side="right">
              {tool.title}
              <Kbd className="ml-1.5">{tool.shortcut}</Kbd>
              {ready ? "" : " · not built yet"}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </ToggleGroup>
  );
}

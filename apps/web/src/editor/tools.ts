// The tools on the rail (ADR-017 D2): each is a mode with one letter, its own options bar, a sentence
// naming the modifiers, and the way it is driven from the keyboard alone. ADR-017 says a tool that does
// not state all of those cannot be added to the rail, so `checkTool` enforces it rather than a comment.

export type ToolId = "select" | "wall" | "room" | "opening" | "item" | "measure" | "annotate" | "pan";

export interface ToolOption {
  id: string;
  label: string;
  kind: "toggle" | "number" | "choice";
  /** The starting value, and what "reset" returns to. */
  value: string | number | boolean;
  /** For "choice" only. */
  choices?: { value: string; label: string }[];
  /** For "number" only, shown after the field. */
  unit?: string;
}

export interface ToolDefinition {
  id: ToolId;
  title: string;
  /** One letter, or "Space" for pan (ADR-017 D2). Escape always returns to select. */
  shortcut: string;
  /** What the tool does, for the palette and the tool options bar. */
  summary: string;
  /** The plain sentence in the options bar naming the modifier keys. */
  modifiers: string;
  /** How the tool is driven with no pointer at all (ADR-017 D4). */
  keyboard: string;
  options: ToolOption[];
}

const SNAP_OPTIONS: ToolOption[] = [
  { id: "snapWalls", label: "Snap to walls", kind: "toggle", value: true },
  { id: "snapAngle", label: "Angle steps 15°", kind: "toggle", value: true },
  { id: "snapGrid", label: "Grid 100 mm", kind: "toggle", value: false },
];

/** Snapping is a preference the modifier keys invert (W-082). */
const SNAP_MODIFIERS = "Hold Shift to align · Alt to bypass snapping";

export const TOOLS: ToolDefinition[] = [
  {
    id: "select",
    title: "Select",
    shortcut: "V",
    summary: "Pick, move and edit what is already there",
    modifiers: "Hold Shift to add to the selection · Alt to bypass snapping",
    keyboard: "Tab steps through entities, arrows nudge, Space picks up and drops, Enter opens properties",
    options: SNAP_OPTIONS,
  },
  {
    id: "wall",
    title: "Draw wall",
    shortcut: "W",
    summary: "Draw a chain of walls",
    modifiers: SNAP_MODIFIERS,
    keyboard: "Type a length, Tab, an angle, then Enter to place; Enter twice ends the chain",
    options: [
      { id: "thickness", label: "Thickness", kind: "number", value: 100, unit: "mm" },
      {
        id: "kind",
        label: "Kind",
        kind: "choice",
        value: "interior",
        choices: [
          { value: "exterior", label: "Exterior" },
          { value: "interior", label: "Interior" },
          { value: "partition", label: "Partition" },
          { value: "glass", label: "Glass" },
        ],
      },
      ...SNAP_OPTIONS,
    ],
  },
  {
    id: "room",
    title: "Draw room",
    shortcut: "R",
    summary: "Draw a room, or fill an area the walls already enclose",
    modifiers: SNAP_MODIFIERS,
    keyboard: "Type a side length, Tab, an angle, then Enter; Enter twice closes the room",
    options: SNAP_OPTIONS,
  },
  {
    id: "opening",
    title: "Add door or window",
    shortcut: "O",
    summary: "Place a door, window or passage in a wall",
    modifiers: "Hold Alt to bypass snapping to the middle of the wall",
    keyboard: "Tab to a wall, Enter to place, then arrows slide it along and Enter confirms",
    options: [
      {
        id: "opening",
        label: "Opening",
        kind: "choice",
        value: "door",
        choices: [
          { value: "door", label: "Door" },
          { value: "window", label: "Window" },
          { value: "passage", label: "Passage" },
        ],
      },
      { id: "width", label: "Width", kind: "number", value: 900, unit: "mm" },
    ],
  },
  {
    id: "item",
    title: "Place item",
    shortcut: "I",
    summary: "Place a piece from the catalog",
    modifiers: SNAP_MODIFIERS,
    keyboard: "Arrows move the piece, brackets rotate it by 15 degrees, Enter places it",
    options: [{ id: "rotation", label: "Rotation", kind: "number", value: 0, unit: "°" }, ...SNAP_OPTIONS],
  },
  {
    id: "measure",
    title: "Measure",
    shortcut: "M",
    summary: "Measure a distance without changing anything",
    modifiers: "Hold Shift to measure along an axis",
    keyboard: "Tab to a point, Enter to start, Tab to the second point, Enter to read the distance",
    options: [
      {
        id: "units",
        label: "Units",
        kind: "choice",
        value: "mm",
        choices: [
          { value: "mm", label: "Millimetres" },
          { value: "m", label: "Metres" },
          { value: "ft", label: "Feet and inches" },
        ],
      },
    ],
  },
  {
    id: "annotate",
    title: "Annotate",
    shortcut: "T",
    summary: "Add a label or a dimension line",
    modifiers: "Hold Shift to keep the line on an axis",
    keyboard: "Enter starts a label where focus is, then type and press Enter again",
    options: [
      {
        id: "annotation",
        label: "Annotation",
        kind: "choice",
        value: "label",
        choices: [
          { value: "label", label: "Label" },
          { value: "dimension", label: "Dimension line" },
        ],
      },
    ],
  },
  {
    id: "pan",
    title: "Pan",
    shortcut: "Space",
    summary: "Move the view without changing anything",
    modifiers: "Hold Space from any tool to pan, and let go to return to it",
    keyboard: "Arrows pan the view, F fits the plan to the window",
    options: [],
  },
];

/** What is missing before this tool may go on the rail (ADR-017 consequences). Empty means it may. */
export function checkTool(tool: ToolDefinition): string[] {
  const missing: string[] = [];
  if (!tool.shortcut.trim()) missing.push("a shortcut");
  if (!tool.summary.trim()) missing.push("a summary");
  if (!tool.modifiers.trim()) missing.push("a sentence naming its modifiers");
  if (!tool.keyboard.trim()) missing.push("a keyboard path");
  return missing;
}

/** Throws unless every tool states what ADR-017 requires; the shell calls this as it builds the rail. */
export function checkTools(tools: readonly ToolDefinition[] = TOOLS): void {
  for (const tool of tools) {
    const missing = checkTool(tool);
    if (missing.length)
      throw new Error(`tool ${tool.id} cannot go on the rail without ${missing.join(", ")}`);
  }
}

/** The tools that actually change something on the plan today. The rest are on the rail so the shape of
 *  the editor is visible, but they do nothing yet, and the shell says so rather than leaving a person
 *  clicking at a canvas that will not answer. Add a tool here as its gestures land. */
const IMPLEMENTED: readonly ToolId[] = ["select", "wall", "pan"];

export function toolReady(tool: ToolDefinition | ToolId): boolean {
  return IMPLEMENTED.includes(typeof tool === "string" ? tool : tool.id);
}

export function toolById(id: string): ToolDefinition | null {
  return TOOLS.find((t) => t.id === id) ?? null;
}

/** The tool a bare letter selects, or null. Case does not matter; "Space" is spelled " " by events. */
export function toolForKey(key: string): ToolDefinition | null {
  const wanted = key === " " ? "space" : key.toLowerCase();
  return TOOLS.find((t) => t.shortcut.toLowerCase() === wanted) ?? null;
}

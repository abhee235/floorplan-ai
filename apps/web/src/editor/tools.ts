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

/** A run of a sentence: either words, or the name of a key to be drawn as a key.
 *
 *  The sentences used to be plain strings, which meant the chrome could only ever render them as prose —
 *  "Hold Shift to add to the selection" put Shift in the same grey as the word "to". Marking the keys up
 *  needs to be a property of the DATA, not something the view rediscovers: a regex over the sentence would
 *  have to know that "Shift" and "Tab" are keys while "Hold" and "Type" are not, and would quietly mangle
 *  "Space picks up and drops" the first time someone reworded it. */
export type Phrase = readonly ({ text: string } | { key: string })[];

export const t = (text: string): { text: string } => ({ text });
export const k = (key: string): { key: string } => ({ key });

/** The words of a phrase, for a plain-text context (an aria-label, a test, a title attribute). */
export function phraseText(phrase: Phrase): string {
  return phrase.map((part) => ("key" in part ? part.key : part.text)).join("");
}

export interface ToolDefinition {
  id: ToolId;
  title: string;
  /** One letter, or "Space" for pan (ADR-017 D2). Escape always returns to select. */
  shortcut: string;
  /** What the tool does, for the palette and the tool options bar. */
  summary: string;
  /** The sentence in the options bar naming the modifier keys, with the keys marked. */
  modifiers: Phrase;
  /** How the tool is driven with no pointer at all (ADR-017 D4), with the keys marked. */
  keyboard: Phrase;
  options: ToolOption[];
}

/** The wall kinds, as the wall tool offers them for a new wall and the properties panel for an existing one. */
export const WALL_KINDS: readonly { value: string; label: string }[] = [
  { value: "exterior", label: "Exterior" },
  { value: "interior", label: "Interior" },
  { value: "partition", label: "Partition" },
  { value: "glass", label: "Glass" },
];

const SNAP_OPTIONS: ToolOption[] = [
  { id: "snapWalls", label: "Snap to walls", kind: "toggle", value: true },
  { id: "snapAngle", label: "Angle steps 15°", kind: "toggle", value: true },
  { id: "snapGrid", label: "Grid 100 mm", kind: "toggle", value: false },
];

/** Snapping is a preference the modifier keys invert (W-082). */
const SNAP_MODIFIERS: Phrase = [
  t("Hold "),
  k("Shift"),
  t(" to align · "),
  k("Alt"),
  t(" to bypass snapping"),
];

export const TOOLS: ToolDefinition[] = [
  {
    id: "select",
    title: "Select",
    shortcut: "V",
    summary: "Pick, move and edit what is already there",
    modifiers: [t("Hold "), k("Shift"), t(" to add to the selection · "), k("Alt"), t(" to bypass snapping")],
    keyboard: [
      k("Tab"),
      t(" steps through entities, arrows nudge, "),
      k("Space"),
      t(" picks up and drops, "),
      k("Enter"),
      t(" opens properties"),
    ],
    options: SNAP_OPTIONS,
  },
  {
    id: "wall",
    title: "Draw wall",
    shortcut: "W",
    summary: "Draw a chain of walls",
    modifiers: SNAP_MODIFIERS,
    keyboard: [
      t("Type a length, "),
      k("Tab"),
      t(", an angle, then "),
      k("Enter"),
      t(" to place; "),
      k("Enter"),
      t(" twice ends the chain"),
    ],
    options: [
      { id: "thickness", label: "Thickness", kind: "number", value: 100, unit: "mm" },
      { id: "kind", label: "Kind", kind: "choice", value: "interior", choices: [...WALL_KINDS] },
      ...SNAP_OPTIONS,
    ],
  },
  {
    id: "room",
    title: "Draw room",
    shortcut: "R",
    summary: "Draw a room, or fill an area the walls already enclose",
    modifiers: SNAP_MODIFIERS,
    keyboard: [
      t("Type a side length, "),
      k("Tab"),
      t(", an angle, then "),
      k("Enter"),
      t("; "),
      k("Enter"),
      t(" twice closes the room"),
    ],
    options: SNAP_OPTIONS,
  },
  {
    id: "opening",
    title: "Add door or window",
    shortcut: "O",
    summary: "Place a door, window or passage in a wall",
    modifiers: [t("Hold "), k("Alt"), t(" to bypass snapping to the middle of the wall")],
    keyboard: [
      k("Tab"),
      t(" to a wall, "),
      k("Enter"),
      t(" to place, then arrows slide it along and "),
      k("Enter"),
      t(" confirms"),
    ],
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
    keyboard: [t("Arrows move the piece, brackets rotate it by 15 degrees, "), k("Enter"), t(" places it")],
    options: [{ id: "rotation", label: "Rotation", kind: "number", value: 0, unit: "°" }, ...SNAP_OPTIONS],
  },
  {
    id: "measure",
    title: "Measure",
    shortcut: "M",
    summary: "Measure a distance without changing anything",
    modifiers: [t("Hold "), k("Shift"), t(" to measure along an axis")],
    keyboard: [
      k("Tab"),
      t(" to a point, "),
      k("Enter"),
      t(" to start, "),
      k("Tab"),
      t(" to the second point, "),
      k("Enter"),
      t(" to read the distance"),
    ],
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
    modifiers: [t("Hold "), k("Shift"), t(" to keep the line on an axis")],
    keyboard: [
      k("Enter"),
      t(" starts a label where focus is, then type and press "),
      k("Enter"),
      t(" again"),
    ],
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
    modifiers: [t("Hold "), k("Space"), t(" from any tool to pan, and let go to return to it")],
    keyboard: [t("Arrows pan the view, "), k("F"), t(" fits the plan to the window")],
    options: [],
  },
];

/** What is missing before this tool may go on the rail (ADR-017 consequences). Empty means it may. */
export function checkTool(tool: ToolDefinition): string[] {
  const missing: string[] = [];
  if (!tool.shortcut.trim()) missing.push("a shortcut");
  if (!tool.summary.trim()) missing.push("a summary");
  if (!phraseText(tool.modifiers).trim()) missing.push("a sentence naming its modifiers");
  if (!phraseText(tool.keyboard).trim()) missing.push("a keyboard path");
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
const IMPLEMENTED: readonly ToolId[] = ["select", "wall", "room", "pan"];

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

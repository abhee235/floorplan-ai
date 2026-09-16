// What the selection is, and what can be done to it (P3-4; ledger F-133, F-138, F-140, F-141).
//
// Free of the DOM and of the canvas so it can be tested. The shell and the properties panel both read
// from here rather than each working the selection out for themselves.

import { itemMaterialSlots } from "@fpv/commands";
import {
  drawnAs,
  finishedMaterialKey,
  MATERIAL_COLOURS,
  materialColour,
  noAssets,
  recipeSlotKey,
} from "@fpv/engine";
import type {
  FinishRef,
  Item,
  Level,
  Opening,
  PrimitiveRecipe,
  Project,
  Room,
  Wall,
  WallPattern,
} from "@fpv/ir";
import {
  blankFinish,
  derive,
  FINISH_SHININESS,
  type FinishName,
  finishNameOf,
  normalizeDeg,
  SKIRTING_DEPTH,
  SKIRTING_DEPTH_RANGE,
  tidyFinish,
} from "@fpv/ir";
import { describeLength, formatDegrees, formatMm, parseDegrees, parseHexColour, parseMm } from "./status.js";
import { WALL_KINDS } from "./tools.js";
import { MAX_LENGTH_MM } from "./wall-tool.js";

/** The entity kinds the editor can select and delete today. */
export type EntityKind = "wall" | "room" | "item" | "opening";

const DELETE_COMMAND: Record<EntityKind, { type: string; key: string }> = {
  wall: { type: "wall.delete", key: "wallIds" },
  room: { type: "room.delete", key: "roomIds" },
  item: { type: "item.delete", key: "itemIds" },
  opening: { type: "opening.delete", key: "openingIds" },
};

/**
 * The kind an id names, or null.
 *
 * Ids are `<kind>_<six chars>` and @fpv/ir has no classifier for them — `idOf` there is a private zod
 * regex factory, not something that maps back. This reads the prefix.
 *
 * Deliberately soft on anything unrecognised: a selection could hold an id for a kind the UI does not
 * handle yet (a zone, an annotation), and throwing on Delete would be far worse than leaving one entity
 * alone. The caller sees it missing from the grouping rather than an exception.
 */
export function kindOf(id: string): EntityKind | null {
  const prefix = id.slice(0, id.indexOf("_"));
  return prefix === "wall" || prefix === "room" || prefix === "item" || prefix === "opening" ? prefix : null;
}

export interface DeleteCommand {
  type: string;
  payload: Record<string, string[]>;
}

/**
 * One delete command per kind in the selection (F-141 applies to what is selected, not to this).
 *
 * A mixed selection cannot be one command: every delete payload names its own id array and validates
 * `.min(1)`, so walls and rooms travel separately. They are returned in a stable order so the history
 * reads the same way twice.
 */
export function deleteCommands(ids: readonly string[]): DeleteCommand[] {
  const byKind = new Map<EntityKind, string[]>();
  for (const id of ids) {
    const kind = kindOf(id);
    if (!kind) continue;
    const list = byKind.get(kind) ?? [];
    list.push(id);
    byKind.set(kind, list);
  }
  // Openings before walls: deleting a wall takes its openings with it, so the reverse order would name
  // ids that no longer exist by the time the second command ran. Items and rooms go ahead of walls for
  // the same reason.
  const order: EntityKind[] = ["opening", "item", "room", "wall"];
  const out: DeleteCommand[] = [];
  for (const kind of order) {
    const list = byKind.get(kind);
    if (!list?.length) continue;
    const spec = DELETE_COMMAND[kind];
    out.push({ type: spec.type, payload: { [spec.key]: list } });
  }
  return out;
}

/** Openings before walls: deleting a wall takes its openings with it, so the reverse order would
 *  delete ids that no longer exist. Same reasoning puts items and rooms ahead of the walls they sit in. */

export interface MoveCommand {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Moving a selection by (dx, dy) in plan millimetres.
 *
 * Openings are deliberately absent. opening.move takes a position ALONG a wall — a fraction or a
 * distance — not a vector, because an opening slides in its host wall rather than moving freely.
 * Turning a free drag into a wall parameter is its own design problem (which wall wins when the drag
 * crosses two, what happens past the ends), and guessing at it here would be worse than leaving
 * openings where they are.
 *
 * Rooms have no move command at all, so each one moves by setPolygon with every point translated. That
 * is why this needs the project and not just the ids.
 */
export function moveCommands(
  project: Project,
  ids: readonly string[],
  dx: number,
  dy: number,
): MoveCommand[] {
  // Whole millimetres: Mm is an integer and Polygon is an array of integer points, so a fractional
  // delta is refused by the schema and nothing moves at all.
  const x = Math.round(dx);
  const y = Math.round(dy);
  if (x === 0 && y === 0) return [];

  const byKind = new Map<EntityKind, string[]>();
  for (const id of ids) {
    const kind = kindOf(id);
    if (!kind) continue;
    byKind.set(kind, [...(byKind.get(kind) ?? []), id]);
  }

  const out: MoveCommand[] = [];
  const wallIds = byKind.get("wall") ?? [];
  if (wallIds.length > 0) out.push({ type: "wall.move", payload: { wallIds, dx: x, dy: y } });

  for (const roomId of byKind.get("room") ?? []) {
    const room = project.rooms.find((r) => r.id === roomId);
    if (!room) continue;
    const shift = (p: { x: number; y: number }) => ({ x: p.x + x, y: p.y + y });
    out.push({
      type: "room.setPolygon",
      payload: {
        roomId,
        polygon: room.polygon.map(shift),
        ...(room.holes.length > 0 ? { holes: room.holes.map((h) => h.map(shift)) } : {}),
      },
    });
  }

  const itemIds = byKind.get("item") ?? [];
  if (itemIds.length > 0) out.push({ type: "item.move", payload: { itemIds, dx: x, dy: y } });

  return out;
}

export interface EditCommand {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * What typing into a field asks for. `command` is null when the text names the value already there, so
 * nothing is sent and no history entry is made. `said` is the resulting value in words, for the
 * announcement: "1.2 m" typed is "1200 millimetres" set, and a screen reader should hear the latter.
 */
export type EditOutcome =
  | { ok: true; command: EditCommand | null; said: string }
  | { ok: false; message: string };

export interface Choice {
  value: string;
  label: string;
  /** A plan pattern to draw beside the label, for a list of them. */
  swatch?: WallPattern;
}

/** One row of the properties panel. */
export interface Fact {
  /** The row's whole name, as a screen reader hears it: "Start X". */
  label: string;
  /**
   * The part of `label` printed beside the field, when that is less than all of it; the rest is read out
   * only. A coordinate pair prints "Start" once, on its X row, and nothing on its Y row, with the axis
   * inside each field instead. Always a leading part of `label`, so what is printed is also what is heard.
   */
  caption?: string;
  /** Printed inside the field, ahead of the value: the axis of a coordinate. */
  prefix?: string;
  /** The band within the entity this row sits in (ADR-017 D3); rows without one come first. */
  group?: string;
  /** Formatted for reading. For an editable fact, exactly the text the field starts from; for a choice, the
   *  chosen value, not its label. */
  value: string;
  /** Printed beside the value rather than inside it, so an edit is a bare number. */
  unit?: string;
  /** Present when the value is picked from a list rather than typed. */
  choices?: readonly Choice[];
  /** Present on a row the model lets be empty, saying what empty stands for. `value` is "" when it is. */
  empty?: EmptyMeaning;
  /** Read to a screen reader as the field's description: what the value means beyond its name. */
  hint?: string;
  /** Present on a colour row: the colour its swatch shows while the value is empty. */
  colour?: { effective: string };
  /** A yes-or-no row: `value` is "true" or "false", and `edit` receives the same words. */
  toggle?: true;
  /** Text reads from the left; numbers, the default, line up on the right. */
  align?: "left";
  /** Present when the panel can change this fact: turns what was typed, or picked, into what to send. */
  edit?: (text: string) => EditOutcome;
}

/** What an empty field stands for. */
export interface EmptyMeaning {
  /** Greyed in the empty field, unit and all, because the unit beside it is hidden while it shows. */
  shown: string;
  /** The name of the button that empties a filled field: "Follow the level's height". */
  action: string;
}

export interface SelectedEntity {
  id: string;
  kind: EntityKind;
  /** What to call it in the panel: a name where the entity has one, else the kind and its id. */
  title: string;
  facts: Fact[];
}

/**
 * The thickness a field will take (W-072): a millimetre at least, which is also the schema's floor, and no
 * more than ten metres, past which a wall is a typing mistake rather than a wall. Refused rather than
 * clamped, unlike the wall tool's typed length: a panel field that quietly writes a different number from
 * the one typed is harder to trust than one that says what it wants.
 */
export const THICKNESS_RANGE = { min: 1, max: 10_000 } as const;

/** A typed wall height: a millimetre up to a hundred metres, past any storey anyone draws. */
export const HEIGHT_RANGE = { min: 1, max: 100_000 } as const;

/** The furthest a wall may curve either way, in degrees; the schema's own limit. */
export const CURVE_LIMIT = 270;

/** Everything the panel needs about one selected id, or null when the id is not in the project. */
export function describeEntity(project: Project, id: string): SelectedEntity | null {
  const kind = kindOf(id);
  if (!kind) return null;
  if (kind === "wall") {
    const w = project.walls.find((x) => x.id === id);
    if (!w) return null;
    const level = derive.levelOf(project, w.levelId) ?? derive.lowestLevel(project);
    return { id, kind, title: "Wall", facts: wallFacts(w, level, project.meta.north) };
  }
  if (kind === "room") {
    const r = project.rooms.find((x) => x.id === id);
    if (!r) return null;
    const level = derive.levelOf(project, r.levelId) ?? derive.lowestLevel(project);
    return { id, kind, title: r.name ?? "Room", facts: roomFacts(r, level) };
  }
  if (kind === "item") {
    const it = project.items.find((x) => x.id === id);
    return it ? { id, kind, title: itemTitle(project, it), facts: itemFacts(project, it) } : null;
  }
  const o = project.openings.find((x) => x.id === id);
  return o ? { id, kind, title: openingTitle(o), facts: openingFacts(project, o) } : null;
}

/** How far from the origin a typed coordinate may be: the same kilometre the wall tool allows (W-072). */
const COORDINATE_RANGE = { min: -MAX_LENGTH_MM, max: MAX_LENGTH_MM } as const;

/** A typed wall length: a whole millimetre at least, since Mm is an integer, up to that same kilometre. */
export const LENGTH_RANGE = { min: 1, max: MAX_LENGTH_MM } as const;

function wallFacts(w: Wall, level: Level, north: number): Fact[] {
  const arc = derive.isArc(w);
  return [
    {
      label: "Kind",
      value: w.kind,
      choices: WALL_KINDS,
      edit: choiceEdit("Kind", WALL_KINDS, w.kind, (kind) => wallModify(w.id, { kind })),
    },
    {
      label: "Plan pattern",
      value: w.pattern,
      choices: WALL_PATTERNS,
      hint: "How the plan fills this wall. Drawings use it to tell new, existing and temporary walls apart.",
      edit: choiceEdit("Plan pattern", WALL_PATTERNS, w.pattern, (pattern) => wallModify(w.id, { pattern })),
    },
    ...endFacts(w, "start"),
    ...endFacts(w, "end"),
    {
      group: "Shape",
      label: "Curve",
      value: w.arcExtent === null ? "" : formatDegrees(w.arcExtent),
      unit: "°",
      empty: { shown: "straight", action: "Make the wall straight" },
      hint: "In degrees. A positive curve bows to the left, going from start to end. Empty is straight.",
      edit: curveEdit(w),
    },
    arc
      ? // Along the curve, which is the length anyone means by a curved wall's length. Not typed: a new
        // length could keep the chord and deepen the curve, or keep the curve and move an end, and neither
        // is obviously what was meant. The arc's own extent is the control for its shape.
        { group: "Size", label: "Length", value: formatMm(derive.wallArcLength(w)), unit: "mm" }
      : {
          group: "Size",
          label: "Length",
          value: formatMm(derive.wallLength(w)),
          unit: "mm",
          edit: lengthEdit("Length", Math.round(derive.wallLength(w)), LENGTH_RANGE, (mm) =>
            wallModify(w.id, { end: endAtLength(w, mm) }),
          ),
        },
    {
      group: "Size",
      label: "Thickness",
      value: formatMm(w.thickness),
      unit: "mm",
      edit: lengthEdit("Thickness", w.thickness, THICKNESS_RANGE, (thickness) =>
        wallModify(w.id, { thickness }),
      ),
    },
    ...heightFacts(w, level),
    ...sideFacts(w, "left", level, north),
    ...sideFacts(w, "right", level, north),
  ];
}

/** How the plan fills a wall's cut (W-121), as a person picks it, each with a picture of itself. */
export const WALL_PATTERNS: readonly Choice[] = [
  { value: "solid", label: "Solid", swatch: "solid" },
  { value: "hatch", label: "Hatched", swatch: "hatch" },
  { value: "cross-hatch", label: "Cross-hatched", swatch: "cross-hatch" },
  { value: "outline", label: "Outline", swatch: "outline" },
];

/** How glossy a side is, as a person picks it. The model keeps a number; these are the three it offers. */
export const WALL_FINISHES: readonly Choice[] = [
  { value: "matt", label: "Matt" },
  { value: "satin", label: "Satin" },
  { value: "gloss", label: "Gloss" },
];

const hexOf = (rgb: number): string => `#${rgb.toString(16).padStart(6, "0").toUpperCase()}`;

/**
 * The colour and finish of one side (W-106). Left and right are as walked from start to end, which nobody
 * can see on a plan, so the band also says which way the side faces (ADR-006 compass words).
 *
 * Every label names its side as well as its field: two "Colour" rows in one wall would otherwise share an id,
 * and a screen reader jumping between fields would hear the same name twice.
 */
function sideFacts(w: Wall, side: "left" | "right", level: Level, north: number): Fact[] {
  const name = `${side} side`;
  const group = `${side === "left" ? "Left" : "Right"} side, facing ${derive.wallCompassSide(w, side, north)}`;
  const current = w.finishes[side];
  const finished = (change: Partial<FinishRef>): EditCommand => {
    const base: FinishRef = current ?? blankFinish();
    return wallModify(w.id, { finishes: { ...w.finishes, [side]: tidyFinish({ ...base, ...change }) } });
  };
  const colour = current?.color ?? null;
  const finish = finishNameOf(current?.shininess ?? null);
  return [
    {
      group,
      label: `Colour, ${name}`,
      caption: "Colour",
      value: colour ?? "",
      colour: { effective: colour ?? hexOf(MATERIAL_COLOURS["wall-side"] ?? 0xe8e6e1) },
      empty: { shown: "default", action: "Use the default colour" },
      hint: "A hex colour, such as #E8E6E1. Empty uses the default wall colour.",
      edit: hexEdit(colour, (color) => finished({ color }), "default", "#E8E6E1"),
    },
    {
      group,
      label: `Finish, ${name}`,
      caption: "Finish",
      value: finish,
      choices: WALL_FINISHES,
      edit: choiceEdit("Finish", WALL_FINISHES, finish, (value) =>
        finished({ shininess: FINISH_SHININESS[value as FinishName] ?? null }),
      ),
    },
    ...skirtingFacts(w, side, level),
  ];
}

// The baseboard defaults are the model's, shared with the agent's finish_wall tool.
export { SKIRTING_DEPTH, SKIRTING_DEPTH_RANGE };

/**
 * The baseboard of one side (ADR-014 D8). Its height stands for the whole thing: empty is no baseboard, as
 * an empty height elsewhere stands for "the level's". The depth row only exists while there is a baseboard
 * to be deep, so a wall without one shows one row per side, not two that mean nothing.
 *
 * A height above the wall is refused rather than stored (W-100): the view would cut it at the wall's top
 * anyway, and a panel should not keep a number the drawing does not show.
 */
function skirtingFacts(w: Wall, side: "left" | "right", level: Level): Fact[] {
  const name = `${side} side`;
  // A band of its own, so its rows can be called Height, Depth and Colour without meeting the side's
  // own Colour in the band above.
  const group = `Baseboard, ${name}`;
  const current = w.skirting[side];
  const tallest = Math.round(derive.wallMaxHeight(w, level));
  const withSkirting = (value: Wall["skirting"]["left"]): EditCommand =>
    wallModify(w.id, { skirting: { ...w.skirting, [side]: value } });
  const facts: Fact[] = [
    {
      group,
      label: `Height of baseboard, ${name}`,
      caption: "Height",
      value: current ? formatMm(current.height) : "",
      unit: "mm",
      empty: { shown: "none", action: "Remove the baseboard" },
      hint: "How high the baseboard along this side is. Empty means there is none.",
      edit: orEmpty(
        lengthEdit("Baseboard height", current?.height ?? null, { min: 1, max: tallest }, (height) =>
          withSkirting({
            thickness: current?.thickness ?? SKIRTING_DEPTH,
            height,
            color: current?.color ?? null,
          }),
        ),
        () => ({ ok: true, command: current ? withSkirting(null) : null, said: "none" }),
      ),
    },
  ];
  if (!current) return facts;
  const sideColour = w.finishes[side]?.color ?? null;
  facts.push(
    {
      group,
      label: `Depth of baseboard, ${name}`,
      caption: "Depth",
      value: formatMm(current.thickness),
      unit: "mm",
      hint: "How far the baseboard stands out from the wall.",
      edit: lengthEdit("Baseboard depth", current.thickness, SKIRTING_DEPTH_RANGE, (thickness) =>
        withSkirting({ ...current, thickness }),
      ),
    },
    {
      group,
      label: `Colour of baseboard, ${name}`,
      caption: "Colour",
      value: current.color ?? "",
      // what it looks like while it has no colour of its own: its side's, or the baseboard off-white
      colour: {
        effective: current.color ?? sideColour ?? hexOf(MATERIAL_COLOURS["wall-skirting"] ?? 0xf6f5f1),
      },
      empty: { shown: "as side", action: "Use the side's colour" },
      hint: "A hex colour, such as #FFFFFF. Empty takes the colour of the side it runs along.",
      edit: hexEdit(current.color, (color) => withSkirting({ ...current, color }), "as its side", "#FFFFFF"),
    },
  );
  return facts;
}

/**
 * How far round a wall bends. Empty and 0 are both straight, which the model keeps as no extent at all:
 * an extent of exactly 0 puts the arc's centre at infinity (W-050).
 */
function curveEdit(w: Wall): (text: string) => EditOutcome {
  const straight = (): EditOutcome => ({
    ok: true,
    command: w.arcExtent === null ? null : wallModify(w.id, { arcExtent: null }),
    said: "straight",
  });
  return (text) => {
    if (text.trim() === "") return straight();
    const deg = parseDegrees(text);
    if (deg === null) return { ok: false, message: "Curve needs a number of degrees, such as 90." };
    if (Math.abs(deg) > CURVE_LIMIT)
      return { ok: false, message: `Curve must be from -${CURVE_LIMIT} to ${CURVE_LIMIT} degrees.` };
    if (deg === 0) return straight();
    // Compared as shown, so a stored 33.29999 and a typed 33.3 are the same curve.
    const same = w.arcExtent !== null && formatDegrees(w.arcExtent) === formatDegrees(deg);
    return { ok: true, command: same ? null : wallModify(w.id, { arcExtent: deg }), said: `${deg} degrees` };
  };
}

/**
 * The height at each end. An empty start follows the level (W-092), and an empty end is a flat top at the
 * start's height, which is how the model keeps a flat top (W-094) — there is no separate flat-or-sloping
 * switch because the model has nowhere to keep one: a sloping wall whose ends are the same height is
 * stored as a flat one.
 */
function heightFacts(w: Wall, level: Level): Fact[] {
  const start = derive.wallHeight(w, level);
  const sloping = w.heightAtEnd !== null;
  const followsLevel = `follows the level, ${describeLength(level.height)}`;
  return [
    {
      group: "Height",
      label: "Height",
      value: w.height === null ? "" : formatMm(w.height),
      unit: "mm",
      // Not offered on a sloping wall: the model keeps an end height only beside a start height of the
      // wall's own, and moves a lone end height into the start (normalizeWall), so emptying the start would
      // turn the slope into a flat top at the end's height.
      ...(sloping
        ? {}
        : { empty: { shown: `level · ${formatMm(level.height)} mm`, action: "Follow the level's height" } }),
      hint: sloping ? "The height at the start of this sloping wall." : `Empty ${followsLevel}.`,
      edit: orEmpty(
        lengthEdit("Height", w.height, HEIGHT_RANGE, (height) => wallModify(w.id, { height })),
        () =>
          sloping
            ? {
                ok: false,
                message: "A sloping wall needs its own height at the start. Empty the height at end first.",
              }
            : {
                ok: true,
                command: w.height === null ? null : wallModify(w.id, { height: null }),
                said: followsLevel,
              },
      ),
    },
    {
      group: "Height",
      label: "Height at end",
      value: w.heightAtEnd === null ? "" : formatMm(w.heightAtEnd),
      unit: "mm",
      empty: { shown: `same · ${formatMm(start)} mm`, action: "Make the top flat" },
      hint: `Empty keeps the top flat, at the start's ${describeLength(start)}.`,
      edit: orEmpty(
        lengthEdit("Height at end", w.heightAtEnd, HEIGHT_RANGE, (mm) => {
          // The start's own height is a flat top, which the model keeps as no end height at all.
          if (mm === start) return sloping ? wallModify(w.id, { heightAtEnd: null }) : null;
          // A wall following the level has no start height to slope from, and the model would move a lone
          // end height into the start. So the start is fixed at the height it shows now, and only the end
          // moves — which is what was asked for.
          return wallModify(
            w.id,
            w.height === null ? { height: start, heightAtEnd: mm } : { heightAtEnd: mm },
          );
        }),
        () => ({
          ok: true,
          command: sloping ? wallModify(w.id, { heightAtEnd: null }) : null,
          said: `flat, ${describeLength(start)}`,
        }),
      ),
    },
  ];
}

/** An edit that means something of its own when the field is emptied. */
function orEmpty(
  edit: (text: string) => EditOutcome,
  whenEmpty: () => EditOutcome,
): (text: string) => EditOutcome {
  return (text) => (text.trim() === "" ? whenEmpty() : edit(text));
}

/**
 * The X and Y rows for one end of a wall. Moving an end takes whatever is joined there along with it
 * (W-031), because that is what wall.modify does, not because anything here arranges it.
 */
function endFacts(w: Wall, end: "start" | "end"): Fact[] {
  const name = end === "start" ? "Start" : "End";
  const at = w[end];
  const other = end === "start" ? w.end : w.start;
  return (["x", "y"] as const).map((axis) => {
    const letter = axis.toUpperCase();
    return {
      group: "Position",
      label: `${name} ${letter}`,
      caption: axis === "x" ? name : "",
      prefix: letter,
      value: formatMm(at[axis]),
      unit: "mm",
      edit: lengthEdit(`${name} ${letter}`, at[axis], COORDINATE_RANGE, (mm) => {
        const moved = { ...at, [axis]: mm };
        // Said here rather than left to the host's wall.zero-length, whose words are about the schema.
        if (moved.x === other.x && moved.y === other.y)
          return "That would put both ends of the wall on one point.";
        return wallModify(w.id, { [end]: moved });
      }),
    };
  });
}

/** The end that gives the wall this length, with the start and the direction kept. */
function endAtLength(w: Wall, mm: number): { x: number; y: number } {
  const scale = mm / derive.wallLength(w);
  // Whole millimetres, as Mm requires. The rounding can leave the new length a fraction of a millimetre
  // off the one typed and the direction a hair off the old one; neither shows at the panel's precision.
  return {
    x: Math.round(w.start.x + (w.end.x - w.start.x) * scale),
    y: Math.round(w.start.y + (w.end.y - w.start.y) * scale),
  };
}

function wallModify(wallId: string, changes: Record<string, unknown>): EditCommand {
  return { type: "wall.modify", payload: { wallId, changes } };
}

/**
 * An edit for a length in millimetres. The words are the ones a person needs to fix the text, and the
 * limits are written in plain digits: a grouped "10 000" is read by some screen readers as four numbers.
 *
 * `command` may answer with a sentence instead of a command, for a value that is a fine number but not a
 * possible one — an end typed onto the other end — or with null, for one that changes nothing although it
 * differs from `current`. `current` is null on a row whose model value is empty.
 */
function lengthEdit(
  name: string,
  current: number | null,
  range: { min: number; max: number },
  command: (mm: number) => EditCommand | string | null,
): (text: string) => EditOutcome {
  return (text) => {
    const mm = parseMm(text);
    if (mm === null) return { ok: false, message: `${name} needs a number of millimetres, such as 120.` };
    if (mm < range.min || mm > range.max)
      return { ok: false, message: `${name} must be from ${range.min} to ${range.max} mm.` };
    if (mm === current) return { ok: true, command: null, said: describeLength(mm) };
    const built = command(mm);
    if (typeof built === "string") return { ok: false, message: built };
    return { ok: true, command: built, said: describeLength(mm) };
  };
}

/** An edit for a value picked from a list. The list is the only way in, so an unknown value is a bug in the
 *  caller rather than a typing slip, but it is still refused in words rather than sent. */
function choiceEdit(
  name: string,
  choices: readonly Choice[],
  current: string,
  command: (value: string) => EditCommand,
): (value: string) => EditOutcome {
  return (value) => {
    const choice = choices.find((c) => c.value === value);
    if (!choice)
      return { ok: false, message: `${name} must be one of ${choices.map((c) => c.label).join(", ")}.` };
    return { ok: true, command: value === current ? null : command(value), said: choice.label };
  };
}

/** What a room is for, in the panel's words; the model's values are the enum's. */
export const ROOM_PURPOSES: readonly Choice[] = [
  { value: "meeting", label: "Meeting room" },
  { value: "huddle", label: "Huddle room" },
  { value: "boardroom", label: "Boardroom" },
  { value: "training", label: "Training room" },
  { value: "open-office", label: "Open office" },
  { value: "focus", label: "Focus room" },
  { value: "reception", label: "Reception" },
  { value: "cafeteria", label: "Cafeteria" },
  { value: "corridor", label: "Corridor" },
  { value: "utility", label: "Utility" },
  { value: "storage", label: "Storage" },
  { value: "restroom", label: "Restroom" },
  { value: "other", label: "Other" },
];

/** Seats a room may be given: none up to a hall's worth. */
export const CAPACITY_RANGE = { min: 0, max: 10_000 } as const;

/** A room name longer than this is a sentence, not a name. */
export const NAME_LIMIT = 80;

/**
 * A room (ADR-017 D3): what it is called and for, how many it seats, how big it is, and its floor and
 * ceiling. Area and corners are read, not typed: a room's shape changes by its corners on the plan.
 */
function roomFacts(r: Room, level: Level): Fact[] {
  const modify = (changes: Record<string, unknown>): EditCommand => ({
    type: "room.modify",
    payload: { roomId: r.id, changes },
  });
  const surface = (which: "floor" | "ceiling", color: string | null): EditCommand =>
    modify({
      finishes: { ...r.finishes, [which]: tidyFinish({ ...(r.finishes[which] ?? blankFinish()), color }) },
    });
  // Square metres: square millimetres is a number nobody reads. roomArea is already absolute and already
  // subtracts the holes (R-006), so there is nothing to correct for here.
  const areaM2 = derive.roomArea(r) / 1_000_000;
  const plain = (key: string, fallback: number) => hexOf(MATERIAL_COLOURS[key] ?? fallback);
  return [
    {
      label: "Name of room",
      caption: "Name",
      value: r.name ?? "",
      align: "left",
      empty: { shown: "unnamed", action: "Clear the name" },
      edit: (text) => {
        const name = text.trim();
        if (name.length > NAME_LIMIT)
          return { ok: false, message: `A name is at most ${NAME_LIMIT} characters.` };
        const next = name === "" ? null : name;
        return {
          ok: true,
          command: next === r.name ? null : modify({ name: next }),
          said: next ?? "unnamed",
        };
      },
    },
    {
      label: "Purpose",
      value: r.purpose,
      choices: ROOM_PURPOSES,
      edit: choiceEdit("Purpose", ROOM_PURPOSES, r.purpose, (purpose) => modify({ purpose })),
    },
    {
      label: "Capacity",
      value: r.capacity === null ? "" : String(r.capacity),
      unit: "seats",
      empty: { shown: "not set", action: "Clear the capacity" },
      hint: "How many people the room seats. Furnishing a room uses it.",
      edit: (text) => {
        const t = text.trim();
        if (t === "")
          return {
            ok: true,
            command: r.capacity === null ? null : modify({ capacity: null }),
            said: "not set",
          };
        if (!/^\d+$/.test(t))
          return { ok: false, message: "Capacity needs a whole number of seats, such as 8." };
        const seats = Number(t);
        if (seats > CAPACITY_RANGE.max)
          return {
            ok: false,
            message: `Capacity must be from ${CAPACITY_RANGE.min} to ${CAPACITY_RANGE.max} seats.`,
          };
        return {
          ok: true,
          command: seats === r.capacity ? null : modify({ capacity: seats }),
          said: `${seats} ${seats === 1 ? "seat" : "seats"}`,
        };
      },
    },
    { group: "Size", label: "Area", value: `${areaM2.toFixed(2)} m²` },
    { group: "Size", label: "Corners", value: String(r.polygon.length) },
    {
      group: "Floor",
      label: "Colour of floor",
      caption: "Colour",
      value: r.finishes.floor?.color ?? "",
      colour: { effective: r.finishes.floor?.color ?? plain("floor", 0xc9c2b8) },
      empty: { shown: "default", action: "Use the default floor colour" },
      edit: hexEdit(
        r.finishes.floor?.color ?? null,
        (color) => surface("floor", color),
        "default",
        "#C9C2B8",
      ),
    },
    {
      group: "Floor",
      label: "Show floor",
      caption: "Show",
      toggle: true,
      value: String(r.floorVisible),
      edit: toggleEdit(r.floorVisible, (floorVisible) => modify({ floorVisible }), SHOWN),
    },
    {
      group: "Ceiling",
      label: "Height of ceiling",
      caption: "Height",
      value: r.ceilingHeight === null ? "" : formatMm(r.ceilingHeight),
      unit: "mm",
      empty: { shown: `level · ${formatMm(level.height)} mm`, action: "Follow the level's height" },
      hint: `Empty follows the level, ${describeLength(level.height)}.`,
      edit: orEmpty(
        lengthEdit("Ceiling height", r.ceilingHeight, HEIGHT_RANGE, (ceilingHeight) =>
          modify({ ceilingHeight }),
        ),
        () => ({
          ok: true,
          command: r.ceilingHeight === null ? null : modify({ ceilingHeight: null }),
          said: `follows the level, ${describeLength(level.height)}`,
        }),
      ),
    },
    {
      group: "Ceiling",
      label: "Colour of ceiling",
      caption: "Colour",
      value: r.finishes.ceiling?.color ?? "",
      colour: { effective: r.finishes.ceiling?.color ?? plain("ceiling", 0xfafafa) },
      empty: { shown: "default", action: "Use the default ceiling colour" },
      edit: hexEdit(
        r.finishes.ceiling?.color ?? null,
        (color) => surface("ceiling", color),
        "default",
        "#FAFAFA",
      ),
    },
    {
      group: "Ceiling",
      label: "Show ceiling",
      caption: "Show",
      toggle: true,
      value: String(r.ceilingVisible),
      edit: toggleEdit(r.ceilingVisible, (ceilingVisible) => modify({ ceilingVisible }), SHOWN),
    },
  ];
}

/**
 * An edit for a colour typed as hex. Empty stands for whatever the surface falls back to, named by
 * `emptySaid`; the example is one a person would recognise for that surface.
 */
function hexEdit(
  current: string | null,
  set: (hex: string | null) => EditCommand,
  emptySaid: string,
  example: string,
): (text: string) => EditOutcome {
  return (text) => {
    if (text.trim() === "")
      return { ok: true, command: current === null ? null : set(null), said: emptySaid };
    const hex = parseHexColour(text);
    if (hex === null) return { ok: false, message: `Colour needs a hex value, such as ${example}.` };
    return { ok: true, command: hex === current ? null : set(hex), said: hex };
  };
}

/** How a yes-or-no row announces its two states. */
interface Said {
  yes: string;
  no: string;
}
const SHOWN: Said = { yes: "shown", no: "hidden" };

/** An edit for a yes-or-no row: the checkbox sends "true" or "false". */
function toggleEdit(
  current: boolean,
  set: (value: boolean) => EditCommand,
  said: Said,
): (text: string) => EditOutcome {
  return (text) => {
    if (text !== "true" && text !== "false") return { ok: false, message: "This is a yes or no." };
    const next = text === "true";
    return { ok: true, command: next === current ? null : set(next), said: next ? said.yes : said.no };
  };
}

/** A generated item's kind, as a person would call it. */
const RECIPE_NAMES: Record<PrimitiveRecipe["kind"], string> = {
  box: "Box",
  cylinder: "Cylinder",
  table: "Table",
  chair: "Chair",
  display: "Display",
  "video-bar": "Video bar",
  "ceiling-speaker": "Ceiling speaker",
  "ceiling-mic": "Ceiling microphone",
};

/**
 * An Item carries no name: it is named by what it refers to. A product reads as the name its catalogue
 * snapshot gives it, or its id when the snapshot has none; a generated item as its label, or its kind.
 */
function itemTitle(project: Project, it: Item): string {
  if (it.ref.kind === "product") {
    const name = (project.catalogRefs[it.ref.productId] as { name?: unknown } | undefined)?.name;
    return typeof name === "string" && name.trim() !== "" ? name : it.ref.productId;
  }
  const recipe = it.ref.recipe;
  const label = "label" in recipe ? recipe.label.trim() : "";
  return label !== "" ? label : RECIPE_NAMES[recipe.kind];
}

/** How far above or below its floor an item may sit. Below is allowed, as the model allows it: a sunken floor. */
const ELEVATION_RANGE = { min: -HEIGHT_RANGE.max, max: HEIGHT_RANGE.max } as const;

/**
 * An item (ADR-017 D3): which room it counts in, where it stands, which way it faces, how high it sits,
 * whether it is mirrored and how big it is. A typed position is kept exactly, without the snapping a drag
 * gets: whoever types a number means that number.
 *
 * A product the catalogue marks as coming in one size shows its size without letting it be typed (F-013).
 * Things stacked on the item move, turn and rise with it, because the commands carry them.
 */
function itemFacts(project: Project, it: Item): Fact[] {
  const ids = [it.id];
  const room = it.roomId ? project.rooms.find((r) => r.id === it.roomId) : undefined;
  const size = derive.itemSize(it, derive.snapshotSizeSource(project));
  const product =
    it.ref.kind === "product"
      ? (project.catalogRefs[it.ref.productId] as { deformable?: boolean } | undefined)
      : undefined;
  const oneSize = product?.deformable === false;
  const facts: Fact[] = [
    { label: "Room", value: room ? (room.name ?? "Unnamed room") : "None" },
    ...(["x", "y"] as const).map((axis): Fact => {
      const letter = axis.toUpperCase();
      return {
        group: "Placement",
        label: `Position ${letter}`,
        caption: axis === "x" ? "Position" : "",
        prefix: letter,
        value: formatMm(it.position[axis]),
        unit: "mm",
        edit: lengthEdit(`Position ${letter}`, it.position[axis], COORDINATE_RANGE, (mm) => ({
          type: "item.move",
          payload: {
            itemIds: ids,
            dx: axis === "x" ? mm - it.position.x : 0,
            dy: axis === "y" ? mm - it.position.y : 0,
            magnetism: false,
          },
        })),
      };
    }),
    {
      group: "Placement",
      label: "Rotation",
      value: formatDegrees(it.rotation),
      unit: "°",
      hint: "In degrees, counter-clockwise on the plan. The thick edge on the plan is the front.",
      edit: (text) => {
        const deg = parseDegrees(text);
        if (deg === null) return { ok: false, message: "Rotation needs a number of degrees, such as 90." };
        // Any turn names an angle the model can keep: -90 is 270, and 360 is none.
        const angle = normalizeDeg(deg);
        const same = formatDegrees(angle) === formatDegrees(it.rotation);
        return {
          ok: true,
          command: same ? null : { type: "item.rotate", payload: { itemIds: ids, angle } },
          said: `${formatDegrees(angle)} degrees`,
        };
      },
    },
    {
      group: "Placement",
      label: "Elevation",
      value: formatMm(it.elevation),
      unit: "mm",
      hint: "How high the bottom of the item is above the floor.",
      edit: lengthEdit("Elevation", it.elevation, ELEVATION_RANGE, (elevation) => ({
        type: "item.setElevation",
        payload: { itemIds: ids, elevation },
      })),
    },
    {
      group: "Placement",
      label: "Mirrored",
      toggle: true,
      value: String(it.mirrored),
      hint: "Left and right swapped, for things that are not the same both ways.",
      edit: toggleEdit(it.mirrored, () => ({ type: "item.mirror", payload: { itemIds: ids } }), {
        yes: "mirrored",
        no: "not mirrored",
      }),
    },
  ];
  if (!size) return facts;
  const dimensions = [
    { key: "w", label: "Width", range: LENGTH_RANGE },
    { key: "d", label: "Depth", range: LENGTH_RANGE },
    { key: "h", label: "Height", range: HEIGHT_RANGE },
  ] as const;
  for (const { key, label, range } of dimensions)
    facts.push({
      group: "Size",
      label,
      value: formatMm(size[key]),
      unit: "mm",
      ...(oneSize
        ? { hint: "This product comes in one size." }
        : {
            // item.resize keeps the back left corner by default (F-100), so a desk against a wall stays
            // against it when it is made deeper.
            ...(key === "h" ? {} : { hint: "The back left corner stays where it is." }),
            edit: lengthEdit(label, size[key], range, (mm) => ({
              type: "item.resize",
              payload: { itemId: it.id, size: { ...size, [key]: mm } },
            })),
          }),
    });
  facts.push(...materialFacts(project, it, size));
  return facts;
}

/**
 * The colour and finish of each part an item is drawn in (P3-5): a chair's fabric and frame, a table's top
 * and legs. Each part gets a band of its own, named by the part, as a wall's sides do.
 */
function materialFacts(project: Project, it: Item, size: { w: number; d: number; h: number }): Fact[] {
  const slots = itemMaterialSlots(project, it) ?? [];
  const recipe = drawnAs(it, size, derive.snapshotSizeSource(project), noAssets).recipe;
  return slots.flatMap((slot): Fact[] => {
    const group = capital(slot);
    const current = it.materials[slot] ?? null;
    const finished = (change: Partial<FinishRef>): EditCommand => ({
      type: "item.setFinish",
      payload: {
        itemIds: [it.id],
        materials: { [slot]: tidyFinish({ ...(current ?? blankFinish()), ...change }) },
      },
    });
    // what the part shows while it has no colour of its own: the item's colour, else the part's plain one
    const base = recipe ? recipeSlotKey(recipe.kind, slot) : "item";
    const effective = hexOf(materialColour(finishedMaterialKey(base, current ?? it.finish)));
    const colour = current?.color ?? null;
    const finish = finishNameOf(current?.shininess ?? null);
    const itemColoured = it.finish?.color != null;
    return [
      {
        group,
        label: `Colour of ${slot}`,
        caption: "Colour",
        value: colour ?? "",
        colour: { effective },
        empty: {
          shown: itemColoured ? "item's" : "default",
          action: itemColoured ? `Use the item's colour for the ${slot}` : `Use the default ${slot} colour`,
        },
        edit: hexEdit(
          colour,
          (color) => finished({ color }),
          itemColoured ? "the item's" : "default",
          effective,
        ),
      },
      {
        group,
        label: `Finish of ${slot}`,
        caption: "Finish",
        value: finish,
        choices: WALL_FINISHES,
        edit: choiceEdit("Finish", WALL_FINISHES, finish, (value) =>
          finished({ shininess: FINISH_SHININESS[value as FinishName] ?? null }),
        ),
      },
    ];
  });
}

function openingTitle(o: Opening): string {
  return o.kind === "door" ? "Door" : o.kind === "window" ? "Window" : "Passage";
}

/** What an opening is, as a person picks it; the model's values are the enum's. */
export const OPENING_KINDS: readonly Choice[] = [
  { value: "door", label: "Door" },
  { value: "window", label: "Window" },
  { value: "passage", label: "Passage" },
];

/** The swing a door is given when it becomes one: the model's own default for a new door. */
const NEW_DOOR_SWING = { hinge: "start", direction: "left" } as const;

const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * A door, window or passage (ADR-017 D3). Where it sits is said as the gap to each end of its wall, named by
 * compass, since a wall's start is invisible on a plan; either can be typed. Each gap runs along the wall's
 * centre line from the end point, where the model measures, to the opening's near edge.
 *
 * Whatever would run an opening off its wall or into another opening is refused here in words, before the
 * host refuses it in the validator's (opening.off-wall, opening.overlap). One through the wall's top is
 * refused too, though the model only warns of it: as with a baseboard (W-100), the panel should not keep a
 * number the drawing does not show.
 */
function openingFacts(project: Project, o: Opening): Fact[] {
  const w = project.walls.find((x) => x.id === o.wallId);
  if (!w) return [];
  const level = derive.levelOf(project, o.levelId) ?? derive.lowestLevel(project);
  const modify = (changes: Record<string, unknown>): EditCommand => ({
    type: "opening.modify",
    payload: { openingId: o.id, changes },
  });
  const len = derive.wallLength(w);
  const top = Math.round(derive.wallMaxHeight(w, level));
  const { from, to } = derive.openingAlongInterval(o, w);
  const startWord = derive.compassOf(derive.wallAngle(w) + 180, project.meta.north);
  const endWord = derive.compassOf(derive.wallAngle(w), project.meta.north);
  const sideWord = (side: "left" | "right") => derive.wallCompassSide(w, side, project.meta.north);
  const others = project.openings.filter((x) => x.wallId === w.id && x.id !== o.id);
  const what = openingTitle(o).toLowerCase();

  /** Why an opening spanning [a, b] along the wall cannot be, or null when it can. */
  const blocked = (a: number, b: number): string | null => {
    if (a < 0) return `The ${what} would run past the ${startWord} end of the wall.`;
    if (b > len) return `The ${what} would run past the ${endWord} end of the wall.`;
    const hit = others.find((x) => {
      const span = derive.openingAlongInterval(x, w);
      return a < span.to && span.from < b;
    });
    return hit ? `The ${what} would overlap the ${openingTitle(hit).toLowerCase()} beside it.` : null;
  };

  const gap = (end: "start" | "end"): Fact => {
    const word = end === "start" ? startWord : endWord;
    const current = Math.round(end === "start" ? from : len - to);
    return {
      group: "Position",
      label: `From ${word} end`,
      value: formatMm(current),
      unit: "mm",
      hint: `How far the ${what} is from the ${word} end of its wall, along the wall's centre line.`,
      edit: lengthEdit(`From ${word} end`, current, { min: 0, max: Math.floor(len - o.width) }, (mm) => {
        const a = end === "start" ? mm : len - mm - o.width;
        return blocked(a, a + o.width) ?? modify({ position: (a + o.width / 2) / len });
      }),
    };
  };

  const facts: Fact[] = [
    {
      label: "Kind",
      value: o.kind,
      choices: OPENING_KINDS,
      // A new door swings the model's default way; the model clears a swing and a sill that the new kind
      // cannot have (normalizeOpening), so neither needs saying here.
      edit: choiceEdit("Kind", OPENING_KINDS, o.kind, (kind) =>
        modify(kind === "door" && o.swing === null ? { kind, swing: NEW_DOOR_SWING } : { kind }),
      ),
    },
    gap("start"),
    gap("end"),
    {
      group: "Size",
      label: "Width",
      value: formatMm(o.width),
      unit: "mm",
      hint: "Widens or narrows about the middle.",
      edit: lengthEdit("Width", o.width, { min: 1, max: Math.floor(len) }, (width) => {
        const middle = (from + to) / 2;
        return blocked(middle - width / 2, middle + width / 2) ?? modify({ width });
      }),
    },
    {
      group: "Size",
      label: "Height",
      value: formatMm(o.height),
      unit: "mm",
      edit: lengthEdit("Height", o.height, { min: 1, max: HEIGHT_RANGE.max }, (height) =>
        o.sill + height > top
          ? `The top of the ${what} would be above the wall, which is ${top} mm high.`
          : modify({ height }),
      ),
    },
  ];
  if (o.kind === "window")
    facts.push({
      group: "Size",
      label: "Sill",
      value: formatMm(o.sill),
      unit: "mm",
      hint: "How high the bottom of the window is above the floor.",
      edit: lengthEdit("Sill", o.sill, { min: 0, max: HEIGHT_RANGE.max }, (sill) =>
        sill + o.height > top
          ? `The top of the window would be above the wall, which is ${top} mm high.`
          : modify({ sill }),
      ),
    });
  if (o.kind === "door") {
    // A door without a swing is a sliding or pocket door: nothing is drawn sweeping the floor.
    const hinges: Choice[] = [
      { value: "start", label: `${capital(startWord)} end` },
      { value: "end", label: `${capital(endWord)} end` },
      { value: "none", label: "No swing" },
    ];
    const hinge = o.swing?.hinge ?? "none";
    facts.push({
      group: "Swing",
      label: "Hinge",
      value: hinge,
      choices: hinges,
      hint: "The end of the door the hinges are on.",
      edit: choiceEdit("Hinge", hinges, hinge, (value) =>
        modify({
          swing: value === "none" ? null : { hinge: value, direction: o.swing?.direction ?? "left" },
        }),
      ),
    });
    if (o.swing) {
      const swing = o.swing;
      const sides: Choice[] = [
        { value: "left", label: `${capital(sideWord("left"))} side` },
        { value: "right", label: `${capital(sideWord("right"))} side` },
      ];
      facts.push({
        group: "Swing",
        label: "Opens to",
        value: swing.direction,
        choices: sides,
        hint: "The side of the wall the door swings into.",
        edit: choiceEdit("Opens to", sides, swing.direction, (direction) =>
          modify({ swing: { ...swing, direction } }),
        ),
      });
    }
  }
  return facts;
}

/**
 * The next selection after a click (F-138, F-140, F-141).
 *
 * - Shift held: the id toggles in or out, so a second shift-click removes it again.
 * - No shift, something hit: that id alone, which is what collapses a multi-selection to one (F-141).
 * - No shift, nothing hit: empty, so pressing on bare plan clears (F-138).
 */
export function nextSelection(current: readonly string[], hit: string | null, shiftHeld: boolean): string[] {
  if (!hit) return shiftHeld ? [...current] : [];
  if (!shiftHeld) return [hit];
  return current.includes(hit) ? current.filter((id) => id !== hit) : [...current, hit];
}

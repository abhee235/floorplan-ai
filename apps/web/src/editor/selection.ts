// What the selection is, and what can be done to it (P3-4; ledger F-133, F-138, F-140, F-141).
//
// Free of the DOM and of the canvas so it can be tested. The shell and the properties panel both read
// from here rather than each working the selection out for themselves.

import { MATERIAL_COLOURS } from "@fpv/engine";
import type { FinishRef, Item, Level, Opening, Project, Room, Wall } from "@fpv/ir";
import { derive } from "@fpv/ir";
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
    return r ? { id, kind, title: r.name ?? "Room", facts: roomFacts(r) } : null;
  }
  if (kind === "item") {
    const it = project.items.find((x) => x.id === id);
    return it ? { id, kind, title: itemTitle(it), facts: itemFacts(it) } : null;
  }
  const o = project.openings.find((x) => x.id === id);
  return o ? { id, kind, title: openingTitle(o), facts: openingFacts(o) } : null;
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

/** How glossy a side is, as a person picks it. The model keeps a number; these are the three it offers. */
export const WALL_FINISHES: readonly Choice[] = [
  { value: "matt", label: "Matt" },
  { value: "satin", label: "Satin" },
  { value: "gloss", label: "Gloss" },
];

/** Matt is no shininess at all, so a side left matt carries nothing and stays the default material. */
const SHININESS: Record<string, number | null> = { matt: null, satin: 0.25, gloss: 0.6 };

/** The offered finish nearest a stored shininess, so a value set by an agent still shows as one of three. */
function finishOf(shininess: number | null): string {
  if (shininess === null || shininess < 0.125) return "matt";
  return shininess < 0.425 ? "satin" : "gloss";
}

const hexOf = (rgb: number): string => `#${rgb.toString(16).padStart(6, "0").toUpperCase()}`;

/** A finish that says nothing is stored as no finish, so a reset side reads exactly like an untouched one. */
function tidyFinish(f: FinishRef): FinishRef | null {
  const blank =
    f.color === null &&
    f.textureId === null &&
    f.placement === null &&
    f.shininess === null &&
    !f.mirrorForLeftSide;
  return blank ? null : f;
}

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
    const base: FinishRef = current ?? {
      color: null,
      textureId: null,
      placement: null,
      mirrorForLeftSide: false,
      shininess: null,
    };
    return wallModify(w.id, { finishes: { ...w.finishes, [side]: tidyFinish({ ...base, ...change }) } });
  };
  const colour = current?.color ?? null;
  const finish = finishOf(current?.shininess ?? null);
  return [
    {
      group,
      label: `Colour, ${name}`,
      caption: "Colour",
      value: colour ?? "",
      colour: { effective: colour ?? hexOf(MATERIAL_COLOURS["wall-side"] ?? 0xe8e6e1) },
      empty: { shown: "default", action: "Use the default colour" },
      hint: "A hex colour, such as #E8E6E1. Empty uses the default wall colour.",
      edit: (text) => {
        if (text.trim() === "")
          return { ok: true, command: colour === null ? null : finished({ color: null }), said: "default" };
        const hex = parseHexColour(text);
        if (hex === null) return { ok: false, message: "Colour needs a hex value, such as #E8E6E1." };
        return { ok: true, command: hex === colour ? null : finished({ color: hex }), said: hex };
      },
    },
    {
      group,
      label: `Finish, ${name}`,
      caption: "Finish",
      value: finish,
      choices: WALL_FINISHES,
      edit: choiceEdit("Finish", WALL_FINISHES, finish, (value) =>
        finished({ shininess: SHININESS[value] ?? null }),
      ),
    },
    ...skirtingFacts(w, side, level),
  ];
}

/**
 * How deep a new baseboard is when only its height was typed: a common painted skirting board. The depth
 * row appears once there is a baseboard, for anyone who wants another.
 */
export const SKIRTING_DEPTH = 12;

/** A baseboard deeper than this is a plinth or a typing slip, not a skirting board. */
export const SKIRTING_DEPTH_RANGE = { min: 1, max: 200 } as const;

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
      edit: (text) => {
        if (text.trim() === "")
          return {
            ok: true,
            command: current.color === null ? null : withSkirting({ ...current, color: null }),
            said: "as its side",
          };
        const hex = parseHexColour(text);
        if (hex === null) return { ok: false, message: "Colour needs a hex value, such as #FFFFFF." };
        return {
          ok: true,
          command: hex === current.color ? null : withSkirting({ ...current, color: hex }),
          said: hex,
        };
      },
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

function roomFacts(r: Room): Fact[] {
  // Square metres: square millimetres is a number nobody reads. roomArea is already absolute and already
  // subtracts the holes (R-006), so there is nothing to correct for here.
  const areaM2 = derive.roomArea(r) / 1_000_000;
  return [
    { label: "Corners", value: String(r.polygon.length) },
    { label: "Area", value: `${areaM2.toFixed(2)} m²` },
    { label: "Purpose", value: r.purpose },
  ];
}

/** An Item carries no name: it is named by what it refers to. ItemRef is a union of a catalogue product
 *  and a generated primitive, so a product item reads as its product id and a recipe item as its kind. */
function itemTitle(it: Item): string {
  return it.ref.kind === "product" ? it.ref.productId : it.ref.recipe.kind;
}

function itemFacts(it: Item): Fact[] {
  return [
    { label: "Position", value: `${Math.round(it.position.x)}, ${Math.round(it.position.y)} mm` },
    { label: "Rotation", value: `${Math.round(it.rotation)}°` },
  ];
}

function openingTitle(o: Opening): string {
  return o.kind === "door" ? "Door" : o.kind === "window" ? "Window" : "Passage";
}

function openingFacts(o: Opening): Fact[] {
  return [
    { label: "Width", value: `${Math.round(o.width)} mm` },
    { label: "In wall", value: o.wallId },
  ];
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

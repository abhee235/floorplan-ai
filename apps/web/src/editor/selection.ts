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
  Point,
  PrimitiveRecipe,
  Project,
  Room,
  Size3,
  Wall,
  WallPattern,
  Zone,
} from "@fpv/ir";
import {
  blankFinish,
  defaultItem,
  derive,
  FINISH_SHININESS,
  type FinishName,
  finishNameOf,
  normalizeDeg,
  poly,
  SKIRTING_DEPTH,
  SKIRTING_DEPTH_RANGE,
  tidyFinish,
} from "@fpv/ir";
import { categoryLabel } from "./catalog.js";
import { describeLength, formatDegrees, formatMm, parseDegrees, parseHexColour, parseMm } from "./status.js";
import { WALL_KINDS } from "./tools.js";
import { MAX_LENGTH_MM } from "./wall-tool.js";
import { FILL_CAP, fitCount, ZONE_PATTERNS, type ZonePattern, type ZoneRule } from "./zone-tool.js";

/** The entity kinds the editor can select and delete today. */
export type EntityKind = "wall" | "room" | "item" | "opening" | "zone";

const DELETE_COMMAND: Record<EntityKind, { type: string; key: string; extra?: Record<string, unknown> }> = {
  wall: { type: "wall.delete", key: "wallIds" },
  room: { type: "room.delete", key: "roomIds" },
  item: { type: "item.delete", key: "itemIds" },
  opening: { type: "opening.delete", key: "openingIds" },
  // Deleting a cluster takes its desks with it. They exist because the zone said so, and leaving a floor
  // covered in desks that nothing now describes is not what "delete this cluster" means.
  zone: { type: "zone.delete", key: "zoneIds", extra: { deleteItems: true } },
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
  return prefix === "wall" ||
    prefix === "room" ||
    prefix === "item" ||
    prefix === "opening" ||
    prefix === "zone"
    ? prefix
    : null;
}

export interface DeleteCommand {
  type: string;
  payload: Record<string, unknown>;
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
  // the same reason, and zones ahead of everything, because a zone takes its own pieces with it.
  const order: EntityKind[] = ["zone", "opening", "item", "room", "wall"];
  const out: DeleteCommand[] = [];
  for (const kind of order) {
    const list = byKind.get(kind);
    if (!list?.length) continue;
    const spec = DELETE_COMMAND[kind];
    out.push({ type: spec.type, payload: { [spec.key]: list, ...spec.extra } });
  }
  return out;
}

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

  // A zone moves by its own polygon, and the reducer walks its pieces along with it: they keep their ids,
  // so anything done to one of them since survives the drag.
  const owned = new Set<string>();
  for (const zoneId of byKind.get("zone") ?? []) {
    const zone = project.zones.find((z) => z.id === zoneId);
    if (!zone) continue;
    for (const id of zone.generatedItemIds) owned.add(id);
    out.push({
      type: "zone.modify",
      payload: { zoneId, changes: { polygon: zone.polygon.map((q) => ({ x: q.x + x, y: q.y + y })) } },
    });
  }

  // A piece its own zone is already moving is left out, or it would travel twice.
  const itemIds = (byKind.get("item") ?? []).filter((id) => !owned.has(id));
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
  /** An image to show beside the label: a texture's. */
  image?: string;
}

/** A texture the panel can offer, as the host lists them (P3-5). */
export interface TextureChoice {
  id: string;
  name: string;
  tags: readonly string[];
}

export interface DescribeOptions {
  /** The catalog's textures, for the material rows. The project's own copies are offered as well. */
  textures?: readonly TextureChoice[];
}

/** A material row's value while the surface is painted rather than wearing a texture. */
export const PAINT = "paint";

/** Where the viewer finds a texture's image: the host serves it (P3-5). */
export function textureUrl(id: string): string {
  return `/textures/${id.split("/").map(encodeURIComponent).join("/")}`;
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
export function describeEntity(
  project: Project,
  id: string,
  options: DescribeOptions = {},
): SelectedEntity | null {
  const kind = kindOf(id);
  if (!kind) return null;
  const materials = (prefer: string) => (current: string | null) =>
    materialChoices(project, options.textures ?? [], prefer, current);
  if (kind === "wall") {
    const w = project.walls.find((x) => x.id === id);
    if (!w) return null;
    const level = derive.levelOf(project, w.levelId) ?? derive.lowestLevel(project);
    return { id, kind, title: "Wall", facts: wallFacts(w, level, project.meta.north, materials("wall")) };
  }
  if (kind === "room") {
    const r = project.rooms.find((x) => x.id === id);
    if (!r) return null;
    const level = derive.levelOf(project, r.levelId) ?? derive.lowestLevel(project);
    return { id, kind, title: r.name ?? "Room", facts: roomFacts(r, level, materials) };
  }
  if (kind === "item") {
    const it = project.items.find((x) => x.id === id);
    return it ? { id, kind, title: itemTitle(project, it), facts: itemFacts(project, it, materials) } : null;
  }
  if (kind === "zone") {
    const z = project.zones.find((x) => x.id === id);
    return z ? { id, kind, title: z.name ?? zoneTitle(project, z), facts: zoneFacts(project, z) } : null;
  }
  const o = project.openings.find((x) => x.id === id);
  return o ? { id, kind, title: openingTitle(o), facts: openingFacts(project, o, materials) } : null;
}

/** How far from the origin a typed coordinate may be: the same kilometre the wall tool allows (W-072). */
const COORDINATE_RANGE = { min: -MAX_LENGTH_MM, max: MAX_LENGTH_MM } as const;

/** A typed wall length: a whole millimetre at least, since Mm is an integer, up to that same kilometre. */
export const LENGTH_RANGE = { min: 1, max: MAX_LENGTH_MM } as const;

/** The material choices for a surface, those tagged `prefer` first, given the texture it wears now. */
type MaterialChoices = (current: string | null) => Choice[];

function materialChoices(
  project: Project,
  textures: readonly TextureChoice[],
  prefer: string,
  current: string | null,
): Choice[] {
  const byId = new Map<string, TextureChoice>();
  for (const t of textures) byId.set(t.id, t);
  // what the project already wears is offered whether or not the list has arrived
  for (const [id, snap] of Object.entries(project.textures)) {
    if (byId.has(id)) continue;
    const name = (snap as { name?: unknown }).name;
    byId.set(id, { id, name: typeof name === "string" ? name : id, tags: [] });
  }
  if (current && !byId.has(current)) byId.set(current, { id: current, name: current, tags: [] });
  const list = [...byId.values()].sort(
    (a, b) =>
      Number(b.tags.includes(prefer)) - Number(a.tags.includes(prefer)) || a.name.localeCompare(b.name),
  );
  return [
    { value: PAINT, label: "Paint" },
    ...list.map((t) => ({ value: t.id, label: t.name, image: textureUrl(t.id) })),
  ];
}

/**
 * The material a surface is made of (P3-5): paint, which takes the colour row below it, or a texture,
 * which shows its own colours. Picking a texture clears the colour, and typing a colour clears the
 * texture, so the rows never say one thing while the view shows another.
 */
function materialFact(
  group: string,
  label: string,
  current: FinishRef | null,
  choices: MaterialChoices,
  set: (textureId: string | null) => EditCommand,
): Fact {
  const value = current?.textureId ?? PAINT;
  const list = choices(current?.textureId ?? null);
  return {
    group,
    label,
    caption: "Material",
    value,
    choices: list,
    hint: "Paint takes the colour. A material shows its own colours, and a colour replaces it.",
    edit: choiceEdit("Material", list, value, (v) => set(v === PAINT ? null : v)),
  };
}

/** A finish change that sets a texture or a colour, never both. */
function paintOrTexture(change: { color?: string | null; textureId?: string | null }): Partial<FinishRef> {
  if (change.textureId) return { textureId: change.textureId, color: null };
  if (change.color) return { color: change.color, textureId: null };
  return change;
}

function wallFacts(w: Wall, level: Level, north: number, materials: MaterialChoices): Fact[] {
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
    arc
      ? // Along the curve, which is the length anyone means by a curved wall's length. Not typed: a new
        // length could keep the chord and deepen the curve, or keep the curve and move an end, and neither
        // is obviously what was meant. The arc's own extent is the control for its shape.
        { group: SHAPE_AND_SIZE, label: "Length", value: formatMm(derive.wallArcLength(w)), unit: "mm" }
      : {
          group: SHAPE_AND_SIZE,
          label: "Length",
          value: formatMm(derive.wallLength(w)),
          unit: "mm",
          edit: lengthEdit("Length", Math.round(derive.wallLength(w)), LENGTH_RANGE, (mm) =>
            wallModify(w.id, { end: endAtLength(w, mm) }),
          ),
        },
    {
      group: SHAPE_AND_SIZE,
      label: "Thickness",
      value: formatMm(w.thickness),
      unit: "mm",
      edit: lengthEdit("Thickness", w.thickness, THICKNESS_RANGE, (thickness) =>
        wallModify(w.id, { thickness }),
      ),
    },
    ...heightFacts(w, level),
    // last in its band, after the length and the heights, which pair up two to a line
    {
      group: SHAPE_AND_SIZE,
      label: "Curve",
      value: w.arcExtent === null ? "" : formatDegrees(w.arcExtent),
      unit: "°",
      empty: { shown: "straight", action: "Make the wall straight" },
      hint: "In degrees. A positive curve bows to the left, going from start to end. Empty is straight.",
      edit: curveEdit(w),
    },
    ...sideFacts(w, "left", level, north, materials),
    ...sideFacts(w, "right", level, north, materials),
  ];
}

/**
 * One band for a wall's curve, length, thickness and heights: each is a single number, and a band each
 * spent more of the panel on headings than on values.
 */
const SHAPE_AND_SIZE = "Shape and size";

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
function sideFacts(
  w: Wall,
  side: "left" | "right",
  level: Level,
  north: number,
  materials: MaterialChoices,
): Fact[] {
  const name = `${side} side`;
  const group = `${side === "left" ? "Left" : "Right"} side, facing ${derive.wallCompassSide(w, side, north)}`;
  const current = w.finishes[side];
  const finished = (change: Partial<FinishRef>): EditCommand => {
    const base: FinishRef = current ?? blankFinish();
    return wallModify(w.id, { finishes: { ...w.finishes, [side]: tidyFinish({ ...base, ...change }) } });
  };
  const colour = current?.color ?? null;
  const finish = finishNameOf(current?.shininess ?? null);
  const textured = Boolean(current?.textureId);
  return [
    materialFact(group, `Material, ${name}`, current, materials, (textureId) =>
      finished(paintOrTexture({ textureId })),
    ),
    {
      group,
      label: `Colour, ${name}`,
      caption: "Colour",
      value: colour ?? "",
      colour: { effective: colour ?? hexOf(MATERIAL_COLOURS["wall-side"] ?? 0xe8e6e1) },
      empty: { shown: textured ? "material" : "default", action: "Use the default colour" },
      hint: "A hex colour, such as #E8E6E1. Empty uses the default wall colour. A colour replaces a material.",
      edit: hexEdit(colour, (color) => finished(paintOrTexture({ color })), "default", "#E8E6E1"),
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
    ...skirtingFacts(w, side, level, group),
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
function skirtingFacts(w: Wall, side: "left" | "right", level: Level, group: string): Fact[] {
  const name = `${side} side`;
  // In its side's band, so its captions say "Baseboard" to stand apart from the side's own Colour.
  const current = w.skirting[side];
  const tallest = Math.round(derive.wallMaxHeight(w, level));
  const withSkirting = (value: Wall["skirting"]["left"]): EditCommand =>
    wallModify(w.id, { skirting: { ...w.skirting, [side]: value } });
  const facts: Fact[] = [
    {
      group,
      label: `Baseboard height, ${name}`,
      caption: "Baseboard height",
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
      label: `Baseboard depth, ${name}`,
      caption: "Baseboard depth",
      value: formatMm(current.thickness),
      unit: "mm",
      hint: "How far the baseboard stands out from the wall.",
      edit: lengthEdit("Baseboard depth", current.thickness, SKIRTING_DEPTH_RANGE, (thickness) =>
        withSkirting({ ...current, thickness }),
      ),
    },
    {
      group,
      label: `Baseboard colour, ${name}`,
      caption: "Baseboard colour",
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
      group: SHAPE_AND_SIZE,
      label: "Height",
      value: w.height === null ? "" : formatMm(w.height),
      unit: "mm",
      // Not offered on a sloping wall: the model keeps an end height only beside a start height of the
      // wall's own, and moves a lone end height into the start (normalizeWall), so emptying the start would
      // turn the slope into a flat top at the end's height.
      ...(sloping
        ? {}
        : { empty: { shown: `${formatMm(level.height)} (level)`, action: "Follow the level's height" } }),
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
      group: SHAPE_AND_SIZE,
      label: "Height at end",
      value: w.heightAtEnd === null ? "" : formatMm(w.heightAtEnd),
      unit: "mm",
      empty: { shown: `${formatMm(start)} (flat)`, action: "Make the top flat" },
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
  { value: "bedroom", label: "Bedroom" },
  { value: "living", label: "Living room" },
  { value: "kitchen", label: "Kitchen" },
  { value: "dining", label: "Dining room" },
  { value: "bathroom", label: "Bathroom" },
  { value: "toilet", label: "Toilet" },
  { value: "foyer", label: "Foyer" },
  { value: "study", label: "Study" },
  { value: "laundry", label: "Laundry" },
  { value: "balcony", label: "Balcony" },
  { value: "garage", label: "Garage" },
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
function roomFacts(r: Room, level: Level, materials: (prefer: string) => MaterialChoices): Fact[] {
  const modify = (changes: Record<string, unknown>): EditCommand => ({
    type: "room.modify",
    payload: { roomId: r.id, changes },
  });
  const surface = (which: "floor" | "ceiling", change: Partial<FinishRef>): EditCommand =>
    modify({
      finishes: {
        ...r.finishes,
        [which]: tidyFinish({ ...(r.finishes[which] ?? blankFinish()), ...paintOrTexture(change) }),
      },
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
    materialFact("Floor", "Material of floor", r.finishes.floor, materials("floor"), (textureId) =>
      surface("floor", { textureId }),
    ),
    {
      group: "Floor",
      label: "Colour of floor",
      caption: "Colour",
      value: r.finishes.floor?.color ?? "",
      colour: { effective: r.finishes.floor?.color ?? plain("floor", 0xc9c2b8) },
      empty: {
        shown: r.finishes.floor?.textureId ? "material" : "default",
        action: "Use the default floor colour",
      },
      edit: hexEdit(
        r.finishes.floor?.color ?? null,
        (color) => surface("floor", { color }),
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
      empty: { shown: `${formatMm(level.height)} (level)`, action: "Follow the level's height" },
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
    materialFact("Ceiling", "Material of ceiling", r.finishes.ceiling, materials("ceiling"), (textureId) =>
      surface("ceiling", { textureId }),
    ),
    {
      group: "Ceiling",
      label: "Colour of ceiling",
      caption: "Colour",
      value: r.finishes.ceiling?.color ?? "",
      colour: { effective: r.finishes.ceiling?.color ?? plain("ceiling", 0xfafafa) },
      empty: {
        shown: r.finishes.ceiling?.textureId ? "material" : "default",
        action: "Use the default ceiling colour",
      },
      edit: hexEdit(
        r.finishes.ceiling?.color ?? null,
        (color) => surface("ceiling", { color }),
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
  bed: "Bed",
  sofa: "Sofa",
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
function itemFacts(project: Project, it: Item, materials: (prefer: string) => MaterialChoices): Fact[] {
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
    ...productFacts(project, it),
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
  ];
  // After the sizes, so the panel pairs the numbers two to a line and the checkbox comes last.
  const mirrored: Fact = {
    group: "Placement",
    label: "Mirrored",
    toggle: true,
    value: String(it.mirrored),
    hint: "Left and right swapped, for things that are not the same both ways.",
    edit: toggleEdit(it.mirrored, () => ({ type: "item.mirror", payload: { itemIds: ids } }), {
      yes: "mirrored",
      no: "not mirrored",
    }),
  };
  if (!size) return [...facts, mirrored];
  const dimensions = [
    { key: "w", label: "Width", range: LENGTH_RANGE },
    { key: "d", label: "Depth", range: LENGTH_RANGE },
    { key: "h", label: "Height", range: HEIGHT_RANGE },
  ] as const;
  // The size the item has without one of its own: its product's, or its recipe's. While the item has its
  // own, each row offers the way back to that one, and says what it is.
  const natural = derive.itemSize({ ...it, size: null }, derive.snapshotSizeSource(project));
  const from = it.ref.kind === "product" ? "catalog" : "shape";
  const back =
    it.size && natural
      ? {
          empty: { shown: `${from} size`, action: `Use the ${from}'s size` },
          reset: (): EditOutcome => ({
            ok: true,
            command: { type: "item.resize", payload: { itemId: it.id, size: null } },
            said: `back to the ${from}'s size`,
          }),
        }
      : null;
  for (const { key, label, range } of dimensions) {
    // item.resize keeps the back left corner by default (F-100), so a desk against a wall stays against it
    // when it is made deeper.
    const keeps = key === "h" ? "" : "The back left corner stays where it is.";
    const own =
      back && natural ? `The ${from}'s ${label.toLowerCase()} is ${describeLength(natural[key])}.` : "";
    const hint = [keeps, own].filter(Boolean).join(" ");
    const typed = lengthEdit(label, size[key], range, (mm) => ({
      type: "item.resize",
      payload: { itemId: it.id, size: { ...size, [key]: mm } },
    }));
    facts.push({
      // with where the item stands: a size is three numbers, and a band of its own cost a heading
      group: "Placement",
      label,
      value: formatMm(size[key]),
      unit: "mm",
      ...(oneSize
        ? { hint: "This product comes in one size." }
        : {
            ...(hint ? { hint } : {}),
            ...(back ? { empty: back.empty } : {}),
            edit: back ? orEmpty(typed, back.reset) : typed,
          }),
    });
  }
  facts.push(mirrored, ...materialFacts(project, it, size, materials));
  return facts;
}

/** What the project's snapshot of a product says (spec 02 section 1.1); only the fields this reads. */
interface SnapshotView {
  make?: string;
  model?: string;
  category?: string;
  dims?: { w: number; d: number; h: number };
  verification?: { status?: string; confidence?: number };
  price?: { amount?: number; currency?: string; type?: string } | null;
}

/**
 * How far a product's catalog record can be trusted, in words short enough for the field, with what that
 * means for a screen reader and the row's description (spec 02 section 6).
 */
const TRUST: Readonly<Record<string, { shown: string; hint?: string }>> = {
  verified: { shown: "Verified", hint: "Its size was found on the maker's or a seller's pages." },
  manual: { shown: "Entered by hand" },
  unverified: { shown: "Unverified", hint: "Its size and price may be wrong until it is verified." },
  rejected: { shown: "Rejected", hint: "The catalog could not confirm this product exists." },
};

/**
 * The product an item is (P3-5), as the project's snapshot of the catalog record says: read, never typed,
 * because the record is the catalog's. A recipe item has none.
 */
function productFacts(project: Project, it: Item): Fact[] {
  if (it.ref.kind !== "product") return [];
  const snap = project.catalogRefs[it.ref.productId] as SnapshotView | undefined;
  const group = "Product";
  if (!snap)
    return [{ group, label: "Product", value: `${it.ref.productId}, not in this project's catalog copy` }];
  const facts: Fact[] = [];
  // Make beside category, then the model, which is the one of the three likely to need the whole line.
  if (snap.make) facts.push({ group, label: "Make", value: snap.make });
  if (snap.category)
    facts.push({
      group,
      label: "Category of product",
      caption: "Category",
      value: categoryLabel(snap.category),
    });
  if (snap.model) facts.push({ group, label: "Model", value: snap.model });
  const status = snap.verification?.status;
  if (status) {
    const confidence = snap.verification?.confidence;
    const sure =
      status === "verified" && typeof confidence === "number"
        ? `, ${Math.round(confidence * 100)}% sure`
        : "";
    const trust = TRUST[status] ?? { shown: status };
    facts.push({
      group,
      label: "Checked",
      value: `${trust.shown}${sure}`,
      ...(trust.hint ? { hint: trust.hint } : {}),
    });
  }
  const price = snap.price;
  if (price && typeof price.amount === "number" && price.currency) {
    const money = new Intl.NumberFormat("en", { style: "currency", currency: price.currency }).format(
      price.amount,
    );
    facts.push({ group, label: "Price", value: price.type ? `${money} ${price.type}` : money });
  }
  return facts;
}

/**
 * The colour and finish of each part an item is drawn in (P3-5): a chair's fabric and frame, a table's top
 * and legs. Each part gets a band of its own, named by the part, as a wall's sides do.
 */
function materialFacts(
  project: Project,
  it: Item,
  size: { w: number; d: number; h: number },
  materials: (prefer: string) => MaterialChoices,
): Fact[] {
  const slots = itemMaterialSlots(project, it) ?? [];
  const recipe = drawnAs(it, size, derive.snapshotSizeSource(project), noAssets).recipe;
  return slots.flatMap((slot): Fact[] => {
    const group = capital(slot);
    const current = it.materials[slot] ?? null;
    const finished = (change: Partial<FinishRef>): EditCommand => ({
      type: "item.setFinish",
      payload: {
        itemIds: [it.id],
        materials: { [slot]: tidyFinish({ ...(current ?? blankFinish()), ...paintOrTexture(change) }) },
      },
    });
    // what the part shows while it has no colour of its own: the item's colour, else the part's plain one
    const base = recipe ? recipeSlotKey(recipe.kind, slot) : "item";
    const effective = hexOf(materialColour(finishedMaterialKey(base, current ?? it.finish)));
    const colour = current?.color ?? null;
    const finish = finishNameOf(current?.shininess ?? null);
    const itemColoured = it.finish?.color != null;
    // fabric and upholstery textures first for a seat, wood and stone for a top, and so on by tag
    const prefer = slot === "fabric" ? "upholstery" : slot === "top" ? "wood" : slot;
    return [
      materialFact(group, `Material of ${slot}`, current, materials(prefer), (textureId) =>
        finished({ textureId }),
      ),
      {
        group,
        label: `Colour of ${slot}`,
        caption: "Colour",
        value: colour ?? "",
        colour: { effective },
        empty: {
          shown: current?.textureId ? "material" : itemColoured ? "item's" : "default",
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
function openingFacts(project: Project, o: Opening, materials: (prefer: string) => MaterialChoices): Fact[] {
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
  // What fills the hole, and what surrounds it, are dressed separately: a white frame around a dark
  // leaf is the ordinary case, and one finish for both could not say it. A passage has no fill, so it
  // is offered only the frame.
  const surface = (slot: "frame" | "leaf", change: { color?: string | null; textureId?: string | null }) =>
    modify({
      finishes: {
        ...o.finishes,
        [slot]: tidyFinish({ ...(o.finishes[slot] ?? blankFinish()), ...paintOrTexture(change) }),
      },
    });
  const fill = o.kind === "window" ? "glass" : o.kind === "door" ? "leaf" : null;
  if (fill) {
    const isGlass = fill === "glass";
    const word = isGlass ? "glazing" : "leaf";
    facts.push(
      materialFact(capital(word), `Material of ${word}`, o.finishes.leaf, materials(fill), (textureId) =>
        surface("leaf", { textureId }),
      ),
      {
        group: capital(word),
        label: `Colour of ${word}`,
        caption: "Colour",
        value: o.finishes.leaf?.color ?? "",
        colour: { effective: o.finishes.leaf?.color ?? (isGlass ? "#A9CFE4" : "#E0DCD4") },
        empty: {
          // Empty means two different things. A window with no colour is glazed as glass; a door with
          // no colour has no leaf at all, and a doorway is what it is until someone gives it one.
          shown: o.finishes.leaf?.textureId ? "material" : isGlass ? "default" : "none",
          action: isGlass ? "Use the default glass colour" : "Leave the doorway open",
        },
        edit: hexEdit(
          o.finishes.leaf?.color ?? null,
          (color) => surface("leaf", { color }),
          "default",
          isGlass ? "#A9CFE4" : "#E0DCD4",
        ),
      },
    );
  }
  facts.push(
    materialFact("Frame", "Material of frame", o.finishes.frame, materials("frame"), (textureId) =>
      surface("frame", { textureId }),
    ),
    {
      group: "Frame",
      label: "Colour of frame",
      caption: "Colour",
      value: o.finishes.frame?.color ?? "",
      colour: { effective: o.finishes.frame?.color ?? "#F4F2EE" },
      empty: {
        shown: o.finishes.frame?.textureId ? "material" : "default",
        action: "Use the default frame colour",
      },
      edit: hexEdit(
        o.finishes.frame?.color ?? null,
        (color) => surface("frame", { color }),
        "default",
        "#F4F2EE",
      ),
    },
  );
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

/** The patterns a cluster can be laid out in, in the panel's words. */
export const ZONE_PATTERN_CHOICES: readonly Choice[] = ZONE_PATTERNS.map((p) => ({
  value: p.value,
  label: p.label,
}));

/** How many pieces a cluster may be asked for: one, up to the tool's own ceiling. */
export const ZONE_COUNT_RANGE = { min: 1, max: FILL_CAP } as const;
/** The gap between pieces, and the margin inside the zone's edge: none, up to ten metres. */
export const ZONE_GAP_RANGE = { min: 0, max: 10_000 } as const;
/** How wide or deep a cluster may be: a hundred millimetres, up to the kilometre a wall may run. */
export const ZONE_SIDE_RANGE = { min: 100, max: MAX_LENGTH_MM } as const;

/**
 * A desk cluster (P3-6). Every row here changes the RULE and lays the pieces out again, which is one
 * `item.arrange` with `replace` rather than a modify and a regenerate: two commands would be two entries
 * in the history, so undoing a change to the gap would leave the old desks deleted and the new ones not
 * yet placed.
 *
 * The count is a field like any other, but its reset button means "fill", because that is what a person
 * wants after making the zone bigger. What is actually standing is shown beside it: the rule can ask for
 * sixty and the floor hold forty-eight, and a panel that showed only the sixty would be lying.
 */
function zoneFacts(project: Project, z: Zone): Fact[] {
  const rule = z.rule;
  const placed = z.generatedItemIds.length;
  const name: Fact = {
    label: "Name of cluster",
    caption: "Name",
    value: z.name ?? "",
    align: "left",
    empty: { shown: "unnamed", action: "Clear the name" },
    edit: (text) => {
      const trimmed = text.trim();
      if (trimmed.length > NAME_LIMIT)
        return { ok: false, message: `A name is at most ${NAME_LIMIT} characters.` };
      const next = trimmed === "" ? null : trimmed;
      return {
        ok: true,
        command:
          next === z.name
            ? null
            : { type: "zone.modify", payload: { zoneId: z.id, changes: { name: next } } },
        said: next ?? "unnamed",
      };
    },
  };
  if (!rule)
    // A zone drawn for something other than furniture: it marks an area and lays nothing out.
    return [name, { label: "Pieces", value: String(placed) }];

  const size = zonePieceSize(project, z);
  const asRule = (over: Partial<ZoneRule> = {}): ZoneRule => ({
    pattern: (over.pattern ?? rule.pattern) as ZonePattern,
    spacing: over.spacing ?? rule.spacing,
    facing: over.facing ?? rule.facing,
    margin: over.margin ?? rule.margin,
  });
  /** How many would fit if the rule changed this way; the count itself never changes the answer. */
  const fitsWith = (over: Partial<ZoneRule> = {}): number =>
    size ? fitCount(z.polygon, asRule(over), size) : 0;
  const rearrange = (over: Partial<ZoneRule> & { count?: number }): EditCommand => {
    const next = asRule(over);
    return {
      type: "item.arrange",
      payload: {
        target: { zoneId: z.id },
        rule: {
          pattern: next.pattern,
          productId: rule.productId,
          recipe: rule.recipe,
          count: over.count ?? rule.count,
          spacing: next.spacing,
          facing: next.facing,
          margin: next.margin,
        },
        replace: true,
      },
    };
  };
  const gap = (axis: "x" | "y", mm: number): EditCommand =>
    rearrange({ spacing: { ...rule.spacing, [axis]: mm } });

  const b = poly.bounds(z.polygon);
  const wide = Math.round(b.maxX - b.minX);
  const deep = Math.round(b.maxY - b.minY);
  /**
   * A new shape for the zone, and the pieces laid out for it in the same command.
   *
   * A cluster that was full stays full: if it held everything that fitted, growing it fills the room it
   * gained, and shrinking it drops what no longer fits. One that was asked for a set number keeps that
   * number, because someone who typed twelve meant twelve.
   */
  const reshape = (polygon: Point[]): EditCommand => {
    const wasFull = rule.count >= fitsWith();
    const now = size ? fitCount(polygon, asRule(), size) : rule.count;
    return {
      type: "item.arrange",
      payload: {
        target: { zoneId: z.id, polygon },
        rule: {
          pattern: rule.pattern,
          productId: rule.productId,
          recipe: rule.recipe,
          count: Math.max(1, wasFull ? now : rule.count),
          spacing: rule.spacing,
          facing: rule.facing,
          margin: rule.margin,
        },
        replace: true,
      },
    };
  };
  /** Scaled about its bottom-left corner, which is the corner the panel prints as its position. */
  const scaled = (across: number | null, along: number | null): Point[] => {
    const sx = across === null ? 1 : across / Math.max(1, wide);
    const sy = along === null ? 1 : along / Math.max(1, deep);
    return z.polygon.map((q) => ({
      x: Math.round(b.minX + (q.x - b.minX) * sx),
      y: Math.round(b.minY + (q.y - b.minY) * sy),
    }));
  };
  const movedTo = (x: number | null, y: number | null): Point[] => {
    const dx = x === null ? 0 : Math.round(x - b.minX);
    const dy = y === null ? 0 : Math.round(y - b.minY);
    return z.polygon.map((q) => ({ x: q.x + dx, y: q.y + dy }));
  };
  // Moving keeps the pieces and their ids, so it goes through zone.modify rather than being laid out
  // again: see the reducer. Resizing cannot, because the old positions were worked out for the old shape.
  const moveTo = (x: number | null, y: number | null): EditCommand => ({
    type: "zone.modify",
    payload: { zoneId: z.id, changes: { polygon: movedTo(x, y) } },
  });

  return [
    name,
    {
      group: "Size and place",
      label: "Position X",
      caption: "Position",
      prefix: "X",
      value: formatMm(Math.round(b.minX)),
      unit: "mm",
      hint: "The corner the cluster is measured from.",
      edit: lengthEdit("Position X", Math.round(b.minX), COORDINATE_RANGE, (mm) => moveTo(mm, null)),
    },
    {
      group: "Size and place",
      label: "Position Y",
      prefix: "Y",
      value: formatMm(Math.round(b.minY)),
      unit: "mm",
      edit: lengthEdit("Position Y", Math.round(b.minY), COORDINATE_RANGE, (mm) => moveTo(null, mm)),
    },
    {
      group: "Size and place",
      label: "Width",
      value: formatMm(wide),
      unit: "mm",
      hint: "How far the cluster reaches from east to west.",
      edit: lengthEdit("Width", wide, ZONE_SIDE_RANGE, (mm) => reshape(scaled(mm, null))),
    },
    {
      group: "Size and place",
      label: "Depth",
      value: formatMm(deep),
      unit: "mm",
      edit: lengthEdit("Depth", deep, ZONE_SIDE_RANGE, (mm) => reshape(scaled(null, mm))),
    },
    {
      group: "Layout",
      label: "Pattern",
      value: rule.pattern,
      choices: ZONE_PATTERN_CHOICES,
      hint: "Rows face one way; bench turns every other row to face back.",
      edit: choiceEdit("Pattern", ZONE_PATTERN_CHOICES, rule.pattern, (pattern) =>
        rearrange({ pattern: pattern as ZonePattern }),
      ),
    },
    {
      group: "Layout",
      label: "Pieces",
      value: String(rule.count),
      unit: "desks",
      empty: { shown: "as many as fit", action: "Fill the zone" },
      hint: `${fitsWith()} fit in this zone at this gap.`,
      edit: (text) => {
        const trimmed = text.trim();
        if (trimmed === "") {
          const fits = fitsWith();
          if (fits === 0) return { ok: false, message: "Nothing fits in this zone at this gap." };
          return {
            ok: true,
            command: fits === rule.count ? null : rearrange({ count: fits }),
            said: `${fits} filling the zone`,
          };
        }
        if (!/^\d+$/.test(trimmed)) return { ok: false, message: "Pieces needs a whole number, such as 24." };
        const count = Number(trimmed);
        if (count < ZONE_COUNT_RANGE.min || count > ZONE_COUNT_RANGE.max)
          return {
            ok: false,
            message: `Pieces must be from ${ZONE_COUNT_RANGE.min} to ${ZONE_COUNT_RANGE.max}.`,
          };
        return {
          ok: true,
          command: count === rule.count ? null : rearrange({ count }),
          said: `${count} ${count === 1 ? "piece" : "pieces"}`,
        };
      },
    },
    {
      group: "Layout",
      label: "Gap across",
      caption: "Gap",
      prefix: "X",
      value: formatMm(rule.spacing.x),
      unit: "mm",
      hint: "Between one piece and the next along a row.",
      edit: lengthEdit("Gap across", rule.spacing.x, ZONE_GAP_RANGE, (mm) => gap("x", mm)),
    },
    {
      group: "Layout",
      label: "Gap between rows",
      prefix: "Y",
      value: formatMm(rule.spacing.y),
      unit: "mm",
      edit: lengthEdit("Gap between rows", rule.spacing.y, ZONE_GAP_RANGE, (mm) => gap("y", mm)),
    },
    {
      group: "Layout",
      label: "Facing",
      value: formatDegrees(normalizeDeg(rule.facing)),
      unit: "°",
      hint: "Which way the pieces face, clockwise from north.",
      edit: (text) => {
        const deg = parseDegrees(text);
        if (deg === null) return { ok: false, message: "Facing needs a number of degrees, such as 180." };
        const facing = normalizeDeg(deg);
        return {
          ok: true,
          command: facing === normalizeDeg(rule.facing) ? null : rearrange({ facing }),
          said: `${formatDegrees(facing)} degrees`,
        };
      },
    },
    {
      group: "Layout",
      label: "Margin",
      value: formatMm(rule.margin),
      unit: "mm",
      hint: "Kept clear inside the zone's edge.",
      edit: lengthEdit("Margin", rule.margin, ZONE_GAP_RANGE, (mm) => rearrange({ margin: mm })),
    },
    { group: "Holds", label: "Piece", value: zonePieceName(project, z), align: "left" },
    {
      group: "Holds",
      label: "Standing",
      value: placed === rule.count ? String(placed) : `${placed} of ${rule.count}`,
      ...(placed < rule.count
        ? { hint: "The rest do not fit; make the zone bigger or the gap smaller." }
        : {}),
    },
  ];
}

/**
 * A cluster with no name of its own is called after what it holds: "Chair cluster". A product's full
 * catalogue name is a sentence — "Generic chair, any size" — so only the part before the first comma is
 * used, and the whole of it is on the Piece row just below.
 */
function zoneTitle(project: Project, z: Zone): string {
  const piece = zonePieceName(project, z);
  if (piece === "nothing") return "Cluster";
  return `${(piece.split(",")[0] as string).trim()} cluster`;
}

/** The size of one piece the zone lays out, worked out as the reducer works it out. */
function zonePieceSize(project: Project, z: Zone): Size3 | null {
  const ref = zoneRef(z);
  if (!ref) return null;
  const probe = defaultItem("item_000000", z.levelId, ref, { x: 0, y: 0 });
  return derive.itemSize(probe, derive.snapshotSizeSource(project)) ?? null;
}

function zoneRef(z: Zone): Item["ref"] | null {
  const rule = z.rule;
  if (!rule) return null;
  if (rule.productId) return { kind: "product", productId: rule.productId };
  return rule.recipe ? { kind: "recipe", recipe: rule.recipe } : null;
}

/** What the zone lays out, in words: the product's name, or the name of the generic shape. Written the
 *  same way an item's own title is, so a cluster of chairs and a chair read alike. */
function zonePieceName(project: Project, z: Zone): string {
  const ref = zoneRef(z);
  if (!ref) return "nothing";
  return itemTitle(project, defaultItem("item_000000", z.levelId, ref, { x: 0, y: 0 }));
}

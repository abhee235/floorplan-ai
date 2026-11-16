// Drawing a desk cluster (P3-6). The rules live here, free of the DOM and of the canvas, so they can be
// tested: the rectangle a drag makes, how many desks fit inside it, and the one command a finished drag
// sends.
//
// A zone is not another room. A room is a floor with walls around it; a zone is an INSTRUCTION — this
// area holds desks, laid out this way — and the desks it made are ordinary items that stay in the model.
// That is why drawing one sends `item.arrange` rather than `zone.create`: the zone and its desks arrive
// together, as one entry in the history, so a single undo takes the whole cluster back.
//
// The count is worked out here rather than asked for. Someone dragging a box over a floor plate means
// "fill this", not "give me 37"; so the tool counts what fits with the real arrangement maths from the
// commands package — the same function the reducer will run — and asks for exactly that many.
import { arrangePlacements } from "@fpv/commands";
import { effectiveMagnetism, snapToPoints, WALL_END_PX } from "@fpv/geometry";
import type { Point, Size3, Wall } from "@fpv/ir";
import type { Placeable } from "./item-tool.js";
import { describeLength } from "./status.js";

/** The patterns a person can draw (spec 03; the rest arrive with the rules pack). */
export type ZonePattern = "rows" | "grid" | "bench";

export const ZONE_PATTERNS: readonly { value: ZonePattern; label: string }[] = [
  { value: "rows", label: "Rows" },
  { value: "grid", label: "Grid" },
  { value: "bench", label: "Bench" },
];

/** Under this, a drag is a click: too small to hold anything, and probably a mis-click. */
export const MIN_SIDE_MM = 300;

/**
 * The most a zone will ask for when it is told to fill itself. A desk cluster this big is already past
 * anything a floor plate holds, and without a ceiling a zero-spacing zone drawn over a whole site would
 * ask for hundreds of thousands of desks before anyone saw a number.
 */
export const FILL_CAP = 1000;

/** What a new zone lays out when the catalog tab has nothing picked: a plain 1600 x 800 desk. */
export const DEFAULT_PIECE: Placeable = {
  id: "recipe:table:rect:1600x800x750",
  name: "Desk",
  category: "table",
  size: { w: 1600, d: 800, h: 750 },
  ref: { kind: "recipe", recipe: { kind: "table", shape: "rect", size: { w: 1600, d: 800, h: 750 } } },
};

/** Facing south, as the agent's `arrange` tool also defaults, measured from north (F-100). */
export const DEFAULT_FACING_DEG = 180;
export const DEFAULT_SPACING_MM = 600;
export const DEFAULT_MARGIN_MM = 300;

export interface ZoneRule {
  pattern: ZonePattern;
  spacing: { x: number; y: number };
  facing: number;
  margin: number;
}

export const DEFAULT_RULE: ZoneRule = {
  pattern: "rows",
  spacing: { x: DEFAULT_SPACING_MM, y: DEFAULT_SPACING_MM },
  facing: DEFAULT_FACING_DEG,
  margin: DEFAULT_MARGIN_MM,
};

export interface ZoneToolOptions {
  levelId: string;
  /** What fills the zone, and the rule it is laid out by; read afresh on every aim. */
  piece(): Placeable;
  rule(): ZoneRule;
}

export interface ZoneAimOptions {
  walls: readonly Wall[];
  /** Millimetres per screen pixel, for snapping tolerances. */
  pixelMm: number;
  magnetism: boolean;
  altHeld?: boolean;
  /** A square rather than a rectangle. */
  shiftHeld?: boolean;
}

export interface ZoneAim {
  polygon: Point[];
  widthMm: number;
  depthMm: number;
  /** How many pieces fit, at the rule as it stands. */
  fits: number;
  snapNote: string;
  announcement: string;
}

export interface ArrangeCommand {
  type: "item.arrange";
  payload: {
    target: { levelId: string; polygon: Point[] } | { roomId: string };
    rule: {
      pattern: ZonePattern;
      productId: string | null;
      recipe: unknown;
      count: number;
      spacing: { x: number; y: number };
      facing: number;
      margin: number;
    };
    replace?: boolean;
  };
}

/** The four corners of the rectangle two opposite corners name, anticlockwise, in whole millimetres. */
export function rectPolygon(a: Point, b: Point): Point[] {
  const minX = Math.round(Math.min(a.x, b.x));
  const maxX = Math.round(Math.max(a.x, b.x));
  const minY = Math.round(Math.min(a.y, b.y));
  const maxY = Math.round(Math.max(a.y, b.y));
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

/**
 * How many pieces of this size the rule lays inside the polygon. The maths is the reducer's own, so the
 * number shown while dragging is the number that will arrive.
 */
export function fitCount(polygon: readonly Point[], rule: ZoneRule, size: Size3): number {
  if (polygon.length < 3) return 0;
  try {
    return arrangePlacements(polygon, { ...ruleBody(rule, FILL_CAP), productId: null, recipe: null }, size)
      .placements.length;
  } catch {
    // A pattern the phase-1 rules pack owns; nothing to show until it lands.
    return 0;
  }
}

function ruleBody(rule: ZoneRule, count: number) {
  return {
    pattern: rule.pattern,
    count: Math.max(1, count),
    spacing: { x: Math.max(0, Math.round(rule.spacing.x)), y: Math.max(0, Math.round(rule.spacing.y)) },
    facing: ((Math.round(rule.facing) % 360) + 360) % 360,
    margin: Math.max(0, Math.round(rule.margin)),
  };
}

/** The rule as a command carries it: the pattern and the piece together. */
export function ruleFor(rule: ZoneRule, piece: Placeable, count: number): ArrangeCommand["payload"]["rule"] {
  return {
    ...ruleBody(rule, count),
    productId: piece.ref.kind === "product" ? piece.ref.productId : null,
    recipe: piece.ref.kind === "recipe" ? piece.ref.recipe : null,
  };
}

export class ZoneTool {
  /** Where the drag began, snapped, or null when no drag is under way. */
  private anchor: Point | null = null;

  constructor(private readonly options: ZoneToolOptions) {}

  get drawing(): boolean {
    return this.anchor !== null;
  }

  get corner(): Point | null {
    return this.anchor;
  }

  /** Puts the first corner down. */
  begin(raw: Point, options: ZoneAimOptions): Point {
    const { point } = this.settle(raw, options, null);
    this.anchor = point;
    return point;
  }

  /**
   * The rectangle as it stands, and what it would hold. Nothing is changed; the pointer calls this on
   * every move.
   */
  aim(raw: Point, options: ZoneAimOptions): ZoneAim | null {
    const from = this.anchor;
    if (!from) return null;
    const { point, snapNote } = this.settle(raw, options, from);
    const polygon = rectPolygon(from, point);
    const widthMm = Math.abs(point.x - from.x);
    const depthMm = Math.abs(point.y - from.y);
    const fits = fitCount(polygon, this.options.rule(), this.options.piece().size);
    return {
      polygon,
      widthMm,
      depthMm,
      fits,
      snapNote,
      announcement: this.say(widthMm, depthMm, fits, snapNote),
    };
  }

  /**
   * Ends the drag. A rectangle too small to be meant, or one nothing fits in, makes no zone: an empty
   * zone is a thing on the plan that does nothing, and leaving one behind after a mis-click is worse
   * than doing nothing at all.
   */
  end(raw: Point, options: ZoneAimOptions): ArrangeCommand | null {
    const aimed = this.aim(raw, options);
    this.anchor = null;
    if (!aimed) return null;
    if (aimed.widthMm < MIN_SIDE_MM || aimed.depthMm < MIN_SIDE_MM) return null;
    if (aimed.fits < 1) return null;
    return this.command({ levelId: this.options.levelId, polygon: aimed.polygon }, aimed.fits);
  }

  /** Filling a room: the same cluster, over the room's own floor. */
  fillRoom(roomId: string, polygon: readonly Point[]): ArrangeCommand | null {
    const fits = fitCount(polygon, this.options.rule(), this.options.piece().size);
    if (fits < 1) return null;
    return this.command({ roomId }, fits);
  }

  cancel(): void {
    this.anchor = null;
  }

  private command(target: ArrangeCommand["payload"]["target"], count: number): ArrangeCommand {
    return {
      type: "item.arrange",
      payload: { target, rule: ruleFor(this.options.rule(), this.options.piece(), count) },
    };
  }

  /** Where a raw point lands: on a wall corner if one is near enough, or square with the first corner. */
  private settle(
    raw: Point,
    options: ZoneAimOptions,
    from: Point | null,
  ): { point: Point; snapNote: string } {
    const magnet = effectiveMagnetism(options.magnetism, options.altHeld ?? false);
    const tolerance = WALL_END_PX * options.pixelMm;
    const corner = magnet ? snapToPoints(raw, wallCorners(options.walls), tolerance) : null;
    if (corner)
      return { point: { x: Math.round(corner.x), y: Math.round(corner.y) }, snapNote: "wall corner" };
    if (from && options.shiftHeld) {
      // A square: the longer side wins, so the shape follows the pointer rather than shrinking under it.
      const side = Math.max(Math.abs(raw.x - from.x), Math.abs(raw.y - from.y));
      return {
        point: {
          x: Math.round(from.x + Math.sign(raw.x - from.x) * side),
          y: Math.round(from.y + Math.sign(raw.y - from.y) * side),
        },
        snapNote: "square",
      };
    }
    return { point: { x: Math.round(raw.x), y: Math.round(raw.y) }, snapNote: "" };
  }

  private say(widthMm: number, depthMm: number, fits: number, snapNote: string): string {
    const size = `${describeLength(widthMm)} by ${describeLength(depthMm)}`;
    const held = fits === 1 ? "1 piece" : `${fits} pieces`;
    const head = `Cluster ${size}, ${held}`;
    return snapNote ? `${head}, ${snapNote}.` : `${head}.`;
  }
}

/** Both ends of every wall: what a zone's corners should meet exactly, as a room's do. */
function wallCorners(walls: readonly Wall[]): Point[] {
  const out: Point[] = [];
  for (const w of walls) {
    out.push({ x: w.start.x, y: w.start.y });
    out.push({ x: w.end.x, y: w.end.y });
  }
  return out;
}

// Drawing a room (P3-2; ledger R-041, R-044, R-045, R-046, R-047). The rules live here, free of the DOM
// and of the canvas, so they can be tested: where the next corner lands, when the ring closes, what is
// said out loud, and the one room.create a finished ring emits.
//
// This is deliberately a sibling of wall-tool.ts rather than a second dialect. The gesture is the same
// shape — aim, place, seed, typedPoint, undoSegment, end — and it shares that file's geometry helpers and
// its Aim type, so snapping, the alignment guides and typed entry all behave identically in both tools.
// Where the two differ is only where a room differs from a chain: a ring needs three corners rather than
// two points, and it always closes.
import { effectiveMagnetism, magnetizePoint, snapToPoints, WALL_END_PX } from "@fpv/geometry";
import type { Point, Wall } from "@fpv/ir";
import { describeLength } from "./status.js";
import { type Aim, type AimOptions, angleOf, clampLength, type Guide, pointAt } from "./wall-tool.js";

/** R-041: under three corners there is no room to make. */
export const MIN_CORNERS = 3;

/** R-046: the first side with no pointer, 3000 mm along +x. The ledger's 300 cm in this project's units. */
export const FIRST_SIDE_MM = 3000;

export interface RoomCreateCommand {
  type: "room.create";
  payload: {
    levelId: string;
    /** A drawn room is always a polygon, never a rect: the reducer takes exactly one of the three, and
     *  a ring that happens to look rectangular is still a ring. */
    polygon: Point[];
    name?: string | null;
    purpose?: string;
  };
}

/** Filling an area the walls already enclose: the host detects it, so only the point travels. */
export interface RoomDetectCommand {
  type: "room.create";
  payload: { levelId: string; atPoint: Point };
}

export interface RoomToolOptions {
  levelId: string;
  purpose?: string;
}

export class RoomTool {
  readonly points: Point[] = [];
  private lastLength = 0;
  private lastAngle = 0;

  constructor(private readonly options: RoomToolOptions) {}

  get drawing(): boolean {
    return this.points.length > 0;
  }

  /** The corner the next side grows from. */
  get anchor(): Point | null {
    return this.points[this.points.length - 1] ?? null;
  }

  /** True once the ring has enough corners to be a room (R-041). */
  get closable(): boolean {
    return this.points.length >= MIN_CORNERS;
  }

  /**
   * Where a raw plan point would land, and what to say about it. Nothing is changed; the pointer calls
   * this on every move.
   *
   * Corner snapping uses the room's OWN corners as well as the walls', because a room is drawn inside or
   * against a structure that already exists and its corners should meet it exactly.
   */
  aim(raw: Point, options: AimOptions): Aim {
    const magnet = effectiveMagnetism(options.magnetism, options.altHeld ?? false);
    const tolerance = WALL_END_PX * options.pixelMm;
    const from = this.anchor;
    const first = this.points[0];

    // Back on the first corner with three already down: the ring closes (R-045).
    const closing = this.closable && magnet && !!first && distance(raw, first) <= tolerance;
    // Otherwise a wall corner within tolerance wins over angle magnetism, as it does for walls.
    const corner = magnet && !closing ? snapToPoints(raw, wallCorners(options.walls), tolerance) : null;

    let point: Point;
    let snap: Aim["snap"];
    let snapNote: string;
    const guides: Guide[] = [];
    if (closing && first) {
      point = { ...first };
      snap = "close";
      snapNote = "closing the room";
    } else if (corner) {
      point = { ...corner };
      snap = "free-end";
      snapNote = "snapped to a wall corner";
    } else if (from && magnet) {
      point = magnetizePoint(from, raw, options.pixelMm);
      snap = "angle";
      snapNote = "";
    } else {
      point = { x: raw.x, y: raw.y };
      snap = "none";
      snapNote = "";
    }

    // Whole millimetres, or the schema refuses the polygon and nothing is drawn (Polygon is an array of
    // integer Mm). Rounding here also makes the preview and the committed room the same shape.
    point = { x: Math.round(point.x), y: Math.round(point.y) };

    const lengthMm = from ? distance(from, point) : 0;
    const angleDeg = from ? angleOf(from, point) : 0;
    return {
      point,
      snap,
      snapNote,
      lengthMm,
      angleDeg,
      announcement: this.say(lengthMm, angleDeg, snapNote, snap === "close"),
      guides,
    };
  }

  /**
   * Confirms a corner. A side of no length adds no point (R-044), and landing back on the first corner
   * closes the ring (R-045).
   */
  place(raw: Point, options: AimOptions): { placed: boolean; closed: boolean; announcement: string } {
    const aimed = this.aim(raw, options);
    const from = this.anchor;
    // R-044: two clicks in the same place leave the ring as it was rather than storing a duplicate, which
    // would otherwise become a zero-length side in the committed polygon.
    if (from && distance(from, aimed.point) === 0)
      return { placed: false, closed: false, announcement: "That side would have no length." };
    if (aimed.snap === "close")
      return { placed: false, closed: true, announcement: `Room closed, ${this.points.length} corners.` };
    if (from) {
      this.lastLength = aimed.lengthMm;
      this.lastAngle = aimed.angleDeg;
    }
    this.points.push(aimed.point);
    return { placed: true, closed: false, announcement: aimed.announcement };
  }

  /**
   * What the typed length and angle boxes start at (R-046, R-047): the first side runs along +x at a
   * sensible length, and every side after it turns ninety degrees from the one before, at the same length,
   * which walks a rectangle without typing an angle at all.
   */
  seed(): { lengthMm: number; angleDeg: number } {
    if (!this.drawing || this.lastLength === 0) return { lengthMm: FIRST_SIDE_MM, angleDeg: 0 };
    // 270 flat: typedPoint reads this as a turn RELATIVE to the previous side, so an absolute bearing
    // would be applied on top of lastAngle and the ring would double back. See WallTool.seed.
    return { lengthMm: this.lastLength, angleDeg: 270 };
  }

  /** The corner a typed length and angle name; the angle is relative to the side before it. */
  typedPoint(lengthMm: number, angleDeg: number): Point | null {
    const from = this.anchor;
    if (!from) return null;
    const absolute = this.points.length >= 2 ? this.lastAngle + angleDeg : angleDeg;
    return pointAt(from, clampLength(lengthMm), ((absolute % 360) + 360) % 360);
  }

  /** Drops the last corner, so Ctrl+Z during a ring takes back one side. */
  undoSegment(): boolean {
    if (this.points.length === 0) return false;
    this.points.pop();
    return true;
  }

  /**
   * Ends the ring. Under three corners there is no room and nothing is emitted (R-041) — the corners are
   * discarded rather than committed as something smaller, because a two-point room is not a shape.
   */
  end(): RoomCreateCommand | null {
    const polygon = this.points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    this.points.length = 0;
    this.lastLength = 0;
    this.lastAngle = 0;
    if (polygon.length < MIN_CORNERS) return null;
    return {
      type: "room.create",
      payload: {
        levelId: this.options.levelId,
        polygon,
        ...(this.options.purpose !== undefined ? { purpose: this.options.purpose } : {}),
      },
    };
  }

  /** Filling an enclosure: the host runs the detection, so the tool only names the point (R-025, R-026). */
  detectAt(point: Point): RoomDetectCommand {
    return {
      type: "room.create",
      payload: {
        levelId: this.options.levelId,
        atPoint: { x: Math.round(point.x), y: Math.round(point.y) },
      },
    };
  }

  /** What a side reads as out loud: plain digits, which a screen reader says as a number. */
  private say(lengthMm: number, angleDeg: number, snapNote: string, closing: boolean): string {
    if (!this.drawing)
      return snapNote ? `Room start, ${snapNote}.` : "Room start. Click a corner, or click inside walls.";
    if (closing) return `Close the room, ${this.points.length} corners.`;
    const side = this.points.length; // the one about to be placed
    const head = `Side ${side}, ${describeLength(lengthMm)} at ${Math.round(angleDeg)} degrees`;
    return snapNote ? `${head}, ${snapNote}.` : `${head}.`;
  }
}

/** Both ends of every wall: what a room's corners should meet exactly. */
function wallCorners(walls: readonly Wall[]): Point[] {
  const out: Point[] = [];
  for (const w of walls) {
    out.push({ x: w.start.x, y: w.start.y });
    out.push({ x: w.end.x, y: w.end.y });
  }
  return out;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

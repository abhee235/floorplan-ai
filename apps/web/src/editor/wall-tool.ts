// Drawing a chain of walls (P3-1; ledger W-067..W-077, W-082, W-090). The rules live here, free of the
// DOM and of the canvas, so they can be tested: where the next point lands, what a snap caught, what is
// said out loud, and the one command the finished chain emits.
//
// Drawing by pointer and drawing by typing are the same gesture (ADR-017 D4): both end in `place`, and
// both read the same snapping preferences, which the modifier keys invert (W-082).
import {
  alignToAxesWithSources,
  effectiveMagnetism,
  intersectLines,
  magnetizePoint,
  SELECTION_PX,
  snapToFreeWallEnd,
  WALL_END_PX,
} from "@fpv/geometry";
import type { Point, Wall } from "@fpv/ir";
import { describeLength } from "./status.js";

/** Length clamp in millimetres (W-072); a wall may be neither nothing nor a kilometre by mistake. */
export const MIN_LENGTH_MM = 0.001;
export const MAX_LENGTH_MM = 1_000_000;

export interface AimOptions {
  /** Existing walls on this level, for snapping to their free ends. */
  walls: readonly Wall[];
  /** Millimetres per screen pixel, that is 1 / view.scale: tolerances are in pixels, not millimetres. */
  pixelMm: number;
  /** The snapping preference from the tool options bar. */
  magnetism: boolean;
  /** Alt bypasses snapping, inverting the preference (W-082). */
  altHeld?: boolean;
  /** Shift is the alignment modifier (W-082, ADR-017): angle magnetism only, no point snapping. */
  shiftHeld?: boolean;
}

export type SnapKind = "none" | "angle" | "free-end" | "close" | "align";

/**
 * A line worth drawing because the point lined up with something (R-053, R-054).
 *
 * `axis: "x"` means the point took its x from `to`, so the two share a vertical line and the guide is
 * drawn vertically between them. This is what makes a snap explainable: without the point it aligned
 * WITH, a guide is just a line appearing for no stated reason.
 */
export interface Guide {
  axis: "x" | "y";
  to: Point;
}

export interface Aim {
  /** Where the point would actually land. */
  point: Point;
  snap: SnapKind;
  /** What the snap caught, in words, or "" when it caught nothing. */
  snapNote: string;
  /** The segment being drawn; both are 0 for the very first point. */
  lengthMm: number;
  angleDeg: number;
  /** The whole sentence for the live region (ADR-017 D5). */
  announcement: string;
  /** Alignment lines to draw, at most one per axis. Empty when nothing lined up. */
  guides: Guide[];
}

export interface WallChainCommand {
  type: "wall.createChain";
  payload: {
    levelId: string;
    points: Point[];
    closed: boolean;
    thickness?: number;
    kind?: string;
  };
}

export interface WallToolOptions {
  levelId: string;
  thickness?: number;
  kind?: string;
}

/** Degrees 0..360 with +x at 0 and +y at 90; the plan's y axis points up. */
export function angleOf(from: Point, to: Point): number {
  const deg = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

export function pointAt(from: Point, lengthMm: number, angleDeg: number): Point {
  const a = (angleDeg * Math.PI) / 180;
  return { x: from.x + Math.cos(a) * lengthMm, y: from.y + Math.sin(a) * lengthMm };
}

export function clampLength(mm: number): number {
  return Math.min(MAX_LENGTH_MM, Math.max(MIN_LENGTH_MM, Math.abs(mm)));
}

export class WallTool {
  /** The points already confirmed, in order. */
  readonly points: Point[] = [];
  private closedLoop = false;
  /** The length and angle the last placed segment used, which seed the next one (W-074). */
  private lastLength = 0;
  private lastAngle = 0;

  constructor(private readonly options: WallToolOptions) {}

  get drawing(): boolean {
    return this.points.length > 0;
  }

  get closed(): boolean {
    return this.closedLoop;
  }

  /** The point already confirmed that the next segment grows from. */
  get anchor(): Point | null {
    return this.points[this.points.length - 1] ?? null;
  }

  /**
   * Where a raw plan point would land, and what to say about it. Nothing is changed; the pointer calls
   * this on every move and the result drives the preview, the status bar and the live region.
   */
  aim(raw: Point, options: AimOptions): Aim {
    const magnet = effectiveMagnetism(options.magnetism, options.altHeld ?? false);
    const tolerance = WALL_END_PX * options.pixelMm;
    const from = this.anchor;

    // A free end of an existing wall wins over angle magnetism (W-068, W-069).
    const freeEnd = magnet ? snapToFreeWallEnd(raw, options.walls, tolerance) : null;
    // Back at the first point with more than two walls drawn: the loop closes (W-070).
    const first = this.points[0];
    const canClose = this.points.length >= 3 && first !== undefined;
    const closing = canClose && magnet && distance(raw, first) <= tolerance;

    let point: Point;
    let snap: SnapKind;
    let snapNote: string;
    let guides: Guide[] = [];
    if (closing && first) {
      point = { ...first };
      snap = "close";
      snapNote = "closing the loop";
    } else if (freeEnd) {
      point = { ...freeEnd.point };
      snap = "free-end";
      snapNote = `snapped to the ${freeEnd.end} of wall ${freeEnd.wallId}`;
    } else if (from && magnet) {
      point = magnetizePoint(from, raw, options.pixelMm);
      snap = "angle";
      snapNote = "";
      // R-052: angle steps first, THEN x/y alignment with nearby wall points. Shift is the alignment
      // modifier and means angle magnetism ONLY, so it suppresses this (W-082).
      if (!options.shiftHeld) {
        const aligned = this.alignment(point, raw, from, options);
        if (aligned) {
          point = aligned.point;
          guides = aligned.guides;
          snap = "align";
          snapNote = aligned.note;
        }
      }
    } else {
      point = { x: raw.x, y: raw.y };
      snap = "none";
      snapNote = "";
    }

    // The IR keeps whole millimetres (Mm is an integer), so a fractional point is refused by the command
    // schema and nothing is drawn. Rounding here also makes the preview and the committed wall the same.
    point = { x: Math.round(point.x), y: Math.round(point.y) };

    const lengthMm = from ? distance(from, point) : 0;
    const angleDeg = from ? angleOf(from, point) : 0;
    return {
      point,
      snap,
      snapNote,
      lengthMm,
      angleDeg,
      announcement: this.say(lengthMm, angleDeg, snapNote),
      guides,
    };
  }

  /**
   * Axis alignment against nearby wall ends and the chain's own corners (R-053), landed on the
   * magnetised ray (R-054).
   *
   * R-054 is what stops alignment and angle magnetism fighting each other. Simply moving the point onto
   * the aligned coordinate would break the 15-degree angle the previous step just established; instead
   * the point becomes where the magnetised RAY crosses the aligned line, which keeps the angle exact and
   * the alignment exact at once. It is only accepted when that crossing is still within a margin of where
   * the pointer actually is, so a nearly-parallel ray cannot fling the point far away. The x branch is
   * tried first, as the ledger specifies.
   */
  private alignment(
    magnetised: Point,
    raw: Point,
    from: Point,
    options: AimOptions,
  ): { point: Point; guides: Guide[]; note: string } | null {
    // R-053's tolerance is the selection margin (4px), wider than the 2px a free wall end catches at.
    const margin = SELECTION_PX * options.pixelMm;
    const candidates = this.alignmentCandidates(options.walls);
    if (candidates.length === 0) return null;

    const found = alignToAxesWithSources(magnetised, candidates, margin);
    if (!found.x && !found.y) return null;

    // Two axes name one corner, and no other point satisfies both lines. Taking them in turn would slide
    // the point off the first line while putting it on the second, so the corner is accepted whole or not
    // at all — and only when the pointer is genuinely near it, never as a side effect of two loose hits.
    if (found.x && found.y) {
      const corner = { x: found.x.x, y: found.y.y };
      if (distance(corner, raw) <= margin)
        return {
          point: corner,
          guides: [
            { axis: "x", to: found.x },
            { axis: "y", to: found.y },
          ],
          note: "aligned on x and y",
        };
    }

    // One axis: the point is where the magnetised ray crosses the aligned line (R-054). x branch first.
    for (const axis of ["x", "y"] as const) {
      const source = axis === "x" ? found.x : found.y;
      if (!source) continue;
      const coord = axis === "x" ? source.x : source.y;
      const value = axis === "x" ? magnetised.x : magnetised.y;

      // Already on the line. A ray running parallel to it can never cross it, so intersectLines returns
      // null and the alignment would be thrown away — even though it is real. That case is not exotic:
      // it is a wall drawn straight up lining up with another corner's x, which is the commonest
      // alignment there is.
      if (Math.abs(value - coord) <= 0.5)
        return { point: magnetised, guides: [{ axis, to: source }], note: `aligned on ${axis}` };

      const a = axis === "x" ? { x: coord, y: 0 } : { x: 0, y: coord };
      const b = axis === "x" ? { x: coord, y: 1000 } : { x: 1000, y: coord };
      const onRay = intersectLines(from, magnetised, a, b);
      // Within a margin of where the pointer actually is (R-054): a shallow crossing can otherwise fling
      // the point a long way down the ray for a tiny alignment.
      if (onRay && distance(onRay, raw) <= margin)
        return { point: onRay, guides: [{ axis, to: source }], note: `aligned on ${axis}` };
    }
    return null;
  }

  /** Wall ends on this level, plus the corners already placed in this chain — but never the anchor. */
  private alignmentCandidates(walls: readonly Wall[]): Point[] {
    const out: Point[] = [];
    for (const w of walls) {
      out.push({ x: w.start.x, y: w.start.y });
      out.push({ x: w.end.x, y: w.end.y });
    }
    // The chain's own corners count: lining a new wall up with one drawn a moment ago is the commonest
    // case of all, and it is not in `walls` until the chain is committed.
    //
    // slice(0, -1) drops the ANCHOR, and that is not a detail. Angle magnetism puts a horizontal segment
    // at exactly the anchor's y and a vertical one at exactly its x, so the anchor would satisfy the
    // alignment test on nearly every stroke — and the tool would draw a guide from the wall back to the
    // point it is already growing out of, saying nothing, on almost every move.
    for (const p of this.points.slice(0, -1)) out.push({ x: p.x, y: p.y });
    return out;
  }

  /** What a segment reads as out loud: plain digits, which a screen reader says as a number. */
  private say(lengthMm: number, angleDeg: number, snapNote: string): string {
    // before the chain starts there is no segment to report, but a start snap is worth hearing (W-068)
    if (!this.drawing)
      return snapNote ? `Wall start, ${snapNote}.` : "Wall start. Click or type a length to draw.";
    const segment = this.points.length; // the one about to be placed
    const head = `Wall ${segment}, ${describeLength(lengthMm)} at ${Math.round(angleDeg)} degrees`;
    return snapNote ? `${head}, ${snapNote}.` : `${head}.`;
  }

  /**
   * Confirms a point. A segment of no length is never committed (W-067), and landing back on the first
   * point closes the chain (W-070).
   */
  place(raw: Point, options: AimOptions): { placed: boolean; closed: boolean; announcement: string } {
    const aimed = this.aim(raw, options);
    const from = this.anchor;
    if (from && distance(from, aimed.point) === 0)
      return { placed: false, closed: false, announcement: "That wall would have no length." };
    if (aimed.snap === "close") {
      this.closedLoop = true;
      return { placed: false, closed: true, announcement: `Loop closed, ${this.points.length} walls.` };
    }
    if (from) {
      this.lastLength = aimed.lengthMm;
      this.lastAngle = aimed.angleDeg;
    }
    this.points.push(aimed.point);
    return { placed: true, closed: false, announcement: aimed.announcement };
  }

  /**
   * What the typed length and angle boxes should start at (W-073, W-074): the first wall runs along +x at
   * a sensible length, and every wall after it is seeded square to the one before, at the same length.
   */
  seed(): { lengthMm: number; angleDeg: number } {
    if (!this.drawing || this.lastLength === 0) return { lengthMm: 3000, angleDeg: 0 };
    // 270 flat, NOT lastAngle - 90. What seed offers is fed straight back into typedPoint, and typedPoint
    // reads an angle as RELATIVE to the previous wall once there are two points (W-076). Returning an
    // absolute bearing here meant the turn was applied twice: after a wall at 270 the seed offered 180,
    // typedPoint computed 270 + 180 = 90, and the next wall doubled back along the one before it.
    //
    // The first side hides this, which is why it survived: lastAngle is 0 there, so 0 - 90 and the
    // relative 270 are the same number. Only the third side and beyond go wrong.
    return { lengthMm: this.lastLength, angleDeg: 270 };
  }

  /**
   * The point a typed length and angle name. The angle is RELATIVE to the wall before it, and absolute
   * for the first wall of the chain (W-076); the length is clamped (W-072).
   */
  typedPoint(lengthMm: number, angleDeg: number): Point | null {
    const from = this.anchor;
    if (!from) return null;
    const absolute = this.points.length >= 2 ? this.lastAngle + angleDeg : angleDeg;
    return pointAt(from, clampLength(lengthMm), ((absolute % 360) + 360) % 360);
  }

  /** Drops the last confirmed point, so Ctrl+Z during a chain takes back one segment. */
  undoSegment(): boolean {
    if (this.points.length === 0) return false;
    this.points.pop();
    this.closedLoop = false;
    return true;
  }

  /**
   * Ends the chain. Escape keeps the walls already drawn rather than rolling them back (W-090); a chain
   * of fewer than two points has nothing to commit and returns null.
   */
  end(): WallChainCommand | null {
    const points = this.points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    const closed = this.closedLoop;
    this.points.length = 0;
    this.closedLoop = false;
    this.lastLength = 0;
    this.lastAngle = 0;
    if (points.length < 2) return null;
    if (closed && points.length < 3) return null;
    return {
      type: "wall.createChain",
      payload: {
        levelId: this.options.levelId,
        points,
        closed,
        // a thickness typed into the options bar has to be a whole millimetre of at least one, too
        ...(this.options.thickness !== undefined
          ? { thickness: Math.max(1, Math.round(this.options.thickness)) }
          : {}),
        ...(this.options.kind !== undefined ? { kind: this.options.kind } : {}),
      },
    };
  }
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

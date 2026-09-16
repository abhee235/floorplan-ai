// Magnetism helpers (ADR-016 D3; ledger W-077..W-083, R-050..R-055). Pixel sizes are in mm per pixel.
import type { Point, Wall } from "@fpv/ir";
import { normalizeDeg } from "@fpv/ir";
import { distance } from "./lines.js";

export const ANGLE_STEPS = 24; // 15 degree steps (W-077, R-052)
export const SELECTION_PX = 4; // W-080, R-050
export const INDICATOR_PX = 5;
export const WALL_END_PX = 2; // W-068, W-069

/**
 * Length precision by twice the pixel size (W-078 in mm): above 1000 round to 1000, above 100 to 100,
 * above 50 to 50, above 10 to 10, above 5 to 5, else 1. A positive length never rounds to zero.
 */
export function magnetizedLength(length: number, pixelMm: number): number {
  const d = 2 * pixelMm;
  const step = d > 1000 ? 1000 : d > 100 ? 100 : d > 50 ? 50 : d > 10 ? 10 : d > 5 ? 5 : 1;
  const rounded = Math.round(length / step) * step;
  return rounded === 0 && length > 0 ? length : rounded;
}

/** Snap the direction from `from` to `to` onto the nearest of ANGLE_STEPS rays and round the length. */
export function magnetizePoint(from: Point, to: Point, pixelMm: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: to.x, y: to.y };
  const stepDeg = 360 / ANGLE_STEPS;
  const angle = normalizeDeg((Math.atan2(dy, dx) * 180) / Math.PI);
  const exactAxis = dx === 0 || dy === 0; // W-077: exact horizontal or vertical skips the angle step
  const snappedAngle = exactAxis ? angle : Math.round(angle / stepDeg) * stepDeg;
  const snappedLen = magnetizedLength(len, pixelMm);
  const a = (snappedAngle * Math.PI) / 180;
  return { x: from.x + Math.cos(a) * snappedLen, y: from.y + Math.sin(a) * snappedLen };
}

export interface FreeEnd {
  wallId: string;
  end: "start" | "end";
  point: Point;
}

/** Free wall ends (no join) on the given walls. */
export function freeWallEnds(walls: readonly Wall[]): FreeEnd[] {
  const out: FreeEnd[] = [];
  for (const w of walls) {
    if (!w.joins.start) out.push({ wallId: w.id, end: "start", point: w.start });
    if (!w.joins.end) out.push({ wallId: w.id, end: "end", point: w.end });
  }
  return out;
}

/** Nearest free wall end within tolerance, or null (W-068, W-069). */
export function snapToFreeWallEnd(
  p: Point,
  walls: readonly Wall[],
  toleranceMm: number,
  exclude?: string,
): FreeEnd | null {
  let best: FreeEnd | null = null;
  let bestD = toleranceMm;
  for (const e of freeWallEnds(walls)) {
    if (exclude && e.wallId === exclude) continue;
    const d = distance(p, e.point);
    if (d <= bestD) {
      best = e;
      bestD = d;
    }
  }
  return best;
}

/** Nearest candidate point within tolerance (Euclidean), or null (W-080, R-051). */
export function snapToPoints(p: Point, candidates: readonly Point[], toleranceMm: number): Point | null {
  let best: Point | null = null;
  let bestD = toleranceMm;
  for (const c of candidates) {
    const d = distance(p, c);
    if (d <= bestD) {
      best = c;
      bestD = d;
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

/** Align x and y independently to nearby candidate coordinates within tolerance (R-053). */
export function alignToAxes(p: Point, candidates: readonly Point[], toleranceMm: number): Point {
  const found = alignToAxesWithSources(p, candidates, toleranceMm);
  return found.point;
}

/**
 * What an axis alignment locked onto, per axis. `x` is the candidate whose x this point took, so the
 * guide to draw for it is VERTICAL; `y` is the candidate whose y it took, and its guide is horizontal.
 */
export interface AxisAlignment {
  point: Point;
  x: Point | null;
  y: Point | null;
}

/**
 * alignToAxes, but reporting which candidate won each axis (R-053).
 *
 * The plain version throws that away, which is fine for moving a point and useless for drawing a guide:
 * a guide line has to reach from the aligned point back to the thing it aligned WITH, or it says nothing
 * about why the point moved. Kept as a separate function so R-053's own contract and test stay exactly
 * as they were.
 */
export function alignToAxesWithSources(
  p: Point,
  candidates: readonly Point[],
  toleranceMm: number,
): AxisAlignment {
  let x = p.x;
  let y = p.y;
  let bx = toleranceMm;
  let by = toleranceMm;
  let sourceX: Point | null = null;
  let sourceY: Point | null = null;
  for (const c of candidates) {
    const dx = Math.abs(c.x - p.x);
    const dy = Math.abs(c.y - p.y);
    if (dx < bx) {
      bx = dx;
      x = c.x;
      sourceX = c;
    }
    if (dy < by) {
      by = dy;
      y = c.y;
      sourceY = c;
    }
  }
  return { point: { x, y }, x: sourceX, y: sourceY };
}

/** Effective magnetism is the preference XOR the held modifier (W-082, F-078). */
export function effectiveMagnetism(preference: boolean, modifierHeld: boolean): boolean {
  return preference !== modifierHeld;
}

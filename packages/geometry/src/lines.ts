// Line and segment helpers with the tolerances of spec 05.
import type { Point } from "@fpv/ir";
import { poly } from "@fpv/ir";
import { TOL } from "./tolerances.js";

export const { distancePointSegment, projectOntoSegment } = poly;

export function angleBetweenDeg(d1: Point, d2: Point): number {
  const l1 = Math.hypot(d1.x, d1.y);
  const l2 = Math.hypot(d2.x, d2.y);
  if (l1 === 0 || l2 === 0) return 0;
  const cos = Math.min(1, Math.max(-1, (d1.x * d2.x + d1.y * d2.y) / (l1 * l2)));
  return (Math.acos(Math.abs(cos)) * 180) / Math.PI; // 0 for parallel or anti-parallel
}

/**
 * Intersection of the infinite lines through (p1, p2) and (p3, p4).
 * Returns null when the lines are parallel within TOL.PARALLEL_DEG or the slope ratio test
 * (W-022, W-023, W-024; F-196 reversed: near-parallel returns null rather than a far point).
 */
export function intersectLines(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const d1 = { x: p2.x - p1.x, y: p2.y - p1.y };
  const d2 = { x: p4.x - p3.x, y: p4.y - p3.y };
  if (angleBetweenDeg(d1, d2) <= TOL.PARALLEL_DEG) return null;
  const s1 = d1.x === 0 ? Number.POSITIVE_INFINITY : d1.y / d1.x;
  const s2 = d2.x === 0 ? Number.POSITIVE_INFINITY : d2.y / d2.x;
  if (Number.isFinite(s1) && Number.isFinite(s2) && Math.sign(s1) === Math.sign(s2) && s1 !== 0 && s2 !== 0) {
    const ratio = Math.max(Math.abs(s1), Math.abs(s2)) / Math.min(Math.abs(s1), Math.abs(s2));
    if (ratio <= 1 + TOL.PARALLEL_RATIO) return null;
  }
  const den = d1.x * d2.y - d1.y * d2.x;
  if (den === 0) return null;
  const t = ((p3.x - p1.x) * d2.y - (p3.y - p1.y) * d2.x) / den;
  return { x: p1.x + t * d1.x, y: p1.y + t * d1.y };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function roundTo(v: number, step: number): number {
  return Math.round(v / step) * step;
}

/** Round a point to the weld tolerance so welded corners compare equal. */
export function weld(p: Point): Point {
  return { x: roundTo(p.x, TOL.WELD), y: roundTo(p.y, TOL.WELD) };
}

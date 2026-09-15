// Arc wall tessellation (ADR-014 D4, ledger W-048..W-059).
import type { Point, Wall } from "@fpv/ir";
import { derive } from "@fpv/ir";
import { TOL } from "./tolerances.js";

export interface ArcTessellation {
  /** Points on the left side from start to end. */
  left: Point[];
  /** Points on the right side from start to end (callers reverse for the footprint contract). */
  right: Point[];
  centre: Point;
  radius: number;
  segments: number;
}

/**
 * Segment count: ceil(sqrt(outer arc length in mm / 10)), at least ARC_MIN_SEGMENTS, so
 * segments are equal (W-052, W-053 adapted to mm).
 */
export function arcSegmentCount(outerArcLengthMm: number): number {
  return Math.max(TOL.ARC_MIN_SEGMENTS, Math.ceil(Math.sqrt(outerArcLengthMm / 10)));
}

/** Tessellate an arc wall; returns null for straight or zero-length walls. */
export function tessellateArc(w: Wall): ArcTessellation | null {
  const p = derive.arcParams(w);
  if (!p) return null;
  const extent = w.arcExtent as number;
  const outerR = p.radius + w.thickness / 2;
  const innerR = Math.max(0, p.radius - w.thickness / 2); // W-056 clamp
  const outerArcLength = (Math.abs(extent) * Math.PI * outerR) / 180;
  const n = arcSegmentCount(outerArcLength);
  // Positive extent bulges to the left of the chord and sweeps clockwise around the centre (derive.arcParams).
  const a0 = Math.atan2(w.start.y - p.centre.y, w.start.x - p.centre.x);
  const sweep = (-extent * Math.PI) / 180;
  const ring = (r: number): Point[] => {
    const pts: Point[] = [];
    for (let i = 0; i <= n; i += 1) {
      const a = a0 + (sweep * i) / n;
      pts.push({ x: p.centre.x + r * Math.cos(a), y: p.centre.y + r * Math.sin(a) });
    }
    return pts;
  };
  // W-055: the outer (convex) side is the left side when the extent is positive.
  const leftR = extent > 0 ? outerR : innerR;
  const rightR = extent > 0 ? innerR : outerR;
  return { left: ring(leftR), right: ring(rightR), centre: p.centre, radius: p.radius, segments: n };
}

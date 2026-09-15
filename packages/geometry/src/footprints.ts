// Wall footprints with the symmetric join pass (ADR-014 D2, D3; ledger W-001..W-028).
// Index contract (W-003): for a footprint of 2n points, indices 0..n-1 are the left side from start to end,
// n..2n-1 are the right side from end back to start. So 0 = left-start, n-1 = left-end, n = right-end, 2n-1 = right-start.
import type { Point, Wall } from "@fpv/ir";
import { derive } from "@fpv/ir";
import { tessellateArc } from "./arcs.js";
import { distance, intersectLines, weld } from "./lines.js";
import { TOL } from "./tolerances.js";

export type WallEnd = "start" | "end";

/** Footprint before joins: straight walls give 4 points, arc walls 2(n+1). */
export function wallFootprintUnjoined(w: Wall): Point[] {
  const arc = tessellateArc(w);
  if (!arc) return derive.wallFootprintUnjoined(w);
  return [...arc.left, ...[...arc.right].reverse()];
}

export interface CornerRef {
  /** Index into the footprint of the corner point. */
  index: number;
  /** Index of the adjacent point along the same side, defining the side line at that corner. */
  adjacent: number;
}

/** Corner and adjacent indices for a wall end and side. */
export function cornerRef(pointCount: number, end: WallEnd, side: "left" | "right"): CornerRef {
  const n = pointCount / 2;
  if (side === "left") return end === "start" ? { index: 0, adjacent: 1 } : { index: n - 1, adjacent: n - 2 };
  return end === "end" ? { index: n, adjacent: n + 1 } : { index: 2 * n - 1, adjacent: 2 * n - 2 };
}

interface JoinPair {
  a: Wall;
  aEnd: WallEnd;
  b: Wall;
  bEnd: WallEnd;
}

/** Each physical join once, regardless of which wall lists it. */
function collectJoins(walls: readonly Wall[]): JoinPair[] {
  const byId = new Map(walls.map((w) => [w.id, w]));
  const seen = new Set<string>();
  const pairs: JoinPair[] = [];
  for (const a of walls) {
    for (const aEnd of ["start", "end"] as const) {
      const j = a.joins[aEnd];
      if (!j || j.wallId === a.id) continue;
      const b = byId.get(j.wallId);
      if (!b) continue;
      const key = [`${a.id}:${aEnd}`, `${b.id}:${j.end}`].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a, aEnd, b, bEnd: j.end });
    }
  }
  return pairs;
}

/**
 * Side pairing (W-019, W-020): head-to-tail pairs left with left and right with right;
 * head-to-head or tail-to-tail pairs left with right.
 */
function pairedSide(aEnd: WallEnd, bEnd: WallEnd, aSide: "left" | "right"): "left" | "right" {
  const headToTail = aEnd !== bEnd;
  if (headToTail) return aSide;
  return aSide === "left" ? "right" : "left";
}

/**
 * Compute footprints for a set of walls, resolving every join in one symmetric pass:
 * both walls of a join receive the same welded corner, so the result does not depend on
 * evaluation order (W-028 reversed). Intersections beyond the clamp or between near-parallel
 * side lines leave the unmitred corners (W-021..W-025).
 */
export function wallFootprints(walls: readonly Wall[]): Map<string, Point[]> {
  const out = new Map<string, Point[]>();
  for (const w of walls) out.set(w.id, wallFootprintUnjoined(w));
  for (const { a, aEnd, b, bEnd } of collectJoins(walls)) {
    const fa = out.get(a.id);
    const fb = out.get(b.id);
    if (!fa || !fb || fa.length < 4 || fb.length < 4) continue;
    const clamp = TOL.CLAMP_FACTOR * Math.max(a.thickness, b.thickness);
    for (const aSide of ["left", "right"] as const) {
      const bSide = pairedSide(aEnd, bEnd, aSide);
      const ca = cornerRef(fa.length, aEnd, aSide);
      const cb = cornerRef(fb.length, bEnd, bSide);
      const pa = fa[ca.index] as Point;
      const qa = fa[ca.adjacent] as Point;
      const pb = fb[cb.index] as Point;
      const qb = fb[cb.adjacent] as Point;
      const x = intersectLines(pa, qa, pb, qb);
      if (!x) continue; // parallel or near-parallel: butt ends stay (W-023..W-025)
      if (distance(x, pa) > clamp || distance(x, pb) > clamp) continue; // W-021
      const shared = weld(x); // W-027: identical coordinates on both walls
      fa[ca.index] = shared;
      fb[cb.index] = { ...shared };
    }
  }
  return out;
}

/** Half-thickness slab for one side: the side's outline plus the centreline (W-106). */
export function wallSidePolygon(footprint: readonly Point[], side: "left" | "right"): Point[] {
  const n = footprint.length / 2;
  const left = footprint.slice(0, n);
  const right = footprint.slice(n).reverse(); // start to end
  const centre: Point[] = left.map((l, i) => {
    const r = right[i] as Point;
    return { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
  });
  return side === "left" ? [...left, ...[...centre].reverse()] : [...centre, ...[...right].reverse()];
}

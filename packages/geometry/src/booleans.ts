// Polygon booleans and morphology over polygon-clipping (MIT). Rings are plan millimetres, y up.
// All coordinates handed to polygon-clipping are rounded to 0.01 mm so coincident edges compare
// exactly; its sweep line is not robust to nearly-coincident floats.
import type { Point } from "@fpv/ir";
import { poly } from "@fpv/ir";
import polygonClipping, {
  type MultiPolygon as PcMultiPolygon,
  type Polygon as PcPolygon,
  type Ring as PcRing,
} from "polygon-clipping";
import { TOL } from "./tolerances.js";

/** A polygon with holes: outer counter-clockwise, holes clockwise. */
export interface PolyWithHoles {
  outer: Point[];
  holes: Point[][];
}
export type MultiPoly = PolyWithHoles[];

const GRID = 100; // 0.01 mm

export function snapGrid(v: number): number {
  return Math.round(v * GRID) / GRID;
}

function toPcRing(ring: readonly Point[]): PcRing {
  return ring.map((p) => [snapGrid(p.x), snapGrid(p.y)] as [number, number]);
}

function toPc(mp: MultiPoly): PcMultiPolygon {
  return mp.map((p): PcPolygon => [toPcRing(p.outer), ...p.holes.map(toPcRing)]);
}

function fromPcRing(ring: PcRing): Point[] {
  return poly.dedupe(ring.map(([x, y]) => ({ x: snapGrid(x), y: snapGrid(y) })));
}

function fromPc(mp: PcMultiPolygon): MultiPoly {
  const out: MultiPoly = [];
  for (const polygon of mp) {
    const [outerRing, ...holeRings] = polygon;
    if (!outerRing) continue;
    let outer = fromPcRing(outerRing);
    if (outer.length < 3) continue;
    if (poly.isClockwise(outer)) outer = poly.reversed(outer);
    const holes = holeRings
      .map(fromPcRing)
      .filter((h) => h.length >= 3)
      .map((h) => (poly.isCounterClockwise(h) ? poly.reversed(h) : h));
    out.push({ outer, holes });
  }
  return out;
}

export function ringToMulti(ring: readonly Point[]): MultiPoly {
  const r = poly.dedupe(ring);
  return r.length >= 3 ? [{ outer: poly.isClockwise(r) ? poly.reversed(r) : r, holes: [] }] : [];
}

export function union(...inputs: MultiPoly[]): MultiPoly {
  const geoms = inputs.filter((g) => g.length > 0).map(toPc);
  if (geoms.length === 0) return [];
  const [first, ...rest] = geoms as [PcMultiPolygon, ...PcMultiPolygon[]];
  return fromPc(polygonClipping.union(first, ...rest));
}

export function unionRings(rings: readonly (readonly Point[])[]): MultiPoly {
  return union(...rings.map(ringToMulti));
}

export function difference(a: MultiPoly, ...subtract: MultiPoly[]): MultiPoly {
  if (a.length === 0) return [];
  const geoms = subtract.filter((g) => g.length > 0).map(toPc);
  if (geoms.length === 0) return a;
  return fromPc(polygonClipping.difference(toPc(a), ...geoms));
}

export function intersection(a: MultiPoly, b: MultiPoly): MultiPoly {
  if (a.length === 0 || b.length === 0) return [];
  return fromPc(polygonClipping.intersection(toPc(a), toPc(b)));
}

export function multiArea(mp: MultiPoly): number {
  let a = 0;
  for (const p of mp) {
    a += poly.area(p.outer);
    for (const h of p.holes) a -= poly.area(h);
  }
  return a;
}

/** Overlap area of two rings via boolean intersection (works for concave rings). */
export function overlapArea(a: readonly Point[], b: readonly Point[]): number {
  return multiArea(intersection(ringToMulti(a), ringToMulti(b)));
}

export function multiBounds(mp: MultiPoly): poly.Rect | null {
  const pts = mp.flatMap((p) => p.outer);
  return pts.length ? poly.bounds(pts) : null;
}

/** Interior rings (holes) of a multipolygon as counter-clockwise rings: the enclosures of a wall union. */
export function interiorRings(mp: MultiPoly): Point[][] {
  return mp.flatMap((p) => p.holes.map((h) => poly.reversed(h)));
}

/** Axis-aligned square of half-size r around a point (the structuring element). */
function squareAt(c: Point, r: number): Point[] {
  return [
    { x: c.x - r, y: c.y - r },
    { x: c.x + r, y: c.y - r },
    { x: c.x + r, y: c.y + r },
    { x: c.x - r, y: c.y + r },
  ];
}

/** Rectangle of half-width r around edge ab, extended by r beyond both ends. */
function edgeBox(a: Point, b: Point, r: number): Point[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len === 0) return [];
  const dx = ((b.x - a.x) / len) * r;
  const dy = ((b.y - a.y) / len) * r;
  const nx = -dy;
  const ny = dx;
  return [
    { x: a.x - dx + nx, y: a.y - dy + ny },
    { x: b.x + dx + nx, y: b.y + dy + ny },
    { x: b.x + dx - nx, y: b.y + dy - ny },
    { x: a.x - dx - nx, y: a.y - dy - ny },
  ];
}

/**
 * Dilate every ring by r using a square structuring element: the union of the polygon, a box
 * around every edge and a square around every vertex. Exact for axis-aligned geometry, which is
 * what walls mostly are; diagonal edges get square-shaped caps.
 */
export function dilate(mp: MultiPoly, r: number): MultiPoly {
  if (r <= 0) return mp;
  const parts: MultiPoly[] = [mp];
  for (const p of mp) {
    for (const ring of [p.outer, ...p.holes]) {
      const n = ring.length;
      for (let i = 0; i < n; i += 1) {
        const a = ring[i] as Point;
        const b = ring[(i + 1) % n] as Point;
        parts.push(ringToMulti(edgeBox(a, b, r)));
        parts.push(ringToMulti(squareAt(a, r)));
      }
    }
  }
  return union(...parts);
}

/** Erode by r: complement, dilate, complement, inside a padded bounding box. */
export function erode(mp: MultiPoly, r: number): MultiPoly {
  if (r <= 0) return mp;
  const b = multiBounds(mp);
  if (!b) return [];
  const pad = r * 4 + 10;
  const box = ringToMulti([
    { x: b.minX - pad, y: b.minY - pad },
    { x: b.maxX + pad, y: b.minY - pad },
    { x: b.maxX + pad, y: b.maxY + pad },
    { x: b.minX - pad, y: b.maxY + pad },
  ]);
  const complement = difference(box, mp);
  const grown = dilate(complement, r);
  return difference(box, grown);
}

/** Morphological close: dilate then erode. Fills gaps narrower than 2r (ADR-016 D1 step 2). */
export function close(mp: MultiPoly, gap: number): MultiPoly {
  const g = Math.min(Math.max(0, gap), TOL.GAP_CLOSE_MAX);
  if (g === 0) return mp;
  return erode(dilate(mp, g), g);
}

/** Douglas-Peucker simplification of a closed ring within `tolerance`, keeping at least 3 points. */
export function flattenRing(ring: readonly Point[], tolerance: number): Point[] {
  const pts = poly.dedupe(ring);
  if (pts.length <= 3 || tolerance <= 0) return pts;
  const keep = new Array<boolean>(pts.length).fill(false);
  // split the ring at its two farthest-apart points so the closed shape simplifies correctly
  let far = 0;
  let farD = -1;
  const first = pts[0] as Point;
  for (let i = 1; i < pts.length; i += 1) {
    const q = pts[i] as Point;
    const d = Math.hypot(q.x - first.x, q.y - first.y);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  keep[0] = true;
  keep[far] = true;
  const mark = (i0: number, i1: number) => {
    const stack: [number, number][] = [[i0, i1]];
    while (stack.length) {
      const [s, e] = stack.pop() as [number, number];
      let maxD = -1;
      let idx = -1;
      const a = pts[s] as Point;
      const b = pts[e % pts.length] as Point;
      for (let i = s + 1; i < e; i += 1) {
        const d = poly.distancePointSegment(pts[i] as Point, a, b);
        if (d > maxD) {
          maxD = d;
          idx = i;
        }
      }
      if (maxD > tolerance && idx > 0) {
        keep[idx] = true;
        stack.push([s, idx], [idx, e]);
      }
    }
  };
  mark(0, far);
  mark(far, pts.length); // wraps back to index 0 through the closing edge
  const out = pts.filter((_, i) => keep[i]);
  return out.length >= 3 ? out : pts;
}

/** Drop edges shorter than minEdge (TOL.DEGENERATE by default). */
export function dropShortEdges(ring: readonly Point[], minEdge = TOL.DEGENERATE): Point[] {
  const out: Point[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < minEdge) continue;
    out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first && last && Math.hypot(first.x - last.x, first.y - last.y) < minEdge) out.pop();
  return out;
}

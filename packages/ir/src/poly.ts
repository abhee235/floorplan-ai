// Small polygon utilities the IR needs for validation and derived values.
// Coordinates are plan millimetres, y up. Counter-clockwise has positive signed area.
// The geometry package re-exports these and adds booleans, offsets and detection.
import type { Point } from "./schema.js";

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Shoelace signed area; positive for counter-clockwise rings (R-004). */
export function signedArea(points: readonly Point[]): number {
  let sum = 0;
  const n = points.length;
  for (let i = 0; i < n; i += 1) {
    const a = points[i] as Point;
    const b = points[(i + 1) % n] as Point;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

export function area(points: readonly Point[]): number {
  return Math.abs(signedArea(points));
}

/** True when the signed area is strictly positive (R-005: zero-area rings are neither). */
export function isCounterClockwise(points: readonly Point[]): boolean {
  return signedArea(points) > 0;
}

export function isClockwise(points: readonly Point[]): boolean {
  return signedArea(points) < 0;
}

export function perimeter(points: readonly Point[]): number {
  let sum = 0;
  const n = points.length;
  for (let i = 0; i < n; i += 1) {
    const a = points[i] as Point;
    const b = points[(i + 1) % n] as Point;
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}

export function bounds(points: readonly Point[]): Rect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/** Remove consecutive duplicate points and a trailing point equal to the first (R-011, P-066 style). */
export function dedupe(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push({ x: p.x, y: p.y });
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first && last && first.x === last.x && first.y === last.y) out.pop();
  return out;
}

export function reversed(points: readonly Point[]): Point[] {
  return [...points].reverse().map((p) => ({ x: p.x, y: p.y }));
}

export function translate(points: readonly Point[], dx: number, dy: number): Point[] {
  return points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

function orient(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return (
    Math.min(a.x, b.x) <= p.x &&
    p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y &&
    p.y <= Math.max(a.y, b.y)
  );
}

/** Proper or touching intersection of segments ab and cd. */
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}

/**
 * A ring is simple when it has at least three distinct points, no zero-length edges,
 * and no two non-adjacent edges intersect or touch (R-150 reversed: we reject non-simple rings).
 */
export function isSimple(points: readonly Point[]): boolean {
  const pts = dedupe(points);
  const n = pts.length;
  if (n < 3) return false;
  if (area(pts) === 0) return false;
  for (let i = 0; i < n; i += 1) {
    const a = pts[i] as Point;
    const b = pts[(i + 1) % n] as Point;
    for (let j = i + 1; j < n; j += 1) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // adjacent edges share a vertex
      const c = pts[j] as Point;
      const d = pts[(j + 1) % n] as Point;
      if (segmentsIntersect(a, b, c, d)) return false;
    }
  }
  return true;
}

/** Ray casting containment; points exactly on an edge count as inside. */
export function containsPoint(points: readonly Point[], p: Point): boolean {
  const n = points.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const a = points[i] as Point;
    const b = points[j] as Point;
    if (orient(a, b, p) === 0 && onSegment(a, b, p)) return true;
    if (a.y > p.y !== b.y > p.y) {
      const x = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < x) inside = !inside;
    }
  }
  return inside;
}

/** Containment with a margin: a square of side 2*margin centred on p must intersect the ring (R-017, F-018). */
export function containsPointWithMargin(points: readonly Point[], p: Point, margin: number): boolean {
  if (margin <= 0) return containsPoint(points, p);
  const box: Point[] = [
    { x: p.x - margin, y: p.y - margin },
    { x: p.x + margin, y: p.y - margin },
    { x: p.x + margin, y: p.y + margin },
    { x: p.x - margin, y: p.y + margin },
  ];
  return polygonsIntersect(points, box);
}

/** True when the rings overlap, touch, or one contains the other. */
export function polygonsIntersect(a: readonly Point[], b: readonly Point[]): boolean {
  if (!rectsIntersect(bounds(a), bounds(b))) return false;
  const first = a[0];
  const second = b[0];
  if (first && containsPoint(b, first)) return true;
  if (second && containsPoint(a, second)) return true;
  const n = a.length;
  const m = b.length;
  for (let i = 0; i < n; i += 1) {
    const p1 = a[i] as Point;
    const p2 = a[(i + 1) % n] as Point;
    for (let j = 0; j < m; j += 1) {
      if (segmentsIntersect(p1, p2, b[j] as Point, b[(j + 1) % m] as Point)) return true;
    }
  }
  return false;
}

/** Every vertex of inner lies inside outer and no edges cross (used for holes). */
export function containsPolygon(outer: readonly Point[], inner: readonly Point[]): boolean {
  for (const p of inner) if (!containsPoint(outer, p)) return false;
  const n = outer.length;
  const m = inner.length;
  for (let i = 0; i < n; i += 1) {
    const a = outer[i] as Point;
    const b = outer[(i + 1) % n] as Point;
    for (let j = 0; j < m; j += 1) {
      const c = inner[j] as Point;
      const d = inner[(j + 1) % m] as Point;
      const o1 = orient(a, b, c);
      const o2 = orient(a, b, d);
      const o3 = orient(c, d, a);
      const o4 = orient(c, d, b);
      if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0)))
        return false;
    }
  }
  return true;
}

/** First index whose point is within margin on both axes (Chebyshev), else -1 (R-016). */
export function pointIndexAt(points: readonly Point[], p: Point, margin: number): number {
  for (let i = 0; i < points.length; i += 1) {
    const q = points[i] as Point;
    if (Math.abs(q.x - p.x) <= margin && Math.abs(q.y - p.y) <= margin) return i;
  }
  return -1;
}

export function distancePointSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function projectOntoSegment(p: Point, a: Point, b: Point): { point: Point; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { point: { x: a.x, y: a.y }, t: 0 };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { point: { x: a.x + t * dx, y: a.y + t * dy }, t };
}

/** Sutherland-Hodgman clip of a polygon by a convex clip ring; used for footprint overlap area. */
export function clipByConvex(subject: readonly Point[], clip: readonly Point[]): Point[] {
  let output = subject.map((p) => ({ x: p.x, y: p.y }));
  const ccwClip = isCounterClockwise(clip) ? clip : reversed(clip);
  const m = ccwClip.length;
  for (let i = 0; i < m && output.length > 0; i += 1) {
    const a = ccwClip[i] as Point;
    const b = ccwClip[(i + 1) % m] as Point;
    const input = output;
    output = [];
    const inside = (p: Point) => orient(a, b, p) >= 0;
    for (let j = 0; j < input.length; j += 1) {
      const cur = input[j] as Point;
      const prev = input[(j + input.length - 1) % input.length] as Point;
      const curIn = inside(cur);
      const prevIn = inside(prev);
      if (curIn) {
        if (!prevIn) output.push(lineIntersection(prev, cur, a, b) ?? cur);
        output.push(cur);
      } else if (prevIn) {
        output.push(lineIntersection(prev, cur, a, b) ?? cur);
      }
    }
  }
  return output;
}

function lineIntersection(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (d === 0) return null;
  const t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / d;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}

/** Overlap area of two convex rings (footprints are rectangles). */
export function convexOverlapArea(a: readonly Point[], b: readonly Point[]): number {
  const clipped = clipByConvex(a, b);
  return clipped.length < 3 ? 0 : area(clipped);
}

/** Signed distance from p to the ring boundary: positive inside, negative outside. */
export function signedDistanceToRing(
  points: readonly Point[],
  holes: readonly (readonly Point[])[],
  p: Point,
): number {
  let best = Number.POSITIVE_INFINITY;
  const rings = [points, ...holes];
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0; i < n; i += 1) {
      const d = distancePointSegment(p, ring[i] as Point, ring[(i + 1) % n] as Point);
      if (d < best) best = d;
    }
  }
  let inside = containsPoint(points, p);
  if (inside) for (const h of holes) if (containsPoint(h, p)) inside = false;
  return inside ? best : -best;
}

/**
 * Pole of inaccessibility: the interior point farthest from the boundary (R-012 reversed).
 * Grid-refinement search with a priority queue; precision 1 mm is plenty for label anchors.
 */
export function poleOfInaccessibility(
  points: readonly Point[],
  holes: readonly (readonly Point[])[] = [],
  precision = 1,
): Point {
  const b = bounds(points);
  const width = b.maxX - b.minX;
  const height = b.maxY - b.minY;
  const cellSize = Math.min(width, height);
  if (cellSize === 0) return { x: b.minX, y: b.minY };
  interface Cell {
    x: number;
    y: number;
    h: number;
    d: number;
    max: number;
  }
  const mk = (x: number, y: number, h: number): Cell => {
    const d = signedDistanceToRing(points, holes, { x, y });
    return { x, y, h, d, max: d + h * Math.SQRT2 };
  };
  // max-heap on the cell's potential; re-sorting an array every step made rotated rooms take seconds
  const heap: Cell[] = [];
  const push = (cell: Cell) => {
    heap.push(cell);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((heap[parent] as Cell).max >= cell.max) break;
      heap[i] = heap[parent] as Cell;
      i = parent;
    }
    heap[i] = cell;
  };
  const pop = (): Cell => {
    const top = heap[0] as Cell;
    const last = heap.pop() as Cell;
    if (heap.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let mMax = last.max;
        if (l < heap.length && (heap[l] as Cell).max > mMax) {
          m = l;
          mMax = (heap[l] as Cell).max;
        }
        if (r < heap.length && (heap[r] as Cell).max > mMax) m = r;
        if (m === i) break;
        heap[i] = heap[m] as Cell;
        i = m;
      }
      heap[i] = last;
    }
    return top;
  };
  let h = cellSize / 2;
  for (let x = b.minX; x < b.maxX; x += cellSize) {
    for (let y = b.minY; y < b.maxY; y += cellSize) push(mk(x + h, y + h, h));
  }
  // centroid seed
  let best = mk((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, 0);
  const centroid = ringCentroid(points);
  const c = mk(centroid.x, centroid.y, 0);
  if (c.d > best.d) best = c;
  while (heap.length > 0) {
    const cell = pop();
    if (cell.d > best.d) best = cell;
    // no remaining cell can beat the best by more than the precision
    if (cell.max - best.d <= precision) break;
    h = cell.h / 2;
    push(mk(cell.x - h, cell.y - h, h));
    push(mk(cell.x + h, cell.y - h, h));
    push(mk(cell.x - h, cell.y + h, h));
    push(mk(cell.x + h, cell.y + h, h));
  }
  return { x: Math.round(best.x), y: Math.round(best.y) };
}

export function ringCentroid(points: readonly Point[]): Point {
  const n = points.length;
  let cx = 0;
  let cy = 0;
  let a2 = 0;
  for (let i = 0; i < n; i += 1) {
    const p = points[i] as Point;
    const q = points[(i + 1) % n] as Point;
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
    a2 += f;
  }
  if (a2 === 0) {
    const b = bounds(points);
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  }
  return { x: cx / (3 * a2), y: cy / (3 * a2) };
}

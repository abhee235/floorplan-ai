// Room detection from the wall union (ADR-016 D1, spec 05 section 4; ledger R-021..R-039, R-149).
import type { Opening, Point, Wall } from "@fpv/ir";
import { derive, poly } from "@fpv/ir";
import {
  close,
  dropShortEdges,
  flattenRing,
  interiorRings,
  type MultiPoly,
  ringToMulti,
  union,
  unionRings,
} from "./booleans.js";
import { wallFootprints } from "./footprints.js";
import { TOL } from "./tolerances.js";

export interface DetectOptions {
  /** Gap-closing tolerance in mm (default TOL.GAP_CLOSE_DEFAULT, capped at TOL.GAP_CLOSE_MAX). */
  gap?: number;
  /** Precomputed footprints, when the caller already has them. */
  footprints?: Map<string, Point[]>;
}

export interface Enclosure {
  polygon: Point[];
  area: number;
  /** True when the enclosure only exists after gap closing; its polygon is then approximate. */
  bridged: boolean;
}

function cleanRing(hole: readonly Point[]): Point[] | null {
  let ring = flattenRing(hole, TOL.ARC_FLATTEN);
  ring = dropShortEdges(ring, TOL.DEGENERATE);
  if (ring.length < 3) return null;
  if (poly.isClockwise(ring)) ring = poly.reversed(ring);
  return ring;
}

/**
 * Enclosures are the interior rings of the union of wall footprints (R-021..R-023, R-027..R-031).
 * With a gap tolerance, the union is also morphologically closed; enclosures that exist only after
 * closing are returned as bridged (R-024 reversed). Enclosures that exist without closing keep their
 * exact polygon, because closing rounds convex room corners by the gap radius.
 */
export function detectEnclosures(walls: readonly Wall[], options: DetectOptions = {}): Enclosure[] {
  const fps = options.footprints ?? wallFootprints(walls);
  const rings = walls.map((w) => fps.get(w.id)).filter((r): r is Point[] => !!r && r.length >= 3);
  if (rings.length === 0) return [];
  const raw = unionRings(rings);
  const exact: Enclosure[] = [];
  for (const hole of interiorRings(raw)) {
    const ring = cleanRing(hole);
    if (!ring) continue;
    const a = poly.area(ring);
    if (a >= TOL.ROOM_MIN_AREA) exact.push({ polygon: ring, area: a, bridged: false });
  }
  const gap = Math.min(Math.max(0, options.gap ?? TOL.GAP_CLOSE_DEFAULT), TOL.GAP_CLOSE_MAX);
  if (gap === 0) return exact;
  const closed = close(raw, gap);
  const out: Enclosure[] = [];
  // each exact enclosure's interior point is computed once, not once per closed ring
  const exactPoles = exact.map((e) => poly.poleOfInaccessibility(e.polygon));
  for (const hole of interiorRings(closed)) {
    const ring = cleanRing(hole);
    if (!ring) continue;
    const a = poly.area(ring);
    if (a < TOL.ROOM_MIN_AREA) continue;
    const pole = poly.poleOfInaccessibility(ring);
    // an exact enclosure whose interior point sits in this closed ring, and vice versa, is the same room
    const match = exact.find(
      (e, i) => poly.containsPoint(ring, exactPoles[i] as Point) && poly.containsPoint(e.polygon, pole),
    );
    out.push(match ?? { polygon: ring, area: a, bridged: true });
  }
  return out;
}

export interface DetectedRoom {
  polygon: Point[];
  wallIds: string[];
  area: number;
  bridged: boolean;
}

const TOUCH_MM = 1;

function ringDistance(ring: readonly Point[], p: Point): number {
  let best = Number.POSITIVE_INFINITY;
  const n = ring.length;
  for (let i = 0; i < n; i += 1) {
    const d = poly.distancePointSegment(p, ring[i] as Point, ring[(i + 1) % n] as Point);
    if (d < best) best = d;
  }
  return best;
}

/** Walls whose footprint boundary touches the ring within 1 mm. */
export function boundingWalls(
  ring: readonly Point[],
  walls: readonly Wall[],
  fps: Map<string, Point[]>,
): string[] {
  const ids: string[] = [];
  const ringBounds = poly.bounds(ring);
  for (const w of walls) {
    const fp = fps.get(w.id);
    if (
      !fp ||
      !poly.rectsIntersect(poly.bounds(fp), {
        minX: ringBounds.minX - TOUCH_MM,
        minY: ringBounds.minY - TOUCH_MM,
        maxX: ringBounds.maxX + TOUCH_MM,
        maxY: ringBounds.maxY + TOUCH_MM,
      })
    )
      continue;
    let touches = false;
    const n = fp.length;
    for (let i = 0; i < n && !touches; i += 1) {
      const a = fp[i] as Point;
      const b = fp[(i + 1) % n] as Point;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (ringDistance(ring, mid) <= TOUCH_MM || ringDistance(ring, a) <= TOUCH_MM) touches = true;
    }
    if (touches) ids.push(w.id);
  }
  return ids;
}

/**
 * The smallest enclosure containing the point (R-026, R-149 reversed), with thresholds patched
 * for doors and passages on its bounding walls (R-032..R-039 reversed). Null when unenclosed (R-025).
 */
export function detectRoomAt(
  walls: readonly Wall[],
  openings: readonly Opening[],
  point: Point,
  options: DetectOptions = {},
): DetectedRoom | null {
  const fps = options.footprints ?? wallFootprints(walls);
  const enclosures = detectEnclosures(walls, { ...options, footprints: fps })
    .filter((e) => poly.containsPoint(e.polygon, point))
    .sort((a, b) => a.area - b.area);
  const best = enclosures[0];
  if (!best) return null;
  const wallIds = boundingWalls(best.polygon, walls, fps);
  const polygon = patchThresholds(best.polygon, walls, openings, wallIds);
  return { polygon, wallIds, area: poly.area(polygon), bridged: best.bridged };
}

/**
 * Extend the room polygon across each door or passage on a bounding wall up to the wall
 * centreline (R-034). Openings whose jambs are not both on the ring edge are skipped
 * (R-037 becomes a validation problem elsewhere).
 */
export function patchThresholds(
  polygon: readonly Point[],
  walls: readonly Wall[],
  openings: readonly Opening[],
  wallIds: readonly string[],
): Point[] {
  const byId = new Map(walls.map((w) => [w.id, w]));
  let result: MultiPoly = ringToMulti(polygon);
  let patched = false;
  for (const o of openings) {
    if (o.kind === "window" || o.sill > TOL.THRESHOLD_SILL_MAX || !wallIds.includes(o.wallId)) continue;
    const w = byId.get(o.wallId);
    if (!w || derive.isArc(w)) continue;
    const len = derive.wallLength(w);
    if (len === 0) continue;
    const dx = (w.end.x - w.start.x) / len;
    const dy = (w.end.y - w.start.y) / len;
    const n = derive.wallSideNormal(w, "left");
    const c = derive.openingCentre(o, w);
    const probeOffset = w.thickness / 2 + 1;
    const leftProbe = { x: c.x + n.x * probeOffset, y: c.y + n.y * probeOffset };
    const rightProbe = { x: c.x - n.x * probeOffset, y: c.y - n.y * probeOffset };
    const roomOnLeft = poly.containsPoint(polygon, leftProbe);
    const roomOnRight = poly.containsPoint(polygon, rightProbe);
    if (roomOnLeft === roomOnRight) continue;
    const sign = roomOnLeft ? 1 : -1;
    const hw = o.width / 2;
    const jambA = {
      x: c.x - dx * hw + sign * n.x * probeOffset,
      y: c.y - dy * hw + sign * n.y * probeOffset,
    };
    const jambB = {
      x: c.x + dx * hw + sign * n.x * probeOffset,
      y: c.y + dy * hw + sign * n.y * probeOffset,
    };
    if (!poly.containsPoint(polygon, jambA) || !poly.containsPoint(polygon, jambB)) continue;
    const depthIn = w.thickness / 2 + 1;
    const notch: Point[] = [
      { x: c.x - dx * hw + sign * n.x * depthIn, y: c.y - dy * hw + sign * n.y * depthIn },
      { x: c.x + dx * hw + sign * n.x * depthIn, y: c.y + dy * hw + sign * n.y * depthIn },
      { x: c.x + dx * hw, y: c.y + dy * hw },
      { x: c.x - dx * hw, y: c.y - dy * hw },
    ];
    result = union(result, ringToMulti(notch));
    patched = true;
  }
  if (!patched) return [...polygon];
  const first = result[0];
  if (!first || result.length !== 1) return [...polygon];
  return dropShortEdges(first.outer, TOL.DEGENERATE);
}

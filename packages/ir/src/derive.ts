// Derived values (spec 01 section 7). Pure functions; nothing here is ever persisted (ADR-001 D7).

import * as poly from "./poly.js";
import type { Item, Level, Opening, Point, PrimitiveRecipe, Project, Room, Size3, Wall } from "./schema.js";
import { normalizeDeg } from "./schema.js";

export type Compass = "north" | "south" | "east" | "west";
export type Side = "left" | "right";

// ---- walls ----------------------------------------------------------------

/** Straight-line distance between start and end (W-051: the chord for arcs). */
export function wallLength(w: Wall): number {
  return Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
}

export function wallAngle(w: Wall): number {
  return normalizeDeg((Math.atan2(w.end.y - w.start.y, w.end.x - w.start.x) * 180) / Math.PI);
}

export function isArc(w: Wall): boolean {
  return w.arcExtent !== null && w.arcExtent !== 0;
}

/** Arc radius and centre for an arc wall (W-049), or null for straight walls. */
export function arcParams(w: Wall): { centre: Point; radius: number } | null {
  if (!isArc(w)) return null;
  const chord = wallLength(w);
  if (chord === 0) return null;
  const a = ((w.arcExtent as number) * Math.PI) / 180;
  const radius = chord / 2 / Math.sin(Math.abs(a) / 2);
  // Distance from chord midpoint to centre, along the chord's left normal (positive extent bulges to the left).
  const h = radius * Math.cos(Math.abs(a) / 2);
  const mx = (w.start.x + w.end.x) / 2;
  const my = (w.start.y + w.end.y) / 2;
  const dx = (w.end.x - w.start.x) / chord;
  const dy = (w.end.y - w.start.y) / chord;
  const sign = a > 0 ? -1 : 1; // centre is on the concave side, opposite the bulge
  return { centre: { x: mx + sign * -dy * h, y: my + sign * dx * h }, radius };
}

/** Arc length for arc walls, chord length otherwise (W-051). */
export function wallArcLength(w: Wall): number {
  const p = arcParams(w);
  if (!p) return wallLength(w);
  return (Math.abs(w.arcExtent as number) * Math.PI * p.radius) / 180;
}

/** Effective height at the start: the wall's own or the level's (W-092). */
export function wallHeight(w: Wall, level: Level): number {
  return w.height ?? level.height;
}

export function wallHeightAtEnd(w: Wall, level: Level): number {
  return w.heightAtEnd ?? wallHeight(w, level);
}

export function isTrapezoidal(w: Wall): boolean {
  return w.heightAtEnd !== null && w.height !== null && w.heightAtEnd !== w.height;
}

/** W-095: the taller of the two ends. */
export function wallMaxHeight(w: Wall, level: Level): number {
  return Math.max(wallHeight(w, level), wallHeightAtEnd(w, level));
}

/** Unit normal pointing to the given side when walking start to end (y up: left is counter-clockwise). */
export function wallSideNormal(w: Wall, side: Side): Point {
  const len = wallLength(w);
  if (len === 0) return { x: 0, y: 0 };
  const dx = (w.end.x - w.start.x) / len;
  const dy = (w.end.y - w.start.y) / len;
  return side === "left" ? { x: -dy, y: dx } : { x: dy, y: -dx };
}

/** Compass word for a direction angle given the project's north (ADR-006 D3). */
export function compassOf(angleDeg: number, north: number): Compass {
  const rel = normalizeDeg(angleDeg - north);
  if (rel < 45 || rel >= 315) return "north";
  if (rel < 135) return "west";
  if (rel < 225) return "south";
  return "east";
}

export function wallCompassSide(w: Wall, side: Side, north: number): Compass {
  const n = wallSideNormal(w, side);
  return compassOf((Math.atan2(n.y, n.x) * 180) / Math.PI, north);
}

/**
 * Unjoined straight footprint: [left-start, left-end, right-end, right-start] (W-001..W-003).
 * Joins are resolved by the geometry package; this is enough for validation and hit tests.
 */
export function wallFootprintUnjoined(w: Wall): Point[] {
  const n = wallSideNormal(w, "left");
  const h = w.thickness / 2;
  return [
    { x: w.start.x + n.x * h, y: w.start.y + n.y * h },
    { x: w.end.x + n.x * h, y: w.end.y + n.y * h },
    { x: w.end.x - n.x * h, y: w.end.y - n.y * h },
    { x: w.start.x - n.x * h, y: w.start.y - n.y * h },
  ];
}

export function pointAlongWall(w: Wall, fraction: number): Point {
  return { x: w.start.x + (w.end.x - w.start.x) * fraction, y: w.start.y + (w.end.y - w.start.y) * fraction };
}

// ---- openings -------------------------------------------------------------

export function openingCentre(o: Opening, w: Wall): Point {
  return pointAlongWall(w, o.position);
}

/** Interval along the wall in mm from its start covered by the opening. */
export function openingAlongInterval(o: Opening, w: Wall): { from: number; to: number } {
  const c = o.position * wallLength(w);
  return { from: c - o.width / 2, to: c + o.width / 2 };
}

/** Opening footprint through the wall thickness plus 1 mm each side so both faces are cut (ADR-014 D7). */
export function openingFootprint(o: Opening, w: Wall, extraMm = 1): Point[] {
  const len = wallLength(w);
  if (len === 0) return [];
  const dx = (w.end.x - w.start.x) / len;
  const dy = (w.end.y - w.start.y) / len;
  const n = wallSideNormal(w, "left");
  const c = openingCentre(o, w);
  const hw = o.width / 2;
  const hd = w.thickness / 2 + extraMm;
  return [
    { x: c.x - dx * hw + n.x * hd, y: c.y - dy * hw + n.y * hd },
    { x: c.x + dx * hw + n.x * hd, y: c.y + dy * hw + n.y * hd },
    { x: c.x + dx * hw - n.x * hd, y: c.y + dy * hw - n.y * hd },
    { x: c.x - dx * hw - n.x * hd, y: c.y - dy * hw - n.y * hd },
  ];
}

/** Hinge side as a compass word for tools: the wall end the hinge sits on, projected outward. */
export function openingHingeCompass(o: Opening, w: Wall, north: number): Compass | null {
  if (!o.swing) return null;
  const dir = o.swing.hinge === "start" ? wallAngle(w) + 180 : wallAngle(w);
  return compassOf(dir, north);
}

// ---- rooms ----------------------------------------------------------------

/** Absolute area with holes subtracted, mm² (R-006). */
export function roomArea(r: Room): number {
  let a = poly.area(r.polygon);
  for (const h of r.holes) a -= poly.area(h);
  return a;
}

export function roomPerimeter(r: Room): number {
  return poly.perimeter(r.polygon);
}

export function roomBounds(r: Room): poly.Rect {
  return poly.bounds(r.polygon);
}

/** Label anchor: pole of inaccessibility plus the stored offset (R-012 reversed). */
export function roomLabelAnchor(r: Room): Point {
  const p = poly.poleOfInaccessibility(r.polygon, r.holes);
  return { x: p.x + r.label.offset.x, y: p.y + r.label.offset.y };
}

export function roomContains(r: Room, p: Point): boolean {
  if (!poly.containsPoint(r.polygon, p)) return false;
  for (const h of r.holes) if (poly.containsPoint(h, p)) return false;
  return true;
}

/** Smallest room on the level containing the point (ADR-016 D1 step 4), or null. */
export function containingRoom(project: Project, levelId: string, p: Point): Room | null {
  let best: Room | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const r of project.rooms) {
    if (r.levelId !== levelId || !roomContains(r, p)) continue;
    const a = roomArea(r);
    if (a < bestArea) {
      best = r;
      bestArea = a;
    }
  }
  return best;
}

// ---- items ----------------------------------------------------------------

export interface SizeSource {
  /** Returns dims and deformable flag for a product id, or null when unknown. */
  product(productId: string): { dims: Size3; deformable: boolean } | null;
}

/** Sizes for primitive recipes (spec 02 section 3.1 fallbacks). */
export function recipeSize(recipe: PrimitiveRecipe): Size3 {
  switch (recipe.kind) {
    case "box":
    case "table":
    case "chair":
    case "video-bar":
    case "ceiling-mic":
      return recipe.size;
    case "cylinder":
      return { w: recipe.diameter, d: recipe.diameter, h: recipe.height };
    case "ceiling-speaker":
      return { w: recipe.diameter, d: recipe.diameter, h: 100 };
    case "display": {
      const diagMm = recipe.diagonalIn * 25.4;
      const w = Math.round(diagMm * 0.8716) + 2 * recipe.bezelMm;
      const h = Math.round(diagMm * 0.4903) + 2 * recipe.bezelMm;
      return { w, d: 60, h };
    }
  }
}

/** Size source backed by a project's catalog snapshots. */
export function snapshotSizeSource(project: Project): SizeSource {
  return {
    product(productId) {
      const snap = project.catalogRefs[productId] as { dims?: Size3; deformable?: boolean } | undefined;
      if (!snap?.dims) return null;
      return { dims: snap.dims, deformable: snap.deformable ?? false };
    },
  };
}

/** Item size: override, else product dims, else recipe size; null when the product is unknown. */
export function itemSize(item: Item, sizes: SizeSource): Size3 | null {
  if (item.size) return item.size;
  if (item.ref.kind === "recipe") return recipeSize(item.ref.recipe);
  return sizes.product(item.ref.productId)?.dims ?? null;
}

/**
 * Footprint corners in order [back-left, back-right, front-right, front-left] (F-007 adapted).
 * Local frame: x to the item's right, y toward its back; front faces local -y. Rotated counter-clockwise.
 */
export function itemFootprint(item: Item, size: Size3): Point[] {
  const hw = size.w / 2;
  const hd = size.d / 2;
  const local: Point[] = [
    { x: -hw, y: hd },
    { x: hw, y: hd },
    { x: hw, y: -hd },
    { x: -hw, y: -hd },
  ];
  const a = (item.rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return local.map((p) => ({
    x: item.position.x + p.x * cos - p.y * sin,
    y: item.position.y + p.x * sin + p.y * cos,
  }));
}

/** F-012: elevation relative to the level plus the level's elevation. */
export function itemGroundElevation(item: Item, level: Level): number {
  return level.elevation + item.elevation;
}

/** F-019: a corner hit must be within margin and closer to that corner than to its two neighbours. */
export function footprintCornerAt(footprint: readonly Point[], p: Point, margin: number): number {
  const n = footprint.length;
  let best = -1;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i += 1) {
    const c = footprint[i] as Point;
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d <= margin && d < bestD) {
      best = i;
      bestD = d;
    }
  }
  if (best < 0) return -1;
  const prev = footprint[(best + n - 1) % n] as Point;
  const next = footprint[(best + 1) % n] as Point;
  const dPrev = Math.hypot(prev.x - p.x, prev.y - p.y);
  const dNext = Math.hypot(next.x - p.x, next.y - p.y);
  return bestD < dPrev && bestD < dNext ? best : -1;
}

/** F-020: parallel within 1 degree for straight walls, 10 degrees for arc walls; never for zero-length walls. */
export function isParallelToWall(item: Item, w: Wall): boolean {
  if (wallLength(w) === 0) return false;
  const tol = isArc(w) ? 10 : 1;
  let diff = normalizeDeg(item.rotation - wallAngle(w)) % 180;
  if (diff > 90) diff = 180 - diff;
  return diff <= tol;
}

// ---- levels and project ---------------------------------------------------

export function levelOf(project: Project, levelId: string): Level | null {
  return project.levels.find((l) => l.id === levelId) ?? null;
}

export function lowestLevel(project: Project): Level {
  return [...project.levels].sort(compareLevels)[0] as Level;
}

export function compareLevels(a: Level, b: Level): number {
  return a.elevation - b.elevation || a.index - b.index;
}

export function projectBounds(
  project: Project,
  sizes: SizeSource = snapshotSizeSource(project),
): poly.Rect | null {
  const pts: Point[] = [];
  for (const w of project.walls) pts.push(...wallFootprintUnjoined(w));
  for (const r of project.rooms) pts.push(...r.polygon);
  for (const i of project.items) {
    const s = itemSize(i, sizes);
    if (s) pts.push(...itemFootprint(i, s));
  }
  return pts.length ? poly.bounds(pts) : null;
}

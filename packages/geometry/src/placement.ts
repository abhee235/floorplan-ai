// The item placement pipeline (spec 05 section 5, ADR-016 D4; ledger F-062..F-099). Pure: a subject item,
// the project around it and flags in, a position, rotation, elevation and parent out. Stages run in the
// order of F-075: onto a surface, against a wall, side by side (only when no surface was found), then
// clearance warnings. Commands call it on place and on single-item move; tools never bypass it.
import type { Item, Point, Project, Size3, Wall } from "@fpv/ir";
import { derive, normalizeDeg, poly } from "@fpv/ir";
import { wallFootprints } from "./footprints.js";

/** Wall detection margin around the item (F-082: 4 px at the reference zoom). */
export const WALL_MARGIN_MM = 40;
/** Side-by-side band around a neighbour (F-093: 8 px). */
export const SIDE_BAND_MM = 80;
/** Corners may overhang a surface by this fraction of the smaller item side (F-063). */
export const SURFACE_MARGIN = 0.05;
/** Inflation for "still touching" after a side-by-side move (F-095). */
export const TOUCH_MM = 1;
/** Overlap below this area in mm² is contact, not penetration. */
const AREA_EPS = 1;

export type MountKind = Item["mount"]["kind"];

export interface Subject {
  /** Null for an item not yet in the project. */
  id: string | null;
  levelId: string;
  position: Point;
  rotation: number;
  elevation: number;
  size: Size3;
  mountKind: MountKind;
  parentId: string | null;
}

export interface PlacementOptions {
  /** Drop re-orients against a wall (F-075); drag keeps the rotation (F-076). */
  forceOrientation: boolean;
  adjustElevation: boolean;
  /** Only an item at elevation 0 is lifted onto a surface (F-066, the move pipeline). */
  adjustOnlyNullElevation: boolean;
  /** Put the item's leading edge, not its centre, at the position along the wall (F-086). */
  alignEdgeToPosition?: boolean;
  /** Items never considered as surfaces or neighbours, e.g. the subject's descendants. */
  exclude?: readonly string[];
}

export interface PlacementContext {
  project: Project;
  sizes: derive.SizeSource;
}

export interface PlacementWarning {
  code: string;
  message: string;
  related: string[];
}

export interface PlacementResult {
  position: Point;
  rotation: number;
  elevation: number;
  parentId: string | null;
  surfaceId: string | null;
  wallId: string | null;
  neighbourId: string | null;
  warnings: PlacementWarning[];
}

// ---- small geometry ------------------------------------------------------------------------------------

const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;

export function footprintAt(position: Point, rotation: number, size: Pick<Size3, "w" | "d">): Point[] {
  return derive.itemFootprint({ position, rotation } as Item, { w: size.w, d: size.d, h: 1 });
}

function overlapArea(subject: readonly Point[], convexClip: readonly Point[]): number {
  const c = poly.clipByConvex(subject, convexClip);
  return c.length < 3 ? 0 : poly.area(c);
}

/** Rotation that turns an item's back (local +y) toward `dir`. */
export function rotationWithBackTo(dir: Point): number {
  return normalizeDeg((Math.atan2(dir.y, dir.x) * 180) / Math.PI - 90);
}

function rotate(v: Point, deg: number): Point {
  const a = (deg * Math.PI) / 180;
  return { x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) };
}

function levelElevation(project: Project, id: string): number {
  return derive.levelOf(project, id)?.elevation ?? 0;
}

// ---- stage 1: onto a surface ------------------------------------------------------------------------------

/** Where dropped items land on an item, as a fraction of its height; null when nothing stacks on it (F-062). */
export function dropRatioOf(project: Project, item: Item): number | null {
  if (item.ref.kind === "recipe") {
    const k = item.ref.recipe.kind;
    return k === "table" || k === "box" ? 1 : null;
  }
  const snap = project.catalogRefs[item.ref.productId] as
    | { mountPoints?: { kind?: string; dropRatio?: number | null }[] }
    | undefined;
  const surface = snap?.mountPoints?.find((m) => m.kind === "surface");
  return typeof surface?.dropRatio === "number" && surface.dropRatio >= 0 ? surface.dropRatio : null;
}

export function surfaceBelow(
  subject: Subject,
  ctx: PlacementContext,
  exclude: ReadonlySet<string>,
): { id: string; elevation: number } | null {
  const { project, sizes } = ctx;
  const fp = footprintAt(subject.position, subject.rotation, subject.size);
  const margin = SURFACE_MARGIN * Math.min(subject.size.w, subject.size.d);
  const base = levelElevation(project, subject.levelId);
  const height = derive.levelOf(project, subject.levelId)?.height ?? Number.POSITIVE_INFINITY;
  let best: { id: string; elevation: number } | null = null;
  for (const cand of project.items) {
    if (cand.id === subject.id || exclude.has(cand.id) || !cand.visible) continue;
    const ratio = dropRatioOf(project, cand);
    if (ratio === null) continue;
    const cs = derive.itemSize(cand, sizes);
    if (!cs) continue;
    const cfp = derive.itemFootprint(cand, cs);
    if (!fp.every((q) => poly.containsPointWithMargin(cfp, q, margin))) continue; // F-063: all four corners
    // F-065: a surface on another level counts relative to the subject's level
    const top = levelElevation(project, cand.levelId) + cand.elevation + cs.h * ratio - base;
    if (top < 0 || top > height) continue;
    if (!best || top > best.elevation) best = { id: cand.id, elevation: Math.round(top) }; // F-064
  }
  return best;
}

// ---- stage 2: against a wall ------------------------------------------------------------------------------

interface WallFrame {
  wall: Wall;
  base: Point;
  /** Along the wall, start to end (tangent for arcs). */
  u: Point;
  /** The wall's left normal. */
  n: Point;
}

function frameAt(w: Wall, near: Point): WallFrame {
  const arc = derive.arcParams(w);
  if (arc) {
    const r = sub(near, arc.centre);
    const len = Math.hypot(r.x, r.y) || 1;
    const radial = mul(r, 1 / len);
    let u = { x: -radial.y, y: radial.x };
    if (dot(u, sub(w.end, w.start)) < 0) u = neg(u);
    return { wall: w, base: add(arc.centre, mul(radial, arc.radius)), u, n: { x: -u.y, y: u.x } };
  }
  const len = derive.wallLength(w);
  const u = { x: (w.end.x - w.start.x) / len, y: (w.end.y - w.start.y) / len };
  return { wall: w, base: w.start, u, n: derive.wallSideNormal(w, "left") };
}

const neg = (v: Point): Point => ({ x: -v.x, y: -v.y });

/**
 * Which way along the wall an item extends from the position when its edge is anchored there (F-086).
 * Walls pointing into (-90, 90] degrees anchor the start-side edge; the boundary is exact with one
 * symmetric tolerance (F-087 reversed: no epsilon added to one side only).
 */
export function anchorsStartEdge(wallAngleDeg: number): boolean {
  const a = (wallAngleDeg * Math.PI) / 180;
  const c = Math.cos(a);
  if (Math.abs(c) > 1e-9) return c > 0;
  return Math.sin(a) > 0;
}

/** The reference wall: one whose footprint contains the position, else the largest overlap within the margin (F-082, F-083 reversed). */
export function referenceWall(
  position: Point,
  rotation: number,
  size: Size3,
  walls: readonly Wall[],
  footprints: ReadonlyMap<string, Point[]>,
): Wall | null {
  for (const w of walls) {
    const fp = footprints.get(w.id);
    if (fp && poly.containsPoint(fp, position)) return w;
  }
  const inflated = footprintAt(position, rotation, {
    w: size.w + 2 * WALL_MARGIN_MM,
    d: size.d + 2 * WALL_MARGIN_MM,
  });
  let best: Wall | null = null;
  let bestArea = 0;
  for (const w of walls) {
    const fp = footprints.get(w.id);
    if (!fp) continue;
    const a = overlapArea(fp, inflated);
    if (a > bestArea) {
      bestArea = a;
      best = w;
    }
  }
  return best;
}

/** Keep the parts of a move that do not push the footprint into the wall (F-096). */
export function constrainToWall(
  delta: Point,
  footprintFor: (d: Point) => Point[],
  wallFootprint: readonly Point[],
  along: Point,
): Point {
  if (overlapArea(wallFootprint, footprintFor(delta)) <= AREA_EPS) return delta;
  const lateral = mul(along, dot(delta, along));
  if (overlapArea(wallFootprint, footprintFor(lateral)) <= AREA_EPS) return lateral;
  return { x: 0, y: 0 };
}

interface WallStage {
  position: Point;
  rotation: number;
  wall: Wall | null;
  warnings: PlacementWarning[];
}

function snapToWall(
  subject: Subject,
  ctx: PlacementContext,
  options: PlacementOptions,
  walls: readonly Wall[],
  fps: ReadonlyMap<string, Point[]>,
): WallStage {
  const none = { position: subject.position, rotation: subject.rotation, wall: null, warnings: [] };
  const ref = referenceWall(subject.position, subject.rotation, subject.size, walls, fps);
  if (!ref) return none;
  const wfp = fps.get(ref.id) as Point[];
  // F-089: an item entirely inside the wall is not snapped
  if (footprintAt(subject.position, subject.rotation, subject.size).every((q) => poly.containsPoint(wfp, q)))
    return {
      ...none,
      warnings: [
        {
          code: "item.in-wall",
          message: `the item is inside wall ${ref.id}; move it into the room`,
          related: [ref.id],
        },
      ],
    };
  const f = frameAt(ref, subject.position);
  const left = dot(sub(subject.position, f.base), f.n) >= 0; // F-085: the nearer side
  const inward = left ? f.n : neg(f.n);
  const rotation = options.forceOrientation ? rotationWithBackTo(neg(inward)) : subject.rotation;
  const skirting =
    subject.elevation === 0 ? ((left ? ref.skirting.left : ref.skirting.right)?.thickness ?? 0) : 0; // F-084
  const face = ref.thickness / 2 + skirting;
  let position = subject.position;
  const nearest = Math.min(
    ...footprintAt(position, rotation, subject.size).map((q) => dot(sub(q, f.base), inward)),
  );
  position = add(position, mul(inward, face - nearest));
  if (options.alignEdgeToPosition) {
    const angle = (Math.atan2(f.u.y, f.u.x) * 180) / Math.PI;
    const along = footprintAt(position, rotation, subject.size).map((q) =>
      dot(sub(q, subject.position), f.u),
    );
    const shift = anchorsStartEdge(angle) ? -Math.min(...along) : -Math.max(...along);
    position = add(position, mul(f.u, shift));
  }
  // F-088: slide clear of a second wall the item now overlaps, unless it straddles non-parallel walls
  const reoriented = rotation !== subject.rotation;
  const arcSkip = derive.isArc(ref) && reoriented && !left; // F-090
  const others = walls.filter(
    (w) =>
      w.id !== ref.id &&
      overlapArea(fps.get(w.id) as Point[], footprintAt(position, rotation, subject.size)) > AREA_EPS,
  );
  const parallel = (w: Wall) => {
    const len = derive.wallLength(w) || 1;
    return Math.abs(cross(f.u, { x: (w.end.x - w.start.x) / len, y: (w.end.y - w.start.y) / len })) < 1e-5;
  };
  if (!arcSkip && others.length > 0 && (others.length === 1 || others.every(parallel))) {
    for (const w of others) {
      const fp = footprintAt(position, rotation, subject.size);
      const clip = poly.clipByConvex(fps.get(w.id) as Point[], fp);
      if (clip.length < 3) continue;
      const cl = Math.min(...clip.map((q) => dot(q, f.u)));
      const ch = Math.max(...clip.map((q) => dot(q, f.u)));
      const il = Math.min(...fp.map((q) => dot(q, f.u)));
      const ih = Math.max(...fp.map((q) => dot(q, f.u)));
      const centre = dot(position, f.u);
      const shift = (cl + ch) / 2 >= centre ? -(ih - cl) : ch - il;
      position = add(position, mul(f.u, shift));
    }
  }
  return { position, rotation, wall: ref, warnings: [] };
}

// ---- stage 3: side by side ------------------------------------------------------------------------------

function toLocal(q: Point, origin: Point, rotation: number): Point {
  return rotate(sub(q, origin), -rotation);
}

/** The move that puts `moving` flush against `fixed`, or null when the band rule does not apply (F-093, F-094). */
function flushDelta(
  moving: readonly Point[],
  fixed: { position: Point; rotation: number; size: Size3 },
): Point | null {
  const hw = fixed.size.w / 2;
  const hd = fixed.size.d / 2;
  const HW = hw + SIDE_BAND_MM;
  const HD = hd + SIDE_BAND_MM;
  const local = moving.map((q) => toLocal(q, fixed.position, fixed.rotation));
  const O = { x: 0, y: 0 };
  const tri = (a: Point, b: Point) => [O, a, b];
  const frontBack =
    overlapArea(local, tri({ x: -HW, y: -HD }, { x: HW, y: -HD })) +
    overlapArea(local, tri({ x: HW, y: HD }, { x: -HW, y: HD }));
  const leftRight =
    overlapArea(local, tri({ x: -HW, y: HD }, { x: -HW, y: -HD })) +
    overlapArea(local, tri({ x: HW, y: -HD }, { x: HW, y: HD }));
  if (frontBack <= 0 && leftRight <= 0) return null;
  const xs = local.map((q) => q.x);
  const ys = local.map((q) => q.y);
  let d: Point;
  if (frontBack >= leftRight) {
    const cy = ys.reduce((s, v) => s + v, 0) / ys.length;
    d = { x: 0, y: cy < 0 ? -hd - Math.max(...ys) : hd - Math.min(...ys) };
  } else {
    const cx = xs.reduce((s, v) => s + v, 0) / xs.length;
    d = { x: cx < 0 ? -hw - Math.max(...xs) : hw - Math.min(...xs), y: 0 };
  }
  return rotate(d, fixed.rotation);
}

interface Neighbour {
  id: string;
  position: Point;
  rotation: number;
  size: Size3;
  footprint: Point[];
}

function sideBySide(
  subject: Subject,
  position: Point,
  rotation: number,
  ctx: PlacementContext,
  exclude: ReadonlySet<string>,
  wall: { footprint: Point[]; along: Point } | null,
): { position: Point; neighbourId: string | null } {
  const { project, sizes } = ctx;
  const fp = footprintAt(position, rotation, subject.size);
  const bottom = subject.elevation;
  const top = subject.elevation + subject.size.h;
  let best: { n: Neighbour; area: number } | null = null;
  for (const cand of project.items) {
    if (cand.id === subject.id || exclude.has(cand.id) || !cand.visible || cand.levelId !== subject.levelId)
      continue;
    const cs = derive.itemSize(cand, sizes);
    if (!cs) continue;
    if (!(cand.elevation < top && bottom < cand.elevation + cs.h)) continue; // F-092: vertical overlap
    const cfp = derive.itemFootprint(cand, cs);
    if (overlapArea(fp, cfp) > AREA_EPS) continue; // F-093: no interior penetration
    const band = footprintAt(cand.position, cand.rotation, {
      w: cs.w + 2 * SIDE_BAND_MM,
      d: cs.d + 2 * SIDE_BAND_MM,
    });
    const area = overlapArea(fp, band);
    if (area <= 0) continue;
    if (!best || area > best.area)
      best = {
        n: { id: cand.id, position: cand.position, rotation: cand.rotation, size: cs, footprint: cfp },
        area,
      };
  }
  if (!best) return { position, neighbourId: null };
  const n = best.n;
  const touches = (d: Point) =>
    poly.polygonsIntersect(
      footprintAt(add(position, d), rotation, {
        w: subject.size.w + 2 * TOUCH_MM,
        d: subject.size.d + 2 * TOUCH_MM,
      }),
      n.footprint,
    );
  const limit = (d: Point) =>
    wall
      ? constrainToWall(
          d,
          (x) => footprintAt(add(position, x), rotation, subject.size),
          wall.footprint,
          wall.along,
        )
      : d;
  const first = flushDelta(fp, n);
  if (first) {
    const d = limit(first);
    if ((d.x !== 0 || d.y !== 0) && touches(d)) return { position: add(position, d), neighbourId: n.id };
  }
  // F-095: roles swapped, the neighbour moving toward the subject, applied in reverse
  const swapped = flushDelta(n.footprint, { position, rotation, size: subject.size });
  if (swapped) {
    const d = limit(neg(swapped));
    if ((d.x !== 0 || d.y !== 0) && touches(d)) return { position: add(position, d), neighbourId: n.id };
  }
  return { position, neighbourId: null };
}

// ---- stage 4: clearances ---------------------------------------------------------------------------------

/** The squares a door sweeps, door width by door width from each wall face. */
export function doorSwingZones(project: Project, levelId: string): { openingId: string; polygon: Point[] }[] {
  const out: { openingId: string; polygon: Point[] }[] = [];
  for (const o of project.openings) {
    if (o.kind !== "door" || o.levelId !== levelId) continue;
    const w = project.walls.find((x) => x.id === o.wallId);
    if (!w) continue;
    const len = derive.wallLength(w);
    if (len === 0) continue;
    const u = { x: (w.end.x - w.start.x) / len, y: (w.end.y - w.start.y) / len };
    const n = derive.wallSideNormal(w, "left");
    const c = derive.openingCentre(o, w);
    for (const sign of [1, -1]) {
      const face = add(c, mul(n, (sign * w.thickness) / 2));
      const p1 = sub(face, mul(u, o.width / 2));
      const p2 = add(face, mul(u, o.width / 2));
      const deep = mul(n, sign * o.width);
      out.push({ openingId: o.id, polygon: [p1, p2, add(p2, deep), add(p1, deep)] });
    }
  }
  return out;
}

export interface Clearance {
  front: number;
  back: number;
  left: number;
  right: number;
}

/** Door swings the item stands in, and neighbours inside its product clearance (spec 05 section 5 stage 4). */
function clearanceWarnings(
  subject: Subject,
  position: Point,
  rotation: number,
  elevation: number,
  ctx: PlacementContext,
  exclude: ReadonlySet<string>,
  clearance: Clearance | null,
): PlacementWarning[] {
  if (subject.mountKind === "ceiling" || subject.mountKind === "wall") return [];
  const out: PlacementWarning[] = [];
  const fp = footprintAt(position, rotation, subject.size);
  const blocked = [
    ...new Set(
      doorSwingZones(ctx.project, subject.levelId)
        .filter((z) => elevation < 2000 && overlapArea(fp, z.polygon) > 1000)
        .map((z) => z.openingId),
    ),
  ];
  if (blocked.length > 0)
    out.push({
      code: "item.door-swing",
      message: `the item stands in the swing of door ${blocked.join(", ")}`,
      related: blocked,
    });
  return clearance
    ? out.concat(clearanceOverlaps(subject, position, rotation, ctx, exclude, clearance))
    : out;
}

function clearanceOverlaps(
  subject: Subject,
  position: Point,
  rotation: number,
  ctx: PlacementContext,
  exclude: ReadonlySet<string>,
  clearance: Clearance,
): PlacementWarning[] {
  const { sizes } = ctx;
  // the clearance box in local terms: left/right widen x, back is +y, front is -y
  const w = subject.size.w + clearance.left + clearance.right;
  const d = subject.size.d + clearance.front + clearance.back;
  const offset = rotate(
    { x: (clearance.right - clearance.left) / 2, y: (clearance.back - clearance.front) / 2 },
    rotation,
  );
  const box = footprintAt(add(position, offset), rotation, { w, d });
  const hits = ctx.project.items
    .filter(
      (i) =>
        i.id !== subject.id &&
        !exclude.has(i.id) &&
        i.levelId === subject.levelId &&
        i.mount.kind === "floor",
    )
    .filter((i) => {
      const s = derive.itemSize(i, sizes);
      return s ? overlapArea(box, derive.itemFootprint(i, s)) > 1000 : false;
    })
    .map((i) => i.id);
  return hits.length > 0
    ? [
        {
          code: "item.clearance",
          message: `the item's access clearance overlaps ${hits.join(", ")}`,
          related: hits,
        },
      ]
    : [];
}

/** The access clearance a product snapshot declares, or null. */
export function clearanceOf(project: Project, productId: string | null): Clearance | null {
  if (!productId) return null;
  const snap = project.catalogRefs[productId] as { clearance?: Clearance | null } | undefined;
  return snap?.clearance ?? null;
}

// ---- the pipeline --------------------------------------------------------------------------------------

export function placeItem(
  subject: Subject,
  ctx: PlacementContext,
  options: PlacementOptions,
  clearance: Clearance | null = null,
): PlacementResult {
  const exclude = new Set(options.exclude ?? []);
  const warnings: PlacementWarning[] = [];
  let { position, rotation, elevation, parentId } = subject;
  let surfaceId: string | null = null;

  // 1. onto a surface (F-063..F-066, F-069)
  const canLift = options.adjustElevation && subject.mountKind !== "wall" && subject.mountKind !== "ceiling";
  if (canLift && !(options.adjustOnlyNullElevation && subject.elevation !== 0 && subject.parentId === null)) {
    const surface = surfaceBelow(subject, ctx, exclude);
    if (surface) {
      elevation = surface.elevation;
      parentId = surface.id;
      surfaceId = surface.id;
    } else if (subject.parentId !== null && !exclude.has(subject.parentId)) {
      elevation = 0; // F-069: moved off its surface
      parentId = null;
    }
  }

  // 2. against a wall (F-082..F-090)
  let wallId: string | null = null;
  let wallInfo: { footprint: Point[]; along: Point } | null = null;
  if (subject.mountKind !== "ceiling") {
    const walls = ctx.project.walls.filter((w) => w.levelId === subject.levelId && derive.wallLength(w) > 0);
    if (walls.length > 0) {
      const fps = wallFootprints(walls);
      const stage = snapToWall({ ...subject, position, rotation, elevation }, ctx, options, walls, fps);
      position = stage.position;
      rotation = stage.rotation;
      warnings.push(...stage.warnings);
      if (stage.wall) {
        wallId = stage.wall.id;
        wallInfo = { footprint: fps.get(stage.wall.id) as Point[], along: frameAt(stage.wall, position).u };
      }
    }
  }

  // 3. side by side, only when no surface took the item (F-075, F-092..F-096)
  let neighbourId: string | null = null;
  if (!surfaceId && subject.mountKind !== "ceiling") {
    const s = sideBySide({ ...subject, elevation }, position, rotation, ctx, exclude, wallInfo);
    position = s.position;
    neighbourId = s.neighbourId;
  }

  // 4. clearances
  warnings.push(
    ...clearanceWarnings({ ...subject, elevation }, position, rotation, elevation, ctx, exclude, clearance),
  );
  return {
    position: { x: Math.round(position.x), y: Math.round(position.y) },
    rotation: normalizeDeg(Math.round(rotation * 1000) / 1000),
    elevation: Math.round(elevation),
    parentId,
    surfaceId,
    wallId,
    neighbourId,
    warnings,
  };
}

// ---- free stretches along a room edge (anchors) ------------------------------------------------------------

/**
 * Intervals along the room edge from `a` to `b` (mm from `a`) where an item of this size can stand
 * against the wall: not across a door's swing, a passage, a window lower than the item, or an item
 * already there (spec 05 section 5 anchors: the longest free segment).
 */
export function freeRunsAlongEdge(
  project: Project,
  levelId: string,
  a: Point,
  b: Point,
  outward: Point,
  size: Size3,
  sizes: derive.SizeSource,
  exclude: readonly string[] = [],
): { from: number; to: number }[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len === 0) return [];
  const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const inward = neg(outward);
  const depth = size.d + 50;
  const band = [a, b, add(b, mul(inward, depth)), add(a, mul(inward, depth))];
  const blocked: [number, number][] = [];
  const along = (q: Point) => dot(sub(q, a), u);
  const block = (shape: readonly Point[]) => {
    const c = poly.clipByConvex(shape, band);
    if (c.length >= 3 && poly.area(c) > 100) {
      const ts = c.map(along);
      blocked.push([Math.min(...ts), Math.max(...ts)]);
    }
  };
  for (const z of doorSwingZones(project, levelId)) block(z.polygon);
  for (const o of project.openings) {
    if (o.levelId !== levelId || o.kind === "door") continue;
    if (o.kind === "window" && o.sill >= size.h) continue;
    const w = project.walls.find((x) => x.id === o.wallId);
    if (!w) continue;
    const c = derive.openingCentre(o, w);
    if (poly.distancePointSegment(c, a, b) > w.thickness / 2 + 60) continue;
    const iv = derive.openingAlongInterval(o, w);
    const wl = derive.wallLength(w);
    if (wl === 0) continue;
    const t1 = along(derive.pointAlongWall(w, iv.from / wl));
    const t2 = along(derive.pointAlongWall(w, iv.to / wl));
    blocked.push([Math.min(t1, t2), Math.max(t1, t2)]);
  }
  const skip = new Set(exclude);
  for (const it of project.items) {
    if (it.levelId !== levelId || skip.has(it.id) || it.mount.kind === "ceiling" || it.elevation >= size.h)
      continue;
    const s = derive.itemSize(it, sizes);
    if (s) block(derive.itemFootprint(it, s));
  }
  blocked.sort((x, y) => x[0] - y[0]);
  const runs: { from: number; to: number }[] = [];
  let cursor = 0;
  for (const [lo, hi] of blocked) {
    if (lo > cursor) runs.push({ from: cursor, to: Math.min(lo, len) });
    cursor = Math.max(cursor, hi);
  }
  if (cursor < len) runs.push({ from: cursor, to: len });
  return runs.filter((r) => r.to - r.from > 0);
}

// ---- drag helpers (editor gestures, ADR-016 D4) --------------------------------------------------------------

/** With the alignment modifier the cursor moves only along 15 degree rays from the press point (F-079). */
export function alignedDragPoint(press: Point, cursor: Point): Point {
  const d = sub(cursor, press);
  const len = Math.hypot(d.x, d.y);
  if (len === 0) return { ...cursor };
  const step = 15;
  const angle = Math.round((Math.atan2(d.y, d.x) * 180) / Math.PI / step) * step;
  const r = (angle * Math.PI) / 180;
  return { x: press.x + Math.cos(r) * len, y: press.y + Math.sin(r) * len };
}

/**
 * A single-item drag: every move restores the item as it was at press time and translates it by the
 * total delta before the pipeline runs, so magnetism never accumulates (F-080). Presses within the first
 * 100 ms are ignored (F-081).
 */
export class DragSession {
  readonly startMs: number;
  constructor(
    private readonly original: Subject,
    private readonly ctx: PlacementContext,
    startMs: number,
    private readonly ignoreMs = 100,
  ) {
    this.startMs = startMs;
  }

  accepts(nowMs: number): boolean {
    return nowMs - this.startMs >= this.ignoreMs;
  }

  move(dx: number, dy: number, magnetism = true): PlacementResult {
    const moved = {
      ...this.original,
      position: { x: this.original.position.x + dx, y: this.original.position.y + dy },
    };
    if (!magnetism)
      return {
        position: moved.position,
        rotation: moved.rotation,
        elevation: moved.elevation,
        parentId: moved.parentId,
        surfaceId: null,
        wallId: null,
        neighbourId: null,
        warnings: [],
      };
    return placeItem(moved, this.ctx, {
      forceOrientation: false,
      adjustElevation: true,
      adjustOnlyNullElevation: true,
    });
  }
}

/** Sizes dragged in by hand snap to whole millimetres (F-098 in mm). */
export function magnetizedSize(size: Size3): Size3 {
  const r = (v: number) => Math.max(1, Math.round(v));
  return { w: r(size.w), d: r(size.d), h: r(size.h) };
}

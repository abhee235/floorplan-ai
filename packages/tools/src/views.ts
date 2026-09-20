// Result fragments shared by tools (spec 04 section 1). Views carry the derived numbers a model would
// otherwise compute: lengths, compass sides, areas, footprints, free wall segments.
import type { Item, Opening, Point, PrimitiveRecipe, Project, Room, Wall } from "@fpv/ir";
import { derive, finishNameOf, poly } from "@fpv/ir";
import { z } from "zod";
import type { CatalogSearch } from "./context.js";

const PointS = z.object({ x: z.number(), y: z.number() });
const Size3S = z.object({ w: z.number(), d: z.number(), h: z.number() });
const CompassS = z.enum(["north", "south", "east", "west"]);
const RectS = z.object({ minX: z.number(), minY: z.number(), maxX: z.number(), maxY: z.number() });

/**
 * Who made this and whether a person has had a hand in it (ADR-023 D3).
 *
 * Present on a view only when the answer is "not yours to change freely", so a model reading a
 * scene of its own work sees nothing extra, and the one line it does see is the one that matters.
 */
export const ByS = z.object({
  createdBy: z.enum(["person", "agent", "import", "unknown"]),
  editedBy: z.enum(["person", "agent", "import", "unknown"]),
  /** True means ask before changing this (ask_user, kind consent). */
  askFirst: z.boolean(),
});

/** The stamp as a view field, or nothing when the agent may change the thing without asking. */
function byOf(e: { by?: { createdBy: string; editedBy: string; touchedByPerson: boolean } }): {
  by?: z.infer<typeof ByS>;
} {
  const by = e.by;
  if (!by) return {};
  const askFirst = by.touchedByPerson || by.createdBy === "import";
  if (!askFirst) return {};
  return {
    by: {
      createdBy: by.createdBy as "person",
      editedBy: by.editedBy as "person",
      askFirst,
    },
  };
}

export const WallViewS = z.object({
  id: z.string(),
  levelId: z.string(),
  start: PointS,
  end: PointS,
  lengthMm: z.number(),
  angleDeg: z.number(),
  thickness: z.number(),
  height: z.number(),
  kind: z.string(),
  /** Present only when the plan fills the wall other than solid. */
  pattern: z.string().optional(),
  arcExtent: z.number().nullable(),
  compass: z.object({ left: CompassS, right: CompassS }),
  joins: z.object({ start: z.string().nullable(), end: z.string().nullable() }),
  openingIds: z.array(z.string()),
  by: ByS.optional(),
  /** Present only when a face has a colour, a finish or a baseboard, so plain walls stay short. */
  faces: z
    .array(
      z.object({
        facing: CompassS,
        colour: z.string().nullable(),
        finish: z.enum(["matt", "satin", "gloss"]),
        baseboard: z
          .object({ height: z.number(), depth: z.number(), colour: z.string().nullable() })
          .nullable(),
      }),
    )
    .optional(),
});
export type WallView = z.infer<typeof WallViewS>;

export const OpeningViewS = z.object({
  id: z.string(),
  wallId: z.string(),
  kind: z.string(),
  atMm: z.number(),
  position: z.number(),
  width: z.number(),
  height: z.number(),
  sill: z.number(),
  hinge: CompassS.nullable(),
  swingDirection: z.enum(["left", "right"]).nullable(),
  productId: z.string().nullable(),
  by: ByS.optional(),
});
export type OpeningView = z.infer<typeof OpeningViewS>;

export const RoomWallS = z.object({
  wallId: z.string(),
  compass: CompassS,
  fromMm: z.number(),
  toMm: z.number(),
});
export const RoomViewS = z.object({
  id: z.string(),
  levelId: z.string(),
  name: z.string().nullable(),
  purpose: z.string(),
  capacity: z.number().nullable(),
  areaM2: z.number(),
  perimeterMm: z.number(),
  bounds: RectS,
  walls: z.array(RoomWallS),
  openingIds: z.array(z.string()),
  itemIds: z.array(z.string()),
  ceilingHeight: z.number(),
  source: z.string(),
  stale: z.boolean(),
  by: ByS.optional(),
});
export type RoomView = z.infer<typeof RoomViewS>;

export const ItemViewS = z.object({
  id: z.string(),
  levelId: z.string(),
  productId: z.string().nullable(),
  recipe: z.unknown().nullable(),
  name: z.string(),
  category: z.string(),
  position: PointS,
  rotation: z.number(),
  elevation: z.number(),
  size: Size3S.nullable(),
  footprint: z.array(PointS),
  bounds3: z
    .object({
      min: z.tuple([z.number(), z.number(), z.number()]),
      max: z.tuple([z.number(), z.number(), z.number()]),
    })
    .nullable(),
  roomId: z.string().nullable(),
  parentId: z.string().nullable(),
  mount: z.object({ kind: z.string(), targetId: z.string().nullable(), height: z.number().nullable() }),
  verified: z.boolean(),
  by: ByS.optional(),
});
export type ItemView = z.infer<typeof ItemViewS>;

export const FreeSegmentS = RoomWallS.extend({ lengthMm: z.number() });
export type FreeSegment = z.infer<typeof FreeSegmentS>;

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function wallView(p: Project, w: Wall): WallView {
  const level = derive.levelOf(p, w.levelId);
  return {
    id: w.id,
    levelId: w.levelId,
    start: w.start,
    end: w.end,
    lengthMm: r1(derive.wallLength(w)),
    angleDeg: r1(derive.wallAngle(w)),
    thickness: w.thickness,
    height: level ? derive.wallHeight(w, level) : (w.height ?? 0),
    kind: w.kind,
    ...(w.pattern === "solid" ? {} : { pattern: w.pattern }),
    arcExtent: w.arcExtent,
    compass: {
      left: derive.wallCompassSide(w, "left", p.meta.north),
      right: derive.wallCompassSide(w, "right", p.meta.north),
    },
    joins: { start: w.joins.start?.wallId ?? null, end: w.joins.end?.wallId ?? null },
    openingIds: p.openings.filter((o) => o.wallId === w.id).map((o) => o.id),
    ...byOf(w),
    ...facesOf(p, w),
  };
}

/** A wall's faces by compass, for walls where a face carries anything; nothing otherwise. */
function facesOf(p: Project, w: Wall): { faces?: NonNullable<WallView["faces"]> } {
  const sides = (["left", "right"] as const).filter((s) => w.finishes[s] || w.skirting[s]);
  if (sides.length === 0) return {};
  return {
    faces: sides.map((s) => {
      const f = w.finishes[s];
      const b = w.skirting[s];
      return {
        facing: derive.wallCompassSide(w, s, p.meta.north),
        colour: f?.color ?? null,
        finish: finishNameOf(f?.shininess ?? null),
        baseboard: b ? { height: b.height, depth: b.thickness, colour: b.color } : null,
      };
    }),
  };
}

export function openingView(p: Project, o: Opening): OpeningView {
  const w = p.walls.find((x) => x.id === o.wallId);
  return {
    id: o.id,
    wallId: o.wallId,
    kind: o.kind,
    atMm: w ? r1(o.position * derive.wallLength(w)) : 0,
    position: o.position,
    width: o.width,
    height: o.height,
    sill: o.sill,
    hinge: w ? derive.openingHingeCompass(o, w, p.meta.north) : null,
    swingDirection: o.swing?.direction ?? null,
    productId: o.productId,
    ...byOf(o),
  };
}

/** Walls that bound a room: the recorded ids, else walls whose centreline runs along the polygon. */
export function roomWalls(p: Project, r: Room): Wall[] {
  const byId = new Map(p.walls.map((w) => [w.id, w]));
  const listed = r.boundingWallIds.map((id) => byId.get(id)).filter((w): w is Wall => w !== undefined);
  if (listed.length > 0) return listed;
  return p.walls.filter((w) => w.levelId === r.levelId && wallTouchesRoom(w, r));
}

function wallTouchesRoom(w: Wall, r: Room): boolean {
  const run = derive.roomWallRun(w, r);
  return run !== null && run.toMm - run.fromMm >= derive.MIN_WALL_SHARE_MM;
}

/**
 * Which side of the wall the room lies on, by probing off the centreline in the middle of the
 * stretch they share -- not the middle of the wall, which for a shared wall can be in another room.
 */
export function roomSideOfWall(w: Wall, r: Room): derive.Side {
  const len = derive.wallLength(w);
  const run = derive.roomWallRun(w, r);
  const t = run && len > 0 ? Math.min(1, Math.max(0, (run.fromMm + run.toMm) / 2 / len)) : 0.5;
  const mid = derive.pointAlongWall(w, t);
  const n = derive.wallSideNormal(w, "left");
  // far enough to clear the wall's face and any gap the room was drawn with
  const d = w.thickness / 2 + derive.WALL_ROOM_GAP_MM + 10;
  const leftProbe = { x: mid.x + n.x * d, y: mid.y + n.y * d };
  return derive.roomContains(r, leftProbe) ? "left" : "right";
}

/** The compass word of a bounding wall as seen from inside the room: its outward normal. */
export function roomWallCompass(p: Project, w: Wall, r: Room): derive.Compass {
  const roomSide = roomSideOfWall(w, r);
  const outward: derive.Side = roomSide === "left" ? "right" : "left";
  return derive.wallCompassSide(w, outward, p.meta.north);
}

/** Interval of the wall (mm from its start) that runs along the room polygon. */
export function roomWallInterval(w: Wall, r: Room): { fromMm: number; toMm: number } {
  const len = derive.wallLength(w);
  if (len === 0) return { fromMm: 0, toMm: 0 };
  const run = derive.roomWallRun(w, r);
  return run ? { fromMm: r1(run.fromMm), toMm: r1(run.toMm) } : { fromMm: 0, toMm: r1(len) };
}

export function roomView(p: Project, r: Room, sizes: derive.SizeSource, stale = false): RoomView {
  const level = derive.levelOf(p, r.levelId);
  const walls = roomWalls(p, r);
  const wallIds = new Set(walls.map((w) => w.id));
  const b = derive.roomBounds(r);
  return {
    id: r.id,
    levelId: r.levelId,
    name: r.name,
    purpose: r.purpose,
    capacity: r.capacity,
    areaM2: r2(derive.roomArea(r) / 1e6),
    perimeterMm: r1(derive.roomPerimeter(r)),
    bounds: { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY },
    walls: walls.map((w) => ({ wallId: w.id, compass: roomWallCompass(p, w, r), ...roomWallInterval(w, r) })),
    openingIds: p.openings.filter((o) => wallIds.has(o.wallId)).map((o) => o.id),
    itemIds: p.items
      .filter(
        (i) =>
          i.roomId === r.id ||
          (i.roomId === null && i.levelId === r.levelId && derive.roomContains(r, i.position)),
      )
      .map((i) => i.id),
    ceilingHeight: r.ceilingHeight ?? level?.height ?? 0,
    source: r.source,
    stale,
    ...byOf(r),
  };
}

function recipeName(recipe: PrimitiveRecipe): string {
  switch (recipe.kind) {
    case "box":
    case "cylinder":
      return recipe.label;
    case "table":
      return `${recipe.shape} table`;
    case "display":
      return `${recipe.diagonalIn} inch display`;
    default:
      return recipe.kind;
  }
}

export function itemView(
  p: Project,
  it: Item,
  sizes: derive.SizeSource,
  catalog: CatalogSearch | null,
): ItemView {
  const size = derive.itemSize(it, sizes);
  const level = derive.levelOf(p, it.levelId);
  const footprint = size ? derive.itemFootprint(it, size) : [];
  const ground = level ? derive.itemGroundElevation(it, level) : it.elevation;
  let name: string;
  let category: string;
  let verified = true;
  let productId: string | null = null;
  let recipe: PrimitiveRecipe | null = null;
  if (it.ref.kind === "recipe") {
    recipe = it.ref.recipe;
    name = recipeName(recipe);
    category = recipe.kind;
  } else {
    productId = it.ref.productId;
    const snap = p.catalogRefs[productId] as
      | { name?: string; category?: string; status?: string }
      | undefined;
    const prod = snap ?? catalog?.product(productId) ?? null;
    name = prod?.name ?? productId;
    category = prod?.category ?? "unknown";
    verified = prod?.status === "verified";
  }
  const fb = footprint.length ? poly.bounds(footprint) : null;
  return {
    id: it.id,
    levelId: it.levelId,
    productId,
    recipe,
    name,
    category,
    position: it.position,
    rotation: it.rotation,
    elevation: it.elevation,
    size,
    footprint: footprint.map((q) => ({ x: r1(q.x), y: r1(q.y) })),
    bounds3:
      fb && size ? { min: [fb.minX, fb.minY, ground], max: [fb.maxX, fb.maxY, ground + size.h] } : null,
    roomId: it.roomId ?? derive.containingRoom(p, it.levelId, it.position)?.id ?? null,
    parentId: it.parentId,
    mount: it.mount,
    verified,
    ...byOf(it),
  };
}

/** Intervals along a room wall not blocked by openings or by items standing against it (spec 04 describe_room). */
/**
 * What a free run of wall is free of.
 *
 * By default every opening takes its span out, which is what `describe_room` should say: a wall
 * with a window in it is not free for a bookcase. A caller placing something lower than the sill
 * passes `blocks` to say otherwise, because a bed under a window is where a bed goes.
 */
export interface FreeSegmentOptions {
  blocks?(opening: Opening): boolean;
}

export function freeSegments(
  p: Project,
  r: Room,
  sizes: derive.SizeSource,
  minMm = 300,
  options: FreeSegmentOptions = {},
): FreeSegment[] {
  const out: FreeSegment[] = [];
  const items = p.items.filter(
    (i) => i.levelId === r.levelId && (i.roomId === r.id || derive.roomContains(r, i.position)),
  );
  for (const w of roomWalls(p, r)) {
    const { fromMm, toMm } = roomWallInterval(w, r);
    const compass = roomWallCompass(p, w, r);
    const len = derive.wallLength(w);
    if (len === 0) continue;
    const dx = (w.end.x - w.start.x) / len;
    const dy = (w.end.y - w.start.y) / len;
    const blocked: { a: number; b: number }[] = [];
    for (const o of p.openings) {
      if (o.wallId !== w.id) continue;
      if (options.blocks && !options.blocks(o)) continue;
      const iv = derive.openingAlongInterval(o, w);
      blocked.push({ a: iv.from, b: iv.to });
    }
    const near = w.thickness / 2 + 150;
    for (const it of items) {
      const size = derive.itemSize(it, sizes);
      if (!size) continue;
      const fp = derive.itemFootprint(it, size);
      if (Math.min(...fp.map((q) => poly.distancePointSegment(q, w.start, w.end))) > near) continue;
      const us = fp.map((q) => (q.x - w.start.x) * dx + (q.y - w.start.y) * dy);
      blocked.push({ a: Math.min(...us), b: Math.max(...us) });
    }
    blocked.sort((x, y) => x.a - y.a);
    let cursor = fromMm;
    const push = (a: number, b: number) => {
      if (b - a >= minMm)
        out.push({ wallId: w.id, compass, fromMm: r1(a), toMm: r1(b), lengthMm: r1(b - a) });
    };
    for (const seg of blocked) {
      if (seg.a > cursor) push(cursor, Math.min(seg.a, toMm));
      cursor = Math.max(cursor, seg.b);
    }
    if (cursor < toMm) push(cursor, toMm);
  }
  return out;
}

/** Prefer a door-free wall opposite the door, else the wall with the longest free run. */
export function suggestedDisplayWall(p: Project, r: Room, free: FreeSegment[]): derive.Compass | null {
  const walls = roomWalls(p, r);
  const doorWalls = new Set(
    p.openings
      .filter((o) => o.kind !== "window" && walls.some((w) => w.id === o.wallId))
      .map((o) => o.wallId),
  );
  const opposite: Record<derive.Compass, derive.Compass> = {
    north: "south",
    south: "north",
    east: "west",
    west: "east",
  };
  const doorSides = new Set(
    [...doorWalls].map((id) => roomWallCompass(p, walls.find((w) => w.id === id) as Wall, r)),
  );
  const candidates = free.filter((f) => !doorWalls.has(f.wallId)).sort((a, b) => b.lengthMm - a.lengthMm);
  if (candidates.length === 0) return free[0]?.compass ?? null;
  for (const side of doorSides) {
    const facing = candidates.find((c) => c.compass === opposite[side]);
    if (facing) return facing.compass;
  }
  return candidates[0]?.compass ?? null;
}

/** Nearest-edge distance between two point sets treated as closed rings (or single points). */
export function ringDistance(a: readonly Point[], b: readonly Point[]): number {
  if (a.length === 0 || b.length === 0) return Number.NaN;
  if (
    a.length > 2 &&
    b.length > 2 &&
    (poly.polygonsIntersect(a, b) ||
      poly.containsPoint(a, b[0] as Point) ||
      poly.containsPoint(b, a[0] as Point))
  )
    return 0;
  let best = Number.POSITIVE_INFINITY;
  const edges = (ring: readonly Point[]) =>
    ring.length === 1
      ? [[ring[0] as Point, ring[0] as Point]]
      : ring.map((q, i) => [q, ring[(i + 1) % ring.length] as Point]);
  for (const q of a)
    for (const [s, e] of edges(b))
      best = Math.min(best, poly.distancePointSegment(q, s as Point, e as Point));
  for (const q of b)
    for (const [s, e] of edges(a))
      best = Math.min(best, poly.distancePointSegment(q, s as Point, e as Point));
  return best;
}

export function centroidOf(ring: readonly Point[]): Point {
  if (ring.length === 1) return ring[0] as Point;
  const b = poly.bounds(ring);
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

/** Outline of any entity in plan mm, for measure and bbox filters. */
export function entityOutline(p: Project, id: string, sizes: derive.SizeSource): Point[] | null {
  const w = p.walls.find((x) => x.id === id);
  if (w) return derive.wallFootprintUnjoined(w);
  const o = p.openings.find((x) => x.id === id);
  if (o) {
    const ow = p.walls.find((x) => x.id === o.wallId);
    return ow ? derive.openingFootprint(o, ow, 0) : null;
  }
  const r = p.rooms.find((x) => x.id === id);
  if (r) return r.polygon;
  const it = p.items.find((x) => x.id === id);
  if (it) {
    const size = derive.itemSize(it, sizes);
    return size ? derive.itemFootprint(it, size) : [it.position];
  }
  const zn = p.zones.find((x) => x.id === id);
  if (zn) return zn.polygon;
  return null;
}

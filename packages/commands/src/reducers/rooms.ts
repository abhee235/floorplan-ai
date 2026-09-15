// Room reducers (spec 03 section 2; ledger R-025, R-040, R-041, R-056..R-058, R-014, R-149).

import { detectEnclosures, detectRoomAt, wallFootprints } from "@fpv/geometry";
import type { Point, Project, Room } from "@fpv/ir";
import { defaultRoom, derive, normalizeRoom, poly } from "@fpv/ir";
import { type Changes, type Ctx, levelById, roomById } from "../context.js";
import { precondition } from "../errors.js";
import type { PayloadOf } from "../types.js";

function assignItemsByContainment(p: Project, room: Room, changes: Changes): void {
  for (const it of p.items) {
    if (it.levelId !== room.levelId) continue;
    const inside = derive.roomContains(room, it.position);
    if (inside && it.roomId === null) {
      it.roomId = room.id;
      changes.update("item", it.id);
    } else if (!inside && it.roomId === room.id) {
      it.roomId = derive.containingRoom(p, it.levelId, it.position)?.id ?? null;
      changes.update("item", it.id);
    }
  }
}

function intersectingRooms(
  p: Project,
  levelId: string,
  polygons: readonly (readonly Point[])[],
  excludeId: string,
): Room[] {
  return p.rooms.filter(
    (r) =>
      r.id !== excludeId &&
      r.levelId === levelId &&
      polygons.some((pg) => poly.polygonsIntersect(r.polygon, pg)),
  );
}

export function roomCreate(p: Project, payload: PayloadOf<"room.create">, ctx: Ctx, changes: Changes): Room {
  levelById(p, payload.levelId);
  const given = [payload.polygon, payload.rect, payload.atPoint].filter((x) => x !== undefined).length;
  if (given !== 1) throw precondition("command.payload", "give exactly one of polygon, rect, or atPoint");
  let polygon: Point[];
  let source: Room["source"] = "manual";
  let boundingWallIds: string[] = [];
  if (payload.polygon) {
    polygon = payload.polygon;
  } else if (payload.rect) {
    const { x, y, w, d } = payload.rect;
    polygon = [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + d },
      { x, y: y + d },
    ];
  } else {
    const walls = p.walls.filter((w) => w.levelId === payload.levelId);
    const openings = p.openings.filter((o) => o.levelId === payload.levelId);
    const detected = detectRoomAt(
      walls,
      openings,
      payload.atPoint as Point,
      payload.gapToleranceMm !== undefined ? { gap: payload.gapToleranceMm } : {},
    );
    if (!detected) {
      throw precondition(
        "room.not-enclosed",
        `no walls enclose (${(payload.atPoint as Point).x}, ${(payload.atPoint as Point).y})`,
        null,
        "check for gaps with get_scene, or pass a polygon",
      );
    }
    polygon = detected.polygon.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) }));
    source = "detected";
    boundingWallIds = detected.wallIds;
  }
  const room = defaultRoom(ctx.ids.next("room"), payload.levelId, polygon, {
    source,
    boundingWallIds,
    ...(payload.name !== undefined ? { name: payload.name } : {}),
    ...(payload.purpose !== undefined ? { purpose: payload.purpose } : {}),
    ...(payload.capacity !== undefined ? { capacity: payload.capacity } : {}),
  });
  p.rooms.push(normalizeRoom(room));
  const stored = roomById(p, room.id);
  changes.add("room", stored.id);
  assignItemsByContainment(p, stored, changes);
  return stored;
}

/** Detect every enclosure not already covered by a room; optionally refresh stale detected rooms (R-040). */
export function roomDetectAll(
  p: Project,
  payload: PayloadOf<"room.detectAll">,
  ctx: Ctx,
  changes: Changes,
): Room[] {
  levelById(p, payload.levelId);
  const walls = p.walls.filter((w) => w.levelId === payload.levelId);
  const openings = p.openings.filter((o) => o.levelId === payload.levelId);
  const fps = wallFootprints(walls);
  const opts = {
    footprints: fps,
    ...(payload.gapToleranceMm !== undefined ? { gap: payload.gapToleranceMm } : {}),
  };
  const out: Room[] = [];
  if (payload.replaceStale) {
    for (const r of p.rooms) {
      if (r.levelId !== payload.levelId || r.source !== "detected" || r.properties.__stale !== "true")
        continue;
      const pole = poly.poleOfInaccessibility(r.polygon, r.holes);
      const d = detectRoomAt(walls, openings, pole, opts);
      if (d) {
        r.polygon = d.polygon.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) }));
        r.boundingWallIds = d.wallIds;
        delete r.properties.__stale;
        changes.update("room", r.id);
        out.push(r);
      }
    }
  }
  for (const e of detectEnclosures(walls, opts)) {
    const pole = poly.poleOfInaccessibility(e.polygon);
    const covered = p.rooms.some((r) => r.levelId === payload.levelId && derive.roomContains(r, pole));
    if (covered) continue;
    const d = detectRoomAt(walls, openings, pole, opts);
    if (!d) continue;
    const room = defaultRoom(
      ctx.ids.next("room"),
      payload.levelId,
      d.polygon.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) })),
      {
        source: "detected",
        boundingWallIds: d.wallIds,
      },
    );
    p.rooms.push(normalizeRoom(room));
    const stored = roomById(p, room.id);
    changes.add("room", stored.id);
    assignItemsByContainment(p, stored, changes);
    out.push(stored);
  }
  return out;
}

export function roomModify(p: Project, payload: PayloadOf<"room.modify">, _ctx: Ctx, changes: Changes): Room {
  const r = roomById(p, payload.roomId);
  Object.assign(r, payload.changes);
  Object.assign(r, normalizeRoom(r));
  changes.update("room", r.id);
  return r;
}

function replaceGeometry(
  p: Project,
  r: Room,
  polygon: Point[],
  holes: Point[][] | undefined,
  changes: Changes,
): Room {
  const old = r.polygon;
  r.polygon = polygon.map((q) => ({ x: q.x, y: q.y }));
  if (holes) r.holes = holes.map((h) => h.map((q) => ({ x: q.x, y: q.y })));
  r.source = "manual";
  delete r.properties.__stale;
  Object.assign(r, normalizeRoom(r));
  changes.update("room", r.id);
  for (const other of intersectingRooms(p, r.levelId, [old, r.polygon], r.id))
    changes.update("room", other.id);
  assignItemsByContainment(p, r, changes);
  return r;
}

export function roomSetPolygon(
  p: Project,
  payload: PayloadOf<"room.setPolygon">,
  _ctx: Ctx,
  changes: Changes,
): Room {
  const r = roomById(p, payload.roomId);
  return replaceGeometry(p, r, payload.polygon, payload.holes, changes);
}

/** Insert on the nearest edge, projected onto it (R-056 reversed). */
export function roomAddPoint(
  p: Project,
  payload: PayloadOf<"room.addPoint">,
  _ctx: Ctx,
  changes: Changes,
): Room {
  const r = roomById(p, payload.roomId);
  const n = r.polygon.length;
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  let bestPoint: Point = payload.point;
  for (let i = 0; i < n; i += 1) {
    const a = r.polygon[i] as Point;
    const b = r.polygon[(i + 1) % n] as Point;
    const d = poly.distancePointSegment(payload.point, a, b);
    if (d < bestD) {
      bestD = d;
      best = i;
      bestPoint = poly.projectOntoSegment(payload.point, a, b).point;
    }
  }
  const polygon = [...r.polygon];
  polygon.splice(best + 1, 0, { x: Math.round(bestPoint.x), y: Math.round(bestPoint.y) });
  return replaceGeometry(p, r, polygon, undefined, changes);
}

export function roomMovePoint(
  p: Project,
  payload: PayloadOf<"room.movePoint">,
  _ctx: Ctx,
  changes: Changes,
): Room {
  const r = roomById(p, payload.roomId);
  if (payload.index >= r.polygon.length)
    throw precondition(
      "room.point-index",
      `index must be below ${r.polygon.length}, got ${payload.index}`,
      r.id,
    );
  const polygon = [...r.polygon];
  polygon[payload.index] = { x: payload.point.x, y: payload.point.y };
  return replaceGeometry(p, r, polygon, undefined, changes);
}

/** Refused below three points (R-057 reversed). */
export function roomRemovePoint(
  p: Project,
  payload: PayloadOf<"room.removePoint">,
  _ctx: Ctx,
  changes: Changes,
): Room {
  const r = roomById(p, payload.roomId);
  if (payload.index >= r.polygon.length)
    throw precondition(
      "room.point-index",
      `index must be below ${r.polygon.length}, got ${payload.index}`,
      r.id,
    );
  if (r.polygon.length <= 3)
    throw precondition("room.too-few-points", "a room needs at least three points", r.id);
  const polygon = r.polygon.filter((_, i) => i !== payload.index);
  return replaceGeometry(p, r, polygon, undefined, changes);
}

export function roomDelete(p: Project, payload: PayloadOf<"room.delete">, _ctx: Ctx, changes: Changes): void {
  for (const id of payload.roomIds) {
    const r = roomById(p, id);
    p.rooms.splice(p.rooms.indexOf(r), 1);
    changes.remove("room", id);
    for (const it of p.items) {
      if (it.roomId === id) {
        it.roomId = derive.containingRoom(p, it.levelId, it.position)?.id ?? null;
        changes.update("item", it.id);
      }
    }
  }
}

// Wall reducers (spec 03 section 2; ledger W-013..W-047, W-067..W-071, W-084, W-086..W-088, W-135..W-154).

import { intersectLines, snapToFreeWallEnd } from "@fpv/geometry";
import type { Join, Point, Project, Wall } from "@fpv/ir";
import { DEFAULTS, defaultWall, derive, normalizeWall } from "@fpv/ir";
import { type Changes, type Ctx, levelById, requireTextures, wallById } from "../context.js";
import { precondition } from "../errors.js";
import type { PayloadOf } from "../types.js";

type End = "start" | "end";

/** Set a join on one wall and the reciprocal join on the partner, detaching previous partners (W-013, W-014). */
export function setJoin(p: Project, wallId: string, end: End, join: Join | null, changes: Changes): void {
  const w = wallById(p, wallId);
  const previous = w.joins[end];
  if (previous) {
    const partner = p.walls.find((x) => x.id === previous.wallId);
    if (partner && partner.joins[previous.end]?.wallId === w.id) {
      partner.joins[previous.end] = null;
      changes.update("wall", partner.id);
    }
  }
  w.joins[end] = join;
  changes.update("wall", w.id);
  if (join) {
    if (join.wallId === w.id) throw precondition("wall.self-join", `wall ${w.id} may not join itself`, w.id);
    const other = wallById(p, join.wallId);
    if (other.levelId !== w.levelId)
      throw precondition("wall.join-cross-level", `wall ${other.id} is on another level`, w.id);
    const a = w[end];
    const b = other[join.end];
    if (a.x !== b.x || a.y !== b.y) {
      throw precondition(
        "wall.join-endpoint-mismatch",
        `wall ${w.id}.${end} (${a.x}, ${a.y}) must coincide with ${other.id}.${join.end} (${b.x}, ${b.y})`,
        w.id,
        "move one endpoint onto the other first, or use wall.join",
      );
    }
    const back = other.joins[join.end];
    if (back && back.wallId !== w.id) {
      const third = p.walls.find((x) => x.id === back.wallId);
      if (third && third.joins[back.end]?.wallId === other.id) {
        third.joins[back.end] = null;
        changes.update("wall", third.id);
      }
    }
    other.joins[join.end] = { wallId: w.id, end };
    changes.update("wall", other.id);
  }
}

function openingsOn(p: Project, wallId: string) {
  return p.openings.filter((o) => o.wallId === wallId);
}

function touchWallDependents(p: Project, w: Wall, changes: Changes): void {
  for (const end of ["start", "end"] as const) {
    const j = w.joins[end];
    if (j) changes.update("wall", j.wallId);
  }
  for (const o of openingsOn(p, w.id)) changes.update("opening", o.id);
  for (const r of p.rooms) {
    if (r.source === "detected" && r.boundingWallIds.includes(w.id)) {
      r.properties.__stale = "true";
      changes.update("room", r.id);
    }
  }
}

export function wallCreate(p: Project, payload: PayloadOf<"wall.create">, ctx: Ctx, changes: Changes): Wall {
  levelById(p, payload.levelId);
  if (payload.start.x === payload.end.x && payload.start.y === payload.end.y) {
    throw precondition("wall.zero-length", "start must differ from end", null);
  }
  const w = defaultWall(ctx.ids.next("wall"), payload.levelId, payload.start, payload.end, {
    kind: payload.kind ?? "interior",
    ...(payload.thickness !== undefined ? { thickness: payload.thickness } : {}),
    ...(payload.height !== undefined ? { height: payload.height } : {}),
    ...(payload.heightAtEnd !== undefined ? { heightAtEnd: payload.heightAtEnd } : {}),
    ...(payload.arcExtent !== undefined ? { arcExtent: payload.arcExtent } : {}),
  });
  p.walls.push(normalizeWall(w));
  changes.add("wall", w.id);
  if (payload.joinStart) setJoin(p, w.id, "start", payload.joinStart, changes);
  if (payload.joinEnd) setJoin(p, w.id, "end", payload.joinEnd, changes);
  return wallById(p, w.id);
}

/** Polyline of walls joined in sequence; ends snap to existing free wall ends within snapMm (W-067..W-070). */
export function wallCreateChain(
  p: Project,
  payload: PayloadOf<"wall.createChain">,
  ctx: Ctx,
  changes: Changes,
): Wall[] {
  levelById(p, payload.levelId);
  const pts: Point[] = [];
  for (const q of payload.points) {
    const last = pts[pts.length - 1];
    if (last && last.x === q.x && last.y === q.y) continue; // W-067 zero-length segments dropped
    pts.push({ x: q.x, y: q.y });
  }
  if (pts.length < 2) throw precondition("wall.zero-length", "at least two distinct points are required");
  if (payload.closed && pts.length < 3)
    throw precondition("wall.chain-too-short", "a closed chain needs at least three distinct points");
  const snapMm = payload.snapMm ?? 20;
  const existing = p.walls.filter((w) => w.levelId === payload.levelId);
  const startSnap = snapMm > 0 ? snapToFreeWallEnd(pts[0] as Point, existing, snapMm) : null;
  const endSnap =
    !payload.closed && snapMm > 0 ? snapToFreeWallEnd(pts[pts.length - 1] as Point, existing, snapMm) : null;
  if (startSnap) pts[0] = { ...startSnap.point };
  if (endSnap && !(startSnap && endSnap.wallId === startSnap.wallId && endSnap.end === startSnap.end)) {
    pts[pts.length - 1] = { ...endSnap.point };
  }
  const created: Wall[] = [];
  const segments = payload.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segments; i += 1) {
    const a = pts[i] as Point;
    const b = pts[(i + 1) % pts.length] as Point;
    if (a.x === b.x && a.y === b.y) continue;
    const w = defaultWall(ctx.ids.next("wall"), payload.levelId, a, b, {
      kind: payload.kind ?? "interior",
      ...(payload.thickness !== undefined ? { thickness: payload.thickness } : {}),
      ...(payload.height !== undefined ? { height: payload.height } : {}),
    });
    p.walls.push(w);
    changes.add("wall", w.id);
    created.push(wallById(p, w.id));
  }
  for (let i = 0; i + 1 < created.length; i += 1) {
    setJoin(
      p,
      (created[i] as Wall).id,
      "end",
      { wallId: (created[i + 1] as Wall).id, end: "start" },
      changes,
    );
  }
  if (payload.closed && created.length >= 3) {
    setJoin(
      p,
      (created[created.length - 1] as Wall).id,
      "end",
      { wallId: (created[0] as Wall).id, end: "start" },
      changes,
    );
  }
  if (startSnap && created.length) {
    const first = created[0] as Wall;
    if (!first.joins.start)
      setJoin(p, first.id, "start", { wallId: startSnap.wallId, end: startSnap.end }, changes);
  }
  if (endSnap && created.length && !payload.closed) {
    const last = created[created.length - 1] as Wall;
    const partner = wallById(p, endSnap.wallId);
    if (!last.joins.end && !partner.joins[endSnap.end]) {
      setJoin(p, last.id, "end", { wallId: endSnap.wallId, end: endSnap.end }, changes);
    }
  }
  return created;
}

/** Move one endpoint of a wall and drag the joined neighbour's coincident endpoint along (W-031). */
function moveEndpoint(p: Project, w: Wall, end: End, to: Point, moved: Set<string>, changes: Changes): void {
  w[end] = { x: to.x, y: to.y };
  changes.update("wall", w.id);
  const j = w.joins[end];
  if (!j || moved.has(j.wallId)) return;
  const n = wallById(p, j.wallId);
  n[j.end] = { x: to.x, y: to.y };
  changes.update("wall", n.id);
  for (const o of openingsOn(p, n.id)) changes.update("opening", o.id);
}

/** Wall fields only the plan draws: changing nothing else rebuilds nothing in 3D (W-121, S-011). */
const PLAN_ONLY: ReadonlySet<string> = new Set(["pattern"]);

export function wallModify(p: Project, payload: PayloadOf<"wall.modify">, ctx: Ctx, changes: Changes): Wall {
  const w = wallById(p, payload.wallId);
  const c = payload.changes;
  if (c.finishes) requireTextures(p, ctx, [c.finishes.left, c.finishes.right, c.finishes.top], w.id);
  const keys = Object.keys(c);
  if (keys.length > 0 && keys.every((k) => PLAN_ONLY.has(k))) {
    if (c.pattern !== undefined) w.pattern = c.pattern;
    // neither its neighbours, its openings nor the rooms it bounds depend on how its cut is filled
    changes.update("wall", w.id, "plan");
    return w;
  }
  const moved = new Set<string>([w.id]);
  if (c.start) moveEndpoint(p, w, "start", c.start, moved, changes);
  if (c.end) moveEndpoint(p, w, "end", c.end, moved, changes);
  if (w.start.x === w.end.x && w.start.y === w.end.y)
    throw precondition("wall.zero-length", "start must differ from end", w.id);
  if (c.thickness !== undefined) w.thickness = c.thickness;
  if (c.height !== undefined) w.height = c.height;
  if (c.heightAtEnd !== undefined) w.heightAtEnd = c.heightAtEnd;
  if (c.arcExtent !== undefined) w.arcExtent = c.arcExtent;
  if (c.kind !== undefined) w.kind = c.kind;
  if (c.pattern !== undefined) w.pattern = c.pattern;
  if (c.finishes !== undefined) w.finishes = c.finishes;
  if (c.skirting !== undefined) w.skirting = c.skirting;
  if (c.properties !== undefined) w.properties = c.properties;
  Object.assign(w, normalizeWall(w));
  changes.update("wall", w.id);
  touchWallDependents(p, w, changes);
  return w;
}

/** Translate walls; neighbours outside the set follow at the shared endpoint (W-031, W-032, W-144). */
export function wallMove(p: Project, payload: PayloadOf<"wall.move">, _ctx: Ctx, changes: Changes): Wall[] {
  const set = new Set(payload.wallIds);
  const walls = payload.wallIds.map((id) => wallById(p, id));
  for (const w of walls) {
    const s = { x: w.start.x + payload.dx, y: w.start.y + payload.dy };
    const e = { x: w.end.x + payload.dx, y: w.end.y + payload.dy };
    moveEndpoint(p, w, "start", s, set, changes);
    moveEndpoint(p, w, "end", e, set, changes);
    touchWallDependents(p, w, changes);
  }
  return walls;
}

/** Split into two new walls at a fraction (W-037, W-038; W-039 reversed: arc extent divided). */
export function wallSplit(
  p: Project,
  payload: PayloadOf<"wall.split">,
  ctx: Ctx,
  changes: Changes,
): [Wall, Wall] {
  const w = wallById(p, payload.wallId);
  const at = payload.at ?? 0.5;
  if (at <= 0 || at >= 1)
    throw precondition("wall.split-fraction", `at must be strictly between 0 and 1, got ${at}`, w.id);
  for (const o of openingsOn(p, w.id)) {
    const iv = derive.openingAlongInterval(o, w);
    const cut = at * derive.wallLength(w);
    if (iv.from < cut && iv.to > cut) {
      throw precondition(
        "wall.split-through-opening",
        `opening ${o.id} straddles the split point`,
        w.id,
        "move the opening or split elsewhere",
      );
    }
  }
  const mid: Point = {
    x: Math.round(w.start.x + (w.end.x - w.start.x) * at),
    y: Math.round(w.start.y + (w.end.y - w.start.y) * at),
  };
  const level = levelById(p, w.levelId);
  const h0 = derive.wallHeight(w, level);
  const h1 = derive.wallHeightAtEnd(w, level);
  const hMid = Math.round(h0 + (h1 - h0) * at);
  const base = {
    thickness: w.thickness,
    kind: w.kind,
    pattern: w.pattern,
    finishes: w.finishes,
    skirting: w.skirting,
    properties: { ...w.properties },
  };
  const first = defaultWall(ctx.ids.next("wall"), w.levelId, { ...w.start }, mid, {
    ...base,
    height: w.height,
    heightAtEnd: w.heightAtEnd === null ? null : hMid,
    arcExtent: w.arcExtent === null ? null : w.arcExtent * at,
  });
  const second = defaultWall(
    ctx.ids.next("wall"),
    w.levelId,
    mid,
    { ...w.end },
    {
      ...base,
      height: w.heightAtEnd === null ? w.height : hMid,
      heightAtEnd: w.heightAtEnd,
      arcExtent: w.arcExtent === null ? null : w.arcExtent * (1 - at),
    },
  );
  const startJoin = w.joins.start;
  const endJoin = w.joins.end;
  // detach the original from its neighbours, then remove it
  setJoin(p, w.id, "start", null, changes);
  setJoin(p, w.id, "end", null, changes);
  p.walls.splice(p.walls.indexOf(w), 1);
  changes.remove("wall", w.id);
  p.walls.push(normalizeWall(first), normalizeWall(second));
  changes.add("wall", first.id);
  changes.add("wall", second.id);
  setJoin(p, first.id, "end", { wallId: second.id, end: "start" }, changes);
  if (startJoin) setJoin(p, first.id, "start", startJoin, changes);
  if (endJoin) setJoin(p, second.id, "end", endJoin, changes);
  const len = derive.wallLength(w);
  for (const o of openingsOn(p, w.id)) {
    const c = o.position * len;
    if (o.position < at) {
      o.wallId = first.id;
      o.position = c / (at * len);
    } else {
      o.wallId = second.id;
      o.position = (c - at * len) / ((1 - at) * len);
    }
    changes.update("opening", o.id);
  }
  for (const r of p.rooms) {
    const k = r.boundingWallIds.indexOf(w.id);
    if (k >= 0) {
      r.boundingWallIds.splice(k, 1, first.id, second.id);
      changes.update("room", r.id);
    }
  }
  return [wallById(p, first.id), wallById(p, second.id)];
}

/** Join two free ends by moving them to the centreline intersection or the midpoint (W-043..W-045). */
export function wallJoin(
  p: Project,
  payload: PayloadOf<"wall.join">,
  _ctx: Ctx,
  changes: Changes,
): [Wall, Wall] {
  const a = wallById(p, payload.a.wallId);
  const b = wallById(p, payload.b.wallId);
  if (a.id === b.id) throw precondition("wall.self-join", "cannot join a wall to itself", a.id);
  if (a.levelId !== b.levelId)
    throw precondition("wall.join-cross-level", "walls are on different levels", a.id);
  if (derive.isArc(a) || derive.isArc(b))
    throw precondition("wall.join-impossible", "arc walls cannot be joined by wall.join (W-066)", a.id);
  if (a.joins[payload.a.end] || b.joins[payload.b.end])
    throw precondition("wall.join-impossible", "both ends must be free", a.id);
  const x = intersectLines(a.start, a.end, b.start, b.end);
  let target: Point;
  if (x) {
    target = { x: Math.round(x.x), y: Math.round(x.y) };
  } else {
    const pa = a[payload.a.end];
    const pb = b[payload.b.end];
    const collinear =
      derive.wallLength(a) > 0 &&
      Math.abs((pb.x - a.start.x) * (a.end.y - a.start.y) - (pb.y - a.start.y) * (a.end.x - a.start.x)) /
        derive.wallLength(a) <=
        1;
    if (!collinear) throw precondition("wall.join-impossible", "walls are parallel but not collinear", a.id);
    target = { x: Math.round((pa.x + pb.x) / 2), y: Math.round((pa.y + pb.y) / 2) };
  }
  a[payload.a.end] = { ...target };
  b[payload.b.end] = { ...target };
  changes.update("wall", a.id);
  changes.update("wall", b.id);
  setJoin(p, a.id, payload.a.end, { wallId: b.id, end: payload.b.end }, changes);
  touchWallDependents(p, a, changes);
  touchWallDependents(p, b, changes);
  return [a, b];
}

/** Reverse direction (W-034, W-035); openings and joins stay in place. */
export function wallReverse(
  p: Project,
  payload: PayloadOf<"wall.reverse">,
  _ctx: Ctx,
  changes: Changes,
): Wall[] {
  const walls = payload.wallIds.map((id) => wallById(p, id));
  for (const w of walls) {
    const s = w.start;
    w.start = w.end;
    w.end = s;
    if (w.arcExtent !== null) w.arcExtent = -w.arcExtent;
    if (w.heightAtEnd !== null) {
      const h = w.height;
      w.height = w.heightAtEnd;
      w.heightAtEnd = h;
    }
    const left = w.finishes.left;
    w.finishes.left = w.finishes.right;
    w.finishes.right = left;
    const sk = w.skirting.left;
    w.skirting.left = w.skirting.right;
    w.skirting.right = sk;
    const js = w.joins.start;
    w.joins.start = w.joins.end;
    w.joins.end = js;
    for (const end of ["start", "end"] as const) {
      const j = w.joins[end];
      if (!j) continue;
      const n = wallById(p, j.wallId);
      if (n.joins[j.end]?.wallId === w.id) n.joins[j.end] = { wallId: w.id, end };
      changes.update("wall", n.id);
    }
    for (const o of openingsOn(p, w.id)) {
      o.position = 1 - o.position;
      if (o.swing) o.swing = { ...o.swing, hinge: o.swing.hinge === "start" ? "end" : "start" };
      changes.update("opening", o.id);
    }
    Object.assign(w, normalizeWall(w));
    changes.update("wall", w.id);
  }
  return walls;
}

/** Delete walls, their openings, detach neighbours at both ends (W-029; W-030 fixed), mark detected rooms stale. */
export function wallDelete(p: Project, payload: PayloadOf<"wall.delete">, _ctx: Ctx, changes: Changes): void {
  const ids = new Set(payload.wallIds);
  for (const id of ids) wallById(p, id);
  for (const w of p.walls) {
    for (const end of ["start", "end"] as const) {
      const j = w.joins[end];
      if (j && ids.has(j.wallId) && !ids.has(w.id)) {
        w.joins[end] = null;
        changes.update("wall", w.id);
      }
    }
  }
  for (const o of [...p.openings]) {
    if (ids.has(o.wallId)) {
      p.openings.splice(p.openings.indexOf(o), 1);
      changes.remove("opening", o.id);
    }
  }
  for (const r of p.rooms) {
    const before = r.boundingWallIds.length;
    r.boundingWallIds = r.boundingWallIds.filter((x) => !ids.has(x));
    if (r.boundingWallIds.length !== before) {
      if (r.source === "detected") r.properties.__stale = "true";
      changes.update("room", r.id);
    }
  }
  for (const it of p.items) {
    if (it.mount.targetId && ids.has(it.mount.targetId)) {
      it.mount = { kind: "floor", targetId: null, height: null };
      changes.update("item", it.id);
    }
  }
  for (const id of ids) {
    const idx = p.walls.findIndex((w) => w.id === id);
    if (idx >= 0) p.walls.splice(idx, 1);
    changes.remove("wall", id);
  }
}

export const WALL_DEFAULT_THICKNESS = DEFAULTS.wallThickness;

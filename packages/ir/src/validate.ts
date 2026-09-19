// Validation (spec 01 section 5). Errors block export and tool success; warnings are advice.
import * as derive from "./derive.js";
import { idType } from "./ids.js";
import * as poly from "./poly.js";
import type { Item, Level, Point, Project, Room, Wall } from "./schema.js";

export type Severity = "error" | "warning";

export interface Problem {
  code: string;
  severity: Severity;
  entityId: string | null;
  message: string;
  hint: string | null;
  related: string[];
}

export interface ValidateOptions {
  sizes?: derive.SizeSource;
}

const ROOM_DEGENERATE_MM2 = 100_000;
const ITEM_OVERLAP_FRACTION = 0.1;
const ELEVATION_SLACK_MM = 1000;

function problem(
  code: string,
  severity: Severity,
  entityId: string | null,
  message: string,
  hint: string | null = null,
  related: string[] = [],
): Problem {
  return { code, severity, entityId, message, hint, related };
}

/** A room edge is bare when this much of it has no wall along it. */
const BARE_EDGE_MM = 500;
/** How far from a wall's face the back of a bed, a wardrobe or a sofa may stand. */
const BACK_TO_WALL_MM = 250;
/** Categories and recipe kinds that are put against a wall and are wrong anywhere else. */
const BACKS_TO_WALL: ReadonlySet<string> = new Set(["bed", "wardrobe", "sofa", "kitchen-run"]);

/** Stretches of a room's edges with no wall running along them, longest first. */
function bareEdges(project: Project, r: Room): { from: Point; to: Point; gapMm: number }[] {
  const walls = project.walls.filter((w) => w.levelId === r.levelId && !derive.isArc(w));
  const out: { from: Point; to: Point; gapMm: number }[] = [];
  for (let i = 0; i < r.polygon.length; i += 1) {
    const a = r.polygon[i] as Point;
    const b = r.polygon[(i + 1) % r.polygon.length] as Point;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < BARE_EDGE_MM) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    // the stretches of this edge that some wall covers, in mm from a
    const covered: { from: number; to: number }[] = [];
    for (const w of walls) {
      const run = derive.roomWallRun(w, r);
      if (!run) continue;
      const wlen = derive.wallLength(w);
      if (wlen === 0) continue;
      const wx = (w.end.x - w.start.x) / wlen;
      const wy = (w.end.y - w.start.y) / wlen;
      // only a wall parallel to this edge, and lying on it, covers it
      if (Math.abs(wx * uy - wy * ux) > 0.035) continue;
      const at = (t: number) => ({ x: w.start.x + wx * t, y: w.start.y + wy * t });
      const ends = [at(run.fromMm), at(run.toMm)];
      const perp = ends.map((q) => Math.abs((q.x - a.x) * uy - (q.y - a.y) * ux));
      if (Math.max(...perp) > w.thickness / 2 + derive.WALL_ROOM_GAP_MM) continue;
      const along = ends.map((q) => (q.x - a.x) * ux + (q.y - a.y) * uy);
      const from = Math.max(0, Math.min(...along));
      const to = Math.min(len, Math.max(...along));
      if (to - from > 1) covered.push({ from, to });
    }
    covered.sort((x, y) => x.from - y.from);
    let cursor = 0;
    const gap = (from: number, to: number) => {
      if (to - from < BARE_EDGE_MM) return;
      out.push({
        from: { x: a.x + ux * from, y: a.y + uy * from },
        to: { x: a.x + ux * to, y: a.y + uy * to },
        gapMm: to - from,
      });
    };
    for (const c of covered) {
      if (c.from > cursor) gap(cursor, Math.min(c.from, len));
      cursor = Math.max(cursor, c.to);
    }
    if (cursor < len) gap(cursor, len);
  }
  return out.sort((x, y) => y.gapMm - x.gapMm);
}

export function validate(project: Project, options: ValidateOptions = {}): Problem[] {
  const out: Problem[] = [];
  const sizes = options.sizes ?? derive.snapshotSizeSource(project);
  const err = (
    code: string,
    id: string | null,
    message: string,
    hint: string | null = null,
    related: string[] = [],
  ) => out.push(problem(code, "error", id, message, hint, related));
  const warn = (
    code: string,
    id: string | null,
    message: string,
    hint: string | null = null,
    related: string[] = [],
  ) => out.push(problem(code, "warning", id, message, hint, related));

  // ---- levels and ids -----------------------------------------------------
  const levels = new Map<string, Level>();
  if (project.levels.length === 0) err("level.none", null, "project must have at least one level");
  const seenOrder = new Set<string>();
  for (const l of project.levels) {
    levels.set(l.id, l);
    const key = `${l.elevation}/${l.index}`;
    if (seenOrder.has(key))
      err("level.duplicate-order", l.id, `levels share elevation ${l.elevation} and index ${l.index}`);
    seenOrder.add(key);
  }

  const allIds = new Map<string, string>(); // id -> expected type
  const register = (id: string, type: string) => {
    if (allIds.has(id)) err("id.duplicate", id, `id ${id} appears more than once`);
    allIds.set(id, type);
    if (idType(id) !== type)
      err("id.format", id, `id ${id} must start with "${type}_" and end with 6 base36 characters`);
  };
  for (const l of project.levels) register(l.id, "level");
  for (const w of project.walls) register(w.id, "wall");
  for (const o of project.openings) register(o.id, "opening");
  for (const r of project.rooms) register(r.id, "room");
  for (const i of project.items) register(i.id, "item");
  for (const z of project.zones) register(z.id, "zone");
  for (const a of project.annotations) register(a.id, "annot");

  const walls = new Map(project.walls.map((w) => [w.id, w]));
  const rooms = new Map(project.rooms.map((r) => [r.id, r]));
  const items = new Map(project.items.map((i) => [i.id, i]));

  const checkLevel = (id: string, levelId: string) => {
    if (!levels.has(levelId)) err("ref.missing", id, `levelId "${levelId}" does not resolve`);
  };
  const checkTexture = (id: string, finish: { textureId: string | null } | null) => {
    if (finish?.textureId && !(finish.textureId in project.textures)) {
      err("ref.missing", id, `textureId "${finish.textureId}" is not in project.textures`);
    }
  };

  // ---- walls --------------------------------------------------------------
  for (const w of project.walls) {
    checkLevel(w.id, w.levelId);
    checkTexture(w.id, w.finishes.left);
    checkTexture(w.id, w.finishes.right);
    checkTexture(w.id, w.finishes.top);
    if (w.start.x === w.end.x && w.start.y === w.end.y) {
      err("wall.zero-length", w.id, "start must differ from end, got identical points");
    }
    if (w.arcExtent !== null && w.arcExtent !== 0 && Math.abs(w.arcExtent) < 1) {
      warn(
        "wall.arc-degenerate",
        w.id,
        `arcExtent must be at least 1 degree in magnitude to matter, got ${w.arcExtent}`,
      );
    }
    for (const end of ["start", "end"] as const) {
      const join = w.joins[end];
      if (!join) continue;
      if (join.wallId === w.id) {
        err(
          "wall.self-join",
          w.id,
          `joins.${end} references the wall itself`,
          "remove the join or point it at a neighbour",
        );
        continue;
      }
      const other = walls.get(join.wallId);
      if (!other) {
        err("ref.missing", w.id, `joins.${end}.wallId "${join.wallId}" does not resolve`);
        continue;
      }
      if (other.levelId !== w.levelId) {
        err("wall.join-cross-level", w.id, `joins.${end} references ${other.id} on another level`, null, [
          other.id,
        ]);
      }
      const back = other.joins[join.end];
      if (!back || back.wallId !== w.id || back.end !== end) {
        err(
          "wall.join-not-reciprocal",
          w.id,
          `joins.${end} points to ${other.id}.${join.end} but ${other.id}.joins.${join.end} does not point back`,
          `set ${other.id}.joins.${join.end} to { wallId: "${w.id}", end: "${end}" }`,
          [other.id],
        );
      }
      const a = w[end];
      const b = other[join.end];
      if (a.x !== b.x || a.y !== b.y) {
        err(
          "wall.join-endpoint-mismatch",
          w.id,
          `joins.${end} endpoint (${a.x}, ${a.y}) must equal ${other.id}.${join.end} (${b.x}, ${b.y})`,
          null,
          [other.id],
        );
      }
    }
  }

  // ---- openings -----------------------------------------------------------
  const openingsByWall = new Map<string, { id: string; from: number; to: number }[]>();
  for (const o of project.openings) {
    checkLevel(o.id, o.levelId);
    checkTexture(o.id, o.finishes.frame);
    checkTexture(o.id, o.finishes.leaf);
    const w = walls.get(o.wallId);
    if (!w) {
      err("ref.missing", o.id, `wallId "${o.wallId}" does not resolve`);
      continue;
    }
    if (w.levelId !== o.levelId)
      err(
        "opening.level-mismatch",
        o.id,
        `levelId must equal the wall's (${w.levelId}), got ${o.levelId}`,
        null,
        [w.id],
      );
    if (o.kind !== "door" && o.swing)
      err("opening.swing-on-window", o.id, `swing must be null for a ${o.kind}`);
    if (o.productId && !(o.productId in project.catalogRefs)) {
      err("catalog.missing-snapshot", o.id, `productId "${o.productId}" has no snapshot in catalogRefs`);
    }
    const len = derive.wallLength(w);
    const interval = derive.openingAlongInterval(o, w);
    if (interval.from < 0 || interval.to > len) {
      const minPos = o.width / 2 / len;
      const maxPos = 1 - minPos;
      err(
        "opening.off-wall",
        o.id,
        `opening of width ${o.width} at position ${o.position} extends beyond the wall (length ${Math.round(len)})`,
        len >= o.width
          ? `use a position between ${minPos.toFixed(3)} and ${maxPos.toFixed(3)}`
          : "the wall is shorter than the opening",
        [w.id],
      );
    }
    const level = levels.get(w.levelId);
    if (level && o.sill + o.height > derive.wallMaxHeight(w, level)) {
      warn(
        "opening.taller-than-wall",
        o.id,
        `sill ${o.sill} plus height ${o.height} exceeds the wall top ${derive.wallMaxHeight(w, level)}`,
        null,
        [w.id],
      );
    }
    const list = openingsByWall.get(w.id) ?? [];
    list.push({ id: o.id, from: interval.from, to: interval.to });
    openingsByWall.set(w.id, list);
  }
  for (const [wallId, list] of openingsByWall) {
    const sorted = [...list].sort((a, b) => a.from - b.from);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1] as { id: string; from: number; to: number };
      const cur = sorted[i] as { id: string; from: number; to: number };
      if (cur.from < prev.to) {
        err(
          "opening.overlap",
          cur.id,
          `overlaps ${prev.id} on wall ${wallId} (intervals ${Math.round(prev.from)}-${Math.round(prev.to)} and ${Math.round(cur.from)}-${Math.round(cur.to)} mm)`,
          null,
          [prev.id, wallId],
        );
      }
    }
  }

  // ---- rooms --------------------------------------------------------------
  for (const r of project.rooms) {
    checkLevel(r.id, r.levelId);
    checkTexture(r.id, r.finishes.floor);
    checkTexture(r.id, r.finishes.ceiling);
    if (r.polygon.length < 3) {
      err("room.too-few-points", r.id, `polygon must have at least 3 points, got ${r.polygon.length}`);
      continue;
    }
    if (!poly.isSimple(r.polygon))
      err("room.not-simple", r.id, "polygon must be simple (no self-intersection, no zero-length edges)");
    else if (!poly.isCounterClockwise(r.polygon))
      err("room.winding", r.id, "polygon must be counter-clockwise");
    for (const [k, h] of r.holes.entries()) {
      if (h.length < 3 || !poly.isSimple(h))
        err("room.not-simple", r.id, `hole ${k} must be a simple polygon with at least 3 points`);
      else if (!poly.isClockwise(h)) err("room.winding", r.id, `hole ${k} must be clockwise`);
      else if (!poly.containsPolygon(r.polygon, h))
        err("room.hole-outside", r.id, `hole ${k} must lie inside the polygon`);
    }
    if (derive.roomArea(r) < ROOM_DEGENERATE_MM2)
      warn(
        "room.degenerate",
        r.id,
        `area ${Math.round(derive.roomArea(r))} mm² is below ${ROOM_DEGENERATE_MM2} mm²`,
      );
    if (r.source === "detected" && r.properties.__stale === "true") {
      warn(
        "room.stale",
        r.id,
        "detected room's bounding walls changed since detection",
        "run room.detect to refresh",
        r.boundingWallIds,
      );
    }
    for (const wid of r.boundingWallIds)
      if (!walls.has(wid)) err("ref.missing", r.id, `boundingWallIds entry "${wid}" does not resolve`);
    // Is the room fenced in? A room is a polygon, not an enclosure, so one can be drawn over open
    // floor and look right in a list of rooms while having no wall along one of its sides. A flat
    // drawn by an agent had five such rooms, and a bed standing against nothing.
    const bare = bareEdges(project, r);
    if (bare.length > 0) {
      const worst = bare.reduce((a, b) => (a.gapMm >= b.gapMm ? a : b));
      warn(
        "room.unenclosed",
        r.id,
        `${bare.length === 1 ? "one side has" : `${bare.length} sides have`} no wall along ${bare.length === 1 ? "it" : "them"}: ` +
          `${Math.round(worst.gapMm)} mm of the ${bare.length === 1 ? "side" : "longest one"} from (${Math.round(worst.from.x)}, ${Math.round(worst.from.y)}) to (${Math.round(worst.to.x)}, ${Math.round(worst.to.y)})`,
        "draw a wall along that side, or move the room polygon onto the walls that are there",
      );
    }
  }

  // ---- items --------------------------------------------------------------
  const wallFootprints = new Map<
    string,
    { wall: Wall; fp: poly.Rect; pts: ReturnType<typeof derive.wallFootprintUnjoined> }
  >();
  for (const w of project.walls) {
    if (derive.isArc(w) || derive.wallLength(w) === 0) continue;
    const pts = derive.wallFootprintUnjoined(w);
    wallFootprints.set(w.id, { wall: w, fp: poly.bounds(pts), pts });
  }
  const footprints = new Map<
    string,
    {
      item: Item;
      pts: ReturnType<typeof derive.itemFootprint>;
      rect: poly.Rect;
      size: { w: number; d: number; h: number };
    }
  >();
  for (const i of project.items) {
    checkLevel(i.id, i.levelId);
    checkTexture(i.id, i.finish);
    for (const f of Object.values(i.materials)) checkTexture(i.id, f);
    if (i.ref.kind === "product") {
      const snap = project.catalogRefs[i.ref.productId] as
        | { verification?: { status?: string }; deformable?: boolean }
        | undefined;
      if (!snap)
        err(
          "catalog.missing-snapshot",
          i.id,
          `productId "${i.ref.productId}" has no snapshot in catalogRefs`,
        );
      else if (
        snap.verification?.status &&
        snap.verification.status !== "verified" &&
        snap.verification.status !== "manual"
      ) {
        warn("catalog.unverified", i.id, `product "${i.ref.productId}" is ${snap.verification.status}`);
      }
      if (i.size && snap && snap.deformable === false)
        err(
          "item.size-not-deformable",
          i.id,
          `size override is not allowed: product "${i.ref.productId}" is not deformable`,
        );
    }
    if (i.parentId) {
      const parent = items.get(i.parentId);
      if (!parent) err("ref.missing", i.id, `parentId "${i.parentId}" does not resolve`);
      else if (parent.levelId !== i.levelId)
        err("item.parent-level", i.id, `parent ${parent.id} is on another level`, null, [parent.id]);
      // cycle detection
      const seen = new Set<string>([i.id]);
      let cur = parent;
      while (cur) {
        if (seen.has(cur.id)) {
          err("item.parent-cycle", i.id, `parentId chain loops through ${cur.id}`, null, [...seen]);
          break;
        }
        seen.add(cur.id);
        cur = cur.parentId ? items.get(cur.parentId) : undefined;
      }
    }
    if (
      (i.mount.kind === "wall" || i.mount.kind === "item") &&
      !(i.mount.targetId && (walls.has(i.mount.targetId) || items.has(i.mount.targetId)))
    ) {
      err(
        "item.mount-target",
        i.id,
        `mount.kind "${i.mount.kind}" requires a resolving mount.targetId, got ${String(i.mount.targetId)}`,
      );
    }
    if (i.roomId) {
      const room = rooms.get(i.roomId);
      if (!room) err("ref.missing", i.id, `roomId "${i.roomId}" does not resolve`);
      else if (!derive.roomContains(room, i.position))
        warn(
          "item.outside-room",
          i.id,
          `centre (${i.position.x}, ${i.position.y}) is not inside room ${room.id}`,
          null,
          [room.id],
        );
    }
    const size = derive.itemSize(i, sizes);
    const level = levels.get(i.levelId);
    if (size && level && i.elevation + size.h > level.height + ELEVATION_SLACK_MM) {
      warn(
        "item.elevation-range",
        i.id,
        `elevation ${i.elevation} plus height ${size.h} exceeds the level height ${level.height} by more than ${ELEVATION_SLACK_MM}`,
      );
    }
    if (size) {
      const pts = derive.itemFootprint(i, size);
      footprints.set(i.id, { item: i, pts, rect: poly.bounds(pts), size });
      // Standing in a doorway, or across a window. The recipe that placed a wardrobe over every
      // bedroom door looked only at the wall's length, never at what was already in it.
      if (i.mount.kind === "floor" && !i.parentId) {
        for (const o of project.openings) {
          const w = walls.get(o.wallId);
          if (!w || w.levelId !== i.levelId || derive.wallLength(w) === 0) continue;
          const len = derive.wallLength(w);
          const ux = (w.end.x - w.start.x) / len;
          const uy = (w.end.y - w.start.y) / len;
          const along = pts.map((q) => (q.x - w.start.x) * ux + (q.y - w.start.y) * uy);
          const away = pts.map((q) => Math.abs((q.x - w.start.x) * uy - (q.y - w.start.y) * ux));
          const span = derive.openingAlongInterval(o, w);
          const overlap = Math.min(Math.max(...along), span.to) - Math.max(Math.min(...along), span.from);
          if (overlap <= 0 || Math.min(...away) > w.thickness / 2 + BACK_TO_WALL_MM) continue;
          warn(
            "item.blocks-opening",
            i.id,
            `stands across ${Math.round(overlap)} mm of ${o.kind} ${o.id}`,
            o.kind === "window" ? "leave the window reachable" : "keep the doorway clear",
            [o.id, w.id],
          );
        }
      }
      // A bed, a wardrobe, a sofa or a kitchen run has a back, and its back goes against a wall.
      const kind =
        i.ref.kind === "recipe"
          ? i.ref.recipe.kind
          : ((project.catalogRefs[i.ref.productId] as { category?: string } | undefined)?.category ?? "");
      if (BACKS_TO_WALL.has(kind) && i.mount.kind === "floor") {
        const a = (i.rotation * Math.PI) / 180;
        const backMid = {
          x: i.position.x - (size.d / 2) * Math.sin(a),
          y: i.position.y + (size.d / 2) * Math.cos(a),
        };
        let nearest = Number.POSITIVE_INFINITY;
        for (const w of project.walls) {
          if (w.levelId !== i.levelId) continue;
          nearest = Math.min(nearest, poly.distancePointSegment(backMid, w.start, w.end) - w.thickness / 2);
        }
        if (nearest > BACK_TO_WALL_MM)
          warn(
            "item.needs-wall",
            i.id,
            `a ${kind} belongs with its back to a wall; the nearest is ${Math.round(nearest)} mm away`,
            "turn it so its back (local +y) faces the wall, or move it against one",
          );
      }
      for (const { wall, fp, pts: wpts } of wallFootprints.values()) {
        if (wall.levelId !== i.levelId || !poly.rectsIntersect(fp, poly.bounds(pts))) continue;
        if (pts.every((p) => poly.containsPoint(wpts, p))) {
          warn(
            "item.in-wall",
            i.id,
            `footprint lies entirely inside wall ${wall.id}`,
            "move the item off the wall",
            [wall.id],
          );
        }
      }
    }
  }
  const list = [...footprints.values()];
  for (let a = 0; a < list.length; a += 1) {
    const A = list[a] as (typeof list)[number];
    if (A.item.mount.kind !== "floor" || A.item.parentId) continue;
    for (let b = a + 1; b < list.length; b += 1) {
      const B = list[b] as (typeof list)[number];
      if (B.item.mount.kind !== "floor" || B.item.parentId || A.item.levelId !== B.item.levelId) continue;
      if (!poly.rectsIntersect(A.rect, B.rect)) continue;
      const overlap = poly.convexOverlapArea(A.pts, B.pts);
      const smaller = Math.min(A.size.w * A.size.d, B.size.w * B.size.d);
      if (smaller > 0 && overlap / smaller > ITEM_OVERLAP_FRACTION) {
        warn(
          "item.overlap",
          A.item.id,
          `overlaps ${B.item.id} by ${Math.round((overlap / smaller) * 100)}% of the smaller footprint`,
          null,
          [B.item.id],
        );
      }
    }
  }

  // ---- zones and annotations ---------------------------------------------
  for (const zn of project.zones) {
    checkLevel(zn.id, zn.levelId);
    const orphans = zn.generatedItemIds.filter((id) => !items.has(id));
    if (orphans.length)
      warn(
        "zone.rule-orphan",
        zn.id,
        `generatedItemIds reference missing items: ${orphans.join(", ")}`,
        "run zone.regenerate",
        orphans,
      );
  }
  for (const a of project.annotations) checkLevel(a.id, a.levelId);

  return out;
}

export function hasErrors(problems: readonly Problem[]): boolean {
  return problems.some((p) => p.severity === "error");
}

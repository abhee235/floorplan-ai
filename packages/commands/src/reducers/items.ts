// Item reducers (spec 03 section 3; ledger F-008, F-013..F-015, F-041..F-047 via parent links, F-070..F-072,
// F-100..F-106, F-113..F-115, F-145..F-153, F-164..F-170, F-171..F-176).

import { productMaterialSlots } from "@fpv/catalog";
import { clearanceOf, freeRunsAlongEdge, placeItem } from "@fpv/geometry";
import type { Item, Point, Project, Room, Size3 } from "@fpv/ir";
import { defaultItem, derive, normalizeDeg, normalizeItem, poly } from "@fpv/ir";
import {
  type Changes,
  type Ctx,
  descendantsOf,
  ensureSnapshot,
  itemById,
  levelById,
  roomById,
  sizeOf,
  wallById,
} from "../context.js";
import { precondition } from "../errors.js";
import type { AnchorSpec, CompassWord, PayloadOf } from "../types.js";

// ---- helpers --------------------------------------------------------------

function requireProduct(p: Project, ctx: Ctx, ref: Item["ref"], entityId: string | null): void {
  if (ref.kind !== "product") return;
  if (!ensureSnapshot(p, ctx, ref.productId)) {
    throw precondition(
      "catalog.missing-snapshot",
      `productId "${ref.productId}" is not in the catalog`,
      entityId,
      "use search_catalog or verify_product first",
    );
  }
}

/**
 * The slots an item's `materials` may name: its recipe's, or its product's (its model's, else its
 * category's recipe's). Null for a product the project holds no snapshot of, which cannot be checked.
 */
export function itemMaterialSlots(p: Project, it: Pick<Item, "ref">): readonly string[] | null {
  if (it.ref.kind === "recipe") return derive.recipeSlots(it.ref.recipe.kind);
  const snap = p.catalogRefs[it.ref.productId] as { category?: string; materialSlots?: string[] } | undefined;
  return snap ? productMaterialSlots(snap) : null;
}

function refreshRoom(p: Project, it: Item): void {
  it.roomId = derive.containingRoom(p, it.levelId, it.position)?.id ?? null;
}

function rotatePoint(q: Point, about: Point, deg: number): Point {
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = q.x - about.x;
  const dy = q.y - about.y;
  return { x: Math.round(about.x + dx * cos - dy * sin), y: Math.round(about.y + dx * sin + dy * cos) };
}

function compassDir(word: CompassWord, north: number): Point {
  const offset = { north: 0, west: 90, south: 180, east: 270 }[word];
  const a = ((north + offset) * Math.PI) / 180;
  return { x: Math.cos(a), y: Math.sin(a) };
}

/** Rotation so the item's back (local +y) faces along `dir` (ADR-016 D4 orientation). */
function rotationFacingBackTo(dir: Point): number {
  return normalizeDeg((Math.atan2(dir.y, dir.x) * 180) / Math.PI - 90);
}

interface RoomEdge {
  a: Point;
  b: Point;
  outward: Point;
  length: number;
}

function roomEdges(r: Room): RoomEdge[] {
  const n = r.polygon.length;
  const out: RoomEdge[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = r.polygon[i] as Point;
    const b = r.polygon[(i + 1) % n] as Point;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    // polygon is counter-clockwise, so the outward normal is to the right of the edge direction
    out.push({ a, b, outward: { x: (b.y - a.y) / len, y: -(b.x - a.x) / len }, length: len });
  }
  return out;
}

/** Resolve a room-relative anchor to a position and rotation (spec 05 section 5 anchors). */
export function resolveAnchor(
  p: Project,
  room: Room,
  anchor: AnchorSpec,
  size: Size3,
): {
  position: Point;
  rotation: number;
  parentId: string | null;
  elevation: number | null;
  warning?: string;
} {
  const north = p.meta.north;
  if (typeof anchor === "object" && "on" in anchor) {
    const parent = itemById(p, anchor.on);
    const ps = sizeOf(p, parent);
    const ratio = anchor.dropRatio ?? 1;
    return {
      position: { ...parent.position },
      rotation: parent.rotation,
      parentId: parent.id,
      elevation: parent.elevation + Math.round(ps.h * ratio),
    };
  }
  if (typeof anchor === "object" && "alongWall" in anchor) {
    const w = wallById(p, anchor.alongWall);
    const len = derive.wallLength(w);
    const t = Math.min(1, Math.max(0, anchor.atMm / len));
    const c = derive.pointAlongWall(w, t);
    const n = derive.wallSideNormal(w, "left");
    const inset = w.thickness / 2 + size.d / 2;
    const left = { x: c.x + n.x * inset, y: c.y + n.y * inset };
    const right = { x: c.x - n.x * inset, y: c.y - n.y * inset };
    const useLeft = derive.roomContains(room, left) || !derive.roomContains(room, right);
    const pos = useLeft ? left : right;
    const back = useLeft ? { x: -n.x, y: -n.y } : n;
    return {
      position: { x: Math.round(pos.x), y: Math.round(pos.y) },
      rotation: rotationFacingBackTo(back),
      parentId: null,
      elevation: null,
    };
  }
  if (anchor === "center") {
    return {
      position: poly.poleOfInaccessibility(room.polygon, room.holes),
      rotation: 0,
      parentId: null,
      elevation: null,
    };
  }
  if (anchor.startsWith("against-")) {
    const word = anchor.slice("against-".length, -"-wall".length) as CompassWord;
    const dir = compassDir(word, north);
    // spec 05 section 5: the wall side facing that way with the longest free stretch the item fits in,
    // clear of door swings, passages, low windows and items already there
    const sizes = derive.snapshotSizeSource(p);
    let best: { edge: RoomEdge; centre: number; fits: boolean } | null = null;
    let bestScore = -Infinity;
    for (const e of roomEdges(room)) {
      const dot = e.outward.x * dir.x + e.outward.y * dir.y;
      if (dot < 0.7) continue;
      const runs = freeRunsAlongEdge(p, room.levelId, e.a, e.b, e.outward, size, sizes)
        .filter((r) => r.to - r.from >= size.w)
        .sort((x, y) => y.to - y.from - (x.to - x.from) || x.from - y.from);
      const run = runs[0];
      const fits = run !== undefined;
      const score = (fits ? 2e9 : 0) + Math.round(dot * 1000) * 1e6 + (run ? run.to - run.from : e.length);
      if (score > bestScore) {
        bestScore = score;
        best = { edge: e, centre: run ? (run.from + run.to) / 2 : e.length / 2, fits };
      }
    }
    if (!best)
      throw precondition(
        "item.anchor-unresolvable",
        `room ${room.id} has no ${word} wall`,
        room.id,
        "use describe_room to see the walls",
      );
    const { edge } = best;
    const t = best.centre / edge.length;
    const at = { x: edge.a.x + (edge.b.x - edge.a.x) * t, y: edge.a.y + (edge.b.y - edge.a.y) * t };
    const inset = size.d / 2;
    return {
      position: {
        x: Math.round(at.x - edge.outward.x * inset),
        y: Math.round(at.y - edge.outward.y * inset),
      },
      rotation: rotationFacingBackTo(edge.outward),
      parentId: null,
      elevation: null,
      ...(best.fits
        ? {}
        : {
            warning: `no free stretch of the ${word} wall is ${size.w} mm wide; the item was centred on the wall and may block a door or another item`,
          }),
    };
  }
  // corners: "north-east-corner" etc.
  const [w1, w2] = anchor.replace("-corner", "").split("-") as [CompassWord, CompassWord];
  const d1 = compassDir(w1, north);
  const d2 = compassDir(w2, north);
  const dir = { x: d1.x + d2.x, y: d1.y + d2.y };
  let best: Point | null = null;
  let bestDot = -Infinity;
  for (const v of room.polygon) {
    const dot = v.x * dir.x + v.y * dir.y;
    if (dot > bestDot) {
      bestDot = dot;
      best = v;
    }
  }
  const corner = best as Point;
  const back = d1; // back to the first-named wall
  const side = d2;
  return {
    position: {
      x: Math.round(corner.x - back.x * (size.d / 2) - side.x * (size.w / 2)),
      y: Math.round(corner.y - back.y * (size.d / 2) - side.y * (size.w / 2)),
    },
    rotation: rotationFacingBackTo(back),
    parentId: null,
    elevation: null,
  };
}

// ---- reducers -------------------------------------------------------------

export function itemPlace(p: Project, payload: PayloadOf<"item.place">, ctx: Ctx, changes: Changes): Item {
  levelById(p, payload.levelId);
  requireProduct(p, ctx, payload.ref, null);
  const hasPos = payload.position !== undefined;
  const hasAnchor = payload.roomId !== undefined && payload.anchor !== undefined;
  if (hasPos === hasAnchor)
    throw precondition("command.payload", "give either position, or roomId plus anchor");
  const id = ctx.ids.next("item");
  const probe = defaultItem(id, payload.levelId, payload.ref, payload.position ?? { x: 0, y: 0 });
  const size = sizeOf(p, probe);
  let position = payload.position ?? { x: 0, y: 0 };
  let rotation = payload.rotation ?? 0;
  let parentId = payload.parentId ?? null;
  let elevation = payload.elevation ?? 0;
  // F-091 reversed, O-013: a door or window product is an opening in a wall, never an item
  if (payload.ref.kind === "product") {
    const snap = p.catalogRefs[payload.ref.productId] as { category?: string } | undefined;
    if (snap?.category === "door" || snap?.category === "window")
      throw precondition(
        "item.opening-product",
        `${payload.ref.productId} is a ${snap.category}; doors and windows go in walls as openings, not items`,
        null,
        "use opening.add (add_opening) with this productId",
      );
  }
  if (hasAnchor) {
    const room = roomById(p, payload.roomId as string);
    if (room.levelId !== payload.levelId)
      throw precondition("command.payload", `room ${room.id} is on another level`);
    const r = resolveAnchor(p, room, payload.anchor as AnchorSpec, size);
    position = r.position;
    if (payload.rotation === undefined) rotation = r.rotation;
    if (r.parentId) parentId = r.parentId;
    if (r.elevation !== null && payload.elevation === undefined) elevation = r.elevation;
    if (r.warning) changes.warn(r.warning);
  }
  // the placement pipeline (spec 05 section 5): a drop re-orients unless the caller gave a rotation
  const mountKind = payload.mount?.kind ?? "floor";
  let wallId: string | null = null;
  if (payload.magnetism !== false && mountKind !== "ceiling") {
    const placed = placeItem(
      {
        id,
        levelId: payload.levelId,
        position,
        rotation: normalizeDeg(rotation),
        elevation,
        size,
        mountKind,
        parentId,
      },
      { project: p, sizes: derive.snapshotSizeSource(p) },
      {
        forceOrientation: payload.rotation === undefined,
        adjustElevation: payload.elevation === undefined && parentId === null,
        adjustOnlyNullElevation: false,
      },
      clearanceOf(p, payload.ref.kind === "product" ? payload.ref.productId : null),
    );
    position = placed.position;
    rotation = placed.rotation;
    elevation = placed.elevation;
    parentId = placed.parentId;
    wallId = placed.wallId;
    for (const w of placed.warnings) changes.warn(w.message);
  }
  const item = defaultItem(id, payload.levelId, payload.ref, position, {
    rotation: normalizeDeg(rotation),
    elevation,
    parentId,
    ...(payload.mount
      ? {
          mount: {
            kind: payload.mount.kind,
            targetId: payload.mount.targetId ?? (payload.mount.kind === "wall" ? wallId : null),
            height: payload.mount.height ?? null,
          },
        }
      : {}),
    ...(payload.tags ? { tags: payload.tags } : {}),
  });
  if (parentId) {
    const parent = itemById(p, parentId);
    if (parent.levelId !== item.levelId)
      throw precondition("item.parent-level", "parent is on another level", id);
  }
  p.items.push(item);
  const stored = itemById(p, id);
  refreshRoom(p, stored);
  changes.add("item", id);
  return stored;
}

export function itemMove(p: Project, payload: PayloadOf<"item.move">, _ctx: Ctx, changes: Changes): Item[] {
  const roots = payload.itemIds.map((id) => itemById(p, id));
  const moved = new Set<string>();
  const all: Item[] = [];
  for (const r of roots)
    for (const it of [r, ...descendantsOf(p, r.id)])
      if (!moved.has(it.id)) {
        moved.add(it.id);
        all.push(it);
      }
  for (const it of all) {
    it.position = { x: it.position.x + payload.dx, y: it.position.y + payload.dy };
    if (payload.dz) it.elevation += payload.dz;
    refreshRoom(p, it);
    changes.update("item", it.id);
  }
  // F-076, F-077: only a single moved item magnetises, and a move never re-orients it
  const root = roots.length === 1 ? roots[0] : undefined;
  if (root && payload.magnetism !== false && root.mount.kind !== "ceiling") {
    const size = derive.itemSize(root, derive.snapshotSizeSource(p));
    if (size) {
      const descendants = descendantsOf(p, root.id);
      const placed = placeItem(
        {
          id: root.id,
          levelId: root.levelId,
          position: root.position,
          rotation: root.rotation,
          elevation: root.elevation,
          size,
          mountKind: root.mount.kind,
          parentId: root.parentId,
        },
        { project: p, sizes: derive.snapshotSizeSource(p) },
        {
          forceOrientation: false,
          adjustElevation: true,
          adjustOnlyNullElevation: true,
          exclude: descendants.map((d) => d.id),
        },
        clearanceOf(p, root.ref.kind === "product" ? root.ref.productId : null),
      );
      const dx = placed.position.x - root.position.x;
      const dy = placed.position.y - root.position.y;
      const dz = placed.elevation - root.elevation;
      if (dx !== 0 || dy !== 0 || dz !== 0)
        for (const it of [root, ...descendants]) {
          it.position = { x: it.position.x + dx, y: it.position.y + dy };
          it.elevation += dz;
          refreshRoom(p, it);
        }
      root.parentId = placed.parentId;
      for (const w of placed.warnings) changes.warn(w.message);
    }
  }
  return all;
}

export function itemRotate(
  p: Project,
  payload: PayloadOf<"item.rotate">,
  _ctx: Ctx,
  changes: Changes,
): Item[] {
  if ((payload.angle === undefined) === (payload.delta === undefined))
    throw precondition("command.payload", "give exactly one of angle or delta");
  const roots = payload.itemIds.map((id) => itemById(p, id));
  const out: Item[] = [];
  for (const r of roots) {
    const delta = payload.delta ?? normalizeDeg((payload.angle as number) - r.rotation);
    const about = payload.about ?? r.position;
    r.rotation = normalizeDeg(r.rotation + delta);
    if (payload.about) r.position = rotatePoint(r.position, about, delta);
    changes.update("item", r.id);
    out.push(r);
    for (const d of descendantsOf(p, r.id)) {
      d.rotation = normalizeDeg(d.rotation + delta);
      d.position = rotatePoint(d.position, payload.about ?? r.position, delta);
      changes.update("item", d.id);
      out.push(d);
    }
    refreshRoom(p, r);
  }
  return out;
}

/** Resize keeping the back-left corner fixed by default (F-100). */
export function itemResize(p: Project, payload: PayloadOf<"item.resize">, _ctx: Ctx, changes: Changes): Item {
  const it = itemById(p, payload.itemId);
  if (it.ref.kind === "product" && payload.size) {
    const snap = p.catalogRefs[it.ref.productId] as { deformable?: boolean } | undefined;
    if (snap && snap.deformable === false)
      throw precondition(
        "item.size-not-deformable",
        `product "${it.ref.productId}" is not deformable`,
        it.id,
      );
  }
  const before = derive.itemFootprint(it, sizeOf(p, it));
  it.size = payload.size ? { ...payload.size } : null;
  const after = derive.itemFootprint(it, sizeOf(p, it));
  if ((payload.anchor ?? "back-left") === "back-left") {
    const b = before[0] as Point;
    const a = after[0] as Point;
    it.position = { x: Math.round(it.position.x + (b.x - a.x)), y: Math.round(it.position.y + (b.y - a.y)) };
  }
  changes.update("item", it.id);
  for (const d of descendantsOf(p, it.id)) changes.update("item", d.id);
  return it;
}

export function itemSetElevation(
  p: Project,
  payload: PayloadOf<"item.setElevation">,
  _ctx: Ctx,
  changes: Changes,
): Item[] {
  const out: Item[] = [];
  for (const id of payload.itemIds) {
    const it = itemById(p, id);
    const delta = payload.elevation - it.elevation;
    it.elevation = payload.elevation;
    changes.update("item", it.id);
    out.push(it);
    for (const d of descendantsOf(p, it.id)) {
      d.elevation += delta;
      changes.update("item", d.id);
      out.push(d);
    }
  }
  return out;
}

export function itemSetParent(
  p: Project,
  payload: PayloadOf<"item.setParent">,
  _ctx: Ctx,
  changes: Changes,
): Item {
  const it = itemById(p, payload.itemId);
  if (payload.parentId) {
    const parent = itemById(p, payload.parentId);
    if (parent.id === it.id || descendantsOf(p, it.id).some((d) => d.id === parent.id)) {
      throw precondition("item.parent-cycle", `parenting ${it.id} under ${parent.id} would loop`, it.id);
    }
    if (parent.levelId !== it.levelId)
      throw precondition("item.parent-level", "parent is on another level", it.id);
    if (payload.dropRatio !== undefined)
      it.elevation = parent.elevation + Math.round(sizeOf(p, parent).h * payload.dropRatio);
  }
  it.parentId = payload.parentId;
  changes.update("item", it.id);
  return it;
}

export function itemSetProduct(
  p: Project,
  payload: PayloadOf<"item.setProduct">,
  ctx: Ctx,
  changes: Changes,
): Item {
  const it = itemById(p, payload.itemId);
  requireProduct(p, ctx, payload.ref, it.id);
  it.ref = payload.ref;
  // a finish for a part the new product does not have would be kept but never drawn
  const slots = itemMaterialSlots(p, it);
  if (slots)
    for (const slot of Object.keys(it.materials)) if (!slots.includes(slot)) delete it.materials[slot];
  if (it.ref.kind === "product") {
    const snap = p.catalogRefs[it.ref.productId] as { deformable?: boolean } | undefined;
    if (snap && snap.deformable === false) it.size = null;
  }
  changes.update("item", it.id);
  return it;
}

export function itemMirror(
  p: Project,
  payload: PayloadOf<"item.mirror">,
  _ctx: Ctx,
  changes: Changes,
): Item[] {
  return payload.itemIds.map((id) => {
    const it = itemById(p, id);
    it.mirrored = !it.mirrored;
    changes.update("item", it.id);
    return it;
  });
}

export function itemSetFinish(
  p: Project,
  payload: PayloadOf<"item.setFinish">,
  _ctx: Ctx,
  changes: Changes,
): Item[] {
  return payload.itemIds.map((id) => {
    const it = itemById(p, id);
    if (payload.finish !== undefined) it.finish = payload.finish;
    if (payload.materials) {
      const slots = itemMaterialSlots(p, it);
      for (const [slot, finish] of Object.entries(payload.materials)) {
        if (slots && !slots.includes(slot))
          throw precondition("item.material-slot", `slot "${slot}" is not one of ${slots.join(", ")}`, it.id);
        if (finish === null) delete it.materials[slot];
        else it.materials[slot] = finish;
      }
    }
    changes.update("item", it.id);
    return it;
  });
}

/** Duplicate with new ids; parents inside the set are remapped, descendants come along (F-145, F-147, F-148). */
export function itemDuplicate(
  p: Project,
  payload: PayloadOf<"item.duplicate">,
  ctx: Ctx,
  changes: Changes,
): Item[] {
  const dx = payload.dx ?? 200;
  const dy = payload.dy ?? 200;
  const roots = payload.itemIds.map((id) => itemById(p, id));
  const sources: Item[] = [];
  const seen = new Set<string>();
  for (const r of roots)
    for (const it of [r, ...descendantsOf(p, r.id)])
      if (!seen.has(it.id)) {
        seen.add(it.id);
        sources.push(it);
      }
  const idMap = new Map<string, string>();
  for (const s of sources) idMap.set(s.id, ctx.ids.next("item"));
  const created: Item[] = [];
  for (const s of sources) {
    const copy = JSON.parse(JSON.stringify(s)) as Item; // drafts cannot be structuredCloned
    copy.id = idMap.get(s.id) as string;
    copy.position = { x: s.position.x + dx, y: s.position.y + dy };
    copy.parentId = s.parentId ? (idMap.get(s.parentId) ?? s.parentId) : null;
    p.items.push(copy);
    const stored = itemById(p, copy.id);
    refreshRoom(p, stored);
    changes.add("item", stored.id);
    created.push(stored);
  }
  return created;
}

export function itemDelete(p: Project, payload: PayloadOf<"item.delete">, _ctx: Ctx, changes: Changes): void {
  const withDescendants = payload.withDescendants ?? true;
  const ids = new Set(payload.itemIds);
  for (const id of payload.itemIds) {
    const it = itemById(p, id);
    if (withDescendants) for (const d of descendantsOf(p, it.id)) ids.add(d.id);
    else {
      for (const d of p.items) {
        if (d.parentId === it.id) {
          d.parentId = it.parentId;
          changes.update("item", d.id);
        }
      }
    }
  }
  for (const id of ids) {
    const idx = p.items.findIndex((x) => x.id === id);
    if (idx >= 0) p.items.splice(idx, 1);
    changes.remove("item", id);
  }
  for (const z of p.zones) {
    const before = z.generatedItemIds.length;
    z.generatedItemIds = z.generatedItemIds.filter((x) => !ids.has(x));
    if (z.generatedItemIds.length !== before) changes.update("zone", z.id);
  }
  for (const it of p.items) {
    if (it.mount.targetId && ids.has(it.mount.targetId)) {
      it.mount = { kind: "floor", targetId: null, height: null };
      changes.update("item", it.id);
    }
  }
}

/** Alignment by footprint extremes (compass) or in the lead's frame (F-165..F-167); only positions change (F-169). */
export function itemAlign(p: Project, payload: PayloadOf<"item.align">, _ctx: Ctx, changes: Changes): Item[] {
  const lead = itemById(p, payload.leadId);
  if (!payload.itemIds.includes(lead.id))
    throw precondition("command.payload", "leadId must be one of itemIds");
  const items = payload.itemIds.map((id) => itemById(p, id));
  const north = p.meta.north;
  const fp = (it: Item) => derive.itemFootprint(it, sizeOf(p, it));
  const extreme = (it: Item, dir: Point) => Math.max(...fp(it).map((q) => q.x * dir.x + q.y * dir.y));
  const shift = (it: Item, dir: Point, amount: number) => {
    it.position = {
      x: Math.round(it.position.x + dir.x * amount),
      y: Math.round(it.position.y + dir.y * amount),
    };
    for (const d of descendantsOf(p, it.id)) {
      d.position = {
        x: Math.round(d.position.x + dir.x * amount),
        y: Math.round(d.position.y + dir.y * amount),
      };
      changes.update("item", d.id);
    }
    refreshRoom(p, it);
    changes.update("item", it.id);
  };
  const edge = payload.edge;
  if (edge === "north" || edge === "south" || edge === "east" || edge === "west") {
    const dir = compassDir(edge, north);
    const target = extreme(lead, dir);
    for (const it of items) if (it.id !== lead.id) shift(it, dir, target - extreme(it, dir));
    return items;
  }
  // lead-frame edges: back = lead local +y, front = -y, right-side = +x, left-side = -x
  const a = (lead.rotation * Math.PI) / 180;
  const localY = { x: -Math.sin(a), y: Math.cos(a) };
  const localX = { x: Math.cos(a), y: Math.sin(a) };
  if (edge === "side-by-side") {
    const others = items
      .filter((it) => it.id !== lead.id)
      .sort(
        (u, v) =>
          u.position.x * localX.x +
          u.position.y * localX.y -
          (v.position.x * localX.x + v.position.y * localX.y),
      );
    const leadBack = extreme(lead, localY);
    let cursor = lead.position.x * localX.x + lead.position.y * localX.y + sizeOf(p, lead).w / 2;
    for (const it of others) {
      const w = sizeOf(p, it).w;
      const alongTarget = cursor + w / 2;
      const alongNow = it.position.x * localX.x + it.position.y * localX.y;
      shift(it, localX, alongTarget - alongNow);
      shift(it, localY, leadBack - extreme(it, localY));
      cursor += w;
    }
    return items;
  }
  const dir =
    edge === "back"
      ? localY
      : edge === "front"
        ? { x: -localY.x, y: -localY.y }
        : edge === "right-side"
          ? localX
          : { x: -localX.x, y: -localX.y };
  const target = extreme(lead, dir);
  for (const it of items) if (it.id !== lead.id) shift(it, dir, target - extreme(it, dir));
  return items;
}

/** First and last stay; inner items spaced with equal gaps (F-168). */
export function itemDistribute(
  p: Project,
  payload: PayloadOf<"item.distribute">,
  _ctx: Ctx,
  changes: Changes,
): Item[] {
  const items = payload.itemIds.map((id) => itemById(p, id));
  const axis = payload.axis;
  const coord = (q: Point) => (axis === "x" ? q.x : q.y);
  const extent = (it: Item) => {
    const pts = derive.itemFootprint(it, sizeOf(p, it)).map(coord);
    return { min: Math.min(...pts), max: Math.max(...pts) };
  };
  const sorted = [...items].sort((u, v) => coord(u.position) - coord(v.position));
  const first = sorted[0] as Item;
  const last = sorted[sorted.length - 1] as Item;
  const inner = sorted.slice(1, -1);
  const span = extent(last).min - extent(first).max;
  const widths = inner.map((it) => {
    const e = extent(it);
    return e.max - e.min;
  });
  const gap = (span - widths.reduce((s, w) => s + w, 0)) / (inner.length + 1);
  let cursor = extent(first).max + gap;
  inner.forEach((it, i) => {
    const w = widths[i] as number;
    const e = extent(it);
    const delta = cursor - e.min;
    it.position =
      axis === "x"
        ? { x: Math.round(it.position.x + delta), y: it.position.y }
        : { x: it.position.x, y: Math.round(it.position.y + delta) };
    for (const d of descendantsOf(p, it.id)) {
      d.position =
        axis === "x"
          ? { x: Math.round(d.position.x + delta), y: d.position.y }
          : { x: d.position.x, y: Math.round(d.position.y + delta) };
      changes.update("item", d.id);
    }
    refreshRoom(p, it);
    changes.update("item", it.id);
    cursor += w + gap;
  });
  return items;
}

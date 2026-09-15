// Zone reducers and arrangement patterns (spec 03 sections 3 and 4; spec 05 section 6, grid and rows in phase 0).
import type { Item, Point, Project, Size3, Zone } from "@fpv/ir";
import { defaultItem, derive, normalizeDeg, poly } from "@fpv/ir";
import { type Changes, type Ctx, ensureSnapshot, levelById, roomById, zoneById } from "../context.js";
import { precondition } from "../errors.js";
import type { PayloadOf } from "../types.js";

type Rule = Zone["rule"] & object;

interface Placement {
  position: Point;
  rotation: number;
}

/** Grid or rows inside the polygon inset by margin; positions whose footprint corners leave the polygon are dropped. */
export function arrangePlacements(
  polygon: readonly Point[],
  rule: Rule,
  size: Size3,
): { placements: Placement[]; requested: number } {
  if (rule.pattern !== "grid" && rule.pattern !== "rows" && rule.pattern !== "bench") {
    throw precondition(
      "command.precondition",
      `pattern "${rule.pattern}" arrives with the phase 1 rules pack`,
      null,
      "use grid, rows, or bench",
    );
  }
  const b = poly.bounds(polygon);
  const a = (rule.facing * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const pitchX = size.w + rule.spacing.x;
  const pitchY = size.d + rule.spacing.y;
  const placements: Placement[] = [];
  const fits = (c: Point): boolean => {
    const hw = size.w / 2;
    const hd = size.d / 2;
    const corners = [
      { x: -hw, y: hd },
      { x: hw, y: hd },
      { x: hw, y: -hd },
      { x: -hw, y: -hd },
    ].map((q) => ({ x: c.x + q.x * cos - q.y * sin, y: c.y + q.x * sin + q.y * cos }));
    return corners.every((q) => poly.containsPoint(polygon, q));
  };
  const startX = b.minX + rule.margin + size.w / 2;
  const startY = b.minY + rule.margin + size.d / 2;
  outer: for (let y = startY; y <= b.maxY - rule.margin - size.d / 2 + 1e-9; y += pitchY) {
    for (let x = startX; x <= b.maxX - rule.margin - size.w / 2 + 1e-9; x += pitchX) {
      const c = { x: Math.round(x), y: Math.round(y) };
      if (!fits(c)) continue;
      // bench: pairs of desks back to back along rows; alternate rows face opposite ways
      const rowIndex = Math.round((y - startY) / pitchY);
      const rotation =
        rule.pattern === "bench" && rowIndex % 2 === 1 ? normalizeDeg(rule.facing + 180) : rule.facing;
      placements.push({ position: c, rotation });
      if (placements.length >= rule.count) break outer;
    }
  }
  return { placements, requested: rule.count };
}

function ruleRef(rule: Rule): Item["ref"] {
  if (rule.productId) return { kind: "product", productId: rule.productId };
  if (rule.recipe) return { kind: "recipe", recipe: rule.recipe };
  throw precondition("command.payload", "rule needs a productId or a recipe");
}

function placeGenerated(p: Project, ctx: Ctx, zone: Zone, changes: Changes): Item[] {
  const rule = zone.rule;
  if (!rule) return [];
  const ref = ruleRef(rule);
  if (ref.kind === "product" && !ensureSnapshot(p, ctx, ref.productId)) {
    throw precondition(
      "catalog.missing-snapshot",
      `productId "${ref.productId}" is not in the catalog`,
      zone.id,
    );
  }
  const probe = defaultItem("item_000000", zone.levelId, ref, { x: 0, y: 0 });
  const size = derive.itemSize(probe, derive.snapshotSizeSource(p));
  if (!size) throw precondition("catalog.missing-snapshot", "cannot size the rule's product", zone.id);
  const { placements, requested } = arrangePlacements(zone.polygon, rule, size);
  if (placements.length < requested)
    changes.warn(`zone ${zone.id}: placed ${placements.length} of ${requested} requested`);
  const created: Item[] = [];
  for (const pl of placements) {
    const item = defaultItem(ctx.ids.next("item"), zone.levelId, ref, pl.position, {
      rotation: pl.rotation,
      tags: ["generated"],
    });
    item.roomId = derive.containingRoom(p, item.levelId, item.position)?.id ?? null;
    p.items.push(item);
    changes.add("item", item.id);
    created.push(item);
  }
  zone.generatedItemIds = created.map((i) => i.id);
  changes.update("zone", zone.id);
  return created;
}

function deleteGenerated(p: Project, zone: Zone, changes: Changes): void {
  const ids = new Set(zone.generatedItemIds);
  for (const it of [...p.items]) {
    if (ids.has(it.id)) {
      p.items.splice(p.items.indexOf(it), 1);
      changes.remove("item", it.id);
    }
  }
  zone.generatedItemIds = [];
}

export function zoneCreate(p: Project, payload: PayloadOf<"zone.create">, ctx: Ctx, changes: Changes): Zone {
  levelById(p, payload.levelId);
  const zone: Zone = {
    id: ctx.ids.next("zone"),
    levelId: payload.levelId,
    name: payload.name ?? null,
    polygon: payload.polygon.map((q) => ({ x: q.x, y: q.y })),
    kind: payload.kind,
    rule: payload.rule ?? null,
    generatedItemIds: [],
    properties: {},
  };
  p.zones.push(zone);
  changes.add("zone", zone.id);
  return zoneById(p, zone.id);
}

export function zoneModify(p: Project, payload: PayloadOf<"zone.modify">, _ctx: Ctx, changes: Changes): Zone {
  const z = zoneById(p, payload.zoneId);
  Object.assign(z, payload.changes);
  changes.update("zone", z.id);
  return z;
}

export function zoneRegenerate(
  p: Project,
  payload: PayloadOf<"zone.regenerate">,
  ctx: Ctx,
  changes: Changes,
): Item[] {
  const z = zoneById(p, payload.zoneId);
  deleteGenerated(p, z, changes);
  return placeGenerated(p, ctx, z, changes);
}

export function zoneDelete(p: Project, payload: PayloadOf<"zone.delete">, _ctx: Ctx, changes: Changes): void {
  for (const id of payload.zoneIds) {
    const z = zoneById(p, id);
    if (payload.deleteItems) deleteGenerated(p, z, changes);
    p.zones.splice(p.zones.indexOf(z), 1);
    changes.remove("zone", id);
  }
}

/** item.arrange: create or reuse a zone for the target and generate items (spec 03 item.arrange). */
export function itemArrange(
  p: Project,
  payload: PayloadOf<"item.arrange">,
  ctx: Ctx,
  changes: Changes,
): { zone: Zone; items: Item[] } {
  let zone: Zone;
  if ("zoneId" in payload.target) {
    zone = zoneById(p, payload.target.zoneId);
    zone.rule = payload.rule;
    if (payload.replace) deleteGenerated(p, zone, changes);
  } else {
    const levelId =
      "roomId" in payload.target ? roomById(p, payload.target.roomId).levelId : payload.target.levelId;
    const polygon =
      "roomId" in payload.target ? roomById(p, payload.target.roomId).polygon : payload.target.polygon;
    zone = zoneCreate(
      p,
      { levelId, polygon, kind: "desk-cluster", rule: payload.rule, name: null },
      ctx,
      changes,
    );
  }
  const items = placeGenerated(p, ctx, zone, changes);
  return { zone, items };
}

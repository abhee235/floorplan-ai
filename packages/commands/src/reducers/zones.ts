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

/**
 * Grid, rows or bench inside the polygon, inset by the margin. Positions whose footprint corners leave
 * the polygon are dropped, so a zone that is not a rectangle still only holds what fits inside it.
 *
 * Two things this gets right that are easy to get wrong:
 *
 * The step is the footprint AS IT LIES, not the size as it was measured. A 1600 x 800 desk turned to
 * face east is 800 across and 1600 deep, and stepping by 1600 across would have left it in a field of
 * gaps — or, turned the other way, overlapping its neighbour.
 *
 * The block is centred in the zone rather than packed into its bottom-left corner. The margin is what
 * is kept clear INSIDE the edge, so whatever is left over after the last row is shared between the two
 * sides; packing to one corner made a zone look mis-drawn, because the gap at the far edge was whatever
 * the arithmetic happened to leave.
 */
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
  // How much room one piece takes along each axis once it is turned to face the way the rule says.
  const spanX = Math.abs(size.w * cos) + Math.abs(size.d * sin);
  const spanY = Math.abs(size.w * sin) + Math.abs(size.d * cos);
  const usableX = b.maxX - b.minX - 2 * rule.margin;
  const usableY = b.maxY - b.minY - 2 * rule.margin;
  const placements: Placement[] = [];
  if (usableX < spanX || usableY < spanY) return { placements, requested: rule.count };

  const columns = offsets(spanX, rule.spacing.x, usableX, false);
  const rows = offsets(spanY, rule.spacing.y, usableY, rule.pattern === "bench");
  const blockX = (columns[columns.length - 1] ?? 0) + spanX;
  const blockY = (rows[rows.length - 1] ?? 0) + spanY;
  const originX = b.minX + rule.margin + (usableX - blockX) / 2 + spanX / 2;
  const originY = b.minY + rule.margin + (usableY - blockY) / 2 + spanY / 2;

  // The corners are pulled a hair towards the middle before they are tested. A piece that exactly fills
  // its zone has corners ON the polygon's edge, where containment is a coin toss, and a zone drawn to
  // hold ten desks would come back holding nine. The shrink is a millionth of the piece — under a
  // thousandth of a millimetre — so it cannot let anything hang outside a zone it does not fit in.
  const fits = (c: Point): boolean => {
    const hw = (size.w / 2) * (1 - 1e-6);
    const hd = (size.d / 2) * (1 - 1e-6);
    const corners = [
      { x: -hw, y: hd },
      { x: hw, y: hd },
      { x: hw, y: -hd },
      { x: -hw, y: -hd },
    ].map((q) => ({ x: c.x + q.x * cos - q.y * sin, y: c.y + q.x * sin + q.y * cos }));
    return corners.every((q) => poly.containsPoint(polygon, q));
  };

  outer: for (let row = 0; row < rows.length; row += 1) {
    for (const acrossOffset of columns) {
      const c = {
        x: Math.round(originX + acrossOffset),
        y: Math.round(originY + (rows[row] as number)),
      };
      if (!fits(c)) continue;
      // bench: desks are back to back in pairs, so every second row faces the way it came from
      const rotation =
        rule.pattern === "bench" && row % 2 === 1 ? normalizeDeg(rule.facing + 180) : rule.facing;
      placements.push({ position: c, rotation });
      if (placements.length >= rule.count) break outer;
    }
  }
  return { placements, requested: rule.count };
}

/**
 * Where each row or column begins, measured from the near edge of the first one, for as many as fit in
 * `available`.
 *
 * Paired rows are what makes a bench a bench: two desks meet back to back with nothing between them,
 * and the gap is what separates one pair from the next. Spreading the gap evenly instead would be a
 * grid of desks that happen to face opposite ways.
 */
function offsets(span: number, gap: number, available: number, paired: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; ; i += 1) {
    const at = paired ? i * span + Math.floor(i / 2) * gap : i * (span + gap);
    if (at + span > available + 1e-9) break;
    out.push(at);
  }
  return out;
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

/**
 * Changes a zone, and keeps what it made in step with it.
 *
 * A zone's pieces exist because the zone says so, so a zone whose shape changed while its pieces stayed
 * put would be a lie on the plan. How they follow depends on what changed:
 *
 * Moved, and nothing else — every corner shifted by the same amount — and the pieces move with it. They
 * keep their ids, which means anything done to one of them since (a colour, a different product on the
 * end of a row) survives being dragged across the floor.
 *
 * Reshaped, and they are laid out again, because the old positions were worked out for a shape that is
 * gone. That does replace them, ids and all; there is no way to keep them and honour the new shape.
 */
export function zoneModify(p: Project, payload: PayloadOf<"zone.modify">, ctx: Ctx, changes: Changes): Zone {
  const z = zoneById(p, payload.zoneId);
  const before = z.polygon.map((q) => ({ x: q.x, y: q.y }));
  Object.assign(z, payload.changes);
  if (payload.changes.polygon) {
    const shift = translationBetween(before, z.polygon);
    if (shift) moveGenerated(p, z, shift, changes);
    else {
      deleteGenerated(p, z, changes);
      placeGenerated(p, ctx, z, changes);
    }
  }
  changes.update("zone", z.id);
  return z;
}

/** The one offset that turns `from` into `to`, or null when the shape changed as well as the place. */
function translationBetween(from: readonly Point[], to: readonly Point[]): Point | null {
  if (from.length !== to.length || from.length === 0) return null;
  const first = from[0] as Point;
  const shift = { x: (to[0] as Point).x - first.x, y: (to[0] as Point).y - first.y };
  for (let i = 1; i < from.length; i += 1) {
    const a = from[i] as Point;
    const b = to[i] as Point;
    if (b.x - a.x !== shift.x || b.y - a.y !== shift.y) return null;
  }
  return shift;
}

function moveGenerated(p: Project, zone: Zone, shift: Point, changes: Changes): void {
  if (shift.x === 0 && shift.y === 0) return;
  const ids = new Set(zone.generatedItemIds);
  for (const it of p.items) {
    if (!ids.has(it.id)) continue;
    it.position = { x: it.position.x + shift.x, y: it.position.y + shift.y };
    // Which room a piece counts in is where it stands, so it is worked out again where it now stands.
    it.roomId = derive.containingRoom(p, it.levelId, it.position)?.id ?? null;
    changes.update("item", it.id);
  }
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
    // A new shape arrives with the rule when a cluster is resized, so the pieces are laid out once, for
    // the zone as it now is, rather than once for the old shape and again for the new one.
    if (payload.target.polygon) zone.polygon = payload.target.polygon.map((q) => ({ x: q.x, y: q.y }));
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

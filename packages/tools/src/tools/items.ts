// Item tools (spec 04 section 5): place_item, modify_item, finish_item, arrange.
import { itemMaterialSlots } from "@fpv/commands";
import { doorSwingZones } from "@fpv/geometry";
import type { Item, Point, Project, Zone } from "@fpv/ir";
import { derive, FINISH_NAMES, finishNameOf, PrimitiveRecipe, poly } from "@fpv/ir";
import { z } from "zod";
import { type CatalogSearch, sizesFor } from "../context.js";
import { invalidArg, ToolError } from "../envelope.js";
import { defineTool, type ToolCall } from "../registry.js";
import { ItemViewS, itemView } from "../views.js";
import { dress, HexS, roomOrThrow, run, runAll } from "./structure.js";

const PointS = z.object({ x: z.number(), y: z.number() });
const CompassS = z.enum(["north", "south", "east", "west"]);

const ANCHOR_WORDS = new Set([
  "center",
  "against-north-wall",
  "against-south-wall",
  "against-east-wall",
  "against-west-wall",
  "north-east-corner",
  "north-west-corner",
  "south-east-corner",
  "south-west-corner",
]);

/** Parse the anchor string of place_item into the command's anchor union. */
export function parseAnchor(anchor: string): unknown {
  if (ANCHOR_WORDS.has(anchor)) return anchor;
  const along = /^along-wall:([a-z0-9_]+)@(\d+)$/.exec(anchor);
  if (along) return { alongWall: along[1], atMm: Number(along[2]) };
  const on = /^on:([a-z0-9_]+)$/.exec(anchor);
  if (on) return { on: on[1] };
  throw invalidArg(
    "anchor",
    `"${anchor}" is not an anchor`,
    "use center, against-<side>-wall, <side>-<side>-corner, along-wall:<wallId>@<mm>, or on:<itemId>",
  );
}

/** Resolve productId or recipe into the command's item ref; unknown products fail with candidates. */
export function itemRefFor(
  catalog: CatalogSearch,
  productId: string | undefined,
  recipe: PrimitiveRecipe | undefined,
): unknown {
  if (productId && recipe) throw invalidArg("productId", "give productId or recipe, not both");
  if (recipe) return { kind: "recipe", recipe };
  if (!productId) throw invalidArg("productId", "give productId or recipe", "use search_catalog to find one");
  if (!catalog.product(productId)) {
    const near = catalog.search({ query: productId, limit: 5 }).hits;
    const hint = near.length
      ? `candidates: ${near.map((h) => `${h.id} (${h.category} ${h.dims.w}x${h.dims.d}x${h.dims.h})`).join(", ")}`
      : "use search_catalog or verify_product";
    throw new ToolError(
      "catalog.unknown-product",
      `product "${productId}" is not in the catalog`,
      null,
      hint,
    );
  }
  return { kind: "product", productId };
}

/**
 * Doors whose swing an item stands in: its footprint overlaps the door's swing square (spec 05 section 5
 * stage 4). place_item and modify_item no longer call this: item.place and item.move report the same
 * check as `item.door-swing` through the placement pipeline.
 */
export function doorSwingWarnings(p: Project, item: Item, sizes: derive.SizeSource): string[] {
  const size = derive.itemSize(item, sizes);
  if (!size || item.mount.kind === "wall" || item.mount.kind === "ceiling") return [];
  const fp: Point[] = derive.itemFootprint(item, size);
  const doors = [
    ...new Set(
      doorSwingZones(p, item.levelId)
        .filter((z) => poly.convexOverlapArea(fp, z.polygon) > 1000)
        .map((z) => z.openingId),
    ),
  ];
  return doors.map(
    (id) => `${item.id} stands in the swing of door ${id}; keep a square as wide as the door clear`,
  );
}

function levelFor(p: Project, roomId: string | undefined, explicit: string | undefined): string {
  if (roomId) return roomOrThrow(p, roomId).levelId;
  if (explicit) return explicit;
  if (p.levels.length === 1) return (p.levels[0] as (typeof p.levels)[number]).id;
  return derive.lowestLevel(p).id;
}

export const placeItem = defineTool({
  name: "place_item",
  description:
    "Place a product or recipe. Either give x, y, or give roomId plus an anchor: 'center', 'against-north-wall' (also south/east/west), 'north-east-corner' (and the other corners), 'along-wall:<wallId>@<mm>', or 'on:<itemId>' to stack on another item. Anchors set rotation for you. Returns the final position after snapping and any warnings about overlaps or blocked door swings.",
  tier: "both",
  mutating: true,
  input: z.object({
    productId: z.string().optional().describe("from search_catalog or verify_product"),
    recipe: PrimitiveRecipe.optional().describe("a parametric shape, e.g. from search_catalog kind 'recipe'"),
    x: z.number().optional().describe("plan x in mm"),
    y: z.number().optional().describe("plan y in mm"),
    roomId: z.string().optional(),
    levelId: z
      .string()
      .optional()
      .describe("needed only when placing by x, y on a project with several levels"),
    anchor: z.string().optional().describe("e.g. 'against-north-wall' or 'along-wall:wall_000001@2400'"),
    rotation: z.number().optional().describe("degrees counter-clockwise; 0 faces -y"),
    elevation: z.number().int().optional().describe("mm above the floor, e.g. 0"),
    mount: z
      .object({
        kind: z.enum(["floor", "wall", "ceiling", "table", "item"]),
        targetId: z.string().optional(),
        height: z.number().int().min(0).optional(),
      })
      .optional(),
    tags: z.array(z.string()).optional(),
    snap: z
      .boolean()
      .optional()
      .describe(
        "default true: snap to walls, surfaces and neighbours; false keeps the exact position and rotation",
      ),
  }),
  output: z.object({ item: ItemViewS, adjusted: z.boolean() }),
  run(args, call) {
    const p0 = call.ctx.store.project;
    const ref = itemRefFor(call.ctx.catalog, args.productId, args.recipe);
    const hasXY = args.x !== undefined && args.y !== undefined;
    if (!hasXY && !(args.roomId && args.anchor))
      throw invalidArg(
        "position",
        "give x and y, or roomId and anchor",
        "e.g. roomId: 'room_000001', anchor: 'center'",
      );
    const levelId = levelFor(p0, args.roomId, args.levelId);
    const payload: Record<string, unknown> = { levelId, ref };
    if (hasXY) payload.position = { x: args.x, y: args.y };
    if (args.roomId) payload.roomId = args.roomId;
    if (args.anchor) payload.anchor = parseAnchor(args.anchor);
    if (args.rotation !== undefined) payload.rotation = args.rotation;
    if (args.elevation !== undefined) payload.elevation = args.elevation;
    if (args.mount)
      payload.mount = {
        kind: args.mount.kind,
        targetId: args.mount.targetId ?? null,
        height: args.mount.height ?? null,
      };
    if (args.tags) payload.tags = args.tags;
    if (args.snap === false) payload.magnetism = false;
    const r = run(call, { type: "item.place", payload });
    const p = call.ctx.store.project;
    const item = p.items.find((i) => i.id === (r.result as Item).id) as Item;
    const sizes = sizesFor(p, call.ctx.catalog);
    const adjusted = hasXY ? item.position.x !== args.x || item.position.y !== args.y : false;
    return { item: itemView(p, item, sizes, call.ctx.catalog), adjusted };
  },
});

export function itemOrThrow(p: Project, id: string): Item {
  const it = p.items.find((i) => i.id === id);
  if (!it)
    throw new ToolError(
      "ref.missing",
      `item "${id}" does not resolve`,
      null,
      "use get_scene with types ['item']",
    );
  return it;
}

export const modifyItem = defineTool({
  name: "modify_item",
  description:
    "Change one item: absolute x, y, rotation, elevation, size (null returns to the product size), parentId (stack on another item or null to unstack), productId, mirrored or tags. Items stacked on it move with it.",
  tier: "primitive",
  mutating: true,
  input: z.object({
    itemId: z.string(),
    x: z.number().optional(),
    y: z.number().optional(),
    rotation: z.number().optional(),
    elevation: z.number().int().optional(),
    size: z
      .object({
        w: z.number().int().positive(),
        d: z.number().int().positive(),
        h: z.number().int().positive(),
      })
      .nullable()
      .optional(),
    parentId: z.string().nullable().optional(),
    productId: z.string().optional(),
    recipe: PrimitiveRecipe.optional(),
    mirrored: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    snap: z
      .boolean()
      .optional()
      .describe("default true: a moved item snaps without turning; false keeps the exact position"),
  }),
  output: z.object({ item: ItemViewS, descendants: z.array(ItemViewS) }),
  run(args, call) {
    const p0 = call.ctx.store.project;
    const it = itemOrThrow(p0, args.itemId);
    const commands: unknown[] = [];
    const ids = [it.id];
    if (args.x !== undefined || args.y !== undefined) {
      commands.push({
        type: "item.move",
        payload: {
          itemIds: ids,
          dx: (args.x ?? it.position.x) - it.position.x,
          dy: (args.y ?? it.position.y) - it.position.y,
          ...(args.snap === false ? { magnetism: false } : {}),
        },
      });
    }
    if (args.rotation !== undefined)
      commands.push({ type: "item.rotate", payload: { itemIds: ids, angle: args.rotation } });
    if (args.elevation !== undefined)
      commands.push({ type: "item.setElevation", payload: { itemIds: ids, elevation: args.elevation } });
    if (args.size !== undefined)
      commands.push({ type: "item.resize", payload: { itemId: it.id, size: args.size } });
    if (args.parentId !== undefined)
      commands.push({ type: "item.setParent", payload: { itemId: it.id, parentId: args.parentId } });
    if (args.productId !== undefined || args.recipe !== undefined)
      commands.push({
        type: "item.setProduct",
        payload: { itemId: it.id, ref: itemRefFor(call.ctx.catalog, args.productId, args.recipe) },
      });
    if (args.mirrored !== undefined && args.mirrored !== it.mirrored)
      commands.push({ type: "item.mirror", payload: { itemIds: ids } });
    if (args.tags !== undefined) call.warn("tags cannot be changed after placement yet; ignored");
    if (commands.length === 0) throw invalidArg("changes", "give at least one field to change");
    const t = call.ctx.store.transaction("modify_item", commands, call.origin);
    if (!t.ok) throw new ToolError(t.error.code, t.error.message, t.error.entityId, t.error.hint);
    call.changed(t.entry?.changes ?? null);
    const p = call.ctx.store.project;
    const sizes = sizesFor(p, call.ctx.catalog);
    const item = p.items.find((i) => i.id === it.id) as Item;
    const descendants = p.items.filter((i) => i.parentId === it.id);
    return {
      item: itemView(p, item, sizes, call.ctx.catalog),
      descendants: descendants.map((d) => itemView(p, d, sizes, call.ctx.catalog)),
    };
  },
});

const PartFinishS = z.object({
  itemId: z.string(),
  part: z.string(),
  colour: z.string().nullable(),
  texture: z.string().nullable(),
  finish: z.string(),
  /** False when the part carries no finish of its own and follows the item's. */
  own: z.boolean(),
});

/**
 * Every part an item is drawn in and how each is dressed now.
 *
 * Reported by finish_item because the part names are otherwise undiscoverable: they come from the
 * recipe behind a product's category, not from anything the model can see. A call that names no part
 * dresses the whole item and answers with the list, so one call teaches the next.
 */
function partFinishes(p: Project, it: Item): z.infer<typeof PartFinishS>[] {
  const slots = itemMaterialSlots(p, it) ?? [];
  return slots.map((part) => {
    const own = it.materials[part] ?? null;
    const f = own ?? it.finish;
    return {
      itemId: it.id,
      part,
      colour: f?.color ?? null,
      texture: f?.textureId ?? null,
      finish: finishNameOf(f?.shininess ?? null),
      own: own !== null,
    };
  });
}

export const finishItem = defineTool({
  name: "finish_item",
  description:
    "Paint or texture items, or one part of them: a chair's fabric or frame, a table's top or legs. Give part to dress that part alone, or leave it out to dress the whole item, which every part without a finish of its own follows. A part given anything of its own stops following the item, so to keep the item's colour on a part, give that colour to the part as well. colour is hex (#RRGGBB or #RGB) or null for the default; texture is a texture id from search_catalog, or null for paint; finish is matt, satin or gloss. The answer lists every part of every item, with `own` saying which parts carry a finish of their own, and is how the part names are learnt.",
  tier: "primitive",
  mutating: true,
  input: z.object({
    itemIds: z.array(z.string()).min(1).describe("one or more items, e.g. ['item_0000a1']"),
    part: z
      .string()
      .optional()
      .describe("a part name such as fabric, frame, top or legs; omit for the whole item"),
    colour: HexS.nullable().optional(),
    texture: z.string().nullable().optional().describe("a texture id from search_catalog, or null for paint"),
    finish: z.enum(FINISH_NAMES as [string, ...string[]]).optional(),
  }),
  output: z.object({ items: z.array(ItemViewS), parts: z.array(PartFinishS) }),
  run(args, call) {
    const { itemIds, part, ...fields } = args;
    if (Object.values(fields).every((v) => v === undefined))
      throw invalidArg("colour", "give at least one of colour, texture, finish");
    const p0 = call.ctx.store.project;
    // One command per item rather than one for all: each is dressed from its own current finish, so a
    // colour given to a mixed set changes the colour and leaves each item's texture and sheen alone.
    const commands = itemIds.map((id) => {
      const it = itemOrThrow(p0, id);
      if (part === undefined)
        return { type: "item.setFinish", payload: { itemIds: [it.id], finish: dress(it.finish, fields) } };
      const slots = itemMaterialSlots(p0, it);
      if (slots && !slots.includes(part))
        throw new ToolError(
          "item.material-slot",
          `"${part}" is not a part of ${it.id}`,
          it.id,
          slots.length
            ? `its parts are ${slots.join(", ")}`
            : "this item has no named parts; dress it without a part",
        );
      return {
        type: "item.setFinish",
        payload: { itemIds: [it.id], materials: { [part]: dress(it.materials[part], fields) } },
      };
    });
    runAll(call, "finish_item", commands);
    const p = call.ctx.store.project;
    const sizes = sizesFor(p, call.ctx.catalog);
    const after = itemIds.map((id) => itemOrThrow(p, id));
    return {
      items: after.map((it) => itemView(p, it, sizes, call.ctx.catalog)),
      parts: after.flatMap((it) => partFinishes(p, it)),
    };
  },
});

const COMPASS_DEG: Record<"north" | "west" | "south" | "east", number> = {
  north: 0,
  west: 90,
  south: 180,
  east: 270,
};

export const arrange = defineTool({
  name: "arrange",
  description:
    "Fill a room or zone with a pattern: 'grid', 'rows', 'bench' (desks back to back), 'boardroom' (one table, chairs around), 'u-shape', 'classroom'. count is the number of items requested; the result says how many fit.",
  tier: "both",
  mutating: true,
  input: z.object({
    roomId: z.string().optional(),
    zoneId: z.string().optional(),
    pattern: z.enum(["grid", "rows", "u-shape", "boardroom", "classroom", "bench"]),
    productId: z.string().optional(),
    recipe: PrimitiveRecipe.optional(),
    count: z.number().int().min(1).describe("items requested, e.g. 12"),
    spacingMm: z.number().int().min(0).optional().describe("gap between items in mm, default 600"),
    facing: CompassS.optional().describe("which way the items face, default south"),
    replace: z.boolean().optional().describe("true replaces items the zone generated earlier"),
  }),
  output: z.object({
    zoneId: z.string(),
    placed: z.number(),
    requested: z.number(),
    items: z.array(ItemViewS),
  }),
  run(args, call) {
    if (!args.roomId && !args.zoneId) throw invalidArg("roomId", "give roomId or zoneId");
    const ref = itemRefFor(call.ctx.catalog, args.productId, args.recipe) as {
      kind: string;
      productId?: string;
      recipe?: PrimitiveRecipe;
    };
    const spacing = args.spacingMm ?? 600;
    const p0 = call.ctx.store.project;
    const rule = {
      pattern: args.pattern,
      productId: ref.productId ?? null,
      recipe: ref.recipe ?? null,
      count: args.count,
      spacing: { x: spacing, y: spacing },
      facing: (p0.meta.north + COMPASS_DEG[args.facing ?? "south"]) % 360,
      margin: 300,
    };
    const target = args.zoneId ? { zoneId: args.zoneId } : { roomId: args.roomId as string };
    const r = run(call, {
      type: "item.arrange",
      payload: { target, rule, ...(args.replace !== undefined ? { replace: args.replace } : {}) },
    });
    const p = call.ctx.store.project;
    const sizes = sizesFor(p, call.ctx.catalog);
    const { zone, items } = r.result as { zone: Zone; items: Item[] };
    if (items.length < args.count)
      call.warn(`only ${items.length} of ${args.count} fit; enlarge the room, reduce spacing or count`);
    return {
      zoneId: zone.id,
      placed: items.length,
      requested: args.count,
      items: items.map((i) =>
        itemView(p, p.items.find((x) => x.id === i.id) as Item, sizes, call.ctx.catalog),
      ),
    };
  },
});

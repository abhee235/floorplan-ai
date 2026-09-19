// Inspect tools (spec 04 section 2): get_scene, describe_room, measure, validate, search_catalog.
import { checkDesign } from "@fpv/catalog";
import type { Point, Project } from "@fpv/ir";
import { derive, poly, validate as validateProject } from "@fpv/ir";
import { z } from "zod";
import { searchRecipes, sizesFor } from "../context.js";
import { invalidArg, paginate, ToolError } from "../envelope.js";
import { defineTool } from "../registry.js";
import {
  centroidOf,
  entityOutline,
  FreeSegmentS,
  freeSegments,
  ItemViewS,
  itemView,
  OpeningViewS,
  openingView,
  RoomViewS,
  ringDistance,
  roomView,
  suggestedDisplayWall,
  WallViewS,
  wallView,
} from "../views.js";

const PointS = z
  .object({ x: z.number(), y: z.number() })
  .describe("plan point in mm, e.g. { x: 1200, y: 3400 }");
const ProblemS = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning"]),
  entityId: z.string().nullable(),
  message: z.string(),
  hint: z.string().nullable(),
  related: z.array(z.string()),
});
const EntityType = z.enum(["wall", "opening", "room", "item", "zone", "annotation"]);

function staleIds(p: Project): Set<string> {
  return new Set(
    p.rooms.filter((r) => r.source === "detected" && r.properties.__stale === "true").map((r) => r.id),
  );
}

export const getScene = defineTool({
  name: "get_scene",
  description:
    "Read the project. Call with detail 'summary' first; it returns levels, rooms with names, purposes, areas and item counts, and the bounding box in under 2 KB. Use detail 'full' with types and levelId to page through entities (100 per page, follow cursor). All lengths are mm, angles degrees, north is +y unless meta.north says otherwise.",
  tier: "both",
  mutating: false,
  input: z.object({
    detail: z.enum(["summary", "full"]).describe("'summary' first; 'full' pages entities"),
    levelId: z.string().optional().describe("restrict to one level, e.g. level_000000"),
    types: z.array(EntityType).optional().describe("entity types to include with detail 'full'"),
    bbox: z
      .object({ minX: z.number(), minY: z.number(), maxX: z.number(), maxY: z.number() })
      .optional()
      .describe("only entities whose outline touches this plan rectangle in mm"),
    cursor: z.string().optional().describe("cursor from the previous page"),
  }),
  output: z.object({}).passthrough(),
  run(args, { ctx }) {
    const p = ctx.store.project;
    const sizes = sizesFor(p, ctx.catalog);
    const level = (id: string) => !args.levelId || id === args.levelId;
    if (args.detail === "summary") {
      const problems = validateProject(p, { sizes });
      const b = derive.projectBounds(p, sizes);
      return {
        meta: p.meta,
        levels: p.levels.map((l) => ({ id: l.id, name: l.name, elevation: l.elevation, height: l.height })),
        rooms: p.rooms
          .filter((r) => level(r.levelId))
          .map((r) => ({
            id: r.id,
            levelId: r.levelId,
            name: r.name,
            purpose: r.purpose,
            areaM2: Math.round(derive.roomArea(r) / 1e4) / 100,
            itemCount: p.items.filter(
              (i) => i.roomId === r.id || (i.roomId === null && derive.roomContains(r, i.position)),
            ).length,
          })),
        counts: {
          walls: p.walls.filter((w) => level(w.levelId)).length,
          openings: p.openings.filter((o) => level(o.levelId)).length,
          rooms: p.rooms.filter((r) => level(r.levelId)).length,
          items: p.items.filter((i) => level(i.levelId)).length,
          zones: p.zones.filter((zn) => level(zn.levelId)).length,
        },
        bounds: b ? { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY } : null,
        problems: {
          errors: problems.filter((x) => x.severity === "error").length,
          warnings: problems.filter((x) => x.severity === "warning").length,
        },
      };
    }
    const types = new Set(args.types ?? EntityType.options);
    const inBox = (id: string) => {
      if (!args.bbox) return true;
      const outline = entityOutline(p, id, sizes);
      if (!outline || outline.length === 0) return false;
      const ob = poly.bounds(outline);
      return poly.rectsIntersect(ob, args.bbox);
    };
    const stale = staleIds(p);
    const rows: { type: string; view: unknown }[] = [];
    if (types.has("wall"))
      for (const w of p.walls)
        if (level(w.levelId) && inBox(w.id)) rows.push({ type: "wall", view: wallView(p, w) });
    if (types.has("opening"))
      for (const o of p.openings)
        if (level(o.levelId) && inBox(o.id)) rows.push({ type: "opening", view: openingView(p, o) });
    if (types.has("room"))
      for (const r of p.rooms)
        if (level(r.levelId) && inBox(r.id))
          rows.push({ type: "room", view: roomView(p, r, sizes, stale.has(r.id)) });
    if (types.has("item"))
      for (const i of p.items)
        if (level(i.levelId) && inBox(i.id))
          rows.push({ type: "item", view: itemView(p, i, sizes, ctx.catalog) });
    if (types.has("zone"))
      for (const zn of p.zones) if (level(zn.levelId) && inBox(zn.id)) rows.push({ type: "zone", view: zn });
    if (types.has("annotation"))
      for (const a of p.annotations) if (level(a.levelId)) rows.push({ type: "annotation", view: a });
    const page = paginate(rows, args.cursor);
    const grouped: Record<string, unknown[]> = {};
    for (const row of page.page) (grouped[`${row.type}s`] ??= []).push(row.view);
    return { ...grouped, cursor: page.cursor, truncated: page.truncated, total: rows.length };
  },
});

export const describeRoom = defineTool({
  name: "describe_room",
  description:
    "Describe one room for placing things: its walls named north/south/east/west with free wall lengths (segments not blocked by openings or items), openings with hinge sides, items with positions, and clearances. Use this before place_item with an anchor.",
  tier: "both",
  mutating: false,
  input: z.object({ roomId: z.string().describe("room id, e.g. room_000001") }),
  output: RoomViewS.extend({
    freeSegments: z.array(FreeSegmentS),
    items: z.array(ItemViewS),
    openings: z.array(OpeningViewS),
    suggestedDisplayWall: z.enum(["north", "south", "east", "west"]).nullable(),
  }),
  run(args, { ctx }) {
    const p = ctx.store.project;
    const r = p.rooms.find((x) => x.id === args.roomId);
    if (!r)
      throw new ToolError(
        "ref.missing",
        `room "${args.roomId}" does not resolve`,
        null,
        "use get_scene to list rooms",
      );
    const sizes = sizesFor(p, ctx.catalog);
    const view = roomView(p, r, sizes, staleIds(p).has(r.id));
    const free = freeSegments(p, r, sizes);
    const ids = new Set(view.openingIds);
    return {
      ...view,
      freeSegments: free,
      items: view.itemIds.map((id) =>
        itemView(p, p.items.find((i) => i.id === id) as (typeof p.items)[number], sizes, ctx.catalog),
      ),
      openings: p.openings.filter((o) => ids.has(o.id)).map((o) => openingView(p, o)),
      suggestedDisplayWall: suggestedDisplayWall(p, r, free),
    };
  },
});

export const measure = defineTool({
  name: "measure",
  description:
    "Distance between two entities (nearest edges) or two points, in mm. dx and dy are centre-to-centre.",
  tier: "both",
  mutating: false,
  input: z.object({
    fromId: z.string().optional().describe("entity id"),
    toId: z.string().optional().describe("entity id"),
    from: PointS.optional(),
    to: PointS.optional(),
  }),
  output: z.object({ mm: z.number(), dx: z.number(), dy: z.number() }),
  run(args, { ctx }) {
    const p = ctx.store.project;
    const sizes = sizesFor(p, ctx.catalog);
    const outline = (id: string | undefined, pt: Point | undefined, field: string): Point[] => {
      if (pt) return [pt];
      if (!id) throw invalidArg(field, "give either an id or a point");
      const o = entityOutline(p, id, sizes);
      if (!o)
        throw new ToolError("ref.missing", `"${id}" does not resolve`, null, "use get_scene to list ids");
      return o;
    };
    const a = outline(args.fromId, args.from, "from");
    const b = outline(args.toId, args.to, "to");
    const ca = centroidOf(a);
    const cb = centroidOf(b);
    return {
      mm: Math.round(ringDistance(a, b) * 10) / 10,
      dx: Math.round(cb.x - ca.x),
      dy: Math.round(cb.y - ca.y),
    };
  },
});

export const validateTool = defineTool({
  name: "validate",
  description:
    "Check the project for problems. Fix errors before continuing; warnings are advice. Each problem names the entity and, where possible, a hint.",
  tier: "both",
  mutating: false,
  input: z.object({ levelId: z.string().optional().describe("restrict to one level") }),
  output: z.object({ errors: z.array(ProblemS), warnings: z.array(ProblemS) }),
  run(args, { ctx }) {
    const p = ctx.store.project;
    const onLevel = new Set<string>();
    if (args.levelId) {
      for (const list of [p.walls, p.openings, p.rooms, p.items, p.zones, p.annotations])
        for (const e of list as { id: string; levelId: string }[])
          if (e.levelId === args.levelId) onLevel.add(e.id);
    }
    const all = [
      ...validateProject(p, { sizes: sizesFor(p, ctx.catalog) }),
      ...(ctx.rules ? checkDesign(p, ctx.rules, { catalog: ctx.catalog }) : []),
    ].filter((x) => !args.levelId || x.entityId === null || onLevel.has(x.entityId));
    return {
      errors: all.filter((x) => x.severity === "error"),
      warnings: all.filter((x) => x.severity === "warning"),
    };
  },
});

export const searchCatalog = defineTool({
  name: "search_catalog",
  description:
    "Find products or parametric recipes. Returns at most 20 with id, category and dimensions in mm. If several match, pick by id in the next call. Never invent a productId.",
  tier: "both",
  mutating: false,
  input: z.object({
    kind: z
      .enum(["product", "recipe"])
      .describe("'product' searches the catalog; 'recipe' lists parametric shapes"),
    query: z.string().describe("words or an exact id, e.g. 'boardroom table' or 'recipe:display:75'"),
    category: z
      .string()
      .optional()
      .describe(
        "e.g. table, chair, display, video-bar, ceiling-mic, ceiling-speaker; for homes bed, wardrobe, sofa, kitchen-run, sanitary, appliance",
      ),
    limit: z.number().int().min(1).max(20).optional().describe("max hits, default 20"),
    cursor: z.string().optional().describe("cursor from the previous page when total exceeds the hits"),
  }),
  output: z.object({
    hits: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        make: z.string(),
        model: z.string(),
        category: z.string(),
        dims: z.object({ w: z.number(), d: z.number(), h: z.number() }),
        verified: z.boolean(),
        price: z.number().nullable(),
        status: z.string().optional(),
        matchedBy: z.string().optional(),
        recipe: z.unknown().optional(),
      }),
    ),
    total: z.number(),
    cursor: z.string().nullable().optional(),
  }),
  run(args, { ctx }) {
    const limit = args.limit ?? 20;
    if (args.kind === "recipe") return searchRecipes(args.query, args.category, limit);
    const r = ctx.catalog.search({
      query: args.query,
      limit,
      ...(args.category ? { category: args.category } : {}),
      ...(args.cursor ? { cursor: args.cursor } : {}),
    });
    return { hits: r.hits, total: r.total, cursor: r.cursor ?? null };
  },
});

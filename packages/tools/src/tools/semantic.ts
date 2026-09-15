// Semantic tools (spec 04 section 6): a whole job in one call, composed of commands (ADR-006 D2).
import type { Item, Room, Wall } from "@fpv/ir";
import { derive } from "@fpv/ir";
import { z } from "zod";
import { parseBrief } from "../brief.js";
import { sizesFor } from "../context.js";
import { ToolError, unavailable } from "../envelope.js";
import { FurnishError, type FurnishOptions, planFurnishing } from "../furnish.js";
import { defineTool, type ToolCall } from "../registry.js";
import { itemView, roomView } from "../views.js";
import { roomOrThrow, runAll } from "./structure.js";

const CompassS = z.enum(["north", "south", "east", "west"]);
const WALL_MM = 100;

/** Plan and apply a recipe for one room in one transaction; returns what the tools report. */
function furnish(call: ToolCall, room: Room, options: FurnishOptions) {
  const { ctx } = call;
  const pack = ctx.rules;
  if (!pack) throw unavailable("furnish_room", "no rules pack is loaded in this session");
  const p = ctx.store.project;
  let plan: ReturnType<typeof planFurnishing>;
  try {
    plan = planFurnishing(p, room, pack, ctx.catalog, sizesFor(p, ctx.catalog), options);
  } catch (e) {
    if (e instanceof FurnishError) throw new ToolError(e.code, e.message, room.id, e.hint);
    throw e;
  }
  for (const w of plan.warnings) call.warn(w);
  const placed: Item[] = [];
  if (plan.commands.length > 0) {
    const results = runAll(call, `furnish ${room.name ?? room.id} (${plan.recipe.id})`, plan.commands);
    for (const r of results)
      if (r.result && typeof r.result === "object" && "ref" in (r.result as object))
        placed.push(r.result as Item);
  } else call.warn("nothing to place; the room already has everything the recipe adds");
  for (const u of plan.unresolved)
    call.warn(
      `no catalog ${u.category} matches ${u.constraint}; placed a ${u.placedAs} (verify_product can add one)`,
    );
  const after = ctx.store.project;
  const sizes = sizesFor(after, ctx.catalog);
  return {
    recipe: plan.recipe.id,
    displayWall: plan.displayWall,
    counts: plan.counts,
    items: placed
      .map((i) => after.items.find((x) => x.id === i.id))
      .filter((i): i is Item => i !== undefined)
      .map((i) => itemView(after, i, sizes, ctx.catalog)),
    unresolved: plan.unresolved,
  };
}

export const furnishRoom = defineTool({
  name: "furnish_room",
  description:
    "Apply a room recipe from the rules pack to an existing room: table and chairs sized to capacity, display on the best wall, video bar, ceiling mics and speakers by area, scheduler by the door. Products are chosen from the catalog by constraint; missing ones are verified or placed as recipes. Existing items are kept unless replace=true.",
  tier: "semantic",
  mutating: true,
  input: z.object({
    roomId: z.string().describe("room id, e.g. room_000001"),
    recipe: z
      .string()
      .optional()
      .describe("huddle, boardroom or training; default chosen by purpose and capacity"),
    replace: z.boolean().optional().describe("true removes the room's items first"),
    preferences: z
      .object({
        make: z.array(z.string()).optional().describe("preferred makes in order, e.g. ['Logitech']"),
        budget: z.enum(["low", "mid", "high"]).optional(),
      })
      .optional(),
  }),
  output: z.object({}).passthrough(),
  run(args, call) {
    if (!call.ctx.rules)
      throw unavailable(
        "furnish_room",
        "no rules pack is loaded in this session",
        "use describe_room, then place_item with anchors and arrange",
      );
    const room = roomOrThrow(call.ctx.store.project, args.roomId);
    if (args.preferences?.budget)
      call.warn("budget preferences are not applied yet; products are chosen by fit and verification");
    return furnish(call, room, {
      recipeId: args.recipe,
      replace: args.replace,
      preferMakes: args.preferences?.make,
    });
  },
});

export const createRoomFromBrief = defineTool({
  name: "create_room_from_brief",
  description:
    "Create and furnish a room from a sentence such as '10-seat boardroom 8 by 5 m with video conferencing'. Parses size, seats, purpose and AV needs; creates walls, a door on the corridor side, the room, then calls furnish_room. Returns what it understood so you can correct it.",
  tier: "semantic",
  mutating: true,
  input: z.object({
    brief: z.string().min(1).describe("e.g. '10-seat boardroom, 8 by 5 metres, video conferencing'"),
    levelId: z.string().optional(),
    origin: z.object({ x: z.number(), y: z.number() }).optional().describe("south-west inside corner in mm"),
    corridorSide: CompassS.optional().describe(
      "wall that gets the door; default the west wall of a wide room",
    ),
  }),
  output: z.object({}).passthrough(),
  run(args, call) {
    const { ctx } = call;
    if (!ctx.rules)
      throw unavailable(
        "create_room_from_brief",
        "no rules pack is loaded in this session",
        "use create_walls (closed), add_opening, create_room, then place_item and arrange",
      );
    const u = parseBrief(args.brief);
    for (const a of u.assumed) call.warn(a);
    const p0 = ctx.store.project;
    const levelId = args.levelId ?? derive.lowestLevel(p0).id;
    if (!derive.levelOf(p0, levelId))
      throw new ToolError("ref.missing", `level "${levelId}" does not resolve`, null, "use get_scene");
    const bounds = derive.projectBounds(p0, sizesFor(p0, ctx.catalog));
    const x0 = Math.round(args.origin?.x ?? (bounds ? Math.ceil((bounds.maxX + 2000) / 100) * 100 : 0));
    const y0 = Math.round(args.origin?.y ?? (bounds ? Math.floor(bounds.minY / 100) * 100 : 0));
    const W = u.widthMm;
    const D = u.depthMm;
    const corridor = args.corridorSide ?? (W >= D ? "west" : "south");
    const h = WALL_MM / 2;
    const before = ctx.store.historyPosition;
    try {
      const [chain] = runAll(call, "brief: walls", [
        {
          type: "wall.createChain",
          payload: {
            levelId,
            points: [
              { x: x0 - h, y: y0 - h },
              { x: x0 + W + h, y: y0 - h },
              { x: x0 + W + h, y: y0 + D + h },
              { x: x0 - h, y: y0 + D + h },
            ],
            closed: true,
            thickness: WALL_MM,
            kind: "interior",
          },
        },
      ]);
      const north = ctx.store.project.meta.north;
      const centre = { x: x0 + W / 2, y: y0 + D / 2 };
      const doorWall = ((chain?.result ?? []) as Wall[]).find((w) => {
        const m = { x: (w.start.x + w.end.x) / 2, y: (w.start.y + w.end.y) / 2 };
        return (
          derive.compassOf((Math.atan2(m.y - centre.y, m.x - centre.x) * 180) / Math.PI, north) === corridor
        );
      });
      if (!doorWall) throw new ToolError("brief.corridor", `no ${corridor} wall to put the door in`);
      const results = runAll(call, "brief: door and room", [
        {
          type: "opening.add",
          payload: {
            wallId: doorWall.id,
            kind: "door",
            position: 0.5,
            width: 900,
            swing: { hinge: "start", direction: "left" },
          },
        },
        {
          type: "room.create",
          payload: {
            levelId,
            polygon: [
              { x: x0, y: y0 },
              { x: x0 + W, y: y0 },
              { x: x0 + W, y: y0 + D },
              { x: x0, y: y0 + D },
            ],
            name: u.name,
            purpose: u.purpose,
            capacity: u.capacity,
          },
        },
      ]);
      const room = roomOrThrow(ctx.store.project, (results[1]?.result as Room).id);
      const vc = u.av.includes("video-conferencing");
      if (!vc)
        call.warn(
          "the brief does not mention video conferencing, so no video bar or ceiling microphones were placed",
        );
      const furnished = furnish(call, room, vc ? {} : { skipCategories: ["video-bar", "ceiling-mic"] });
      const p = ctx.store.project;
      return {
        understood: {
          purpose: u.purpose,
          capacity: u.capacity,
          widthMm: W,
          depthMm: D,
          av: u.av,
          corridorSide: corridor,
        },
        room: roomView(p, roomOrThrow(p, room.id), sizesFor(p, ctx.catalog)),
        ...furnished,
      };
    } catch (e) {
      while (ctx.store.historyPosition > before) ctx.store.undo();
      throw e;
    }
  },
});

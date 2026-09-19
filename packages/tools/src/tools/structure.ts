// Structure tools (spec 04 section 4): walls, openings, rooms. Each maps onto one command or one
// atomic transaction and echoes the resolved geometry.
import type { ApplyResult, Ref } from "@fpv/commands";
import type { FinishRef, Opening, Project, Room, Wall } from "@fpv/ir";
import {
  blankFinish,
  derive,
  FINISH_NAMES,
  FINISH_SHININESS,
  idType,
  parseHexColour,
  SKIRTING_DEPTH,
  SKIRTING_DEPTH_RANGE,
  tidyFinish,
  WallPattern,
} from "@fpv/ir";
import { z } from "zod";
import { sizesFor } from "../context.js";
import { invalidArg, ToolError } from "../envelope.js";
import { defineTool, type ToolCall } from "../registry.js";
import { OpeningViewS, openingView, RoomViewS, roomView, WallViewS, wallView } from "../views.js";

const PointS = z.object({ x: z.number(), y: z.number() }).describe("plan point in mm");
const CompassS = z.enum(["north", "south", "east", "west"]);
const RefS = z.object({ type: z.string(), id: z.string() });

/** Apply one command through the store as the agent; failures become tool errors. */
export function run(call: ToolCall, command: unknown): Extract<ApplyResult, { ok: true }> {
  const r = call.ctx.store.apply(command, "agent");
  if (!r.ok) throw new ToolError(r.error.code, r.error.message, r.error.entityId, r.error.hint);
  for (const w of r.warnings) call.warn(w);
  call.changed(r.changes);
  return r;
}

/** Apply several commands atomically; the merged change set is reported. */
export function runAll(
  call: ToolCall,
  label: string,
  commands: unknown[],
): Extract<ApplyResult, { ok: true }>[] {
  const t = call.ctx.store.transaction(label, commands, "agent");
  if (!t.ok)
    throw new ToolError(
      t.error.code,
      `${t.error.message} (command ${t.failedIndex + 1} of ${commands.length})`,
      t.error.entityId,
      t.error.hint,
    );
  const oks = t.results as Extract<ApplyResult, { ok: true }>[];
  for (const r of oks) for (const w of r.warnings) call.warn(w);
  call.changed(t.entry?.changes ?? null);
  return oks;
}

export function openingOrThrow(p: Project, id: string): Opening {
  const o = p.openings.find((x) => x.id === id);
  if (!o)
    throw new ToolError(
      "ref.missing",
      `opening "${id}" does not resolve`,
      null,
      "use get_scene with types ['opening']",
    );
  return o;
}

export function wallOrThrow(p: Project, id: string): Wall {
  const w = p.walls.find((x) => x.id === id);
  if (!w)
    throw new ToolError(
      "ref.missing",
      `wall "${id}" does not resolve`,
      null,
      "use get_scene with types ['wall']",
    );
  return w;
}
export function roomOrThrow(p: Project, id: string): Room {
  const r = p.rooms.find((x) => x.id === id);
  if (!r)
    throw new ToolError("ref.missing", `room "${id}" does not resolve`, null, "use get_scene to list rooms");
  return r;
}

export const createWalls = defineTool({
  name: "create_walls",
  description:
    "Create walls along a polyline in mm. closed=true joins the last point to the first. Endpoints within snapMm of an existing free wall end are joined to it. Returns the new walls with lengths and compass sides. Default thickness 120 (partition 100, exterior 300), height from the level.",
  tier: "primitive",
  mutating: true,
  input: z.object({
    levelId: z.string().describe("level id, e.g. level_000000"),
    points: z.array(PointS).min(2).describe("polyline vertices in mm, e.g. [{x:0,y:0},{x:8000,y:0}]"),
    closed: z.boolean().describe("true to join the last point back to the first"),
    thickness: z.number().int().positive().optional().describe("wall thickness in mm, e.g. 120"),
    height: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("wall height in mm, e.g. 2700; default from the level"),
    kind: z.enum(["exterior", "interior", "partition", "glass"]).optional(),
    snapMm: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("snap distance to existing free wall ends, default 20"),
  }),
  output: z.object({ walls: z.array(WallViewS) }),
  run(args, call) {
    const r = run(call, { type: "wall.createChain", payload: args });
    const p = call.ctx.store.project;
    return { walls: (r.result as Wall[]).map((w) => wallView(p, wallOrThrow(p, w.id))) };
  },
});

export const modifyWall = defineTool({
  name: "modify_wall",
  description:
    "Change one wall: move its start or end (joined neighbours follow), or set thickness, height, heightAtEnd (sloped top), arcExtent (degrees, positive bulges left), kind, or pattern (how the plan fills it: solid, hatch, cross-hatch or outline). Returns the wall and every wall that changed with it.",
  tier: "primitive",
  mutating: true,
  input: z.object({
    wallId: z.string(),
    start: PointS.optional(),
    end: PointS.optional(),
    thickness: z.number().int().positive().optional(),
    height: z.number().int().positive().nullable().optional(),
    heightAtEnd: z.number().int().positive().nullable().optional(),
    arcExtent: z.number().min(-270).max(270).nullable().optional(),
    kind: z.enum(["exterior", "interior", "partition", "glass"]).optional(),
    pattern: WallPattern.optional(),
  }),
  output: z.object({ wall: WallViewS, affected: z.array(WallViewS) }),
  run(args, call) {
    const { wallId, ...changes } = args;
    if (Object.keys(changes).length === 0) throw invalidArg("changes", "give at least one field to change");
    const r = run(call, { type: "wall.modify", payload: { wallId, changes } });
    const p = call.ctx.store.project;
    const affected = r.changes.updated
      .filter((x: Ref) => x.type === "wall" && x.id !== wallId)
      .map((x: Ref) => wallView(p, wallOrThrow(p, x.id)));
    return { wall: wallView(p, wallOrThrow(p, wallId)), affected };
  },
});

const HexS = z
  .string()
  .refine((v) => parseHexColour(v) !== null, "a colour is hex, e.g. #E8E6E1 or #FFF")
  .describe("hex colour, e.g. #E8E6E1");
const hex = (value: string): string => parseHexColour(value) as string;

/**
 * Paint a wall face and give it a baseboard (ADR-006 D3: compass words, not left and right). A model cannot
 * see which side of a wall is its left, but describe_room and get_scene say which way each face looks, so
 * the face is named the same way here. Only the fields given change; everything goes in one command.
 */
export const finishWall = defineTool({
  name: "finish_wall",
  description:
    "Paint a wall face and set its baseboard. face is the compass direction the face looks toward (get_scene lists them under compass) or 'both'. colour is hex (#RRGGBB or #RGB) or null for the default; finish is matt, satin or gloss. baseboardHeight in mm, null removes the baseboard; baseboardDepth in mm (default 12); baseboardColour is hex or null to follow the face. Only the fields you give change.",
  tier: "primitive",
  mutating: true,
  input: z.object({
    wallId: z.string(),
    face: z.enum(["north", "south", "east", "west", "both"]),
    colour: HexS.nullable().optional(),
    finish: z.enum(FINISH_NAMES as [string, ...string[]]).optional(),
    texture: z.string().nullable().optional().describe("a texture id from search_catalog, or null for paint"),
    baseboardHeight: z.number().int().positive().nullable().optional().describe("mm, e.g. 100"),
    baseboardDepth: z.number().int().positive().optional().describe("mm, e.g. 12"),
    baseboardColour: HexS.nullable().optional(),
  }),
  output: z.object({ wall: WallViewS }),
  run(args, call) {
    const { wallId, face, ...fields } = args;
    if (Object.values(fields).every((v) => v === undefined))
      throw invalidArg(
        "face",
        "give at least one of colour, texture, finish, baseboardHeight, baseboardDepth, baseboardColour",
      );
    const p = call.ctx.store.project;
    const w = wallOrThrow(p, wallId);
    const facing = {
      left: derive.wallCompassSide(w, "left", p.meta.north),
      right: derive.wallCompassSide(w, "right", p.meta.north),
    };
    const sides = (["left", "right"] as const).filter((s) => face === "both" || facing[s] === face);
    if (sides.length === 0)
      throw new ToolError(
        "wall.face",
        `wall ${wallId} has no face looking ${face}`,
        wallId,
        `its faces look ${facing.left} and ${facing.right}; use one of those or both`,
      );
    const level = derive.levelOf(p, w.levelId) ?? derive.lowestLevel(p);
    const tallest = Math.round(derive.wallMaxHeight(w, level));
    if (fields.baseboardHeight != null && fields.baseboardHeight > tallest)
      throw invalidArg(
        "baseboardHeight",
        `at most the wall's height, ${tallest} mm; got ${fields.baseboardHeight}`,
      );
    const depth = fields.baseboardDepth;
    if (depth !== undefined && (depth < SKIRTING_DEPTH_RANGE.min || depth > SKIRTING_DEPTH_RANGE.max))
      throw invalidArg(
        "baseboardDepth",
        `from ${SKIRTING_DEPTH_RANGE.min} to ${SKIRTING_DEPTH_RANGE.max} mm; got ${depth}`,
      );

    const finishes = { ...w.finishes };
    const skirting = { ...w.skirting };
    for (const s of sides) {
      if (fields.colour !== undefined || fields.finish !== undefined || fields.texture !== undefined) {
        finishes[s] = dress(w.finishes[s], fields);
      }
      const board = w.skirting[s];
      if (fields.baseboardHeight === null) {
        skirting[s] = null;
        continue;
      }
      if (!board && fields.baseboardHeight === undefined) {
        if (depth !== undefined || fields.baseboardColour !== undefined)
          throw invalidArg(
            "baseboardHeight",
            `the ${facing[s]} face has no baseboard; give its height to add one`,
          );
        continue;
      }
      skirting[s] = {
        height: fields.baseboardHeight ?? (board?.height as number),
        thickness: depth ?? board?.thickness ?? SKIRTING_DEPTH,
        color:
          fields.baseboardColour === undefined
            ? (board?.color ?? null)
            : fields.baseboardColour === null
              ? null
              : hex(fields.baseboardColour),
      };
    }
    run(call, { type: "wall.modify", payload: { wallId, changes: { finishes, skirting } } });
    const after = call.ctx.store.project;
    // the view lists the faces by compass, colour, finish and baseboard: what the model reads back
    return { wall: wallView(after, wallOrThrow(after, wallId)) };
  },
});

/**
 * A surface's finish after a change: paint, or a texture, never both.
 *
 * The same rule the properties panel follows — a texture replaces the colour and a colour replaces the
 * texture — so a surface never says one thing while the view shows another. Shared by every tool that
 * dresses something, because three copies of it would eventually be two rules.
 */
function dress(
  current: FinishRef | null | undefined,
  fields: {
    colour?: string | null | undefined;
    texture?: string | null | undefined;
    finish?: string | undefined;
  },
): FinishRef | null {
  const f = { ...(current ?? blankFinish()) };
  if (fields.texture !== undefined) {
    f.textureId = fields.texture;
    if (fields.texture !== null) f.color = null;
  }
  if (fields.colour !== undefined) {
    f.color = fields.colour === null ? null : hex(fields.colour);
    if (fields.colour !== null) f.textureId = null;
  }
  if (fields.finish !== undefined)
    f.shininess = FINISH_SHININESS[fields.finish as keyof typeof FINISH_SHININESS];
  // tidyFinish drops a finish that says nothing at all, which is a surface back to its default.
  return tidyFinish(f);
}

export const modifyOpening = defineTool({
  name: "modify_opening",
  description:
    "Change one door or window: its kind (door, window or passage), how far along its wall it sits (position 0 to 1, or atMm from the wall's start), width, height, sill in mm, whether it is mirrored, and its swing. swing is {hinge, direction} where hinge is 'start' or 'end' of the wall and direction is 'left' or 'right'; null means no swing, which is a sliding or pocket door. Turning a door into a window clears the swing; turning it back gives it one. Only the fields you give change.",
  tier: "primitive",
  mutating: true,
  input: z.object({
    openingId: z.string(),
    kind: z.enum(["door", "window", "passage"]).optional(),
    position: z.number().min(0).max(1).optional(),
    atMm: z.number().min(0).optional().describe("distance from the wall's start, instead of position"),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    sill: z.number().int().min(0).optional(),
    mirrored: z.boolean().optional(),
    swing: z
      .object({ hinge: z.enum(["start", "end"]), direction: z.enum(["left", "right"]) })
      .nullable()
      .optional(),
  }),
  output: z.object({ opening: OpeningViewS }),
  run(args, call) {
    const { openingId, atMm, ...rest } = args;
    const changes: Record<string, unknown> = { ...rest };
    if (atMm !== undefined) {
      // Given as a distance, which is how a drawing states it; the store keeps a fraction.
      const p = call.ctx.store.project;
      const o = openingOrThrow(p, openingId);
      const w = wallOrThrow(p, o.wallId);
      const len = derive.wallLength(w);
      if (len <= 0) throw invalidArg("atMm", "that wall has no length");
      if (atMm > len)
        throw invalidArg("atMm", `at most the wall's length, ${Math.round(len)} mm; got ${atMm}`);
      changes.position = atMm / len;
    }
    if (Object.keys(changes).length === 0) throw invalidArg("changes", "give at least one field to change");
    // Becoming a door means swinging again. The reducer clears a swing when a door becomes a window
    // and does not give one back, so the editor's panel supplies the default and so must this: a door
    // changed by an agent and one changed by a person should not differ.
    if (changes.kind === "door" && changes.swing === undefined) {
      const was = openingOrThrow(call.ctx.store.project, openingId);
      if (!was.swing) changes.swing = { hinge: "start", direction: "left" };
    }
    run(call, { type: "opening.modify", payload: { openingId, changes } });
    const after = call.ctx.store.project;
    return { opening: openingView(after, openingOrThrow(after, openingId)) };
  },
});

export const finishOpening = defineTool({
  name: "finish_opening",
  description:
    "Paint or texture a door or window. part is 'leaf' (the door leaf or the window glazing), 'frame' (the reveal around it) or 'both'. colour is hex (#RRGGBB or #RGB) or null for the default; texture is a texture id or null for paint; finish is matt, satin or gloss. A window is glazed by default and a door has no leaf until one is given here. Only the fields you give change.",
  tier: "primitive",
  mutating: true,
  input: z.object({
    openingId: z.string(),
    part: z.enum(["leaf", "frame", "both"]),
    colour: HexS.nullable().optional(),
    texture: z.string().nullable().optional().describe("a texture id from search_catalog, or null for paint"),
    finish: z.enum(FINISH_NAMES as [string, ...string[]]).optional(),
  }),
  output: z.object({ opening: OpeningViewS }),
  run(args, call) {
    const { openingId, part, ...fields } = args;
    if (Object.values(fields).every((v) => v === undefined))
      throw invalidArg("part", "give at least one of colour, texture, finish");
    const p = call.ctx.store.project;
    const o = openingOrThrow(p, openingId);
    if (part !== "frame" && o.kind === "passage")
      throw new ToolError(
        "opening.part",
        `${openingId} is a passage, which has nothing in it to dress`,
        openingId,
        "a passage has a frame only; use part 'frame'",
      );
    const finishes = { ...o.finishes };
    for (const slot of (["leaf", "frame"] as const).filter((x) => part === "both" || x === part))
      finishes[slot] = dress(o.finishes[slot], fields);
    run(call, { type: "opening.modify", payload: { openingId, changes: { finishes } } });
    const after = call.ctx.store.project;
    return { opening: openingView(after, openingOrThrow(after, openingId)) };
  },
});

export const deleteTool = defineTool({
  name: "delete",
  description:
    "Delete any entities by id. Deleting a wall deletes its openings and detaches neighbours; deleting an item deletes items stacked on it.",
  tier: "primitive",
  mutating: true,
  input: z.object({
    ids: z.array(z.string()).min(1).describe("ids of any type, e.g. ['wall_000001', 'item_0000a1']"),
  }),
  output: z.object({ removed: z.array(RefS), updated: z.array(RefS) }),
  run(args, call) {
    const groups: Record<string, string[]> = {};
    for (const id of args.ids) {
      const t = idType(id);
      if (!t || t === "level")
        throw invalidArg(
          "ids",
          `"${id}" is not a deletable entity id`,
          "ids look like wall_000001, item_0000a1, room_000002",
        );
      (groups[t] ??= []).push(id);
    }
    const commands: unknown[] = [];
    if (groups.opening) commands.push({ type: "opening.delete", payload: { openingIds: groups.opening } });
    if (groups.item)
      commands.push({ type: "item.delete", payload: { itemIds: groups.item, withDescendants: true } });
    if (groups.zone) commands.push({ type: "zone.delete", payload: { zoneIds: groups.zone } });
    if (groups.room) commands.push({ type: "room.delete", payload: { roomIds: groups.room } });
    if (groups.wall) commands.push({ type: "wall.delete", payload: { wallIds: groups.wall } });
    if (groups.annot) commands.push({ type: "annotation.delete", payload: { annotationIds: groups.annot } });
    const results = runAll(call, "delete", commands);
    const removed: Ref[] = [];
    const updated: Ref[] = [];
    for (const r of results) {
      removed.push(...r.changes.removed);
      updated.push(...r.changes.updated);
    }
    const gone = new Set(removed.map((x) => `${x.type}:${x.id}`));
    return { removed, updated: updated.filter((x) => !gone.has(`${x.type}:${x.id}`)) };
  },
});

/** Map a compass hinge side onto the wall end it names; errors name the two valid words for this wall. */
export function hingeEndFor(p: Project, w: Wall, side: "north" | "south" | "east" | "west"): "start" | "end" {
  const toEnd = derive.compassOf(derive.wallAngle(w), p.meta.north);
  const toStart = derive.compassOf(derive.wallAngle(w) + 180, p.meta.north);
  if (side === toEnd) return "end";
  if (side === toStart) return "start";
  throw invalidArg(
    "hingeSide",
    `wall ${w.id} runs ${toStart} to ${toEnd}; "${side}" is not along it`,
    `use hingeSide "${toStart}" or "${toEnd}"`,
  );
}

export const addOpening = defineTool({
  name: "add_opening",
  description:
    "Add a door, window or passage to a wall. Give either position (0..1 along the wall from its start) or atMm from the start. hingeSide is a compass word naming the wall end that carries the hinge; swingDirection is left or right as seen from the wall's start looking along it. Defaults: door 900x2100, window 1200x1200 sill 900, passage 1000x2100.",
  tier: "primitive",
  mutating: true,
  input: z.object({
    wallId: z.string(),
    kind: z.enum(["door", "window", "passage"]),
    position: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("fraction along the wall from its start, e.g. 0.5"),
    atMm: z.number().min(0).optional().describe("distance from the wall start in mm, e.g. 1200"),
    width: z.number().int().positive().optional().describe("mm, e.g. 900"),
    height: z.number().int().positive().optional().describe("mm, e.g. 2100"),
    sill: z.number().int().min(0).optional().describe("mm above the floor, e.g. 900 for a window"),
    hingeSide: CompassS.optional().describe("compass word for the wall end holding the hinge"),
    swingDirection: z.enum(["left", "right"]).optional(),
    productId: z.string().optional().describe("a door or window product id from search_catalog"),
  }),
  output: z.object({ opening: OpeningViewS, wall: WallViewS }),
  run(args, call) {
    const p0 = call.ctx.store.project;
    const w = wallOrThrow(p0, args.wallId);
    if (args.position === undefined && args.atMm === undefined)
      throw invalidArg("position", "give position (0..1) or atMm", "e.g. position: 0.5");
    const payload: Record<string, unknown> = {
      wallId: args.wallId,
      kind: args.kind,
      ...(args.position !== undefined ? { position: args.position } : {}),
      ...(args.atMm !== undefined ? { atMm: args.atMm } : {}),
      ...(args.width !== undefined ? { width: args.width } : {}),
      ...(args.height !== undefined ? { height: args.height } : {}),
      ...(args.sill !== undefined ? { sill: args.sill } : {}),
      ...(args.productId !== undefined ? { productId: args.productId } : {}),
    };
    if (args.kind !== "window" && (args.hingeSide || args.swingDirection)) {
      const hinge = args.hingeSide ? hingeEndFor(p0, w, args.hingeSide) : "start";
      payload.swing = { hinge, direction: args.swingDirection ?? "left" };
    } else if (args.kind === "window" && (args.hingeSide || args.swingDirection)) {
      call.warn("windows have no swing; hingeSide and swingDirection ignored");
    }
    const r = run(call, { type: "opening.add", payload });
    const p = call.ctx.store.project;
    const o = r.result as Opening;
    return {
      opening: openingView(p, p.openings.find((x) => x.id === o.id) as Opening),
      wall: wallView(p, wallOrThrow(p, w.id)),
    };
  },
});

export const createRoom = defineTool({
  name: "create_room",
  description:
    "Create a room by polygon, by rect {x,y,w,d}, or by atPoint (detect the enclosure around a point from the walls; smallest enclosure wins). Set purpose and capacity; furnish_room uses them.",
  tier: "primitive",
  mutating: true,
  input: z.object({
    levelId: z.string(),
    polygon: z.array(PointS).min(3).optional().describe("counter-clockwise vertices in mm"),
    rect: z
      .object({ x: z.number(), y: z.number(), w: z.number().positive(), d: z.number().positive() })
      .optional()
      .describe("origin corner plus width and depth in mm"),
    atPoint: PointS.optional().describe("a point inside the walls to detect the room around"),
    name: z.string().optional(),
    purpose: z
      .enum([
        "meeting",
        "huddle",
        "boardroom",
        "training",
        "open-office",
        "focus",
        "reception",
        "cafeteria",
        "corridor",
        "utility",
        "storage",
        "restroom",
        "other",
      ])
      .optional(),
    capacity: z.number().int().min(0).optional().describe("seats, e.g. 10"),
  }),
  output: z.object({ room: RoomViewS }),
  run(args, call) {
    const r = run(call, { type: "room.create", payload: args });
    const p = call.ctx.store.project;
    const room = roomOrThrow(p, (r.result as Room).id);
    return { room: roomView(p, room, sizesFor(p, call.ctx.catalog)) };
  },
});

export const modifyRoom = defineTool({
  name: "modify_room",
  description:
    "Change a room's name, purpose, capacity, ceiling height or polygon. Returns the room with recomputed area and walls.",
  tier: "primitive",
  mutating: true,
  input: z.object({
    roomId: z.string(),
    name: z.string().nullable().optional(),
    purpose: z
      .enum([
        "meeting",
        "huddle",
        "boardroom",
        "training",
        "open-office",
        "focus",
        "reception",
        "cafeteria",
        "corridor",
        "utility",
        "storage",
        "restroom",
        "other",
      ])
      .optional(),
    capacity: z.number().int().min(0).nullable().optional(),
    ceilingHeight: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe("mm; null returns to the level height"),
    polygon: z.array(PointS).min(3).optional(),
  }),
  output: z.object({ room: RoomViewS }),
  run(args, call) {
    const { roomId, polygon, ...changes } = args;
    const commands: unknown[] = [];
    if (Object.keys(changes).length > 0) commands.push({ type: "room.modify", payload: { roomId, changes } });
    if (polygon) commands.push({ type: "room.setPolygon", payload: { roomId, polygon } });
    if (commands.length === 0) throw invalidArg("changes", "give at least one field to change");
    runAll(call, "modify_room", commands);
    const p = call.ctx.store.project;
    return { room: roomView(p, roomOrThrow(p, roomId), sizesFor(p, call.ctx.catalog)) };
  },
});

// The design tools (spec 04 section 6a, ADR-022): propose a design and have it measured, then build
// the one that passed.
//
// Two calls rather than one because they are two different jobs. Checking is free, has no effect on
// the drawing, and is what the architect does over and over while it gets the plan right. Building
// is one irreversible-looking act -- undoable, but not something to do by accident -- and it refuses
// a design the checker has not passed, which is the whole point of having a checker.
import {
  checkLayout,
  type LayoutReport,
  layoutIsBuildable,
  missingFromProgramme,
  type Programme,
  packProgramme,
} from "@fpv/catalog";
import type { Store } from "@fpv/commands";
import {
  Design,
  type DesignRoom,
  derive,
  type Opening,
  purposeFromWord,
  type Room,
  RoomPurpose,
  type Wall,
} from "@fpv/ir";
import { z } from "zod";
import { openingsWanted, roomPolygon, runPoints, SNAP_MM, wallRuns } from "../build-design.js";
import { sizesFor } from "../context.js";
import { invalidArg, ToolError, unavailable } from "../envelope.js";
import { defineTool, TIMEOUTS } from "../registry.js";
import { RoomViewS, roomView } from "../views.js";
import { runAll } from "./structure.js";

/** Designs checked in this session, newest last, so build_design can be given an id and not a copy. */
const CHECKED = new WeakMap<Store, Map<string, Design>>();
const KEEP = 8;

function remember(store: Store, id: string, design: Design) {
  let held = CHECKED.get(store);
  if (!held) {
    held = new Map();
    CHECKED.set(store, held);
  }
  held.set(id, design);
  while (held.size > KEEP) held.delete(held.keys().next().value as string);
}

function recall(store: Store, id: string): Design {
  const design = CHECKED.get(store)?.get(id);
  if (!design)
    throw new ToolError(
      "design.unknown",
      `no design called "${id}" was checked in this session`,
      null,
      "call check_design first; it answers with the designId to build",
    );
  return design;
}

/** A stable id per design, so the same design checked twice keeps one name. */
let seq = 0;
const nextId = () => `design_${(seq += 1).toString(36).padStart(4, "0")}`;

const RectS = z.object({
  x: z.number().describe("south-west corner of the clear inside, mm"),
  y: z.number(),
  w: z.number().positive().describe("east-west, mm"),
  d: z.number().positive().describe("north-south, mm"),
});

const DesignS = z.object({
  brief: z.string().describe("the words you are designing for"),
  kind: z.enum(["dwelling", "workplace", "mixed"]),
  levelId: z.string().nullable().optional().describe("default: the lowest level"),
  shell: z
    .object({
      x: z.number(),
      y: z.number(),
      w: z.number().positive(),
      d: z.number().positive(),
      wallMm: z.number().positive().optional().describe("outside walls, 230 to 300"),
      interiorWallMm: z.number().positive().optional().describe("inside walls, 100 to 120"),
    })
    .describe("the outside of the building, in mm"),
  rooms: z
    .array(
      z.object({
        key: z
          .string()
          .describe("a short name you keep between rounds, e.g. bed1; lower case letters and digits"),
        name: z.string().describe("what a person calls it, e.g. 'Bedroom 1'"),
        // the enum itself, so the model is told the words up front rather than after a refusal
        purpose: z.string().describe(`one of: ${RoomPurpose.options.join(", ")}`),
        rect: RectS.describe("the clear inside; walls go outside it"),
        capacity: z.number().int().min(0).nullable().optional(),
        doorsTo: z
          .array(z.string())
          .optional()
          .describe("keys of the rooms this one opens onto, or 'outside' for the front door"),
        window: z.boolean().optional().describe("true when it needs a window, so it needs an outside wall"),
      }),
    )
    .min(1),
  circulation: z.array(z.string()).optional().describe("keys of the halls and corridors"),
  assumptions: z.array(z.string()).optional().describe("what the brief did not say and you decided"),
});

const ProblemS = z.object({
  code: z.string(),
  severity: z.string(),
  entityId: z.string().nullable(),
  message: z.string(),
  hint: z.string().nullable(),
  related: z.array(z.string()),
});

function reportOf(id: string, report: LayoutReport) {
  const errors = report.problems.filter((p) => p.severity === "error");
  const warnings = report.problems.filter((p) => p.severity === "warning");
  return {
    designId: id,
    buildable: layoutIsBuildable(report),
    score: report.score,
    totals: report.totals,
    errors,
    warnings,
  };
}

export const checkDesignTool = defineTool({
  name: "check_design",
  description:
    "Measure a design before anything is drawn: room sizes against what each room is for, rooms that overlap or fall outside the building, doors without a wall to sit in, rooms nobody can reach without walking through a bedroom, missing kitchens and bathrooms, windows on inside walls. Returns the arithmetic and a designId. Fix every error and check again; build_design refuses a design with errors left.",
  tier: "both",
  mutating: false,
  input: z.object({ design: DesignS }),
  output: z.object({
    designId: z.string(),
    buildable: z.boolean(),
    score: z.number().describe("1 is a design with nothing against it"),
    totals: z.object({
      shellM2: z.number(),
      roomsM2: z.number(),
      unaccountedM2: z.number(),
      rooms: z.number(),
      byPurpose: z.record(z.number()),
    }),
    errors: z.array(ProblemS),
    warnings: z.array(ProblemS),
  }),
  run(args, call) {
    // What the rooms were called, turned into purposes the model has: "living room" is the living
    // room and "Master bedroom" is a bedroom, and neither is worth a round trip to say so.
    const given = args.design as { rooms?: { purpose?: unknown; name?: unknown }[] };
    const read: string[] = [];
    for (const room of given.rooms ?? []) {
      if (typeof room.purpose !== "string") continue;
      const purpose = purposeFromWord(room.purpose);
      if (purpose === null || purpose === room.purpose) continue;
      read.push(`read "${room.purpose}" as ${purpose}`);
      room.purpose = purpose;
    }
    for (const r of read) call.warn(r);

    const parsed = Design.safeParse(args.design);
    if (!parsed.success) {
      // One line per problem, without the enum repeated after each: a schema error that runs to a
      // thousand tokens is a schema error the model reads the end of and not the beginning.
      const issues = parsed.error.issues.slice(0, 8).map((i) => {
        const where = i.path.join(".") || "(root)";
        const message = i.code === "invalid_enum_value" ? `${i.message.split(",")[0]}` : i.message;
        return `${where}: ${message.replace(/Expected .*, received/, "not a purpose:")}`;
      });
      throw invalidArg(
        "design",
        issues.join("; "),
        `every room needs key, name, purpose and rect; purposes are: ${RoomPurpose.options.join(", ")}`,
      );
    }
    const design = parsed.data;
    const report = checkLayout(design, call.ctx.rules);
    const id = nextId();
    remember(call.ctx.store, id, design);
    for (const p of report.problems.filter((x) => x.severity === "error")) call.warn(p.message);
    return reportOf(id, report);
  },
});

export const planRoomsTool = defineTool({
  name: "plan_rooms",
  description:
    "Turn a list of rooms into a plan. You say what rooms the building needs, what each is for and roughly how many square metres it wants; this works out the building's size, lays the rooms out either side of a hallway so every one has a door to it and an outside wall for its window, and checks the result. Use this rather than placing rectangles yourself. Returns a designId for build_design.",
  tier: "both",
  mutating: false,
  input: z.object({
    brief: z.string().describe("the person's own words, so the design records what it was for"),
    kind: z.enum(["dwelling", "workplace", "mixed"]),
    shell: z
      .object({ w: z.number().positive(), d: z.number().positive() })
      .optional()
      .describe("the plot, in mm; leave it out and a building is sized to hold the rooms"),
    rooms: z
      .array(
        z.object({
          key: z.string().describe("a short name you keep, e.g. bed1"),
          name: z.string().describe("what a person calls it, e.g. 'Bedroom 1'"),
          purpose: z.string().describe(`one of: ${RoomPurpose.options.join(", ")}`),
          targetM2: z
            .number()
            .positive()
            .optional()
            .describe("floor area wanted; a sensible default otherwise"),
          capacity: z.number().int().min(0).nullable().optional(),
          window: z.boolean().optional().describe("default: true for a room people spend time in"),
          nextTo: z.array(z.string()).optional().describe("keys this room should be beside"),
        }),
      )
      .min(1),
    assumptions: z.array(z.string()).optional().describe("what the brief did not say and you decided"),
    alternatives: z
      .array(
        z.object({
          note: z.string().describe("what is different about this one, in a few words"),
          shell: z.object({ w: z.number().positive(), d: z.number().positive() }).optional(),
          rooms: z
            .array(
              z.object({
                key: z.string(),
                name: z.string(),
                purpose: z.string(),
                targetM2: z.number().positive().optional(),
                capacity: z.number().int().min(0).nullable().optional(),
                window: z.boolean().optional(),
                nextTo: z.array(z.string()).optional(),
              }),
            )
            .min(1),
        }),
      )
      .max(3)
      .optional()
      .describe(
        "other ways of doing it, each differing in something you can name: a bigger living room and smaller bedrooms, a separate dining room, a narrower plot. Each is packed and checked and the best is kept.",
      ),
  }),
  output: z.object({
    designId: z.string(),
    buildable: z.boolean(),
    score: z.number(),
    tried: z.number(),
    chosen: z.string(),
    rejected: z.array(z.object({ note: z.string(), score: z.number(), errors: z.number() })),
    totals: z.object({
      shellM2: z.number(),
      roomsM2: z.number(),
      unaccountedM2: z.number(),
      rooms: z.number(),
      byPurpose: z.record(z.number()),
    }),
    shell: z.object({ w: z.number(), d: z.number() }),
    rooms: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        purpose: z.string(),
        widthMm: z.number(),
        depthMm: z.number(),
        areaM2: z.number(),
      }),
    ),
    decided: z.array(z.string()),
    unplaced: z.array(z.object({ key: z.string(), why: z.string() })),
    errors: z.array(ProblemS),
    warnings: z.array(ProblemS),
  }),
  run(args, call) {
    const { alternatives, ...first } = args;
    const tries: { note: string; programme: Programme }[] = [
      { note: "as asked for", programme: first as Programme },
      ...(alternatives ?? []).map((a) => ({
        note: a.note,
        programme: {
          ...(first as Programme),
          ...(a.shell ? { shell: a.shell } : {}),
          rooms: a.rooms as Programme["rooms"],
        },
      })),
    ];
    const missing = missingFromProgramme(first as Programme);
    for (const m of missing) call.warn(`a home needs a ${m}, and this programme has none`);

    // Pack and check every one of them, and keep the best. Packing costs nothing, so trying three
    // ways of arranging the same brief costs one answer's worth of extra words and no tool calls
    // (ADR-024 D5). It is the untrained version of the best-of-ten sampling the RLVR paper needs.
    const packed = tries.map((t) => {
      const result = packProgramme(t.programme);
      const design = Design.parse(result.design);
      const report = checkLayout(design, call.ctx.rules);
      const errors = report.problems.filter((p) => p.severity === "error").length;
      return { ...t, ...result, design, report, errors };
    });
    const ranked = [...packed].sort(
      (a, b) =>
        a.errors - b.errors || b.report.score - a.report.score || a.unplaced.length - b.unplaced.length,
    );
    const best = ranked[0] as (typeof ranked)[number];

    for (const u of best.unplaced) call.warn(u.why);
    for (const n of best.notes) call.warn(n);
    const id = nextId();
    remember(call.ctx.store, id, best.design);
    for (const p of best.report.problems.filter((x) => x.severity === "error")) call.warn(p.message);
    if (ranked.length > 1)
      call.warn(
        `tried ${ranked.length} ways of arranging it and kept "${best.note}"; the others scored ${ranked
          .slice(1)
          .map((r) => `${r.report.score} (${r.note})`)
          .join(", ")}`,
      );

    return {
      ...reportOf(id, best.report),
      score: best.report.score,
      tried: ranked.length,
      chosen: best.note,
      rejected: ranked.slice(1).map((r) => ({ note: r.note, score: r.report.score, errors: r.errors })),
      shell: { w: best.design.shell.w, d: best.design.shell.d },
      rooms: best.design.rooms.map((r) => ({
        key: r.key,
        name: r.name,
        purpose: r.purpose,
        widthMm: r.rect.w,
        depthMm: r.rect.d,
        areaM2: Math.round((r.rect.w * r.rect.d) / 1e5) / 10,
      })),
      decided: best.notes,
      unplaced: best.unplaced,
    };
  },
});

export const designLayoutTool = defineTool({
  name: "design_layout",
  description:
    "Work the whole plan out before drawing any of it. Hands the brief to an architect that has the inspect tools and check_design and nothing that draws, and gets back a design that passed the checker, ready for build_design. Use it for anything that builds a building or rearranges its rooms; for adding one table to a room that exists, do not.",
  tier: "both",
  mutating: false,
  timeoutMs: TIMEOUTS.slow,
  input: z.object({
    brief: z
      .string()
      .min(1)
      .describe("what to design, in the person's own words, with anything you have since learned"),
  }),
  output: z.object({
    designId: z.string().nullable(),
    said: z.string(),
    unresolved: z.array(z.string()),
    rounds: z.number(),
  }),
  async run(args, call) {
    const runner = call.ctx.subagent;
    if (!runner)
      throw unavailable(
        "design_layout",
        "this session has no architect behind it",
        "design it yourself and send it to check_design",
      );
    const result = await runner.run({ role: "architect", brief: args.brief });
    for (const u of result.unresolved) call.warn(u);
    if (!result.designId)
      call.warn("the architect did not reach a design that passes the checker; read what it said");
    return {
      designId: result.designId,
      said: result.text,
      unresolved: result.unresolved,
      rounds: result.rounds,
    };
  },
});

export const buildDesignTool = defineTool({
  name: "build_design",
  description:
    "Draw a design that check_design passed: the outside walls, the inside walls with one wall shared between neighbouring rooms, a door in each pair the design joins, a window on each room that asked for one, and the rooms themselves with their purposes. One undoable step. Furnish afterwards with furnish_room.",
  tier: "semantic",
  mutating: true,
  input: z.object({
    designId: z.string().describe("from check_design"),
    levelId: z.string().optional().describe("default: the design's own, else the lowest level"),
  }),
  output: z.object({
    walls: z.number(),
    doors: z.number(),
    windows: z.number(),
    rooms: z.array(RoomViewS),
    unplaced: z.array(z.string()),
  }),
  run(args, call) {
    const { ctx } = call;
    const design = recall(ctx.store, args.designId);
    const report = checkLayout(design, ctx.rules);
    if (!layoutIsBuildable(report)) {
      const first = report.problems.find((p) => p.severity === "error");
      throw new ToolError(
        "design.not-checked",
        `this design still has ${report.problems.filter((p) => p.severity === "error").length} error(s), the first being: ${first?.message ?? "?"}`,
        first?.entityId ?? null,
        "fix them and call check_design again; the design you build has to be one that passed",
      );
    }
    const p0 = ctx.store.project;
    const levelId = args.levelId ?? design.levelId ?? derive.lowestLevel(p0).id;
    if (!derive.levelOf(p0, levelId))
      throw new ToolError("ref.missing", `level "${levelId}" does not resolve`, null, "use get_scene");

    const runs = wallRuns(design);
    const before = ctx.store.historyPosition;
    try {
      // the walls first, as one chain each, so the store joins what meets
      const wallResults = runAll(
        call,
        "design: walls",
        runs.map((r) => ({
          type: "wall.createChain",
          payload: {
            levelId,
            points: runPoints(r),
            closed: false,
            thickness: r.thickness,
            kind: r.kind,
          },
        })),
      );
      const walls: Wall[] = wallResults.flatMap((r) => (r.result as Wall[]) ?? []);

      // then the openings, each matched to the wall whose line passes through the point the design
      // put it at; a door nobody can place is reported rather than dropped in silence
      const { wanted, warnings } = openingsWanted(design);
      for (const w of warnings) call.warn(w);
      const unplaced: string[] = [];
      const openings: unknown[] = [];
      for (const want of wanted) {
        const wall = nearestWall(walls, want.at);
        if (!wall) {
          unplaced.push(`${want.kind} between ${want.between}`);
          continue;
        }
        const len = derive.wallLength(wall);
        const t =
          ((want.at.x - wall.start.x) * (wall.end.x - wall.start.x) +
            (want.at.y - wall.start.y) * (wall.end.y - wall.start.y)) /
          (len * len);
        const position = Math.min(Math.max(t, want.width / 2 / len), 1 - want.width / 2 / len);
        if (!Number.isFinite(position) || len < want.width + 2 * SNAP_MM) {
          unplaced.push(`${want.kind} between ${want.between} (the wall is only ${Math.round(len)} mm long)`);
          continue;
        }
        openings.push({
          type: "opening.add",
          payload: {
            wallId: wall.id,
            kind: want.kind,
            position,
            width: want.width,
            height: want.height,
            sill: want.sill,
            ...(want.kind === "door" ? { swing: { hinge: "start", direction: "left" } } : {}),
          },
        });
      }
      const openingResults = openings.length > 0 ? runAll(call, "design: openings", openings) : [];

      // and the rooms over the rectangles the design was measured on
      const roomResults = runAll(
        call,
        "design: rooms",
        design.rooms.map((r: DesignRoom) => ({
          type: "room.create",
          payload: {
            levelId,
            polygon: roomPolygon(r),
            name: r.name,
            purpose: r.purpose,
            ...(r.capacity === null ? {} : { capacity: r.capacity }),
          },
        })),
      );
      const project = ctx.store.project;
      const sizes = sizesFor(project, ctx.catalog);
      for (const u of unplaced) call.warn(`could not place the ${u}`);
      return {
        walls: walls.length,
        doors: (openingResults.map((r) => r.result as Opening) ?? []).filter((o) => o?.kind === "door")
          .length,
        windows: (openingResults.map((r) => r.result as Opening) ?? []).filter((o) => o?.kind === "window")
          .length,
        rooms: roomResults.map((r) =>
          roomView(project, project.rooms.find((x) => x.id === (r.result as Room).id) as Room, sizes),
        ),
        unplaced,
      };
    } catch (e) {
      while (ctx.store.historyPosition > before) ctx.store.undo();
      throw e;
    }
  },
});

/** The wall whose centreline passes nearest the point, within a wall's thickness of it. */
function nearestWall(walls: readonly Wall[], at: { x: number; y: number }): Wall | null {
  let best: Wall | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const w of walls) {
    const len = derive.wallLength(w);
    if (len === 0) continue;
    const ux = (w.end.x - w.start.x) / len;
    const uy = (w.end.y - w.start.y) / len;
    const along = (at.x - w.start.x) * ux + (at.y - w.start.y) * uy;
    if (along < 0 || along > len) continue;
    const across = Math.abs((at.x - w.start.x) * uy - (at.y - w.start.y) * ux);
    if (across <= w.thickness / 2 + 60 && across < bestDistance) {
      best = w;
      bestDistance = across;
    }
  }
  return best;
}

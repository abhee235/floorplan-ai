// The design tools (spec 04 section 6a, ADR-022): propose a design and have it measured, then build
// the one that passed.
//
// Two calls rather than one because they are two different jobs. Checking is free, has no effect on
// the drawing, and is what the architect does over and over while it gets the plan right. Building
// is one irreversible-looking act -- undoable, but not something to do by accident -- and it refuses
// a design the checker has not passed, which is the whole point of having a checker.
import {
  checkLayout,
  type ExprScope,
  type ExprValue,
  evalCondition,
  evalNumber,
  type LayoutReport,
  layoutIsBuildable,
  layoutQuality,
  missingFromProgramme,
  type Programme,
  packProgramme,
} from "@fpv/catalog";
import type { Store } from "@fpv/commands";
import {
  Design,
  type DesignRoom,
  derive,
  enclosureOf,
  type Opening,
  outsideSides,
  purposeFromWord,
  type Room,
  RoomPurpose,
  roomKey,
  roomKeys,
  sharedEdge,
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

/** The design checked last in this session, with its id, to compare a new one against. */
function lastChecked(store: Store): { id: string; design: Design } | null {
  const held = CHECKED.get(store);
  if (!held || held.size === 0) return null;
  const id = [...held.keys()].at(-1) as string;
  return { id, design: held.get(id) as Design };
}

/**
 * What changed between two designs, in words, and whether anything the model meant to change did.
 *
 * A real run said "I need to fix: the overlapping focus booths, the missing entrance, the windows on
 * inside rooms" and re-sent a 24-room design with none of the three changed and `enclosure` dropped
 * from every room. The report came back the same, and the model could not tell from it that its edit
 * had not landed. This says so.
 */
export function describeChange(before: Design, after: Design): { same: boolean; lines: string[] } {
  const was = new Map(before.rooms.map((r) => [r.key, r]));
  const now = new Map(after.rooms.map((r) => [r.key, r]));
  const lines: string[] = [];
  const added = [...now.keys()].filter((k) => !was.has(k));
  const removed = [...was.keys()].filter((k) => !now.has(k));
  if (added.length) lines.push(`added ${added.join(", ")}`);
  if (removed.length) lines.push(`removed ${removed.join(", ")}`);
  const moved: string[] = [];
  const doors: string[] = [];
  const windows: string[] = [];
  const enclosures: string[] = [];
  for (const [key, r] of now) {
    const old = was.get(key);
    if (!old) continue;
    if (JSON.stringify(old.rect) !== JSON.stringify(r.rect)) moved.push(key);
    if (JSON.stringify(old.doorsTo) !== JSON.stringify(r.doorsTo)) doors.push(key);
    if (old.window !== r.window) windows.push(key);
    if (enclosureOf(old) !== enclosureOf(r))
      enclosures.push(`${key} ${enclosureOf(old)} to ${enclosureOf(r)}`);
  }
  if (moved.length) lines.push(`moved or resized ${moved.join(", ")}`);
  if (doors.length) lines.push(`changed the doors of ${doors.join(", ")}`);
  if (windows.length) lines.push(`changed the windows of ${windows.join(", ")}`);
  if (enclosures.length)
    lines.push(
      enclosures.length > 6
        ? `changed the enclosure of ${enclosures.length} rooms (${enclosures.slice(0, 4).join("; ")}; ...)`
        : `changed the enclosure of ${enclosures.join("; ")}`,
    );
  if (JSON.stringify(before.shell) !== JSON.stringify(after.shell)) lines.push("changed the shell");
  return { same: lines.length === 0, lines };
}

/** The line a re-sent design gets: what changed since the last one, and which errors did not. */
function compareWithLast(store: Store, design: Design, report: LayoutReport): string | null {
  const last = lastChecked(store);
  if (!last) return null;
  // Only a design of the same building: most of its rooms kept their keys.
  const keys = new Set(last.design.rooms.map((r) => r.key));
  const shared = design.rooms.filter((r) => keys.has(r.key)).length;
  if (shared < Math.max(2, Math.ceil(last.design.rooms.length / 2))) return null;
  const before = checkLayout(last.design, null).problems.filter((p) => p.severity === "error");
  const after = report.problems.filter((p) => p.severity === "error");
  const still = after.filter((a) => before.some((b) => b.code === a.code && b.message === a.message));
  const change = describeChange(last.design, design);
  const what = change.same ? "nothing changed" : change.lines.join("; ");
  const kept =
    still.length > 0
      ? ` ${still.length} of its ${before.length} error(s) are still here, word for word.`
      : "";
  return `compared with ${last.id}: ${what}.${kept} To change a few rooms, call revise_design { designId: "${last.id}", rooms: [{ key, ...fields }] } instead of sending the whole design again.`;
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
      facade: z
        .object({
          north: z.enum(["windows", "glazed"]).optional(),
          south: z.enum(["windows", "glazed"]).optional(),
          east: z.enum(["windows", "glazed"]).optional(),
          west: z.enum(["windows", "glazed"]).optional(),
        })
        .optional()
        .describe(
          "per side: 'windows' (default) or 'glazed', one glass wall the length of that side with no separate windows; rooms on a glazed side need no window: true",
        ),
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
        enclosure: z
          .enum(["walled", "glass", "open"])
          .optional()
          .describe(
            "what stands between it and the floor: 'walled' (default), 'glass' (a glass box: meeting, focus), or 'open' (no walls at all: desks, cafe, breakout; an open room needs no doors and is the circulation). Restrooms, stores and server rooms are always walled.",
          ),
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

/**
 * A door for every enclosed room that lists none, onto the circulation it touches (ADR-028 D10).
 *
 * The first live runs of a model drawing its own plan wrote sound rectangles and no `doorsTo` on any
 * room, twelve times over two attempts, each time saying it was about to add them. Which room a
 * meeting room off a corridor opens onto is not a design decision; it is the obvious door, and the
 * model is told which ones were assumed. Only rooms with no doors at all are touched, only onto a
 * corridor, a foyer or an open room they share at least a metre of wall with, and the longest such
 * wall wins. A room that touches none is left for the checker to name.
 */
export function inferDoors(design: Design): { design: Design; assumed: string[] } {
  const gap = design.shell.interiorWallMm + 400;
  const assumed: string[] = [];
  const circulation = design.rooms.filter(
    (r) =>
      r.purpose === "corridor" ||
      r.purpose === "foyer" ||
      design.circulation.includes(r.key) ||
      enclosureOf(r) === "open",
  );
  const rooms = design.rooms.map((r) => {
    if (r.doorsTo.length > 0 || enclosureOf(r) === "open" || circulation.includes(r)) return r;
    const best = circulation
      .map((c) => ({ c, shared: sharedEdge(r.rect, c.rect, gap) }))
      .filter((x) => x.c.key !== r.key && x.shared >= 1000)
      .sort((a, b) => b.shared - a.shared)[0];
    if (!best) return r;
    assumed.push(`${r.name} opens onto ${best.c.name}`);
    return { ...r, doorsTo: [best.c.key] };
  });
  return { design: { ...design, rooms }, assumed };
}

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
    "Measure a design you wrote before anything is drawn: rooms that overlap or fall outside the building, doors without a wall to sit in, rooms nobody can reach, a room too small for its seats, missing toilets or kitchens, windows on inside walls. It judges whether the plan can be built and used, never what shape it is: an open floor, rooms around a courtyard or a copy of a picture all pass if they add up. Each room says whether it is walled, glass or open, and the shell says which sides are glazed. Returns the arithmetic and a designId. Fix every error and check again; build_design refuses a design with errors left.",
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
    const { design, assumed } = inferDoors(parsed.data);
    if (assumed.length)
      call.warn(
        `no doors were given for ${assumed.length} room(s), so each opens onto what it touches: ${assumed.join("; ")}`,
      );
    const report = checkLayout(design, call.ctx.rules);
    const compared = compareWithLast(call.ctx.store, design, report);
    if (compared) call.warn(compared);
    const id = nextId();
    remember(call.ctx.store, id, design);
    for (const p of report.problems.filter((x) => x.severity === "error")) call.warn(p.message);
    return reportOf(id, report);
  },
});

/** What a design query can name, for the description and the error when a name is unknown. */
const QUERY_NAMES =
  "key, name, purpose, area (m2), w, d, x, y (mm), capacity, window, enclosure, onOutside, gapNorth, gapSouth, gapEast, gapWest (mm from the room to that side of the building), touches (keys of rooms sharing a wall, comma-separated: use has(touches, 'cafe')), doors (keys, comma-separated), shellW, shellD, rooms";

export const queryDesignTool = defineTool({
  name: "query_design",
  description: `Ask a checked design a question of your own, before you answer: which rooms are far from glass, which are slivers, what touches what. where is a condition over each room and select is what to report; both use the rules expression language (arithmetic, comparisons, and/or/not, has). Names: ${QUERY_NAMES}. Example: where "purpose == 'open-office' and gapNorth > 8000 and gapSouth > 8000", select ["area", "w / d"]. This is how you verify your own plan against what you meant, which the checker does not know.`,
  tier: "both",
  mutating: false,
  input: z.object({
    designId: z.string().describe("from check_design or plan_rooms"),
    where: z.string().optional().describe("a condition; leave out for every room"),
    select: z
      .array(z.string())
      .max(8)
      .optional()
      .describe("expressions to report per room; default area, w, d"),
    limit: z.number().int().min(1).max(60).optional(),
  }),
  output: z.object({
    count: z.number(),
    rows: z.array(z.object({ key: z.string(), name: z.string(), values: z.record(z.unknown()) })),
    errors: z.array(z.string()),
  }),
  run(args, call) {
    const design = recall(call.ctx.store, args.designId);
    const gap = design.shell.interiorWallMm + 400;
    const errors: string[] = [];
    const select = args.select?.length ? args.select : ["area", "w", "d"];
    const rows: { key: string; name: string; values: Record<string, unknown> }[] = [];
    for (const r of design.rooms) {
      const { x, y, w, d } = r.rect;
      const touches = design.rooms
        .filter((o) => o.key !== r.key && sharedEdge(r.rect, o.rect, gap) >= 1000)
        .map((o) => o.key);
      const facts: Record<string, ExprValue> = {
        key: r.key,
        name: r.name,
        purpose: r.purpose,
        area: Math.round((w * d) / 1e4) / 100,
        w,
        d,
        x,
        y,
        capacity: r.capacity ?? 0,
        window: r.window,
        enclosure: enclosureOf(r),
        onOutside: outsideSides(r, design.shell, gap).length > 0,
        gapWest: x - design.shell.x,
        gapSouth: y - design.shell.y,
        gapEast: design.shell.x + design.shell.w - (x + w),
        gapNorth: design.shell.y + design.shell.d - (y + d),
        touches: touches.join(","),
        doors: r.doorsTo.join(","),
        shellW: design.shell.w,
        shellD: design.shell.d,
        rooms: design.rooms.length,
      };
      const scope: ExprScope = {
        ident: (name) => {
          if (!(name in facts)) throw new Error(`unknown name "${name}"; the names are ${QUERY_NAMES}`);
          return facts[name] as ExprValue;
        },
        call: (name) => {
          throw new Error(`unknown function ${name}`);
        },
      };
      if (args.where) {
        const c = evalCondition(args.where, scope);
        if (!c.ok) {
          errors.push(`where: ${c.error}`);
          break;
        }
        if (!c.value) continue;
      }
      const values: Record<string, unknown> = {};
      for (const expr of select) {
        const n = evalNumber(expr, scope);
        if (n.ok) {
          values[expr] = Math.round(n.value * 100) / 100;
          continue;
        }
        const b = evalCondition(expr, scope);
        if (b.ok && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr.trim())) {
          values[expr] = b.value;
          continue;
        }
        const bare = expr.trim();
        if (bare in facts) values[expr] = facts[bare];
        else errors.push(`${expr}: ${n.error}`);
      }
      rows.push({ key: r.key, name: r.name, values });
      if (rows.length >= (args.limit ?? 60)) break;
    }
    for (const e of [...new Set(errors)]) call.warn(e);
    return { count: rows.length, rows, errors: [...new Set(errors)] };
  },
});

/** One room's fields as a revision may set them; anything left out keeps its value. */
const RoomPatchS = z.object({
  key: z.string().describe("which room"),
  name: z.string().optional(),
  purpose: z.string().optional(),
  rect: RectS.optional(),
  capacity: z.number().int().min(0).nullable().optional(),
  doorsTo: z.array(z.string()).optional(),
  window: z.boolean().optional(),
  enclosure: z.enum(["walled", "glass", "open"]).optional(),
});

export const reviseDesignTool = defineTool({
  name: "revise_design",
  description:
    "Change a checked design a little and check it again, without sending the whole design back: set fields on named rooms (rect, doorsTo, enclosure, window, capacity, purpose, name), add rooms, remove rooms, or change the shell. A revision is a few lines; a whole design re-sent is a page, and a page re-sent tends to come back unchanged. Returns a new designId and the same report check_design gives.",
  tier: "both",
  mutating: false,
  input: z.object({
    designId: z
      .string()
      .describe("the design to start from, from check_design, plan_rooms or a previous revision"),
    rooms: z.array(RoomPatchS).optional().describe("fields to set on rooms, by key"),
    add: z.array(DesignS.shape.rooms.element).optional().describe("rooms to add, complete"),
    remove: z.array(z.string()).optional().describe("keys of rooms to drop"),
    shell: DesignS.shape.shell.partial().optional().describe("fields of the shell to change"),
    circulation: z.array(z.string()).optional(),
  }),
  output: checkDesignTool.output,
  run(args, call) {
    const base = recall(call.ctx.store, args.designId);
    const byKey = new Map(base.rooms.map((r) => [r.key, r]));
    const unchanged: string[] = [];
    for (const p of args.rooms ?? []) {
      const room = byKey.get(p.key);
      if (room) {
        // A move to where the room already is: a real run "moved" two overlapping booths to the
        // coordinates they had, and nothing told it the overlap was still its own doing.
        const same = Object.entries(p).filter(
          ([k, v]) =>
            k !== "key" && JSON.stringify((room as Record<string, unknown>)[k]) === JSON.stringify(v),
        );
        for (const [k] of same) unchanged.push(`${p.key}.${k}`);
      }
      if (!room)
        throw invalidArg(
          "rooms",
          `no room "${p.key}" in ${args.designId}`,
          `its rooms are: ${[...byKey.keys()].join(", ")}`,
        );
      const { key: _key, ...fields } = p;
      const purpose =
        fields.purpose === undefined ? {} : { purpose: purposeFromWord(fields.purpose) ?? fields.purpose };
      byKey.set(p.key, { ...room, ...fields, ...purpose } as DesignRoom);
    }
    for (const key of args.remove ?? []) {
      if (!byKey.delete(key)) call.warn(`no room "${key}" to remove`);
    }
    const added = (args.add ?? []).map((r) => ({
      ...r,
      purpose: purposeFromWord(r.purpose) ?? r.purpose,
    }));
    const next = {
      ...base,
      shell: { ...base.shell, ...(args.shell ?? {}) },
      rooms: [...byKey.values(), ...added],
      ...(args.circulation ? { circulation: args.circulation } : {}),
    };
    const parsed = Design.safeParse(next);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      throw invalidArg("rooms", issues.join("; "), `purposes are: ${RoomPurpose.options.join(", ")}`);
    }
    if (unchanged.length)
      call.warn(
        `these were set to the value they already had, so they changed nothing: ${unchanged.join(", ")}`,
      );
    const { design, assumed } = inferDoors(parsed.data);
    if (assumed.length)
      call.warn(
        `no doors were given for ${assumed.length} room(s), so each opens onto what it touches: ${assumed.join("; ")}`,
      );
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
    "A quick first draft: turn a list of rooms into a plan of rooms either side of hallways, sized to their areas, and check it. It always makes that one shape and cannot make an open floor, rooms around a courtyard or a copy of a picture; for those, write the design yourself and give it to check_design. Returns a designId for build_design.",
  tier: "both",
  mutating: false,
  input: z.object({
    brief: z.string().describe("the person's own words, so the design records what it was for"),
    kind: z.enum(["dwelling", "workplace", "mixed"]),
    shell: z
      .object({ w: z.number().positive(), d: z.number().positive() })
      .optional()
      .describe(
        "the plot, in mm, ONLY if the brief stated one. Leave it out otherwise: the building is then sized to suit the rooms, which is far better than a plot you made up. A round number like 60000 by 40000 is a sign you are inventing it.",
      ),
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
      { note: "as asked for", programme: tidyKeys(first as Programme) },
      ...(alternatives ?? []).map((a) => ({
        note: a.note,
        programme: tidyKeys({
          ...(first as Programme),
          ...(a.shell ? { shell: a.shell } : {}),
          rooms: a.rooms as Programme["rooms"],
        }),
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
      // The checker's score cannot see a sliver; the quality measure can (ADR-028 D2). A real run
      // chose a design at 0.96 that the quality measure put at 0.73 for six rooms 6 m by 1.8.
      const quality = layoutQuality(design).score;
      const combined = Math.round(((report.score + quality) / 2) * 1000) / 1000;
      return { ...t, ...result, design, report, errors, quality, combined };
    });
    const ranked = [...packed].sort(
      (a, b) => a.errors - b.errors || b.combined - a.combined || a.unplaced.length - b.unplaced.length,
    );
    const best = ranked[0] as (typeof ranked)[number];

    for (const u of best.unplaced) call.warn(u.why);
    for (const n of best.notes) call.warn(n);
    const id = nextId();
    remember(call.ctx.store, id, best.design);
    for (const p of best.report.problems.filter((x) => x.severity === "error")) call.warn(p.message);
    if (ranked.length > 1)
      call.warn(
        `tried ${ranked.length} ways of arranging it and kept "${best.note}" at ${best.combined}; the others scored ${ranked
          .slice(1)
          .map((r) => `${r.combined} (${r.note})`)
          .join(", ")}`,
      );

    return {
      ...reportOf(id, best.report),
      score: best.report.score,
      quality: best.quality,
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

/**
 * The programme with its keys made into keys.
 *
 * A design refers to its own rooms by key, and the key has to be a slug. A model given a field
 * called "key" writes "Open Workspace" about as often as it writes "ws1", and refusing that ended a
 * real run three steps later with a page of raw schema errors that said "Invalid" and nothing else.
 * Whatever it called the room is unambiguous, so it is turned into a key rather than rejected, and
 * every reference to it -- what each room should be beside -- is turned the same way.
 */
function tidyKeys(programme: Programme): Programme {
  const keys = roomKeys(programme.rooms.map((r) => r.key || r.name));
  const renamed = new Map(programme.rooms.map((r, i) => [r.key, keys[i] as string]));
  return {
    ...programme,
    rooms: programme.rooms.map((r, i) => ({
      ...r,
      key: keys[i] as string,
      ...(r.nextTo
        ? { nextTo: r.nextTo.map((k) => renamed.get(k) ?? roomKey(k)).filter((k) => keys.includes(k)) }
        : {}),
    })),
  };
}

export const designLayoutTool = defineTool({
  name: "design_layout",
  description:
    "Work the whole plan out before drawing any of it. Hands the brief to an architect that has the inspect tools and check_design and nothing that draws, and gets back a design that passed the checker, ready for build_design. Use it for anything that builds a building or rearranges its rooms; for adding one table to a room that exists, do not. If it comes back without a passing design, call it again with designId set to the lastDesignId it gave: the next architect fixes that design instead of starting over. Never draw the building wall by wall instead.",
  tier: "both",
  mutating: false,
  // A whole agent run, not a calculation: it stops itself on its step budget, its round budget or a
  // Cancel, and this only catches a wedge.
  timeoutMs: TIMEOUTS.subrun,
  input: z.object({
    brief: z
      .string()
      .min(1)
      .describe("what to design, in the person's own words, with anything you have since learned"),
    designId: z
      .string()
      .optional()
      .describe(
        "a design to continue from: the lastDesignId an earlier design_layout returned without a pass",
      ),
  }),
  output: z.object({
    designId: z.string().nullable(),
    lastDesignId: z.string().nullable(),
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
    let from: { designId: string; errors: string[] } | undefined;
    if (args.designId) {
      const earlier = recall(call.ctx.store, args.designId);
      from = {
        designId: args.designId,
        errors: checkLayout(earlier, call.ctx.rules)
          .problems.filter((p) => p.severity === "error")
          .map((p) => p.message),
      };
    }
    const result = await runner.run({ role: "architect", brief: args.brief, ...(from ? { from } : {}) });
    for (const u of result.unresolved) call.warn(u);
    if (!result.designId)
      call.warn(
        result.lastDesignId
          ? `the architect did not reach a design that passes; ${result.lastDesignId} was its closest, with ${result.unresolved.length} error(s) left. Call design_layout again with designId: "${result.lastDesignId}" to have it finished; do not draw the building by hand`
          : "the architect did not reach a design that passes the checker; read what it said",
      );
    return {
      designId: result.designId,
      lastDesignId: result.lastDesignId,
      said: result.text,
      unresolved: result.unresolved,
      rounds: result.rounds,
    };
  },
});

export const buildDesignTool = defineTool({
  name: "build_design",
  description:
    "Draw a design that check_design passed, exactly as it is: the outside walls (glass along a glazed side), one wall between neighbouring rooms -- plaster, glass, or none where both are open -- a door in each pair the design joins, a window on each room that asked for one, and the rooms themselves with their purposes. It never rearranges anything. One undoable step. Furnish afterwards with furnish_room.",
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
            // An open zone has no walls by design; validate is told so, not left to warn about it.
            ...(enclosureOf(r) === "open" ? { properties: { enclosure: "open" } } : {}),
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

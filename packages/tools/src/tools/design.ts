// The design tools (spec 04 section 6a, ADR-022): propose a design and have it measured, then build
// the one that passed.
//
// Two calls rather than one because they are two different jobs. Checking is free, has no effect on
// the drawing, and is what the architect does over and over while it gets the plan right. Building
// is one irreversible-looking act -- undoable, but not something to do by accident -- and it refuses
// a design the checker has not passed, which is the whole point of having a checker.
import {
  checkLayout,
  type DesignWalk,
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
  type RulesPack,
  walkDesign,
} from "@fpv/catalog";
import { createStore, type Store } from "@fpv/commands";
import {
  Design,
  type DesignRoom,
  derive,
  enclosureOf,
  type Opening,
  outsideSides,
  type Project,
  purposeFromWord,
  type Room,
  RoomPurpose,
  roomKey,
  roomKeys,
  sequentialIdGenerator,
  sharedEdge,
  type Wall,
} from "@fpv/ir";
import { z } from "zod";
import { openingsWanted, roomPolygon, runPoints, SNAP_MM, wallRuns } from "../build-design.js";
import { sizesFor } from "../context.js";
import { invalidArg, ToolError, unavailable } from "../envelope.js";
import { pickRecipe } from "../furnish.js";
import { drawLevel, PLAN_KEY, type PlanPicture } from "../plan-picture.js";
import { defineTool, TIMEOUTS, type ToolCall } from "../registry.js";
import { tidyDesign } from "../tidy.js";
import {
  freeSegments,
  RoomViewS,
  roomView,
  roomWallCompass,
  roomWalls,
  suggestedDisplayWall,
} from "../views.js";
import { runAll } from "./structure.js";

/** Designs checked in this session, newest last, so build_design can be given an id and not a copy. */
const CHECKED = new WeakMap<Store, Map<string, Design>>();
/**
 * How many a session holds.
 *
 * Eight was the import drafts' number and it was too few here: an architect has ten rounds and a
 * design a round, so the id it was told to continue from had already been dropped, and it was
 * answered with "no design called design_000s was checked in this session" -- which reads as a
 * mistake it made. A design is a page of JSON; thirty-two of them are nothing beside a run.
 */
const KEEP = 32;

/** The first error of a design, as the sentence and the fix, for a refusal to carry. */
function firstFix(design: Design, rules: RulesPack | null): string {
  const first = checkLayout(design, rules).problems.find((p) => p.severity === "error");
  return first ? ` Its first error is: ${first.message}${first.hint ? `. ${first.hint}` : ""}` : "";
}

/** The id of a design this session has already checked that is this one exactly, if there is one. */
function sameAsChecked(store: Store, design: Design): string | null {
  const text = JSON.stringify(design);
  for (const [id, held] of CHECKED.get(store) ?? []) if (JSON.stringify(held) === text) return id;
  return null;
}

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

/** A design this session holds, or null; recall() is the same with a refusal instead of the null. */
function held(store: Store, id: string): Design | null {
  return CHECKED.get(store)?.get(id) ?? null;
}

function recall(store: Store, id: string): Design {
  const held = CHECKED.get(store) ?? new Map<string, Design>();
  const design = held.get(id);
  if (!design)
    throw new ToolError(
      "design.unknown",
      `no design called "${id}" was checked in this session`,
      null,
      // Whoever is asking is told what they can do about it: the designer has design_layout and not
      // check_design, and a live designer told to "call check_design first" gave up instead, four
      // steps into a run, because it has no such tool (ADR-022 D1a).
      held.size > 0
        ? `this session has: ${[...held.keys()].join(", ")}. A design lives as long as the host does, so an id from an earlier session is gone; design it again with design_layout, or check_design if you are the architect`
        : "nothing has been designed in this session yet: call design_layout with the brief, or check_design if you are the architect",
    );
  return design;
}

/** A stable id per design, so the same design checked twice keeps one name. */
let seq = 0;
const nextId = () => `design_${(seq += 1).toString(36).padStart(4, "0")}`;

const RectS = z.object({
  x: z.number().describe("the south-west corner of the clear inside, mm; x grows to the east"),
  y: z.number().describe("the same corner, mm; y grows to the north, so y = 0 is the south side"),
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
          north: z.enum(["windows", "glazed", "solid"]).optional(),
          south: z.enum(["windows", "glazed", "solid"]).optional(),
          east: z.enum(["windows", "glazed", "solid"]).optional(),
          west: z.enum(["windows", "glazed", "solid"]).optional(),
        })
        .optional()
        .describe(
          "per side: 'glazed', one glass wall the length of that side with no separate windows, the default for a workplace; 'windows', punched windows, the default for a home; or 'solid', no windows, for a side against a neighbour or the building's core, where a door can still go. Rooms on a glazed side need no window: true",
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

function reportOf(id: string, report: LayoutReport, walk?: Walk) {
  const errors = report.problems.filter((p) => p.severity === "error");
  const warnings = report.problems.filter((p) => p.severity === "warning");
  return {
    designId: id,
    buildable: layoutIsBuildable(report),
    score: report.score,
    totals: report.totals,
    errors,
    warnings,
    ...(walk ? { walk } : {}),
  };
}

/** What walking a design finds, in the report every check returns (ADR-028 D11). */
const WalkS = z
  .object({
    entrances: z.array(z.string()),
    routes: z.record(z.string()),
    through: z.array(z.string()),
    unreached: z.array(z.string()),
    sides: z.record(
      z.object({ facade: z.string(), enclosed: z.number(), empty: z.number(), along: z.array(z.string()) }),
    ),
    displays: z.record(z.string()),
  })
  .describe(
    "what walking the plan from the entrance finds: the route to each room, rooms reached only through another, what stands along each side of the building (enclosed is the share of its length with a room against it that is not open floor), and the wall each meeting room's screen would go on. Facts for you to judge, not errors",
  );

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
    walk: WalkS.optional(),
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
    // And what they were keyed by: "meetA" is refused by the key rule, and a live architect spent a
    // round discovering that capital letter. Lower-cased here, doors and circulation with them.
    const renamed = new Map<string, string>();
    const keyed = args.design as {
      rooms?: { key?: unknown; doorsTo?: unknown }[];
      circulation?: unknown;
    };
    for (const room of keyed.rooms ?? []) {
      if (typeof room.key !== "string") continue;
      const key = roomKey(room.key);
      if (key === room.key) continue;
      renamed.set(room.key, key);
      room.key = key;
    }
    if (renamed.size > 0) {
      const map = (k: unknown) => (typeof k === "string" ? (renamed.get(k) ?? k) : k);
      for (const room of keyed.rooms ?? [])
        if (Array.isArray(room.doorsTo)) room.doorsTo = room.doorsTo.map(map);
      if (Array.isArray(keyed.circulation)) keyed.circulation = keyed.circulation.map(map);
      call.warn(
        `a key is lower-case letters, digits and underscores, so these were read as: ${[...renamed]
          .map(([was, now]) => `${was} as ${now}`)
          .join(", ")}`,
      );
    }

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
    // The same design again, word for word, is not checked again. A live run sent one design three
    // times in a row, saying each time that it would redesign from scratch, and the warning that
    // nothing had changed did not stop it; each copy cost a round. A refusal is a failed call, which
    // the loop's stall breaker counts, and it costs no round.
    const again = sameAsChecked(call.ctx.store, design);
    const report = checkLayout(design, call.ctx.rules);
    // A design that passed is not a mistake to send again -- the look gate bounces an answer, and
    // the model checks its design once more before answering -- so it gets its report and the id it
    // already has. A design that still has errors is refused: it cost a round three times in a row.
    if (again && !layoutIsBuildable(report))
      throw new ToolError(
        "design.unchanged",
        `this is ${again} again, word for word, and it has the same errors.${firstFix(design, call.ctx.rules)}`,
        null,
        `change it: revise_design { designId: "${again}", rooms: [{ key, rect: { ... } }] } moves the rooms the errors name; preview_design { designId: "${again}" } shows where they are, if you can see pictures`,
      );
    if (again) {
      call.warn(`this is ${again} again, and it passes; build it with that designId`);
      return reportOf(again, report, walkOf(call, design));
    }
    const compared = compareWithLast(call.ctx.store, design, report);
    if (compared) call.warn(compared);
    const id = nextId();
    remember(call.ctx.store, id, design);
    for (const p of report.problems.filter((x) => x.severity === "error")) call.warn(p.message);
    return reportOf(id, report, walkOf(call, design));
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
  // Part of a rect is a rect: "move it 2 m north" is y alone, and a model that had to restate the
  // size to move a room sent w and d as zero and was refused twice for it.
  rect: RectS.partial().optional().describe("any of x, y, w, d; what you leave out stays as it is"),
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
    /** The room a key names, allowing for the shapes a model writes it in: openoffice, OpenOffice. */
    const find = (given: string): string | undefined => {
      if (byKey.has(given)) return given;
      const flat = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
      const near = [...byKey.keys()].filter((k) => flat(k) === flat(given));
      return near.length === 1 ? near[0] : undefined;
    };
    for (const patch of args.rooms ?? []) {
      const key = find(patch.key);
      const p = key === undefined || key === patch.key ? patch : { ...patch, key };
      if (key !== undefined && key !== patch.key)
        call.warn(`read "${patch.key}" as ${key}, the room of that name in ${args.designId}`);
      const room = byKey.get(p.key);
      if (room) {
        // A move to where the room already is: a real run "moved" two overlapping booths to the
        // coordinates they had, and nothing told it the overlap was still its own doing.
        const same = Object.entries(p).filter(([k, v]) => {
          if (k === "key") return false;
          const held = (room as Record<string, unknown>)[k];
          // a rect given in part is the same only if every part of it already is
          if (k === "rect" && v && typeof v === "object")
            return Object.entries(v as Record<string, unknown>).every(
              ([f, value]) => (held as Record<string, unknown> | undefined)?.[f] === value,
            );
          return JSON.stringify(held) === JSON.stringify(v);
        });
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
      // What a partial rect leaves out stays as it was.
      const rect = fields.rect === undefined ? {} : { rect: { ...room.rect, ...fields.rect } };
      byKey.set(p.key, { ...room, ...fields, ...purpose, ...rect } as DesignRoom);
    }
    for (const given of args.remove ?? []) {
      const key = find(given);
      if (key === undefined || !byKey.delete(key)) call.warn(`no room "${given}" to remove`);
    }
    const added = (args.add ?? []).map((r) => ({
      ...r,
      purpose: purposeFromWord(r.purpose) ?? r.purpose,
    }));
    const next = {
      ...base,
      // side by side, so changing one side's facade leaves the others as they were
      shell: {
        ...base.shell,
        ...(args.shell ?? {}),
        facade: { ...base.shell.facade, ...(args.shell?.facade ?? {}) },
      },
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
    // A revision that changes nothing is the whole-design problem in patch form: a live architect
    // sent eight rooms' rects back exactly as they were. Refused, so it costs no round.
    const asked = (args.rooms?.length ?? 0) + (args.add?.length ?? 0) + (args.remove?.length ?? 0);
    const touched = (args.rooms ?? []).reduce((n, patch) => n + Object.keys(patch).length - 1, 0);
    if (
      asked > 0 &&
      (args.add?.length ?? 0) === 0 &&
      (args.remove?.length ?? 0) === 0 &&
      !args.shell &&
      !args.circulation &&
      unchanged.length >= touched
    )
      throw new ToolError(
        "design.unchanged",
        `every field in this revision is already what it says: ${unchanged.slice(0, 6).join(", ")}.${firstFix(base, call.ctx.rules)}`,
        null,
        "give the rooms the numbers you want them to have; the errors say what is wrong with the numbers they have",
      );
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
    return reportOf(id, report, walkOf(call, design));
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
      ...reportOf(id, best.report, walkOf(call, best.design)),
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
    looked: z.boolean().describe("whether the architect looked at the design before handing it on"),
    stopped: z.string().describe("how the architect's run ended: done, stalled, step-budget, ..."),
    verdict: z.string().nullable().describe("the architect's LOOK verdict on it"),
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
      // A design to continue from that this session no longer holds -- an id remembered from an
      // earlier conversation, after the host restarted -- is a reason to start fresh, not to refuse
      // to design at all. A live designer asked for one, was refused, and had nothing left to try.
      const earlier = held(call.ctx.store, args.designId);
      if (earlier)
        from = {
          designId: args.designId,
          errors: checkLayout(earlier, call.ctx.rules)
            .problems.filter((p) => p.severity === "error")
            .map((p) => p.message),
        };
      else
        call.warn(
          `no design called "${args.designId}" is held in this session, so the architect designs from the brief instead`,
        );
    }
    const result = await runner.run({ role: "architect", brief: args.brief, ...(from ? { from } : {}) });
    for (const u of result.unresolved) call.warn(u);
    if (!result.designId)
      call.warn(
        result.lastDesignId
          ? `the architect did not reach a design that passes; ${result.lastDesignId} was its closest, with ${result.unresolved.length} error(s) left. Call design_layout again with designId: "${result.lastDesignId}" to have it finished; do not draw the building by hand`
          : "the architect did not reach a design that passes the checker; read what it said",
      );
    // Why it stopped, when it did not simply answer: a live architect died on a provider error and
    // the designer was told only that no design passed (ADR-028 D11).
    if (result.reason !== "done")
      call.warn(
        `the architect's run ended early (${result.reason}${result.error ? `: ${result.error}` : ""}); it had ${result.lastDesignId ?? "no design"} at that point`,
      );
    if (result.designId && result.looked === false)
      call.warn(
        `the architect handed on ${result.designId} without looking at it; look at it yourself with preview_design { designId: "${result.designId}" } before you build it`,
      );
    return {
      designId: result.designId,
      lastDesignId: result.lastDesignId,
      said: result.text,
      unresolved: result.unresolved,
      rounds: result.rounds,
      looked: result.looked ?? false,
      verdict: result.verdict ?? null,
      stopped: result.reason,
    };
  },
});

/**
 * Draw a design into whichever store the call carries: the project's, for build_design, or a scratch
 * copy, for a preview and the walk (ADR-028 D11). One path, so what a model is shown is what gets
 * built.
 */
function buildInto(
  call: ToolCall,
  design: Design,
  levelId: string,
): { walls: Wall[]; openings: Opening[]; rooms: Room[]; unplaced: string[] } {
  const runs = wallRuns(design);
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
  return {
    walls,
    openings: openingResults.map((r) => r.result as Opening),
    rooms: roomResults.map((r) => r.result as Room),
    unplaced,
  };
}

/** A design built into a throwaway copy of the project: the level it went on and each room's id. */
interface Scratch {
  project: Project;
  levelId: string;
  roomOf: Map<string, string>;
  warnings: string[];
  unplaced: string[];
  /** The builder refused it, so only the rooms were drawn: no walls, no doors. */
  sketch: boolean;
}

/**
 * Build a design where nobody will see it: an empty copy of the project with its levels, a store of
 * its own, and warnings kept rather than sent. Null when the builder refuses it, which a design the
 * checker is still failing can make it do.
 */
function scratchBuild(call: ToolCall, design: Design): Scratch | null {
  const p0 = call.ctx.store.project;
  const levelId =
    design.levelId && derive.levelOf(p0, design.levelId) ? design.levelId : derive.lowestLevel(p0).id;
  const empty: Project = { ...p0, walls: [], openings: [], rooms: [], items: [], zones: [], annotations: [] };
  const store = createStore(empty, { ids: sequentialIdGenerator(1), now: call.ctx.now });
  const warnings: string[] = [];
  const scratch: ToolCall = {
    ...call,
    ctx: { ...call.ctx, store },
    warn: (m) => warnings.push(m),
    changed: () => {},
  };
  try {
    const built = buildInto(scratch, design, levelId);
    const roomOf = new Map(design.rooms.map((r, i) => [r.key, built.rooms[i]?.id ?? ""]));
    return { project: store.project, levelId, roomOf, warnings, unplaced: built.unplaced, sketch: false };
  } catch {
    // The builder refuses some designs that are still wrong. The rooms alone still show where
    // everything is, which is what a model fixing its arithmetic needs to see.
    try {
      const alone = createStore(empty, { ids: sequentialIdGenerator(1), now: call.ctx.now });
      const rooms = runAll(
        { ...scratch, ctx: { ...call.ctx, store: alone } },
        "design: rooms",
        design.rooms.map((r: DesignRoom) => ({
          type: "room.create",
          payload: {
            levelId,
            polygon: roomPolygon(r),
            name: r.name,
            purpose: r.purpose,
            ...(enclosureOf(r) === "open" ? { properties: { enclosure: "open" } } : {}),
          },
        })),
      );
      const roomOf = new Map(
        design.rooms.map((r, i) => [r.key, (rooms[i]?.result as Room | undefined)?.id ?? ""]),
      );
      return { project: alone.project, levelId, roomOf, warnings, unplaced: [], sketch: true };
    } catch {
      return null;
    }
  }
}

/**
 * The wall each room's screen would go on, by the rule furnishing uses, on the design built where
 * nobody sees it (ADR-028 D12). Only rooms whose recipe has a screen on a wall it chooses itself.
 */
function displaysOf(call: ToolCall, design: Design, scratch: Scratch): Record<string, string> {
  const out: Record<string, string> = {};
  const rules = call.ctx.rules;
  if (!rules) return out;
  const p = scratch.project;
  const sizes = sizesFor(p, call.ctx.catalog);
  for (const r of design.rooms) {
    const room = p.rooms.find((x) => x.id === scratch.roomOf.get(r.key));
    if (!room) continue;
    let recipe: ReturnType<typeof pickRecipe>;
    try {
      recipe = pickRecipe(rules, room);
    } catch {
      continue;
    }
    const step = recipe.steps.find((s) => s.op === "display");
    if (!step || step.wall !== "auto") continue;
    const side = suggestedDisplayWall(p, room, freeSegments(p, room, sizes));
    if (!side) {
      out[r.key] = "none: every wall is glass or has a window, so the screen would stand on the floor";
      continue;
    }
    const kinds = roomWalls(p, room)
      .filter((w) => w.kind !== "glass" && roomWallCompass(p, w, room) === side)
      .map((w) => w.kind);
    out[r.key] = `${side}, on ${kinds.every((k) => k === "exterior") ? "an outside wall" : "plaster"}`;
  }
  return out;
}

export type Walk = DesignWalk & { displays: Record<string, string> };

/** What walking the design finds, with the screens' walls: facts for the model to judge (D11). */
export function walkOf(call: ToolCall, design: Design): Walk {
  const scratch = scratchBuild(call, design);
  return { ...walkDesign(design), displays: scratch ? displaysOf(call, design, scratch) : {} };
}

/** The headings a LOOK verdict has to speak to, so "Verdict: DONE" alone is not a verdict. */
export const LOOK_HEADINGS = [
  "Way in",
  "Every room reached",
  "Sides",
  "Zones",
  "Doors outside",
  "Drawn over",
  "Left over",
  "Displays",
  "Brief",
] as const;

/**
 * Which of them a verdict left out.
 *
 * Emphasis is stripped first: a model writes "- **Way in:** ..." as often as "- Way in: ...", and a
 * gate that could not read the first sent a good verdict back twice for saying nothing.
 */
export function lookMissing(verdict: string): string[] {
  // Plain text and a colon, not a pattern: a verdict comes as "- Way in: ...", "- **Way in:** ..."
  // or all on one line, and a regex written in a template literal ate its own escapes and found
  // none of them, which sent three good verdicts back as saying nothing.
  const plain = verdict.replace(/[*_`#]/g, "").toLowerCase();
  return LOOK_HEADINGS.filter((h) => !plain.includes(`${h.toLowerCase()}:`));
}

/** The checklist a design is looked at against, before it is called done (ADR-028 D11). */
export function lookChecklist(designId: string): string {
  return [
    `Write the LOOK verdict for ${designId}: one concrete sentence per line, naming what you see. "Looks good" is not a verdict, and a line that names nothing was not looked at.`,
    `LOOK ${designId}`,
    "- Way in: where the entrance is, what it opens onto, and whether the reception is the first room you reach",
    "- Every room reached: the longest route, and any room reached only through another",
    "- Sides: what stands along each side of the building, and any side left blank",
    "- Zones: whether the desks are open floor (yellow) or a room behind a door, and whether the cafe and the rooms people sit in have daylight",
    "- Doors outside: any door to outside that is not the entrance",
    "- Drawn over: anything on top of something else",
    "- Left over: any pink floor that no room covers, and how big it is",
    "- Displays: which wall each meeting room's screen goes on, and that it is not glass or a window",
    "- Brief: what the person asked for that is there, and what is not",
    "- Verdict: DONE, or FIX and the fixes",
    "If it is FIX, make the fixes with revise_design and look again.",
  ].join("\n");
}

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

    const before = ctx.store.historyPosition;
    try {
      const built = buildInto(call, design, levelId);
      const project = ctx.store.project;
      const sizes = sizesFor(project, ctx.catalog);
      for (const u of built.unplaced) call.warn(`could not place the ${u}`);
      return {
        walls: built.walls.length,
        doors: built.openings.filter((o) => o?.kind === "door").length,
        windows: built.openings.filter((o) => o?.kind === "window").length,
        rooms: built.rooms.map((r) =>
          roomView(project, project.rooms.find((x) => x.id === r.id) as Room, sizes),
        ),
        unplaced: built.unplaced,
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

/**
 * A picture of a plan, for a model to look at before it calls it done (ADR-028 D11): a checked design
 * as build_design will draw it, or the level as built. Only offered to a model that can see.
 */
export const previewDesignTool = defineTool({
  name: "preview_design",
  description:
    "Look at a plan: a drawing, north up, of a checked design exactly as build_design will draw it -- outside walls, plaster, glass, doors, the entrance, windows, and the rooms numbered with a legend. With no designId, the level as it is built now, furniture included, so you can see where every screen went. Look before you call a design done, and after you build it.",
  tier: "both",
  mutating: false,
  timeoutMs: TIMEOUTS.slow,
  resultCapBytes: 8 * 1024 * 1024,
  input: z.object({
    designId: z
      .string()
      .optional()
      .describe("a design from check_design or revise_design; leave it out to see what is built"),
    levelId: z.string().optional().describe("with no designId: the level to draw, default the lowest"),
  }),
  output: z.object({
    caption: z.string(),
    ask: z.string(),
    legend: z.array(z.string()),
    images: z.array(
      z.object({ name: z.string(), width: z.number(), height: z.number(), pngBase64: z.string() }),
    ),
  }),
  run(args, call) {
    const key = (pic: PlanPicture) =>
      pic.northUp
        ? PLAN_KEY
        : PLAN_KEY.replace("North is up.", "North is where the arrow at the top right points.");
    const image = (name: string, pic: PlanPicture) => ({
      name,
      width: pic.width,
      height: pic.height,
      pngBase64: Buffer.from(pic.png).toString("base64"),
    });
    if (args.designId) {
      const design = recall(call.ctx.store, args.designId);
      const scratch = scratchBuild(call, design);
      if (!scratch)
        throw new ToolError(
          "design.not-drawable",
          `${args.designId} cannot be drawn: the builder refuses it`,
          null,
          "fix its errors with revise_design and look at the new designId",
        );
      const labels = new Map<string, string>();
      const legend: string[] = [];
      design.rooms.forEach((r, i) => {
        const id = scratch.roomOf.get(r.key);
        if (id) labels.set(id, String(i + 1));
        legend.push(`${i + 1} ${r.key}`);
      });
      for (const u of scratch.unplaced) call.warn(`build_design would not place the ${u}`);
      const pic = drawLevel(scratch.project, scratch.levelId, { labels });
      const what = scratch.sketch
        ? `The rooms of ${args.designId} as rectangles alone: the builder cannot draw its walls yet, so there are no walls or doors in it.`
        : `The plan of ${args.designId} as build_design will draw it.`;
      return {
        caption: `${what} ${key(pic)} Rooms by number: ${legend.join(", ")}.`,
        ask: lookChecklist(args.designId),
        legend,
        images: [image(args.designId, pic)],
      };
    }
    const p = call.ctx.store.project;
    const levelId = args.levelId ?? derive.lowestLevel(p).id;
    if (!derive.levelOf(p, levelId))
      throw new ToolError("ref.missing", `level "${levelId}" does not resolve`, null, "use get_scene");
    const labels = new Map<string, string>();
    const legend: string[] = [];
    p.rooms
      .filter((r) => r.levelId === levelId)
      .forEach((r, i) => {
        labels.set(r.id, String(i + 1));
        legend.push(`${i + 1} ${r.name ?? r.purpose} (${r.id})`);
      });
    const pic = drawLevel(p, levelId, { labels, items: true, sizes: sizesFor(p, call.ctx.catalog) });
    return {
      caption: `The level as it is built now, furniture included. ${key(pic)} Rooms by number: ${legend.join(", ")}.`,
      ask: "Compare it with the design that was approved: every wall, door and window where the design put them, every screen on a plaster wall and none on glass or a window, and every room furnished that should be. Name each difference in a sentence. A difference in the walls is the builder's fault to report, never a reason to draw walls by hand.",
      legend,
      images: [image(levelId, pic)],
    };
  },
});

/**
 * The arithmetic done for a design whose arrangement is already decided (ADR-028 D10).
 *
 * Not a rearranger: it moves each room the least it can. Across five live runs the errors a local
 * model could not clear were rooms overlapping by a few hundred millimetres and rooms past the shell,
 * and it spent every round re-sending the same rectangles rather than applying the numbers the hints
 * gave it.
 */
export const tidyDesignTool = defineTool({
  name: "tidy_design",
  description:
    "Do the arithmetic on a design you have already drawn: every room moved the least it can be so that none overlaps another and all of them are inside the building. It never changes which room is where, what it is, or what it opens onto, and it says what it moved. Use it when an overlap or an outside-the-building error will not clear; then look at the result and put right anything it moved that you did not mean.",
  tier: "both",
  mutating: false,
  input: z.object({
    designId: z.string().describe("the design to tidy, from check_design or revise_design"),
  }),
  output: checkDesignTool.output,
  run(args, call) {
    const base = recall(call.ctx.store, args.designId);
    const { design, moves, unresolved } = tidyDesign(base);
    if (moves.length === 0)
      call.warn("nothing moved: no room overlaps another and all are inside the building");
    for (const m of moves) call.warn(m);
    for (const u of unresolved) call.warn(u);
    const report = checkLayout(design, call.ctx.rules);
    const id = nextId();
    remember(call.ctx.store, id, design);
    for (const p of report.problems.filter((x) => x.severity === "error")) call.warn(p.message);
    return reportOf(id, report, walkOf(call, design));
  },
});

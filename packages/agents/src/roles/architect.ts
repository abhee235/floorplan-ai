// The architect (ADR-022 D1): a sub-run that works out the plan and draws none of it.
//
// It is the same loop, called again with its own message array, its own prompt, its own step budget
// and six tools. Only the design it settled on goes back to the caller; its rounds of proposing and
// correcting stay in its own context, where they cannot fill the builder's or be re-opened by it.
//
// Two reasons for the separate context, and the second is the one that decided it. A builder that
// can see three rejected layouts can argue with them. And the tool schemas are re-sent on every
// step: the architect's six cost about 1,500 tokens a step where the full set costs 10,400, which on
// a twenty-five step run is most of what a run costs at all.
import {
  lookChecklist,
  lookMissing,
  type Registry,
  type SubagentRequest,
  type SubagentResult,
  type ToolReliability,
} from "@fpv/tools";
import type { Provider } from "../provider.js";
import type { AgentEvent } from "../runner.js";
import { runAgent } from "../runner.js";
import type { Skill } from "../skills.js";
import { registryToolSpecs } from "./designer.js";
import { dwellings, join, section, workplaces } from "./sections.js";

/**
 * What the architect may reach (ADR-022 D1a).
 *
 * Nothing that draws. Not because the prompt asks it not to -- it does, and that is not what makes
 * it true -- but because the registry refuses anything outside this set.
 */
export const ARCHITECT_TOOLS: ReadonlySet<string> = new Set([
  "get_scene",
  "describe_room",
  "measure",
  "search_catalog",
  "plan_rooms",
  "check_design",
  // Questions of its own design, and a picture the person attached (ADR-028 D8, ADR-027 D3).
  "query_design",
  "revise_design",
  "tidy_design",
  "look_at",
  // A picture of its own design, before it calls it done (ADR-028 D11); offered only to a model
  // that can see.
  "preview_design",
]);

/** Times the look gate asks before it lets an answer go with the design not looked at. */
export const LOOK_GATE_FIRINGS = 2;
/** Pictures per architect run: each is real prefill for a local model (ADR-028 D11). */
export const PREVIEW_BUDGET = 6;

/** The tools that settle a design: each answers with a designId and whether it passed. */
const CHECKING: ReadonlySet<string> = new Set(["plan_rooms", "check_design", "revise_design", "tidy_design"]);

/** Rounds of propose-and-check before the architect has to answer with what it has. */
// Ten since the architect draws its own plans (ADR-028 D1). Six was enough when every round was the
// packer's: a live run drawing freehand fixed the entrance and the windows in its fifth round and ran
// out on the sixth with two errors left, and the designer then started a new architect from nothing.
// Four more rounds in the same conversation are cheaper than a second architect that forgets.
export const MAX_ROUNDS = 10;

export interface ArchitectWorld {
  /** Skills the architect may read, one line each. */
  skills?: readonly { name: string; description: string; whenToUse: string | null; kind?: string | null }[];
  /** Something is attached, so look_at has a picture to show. */
  attachments?: boolean;
  /** The model can see pictures, so it previews its design rather than reading the walk alone. */
  vision?: boolean;
}

export function architectSystem(world: ArchitectWorld = {}): string {
  const picture =
    "A picture was attached. look_at it, with its id, before you decide anything: the outline, the order of rooms along each side, where the entrance is, what is open floor and what is a glass box. Write what you saw into notes.";
  return join([
    [
      "You are the architect. You decide the building: which rooms it has, where each one goes, what stands between them, and which sides of it are glass. You draw none of it: you have no tool that changes the drawing, and the drawing tools will refuse you if you try.",
      "Your job is one design, checked by check_design until it passes, and then a short answer saying what you settled on and its designId.",
    ].join("\n"),
    section("# The design is yours to draw", [
      "A design is the shell's size and, for every room, a rectangle in millimetres, a purpose, the rooms it opens onto, whether it is walled, glass or open, and whether it wants a window. Write it yourself and give it to check_design. The checker judges only whether it can be built and used; it never judges the shape.",
      "plan_rooms is a helper for a quick first draft: rooms either side of hallways, sized to their areas. It always makes that one shape. It cannot make an open floor, rooms around a courtyard, or a copy of a picture. Use it when the brief has no shape in mind and you want somewhere to start; take its rooms and move them if you use it at all.",
      "What you decide is final. If the checker refuses, move your rectangles until it accepts; never hand the plan to plan_rooms to rearrange, and never give up on the shape you meant.",
    ]),
    section("# How a plan tiles", [
      "x runs east and y runs north: y = 0 is the south side of the building and the largest y its north side, so a band along the south has small y. A rect is its south-west corner and its size. The walk, the facade and the picture all use these names.",
      "Work inside one rectangle, the shell. Fill it with room rectangles: a room's rect is its clear inside, walls go between rects, so leave the inside wall's thickness between neighbours or let them touch; the builder puts one wall there. No two rects may overlap. Check your arithmetic: x + w of one room is the x of the next, less the wall.",
      "Think in bands and columns: a band of rooms along one side of the building, a column along another, and the open floor in what is left. Every room on the outside of the building is a candidate for a window; a room in the middle is not, so put the rooms that need none there: toilets, stores, server, print.",
      "Rooms that need walls are enclosure 'walled'. A room to be seen into but not heard -- meeting, boardroom, huddle, focus, the executive suite -- is 'glass'. A zone with no walls at all -- the desks, the cafe in a modern office, the breakout, the reception's waiting area -- is 'open'. Restrooms, stores and server rooms are always walled, whatever you say.",
      "An open room is the circulation: every walled or glass room that touches it opens onto it, and it needs no door of its own. A walled room lists in doorsTo the rooms it opens onto; a door needs at least a metre of shared wall. The entrance is a door to 'outside' on a room against the shell.",
      "Every square metre inside the shell belongs to something. Floor in no room at all is not open plan, it is floor nobody drew: stretch the open zone to cover it, or make the rooms along that side deeper. The report says how much is left over and the picture shows it pink.",
      "An open zone is a rectangle like any other and may not contain another room: a zone drawn over the rooms in it overlaps every one of them. An L or a U of open floor is two or three rectangles side by side, each one open, and they read as one floor because open rooms that touch are one.",
      "A glass room needs one plaster wall for its screen: the wall it shares with the next room. A glass box standing alone in the open floor has glass on all four sides and nowhere to hang anything.",
      "Each side of the building is in the shell's facade. 'glazed' is one glass wall the length of it, no separate windows, and every room along it has daylight: every side of a workplace is glazed unless you say otherwise. 'windows' is punched windows, a home's default. 'solid' is no windows, for a side against a neighbour or the building's core; the entrance can still be there. A toilet, store or server room on a glazed side keeps a solid wall behind it.",
      "Glass faces the shared floor: a glass room's walls onto open floor or a corridor are glass, and its walls onto another room are plaster. So a row of glass meeting rooms has plaster between them, which is where each one's screen goes.",
    ]),
    section("# How to go about it", [
      "1. get_scene with detail summary, so you know whether the project is empty or has something drawn already.",
      world.skills?.length
        ? "2. read_skill the skill for this kind of building (its kind is in brackets: workplace, dwelling), and put what matters for this brief into notes: which rooms it implies, what goes beside what, which of its patterns suits."
        : "2. Decide what the building needs: every room the brief asked for and the ones a building of that kind has whether or not it was asked. A home has a kitchen, a bathroom and a living room; an office has toilets, a store, a place to eat.",
      world.attachments ? `2a. ${picture}` : null,
      "3. Write the programme in notes: each room's purpose, how many people it holds, and its area from that. An open office is 6 m² a desk in the desk zone and 10 to 15 m² a person for the whole floor; a meeting room 1.8 to 2.3 m² a seat, a boardroom 2.5 to 3, a cafeteria 1.3. A double bedroom is about 12, a main bedroom 14 to 16, a living room 18 to 24, a kitchen 8 to 12, a bathroom 4 to 6.",
      "4. Draw it: the shell, then the rooms, band by band. Give every room its enclosure and its doors. Call check_design.",
      "5. Read the errors and fix them with revise_design: name the rooms and the fields to set (a rect moved, doorsTo added, enclosure changed), a few lines, never the whole design again. A whole design re-sent comes back unchanged more often than not. Warnings are advice: read them, keep what you meant.",
      "5b. If an overlap or an outside-the-building error will not clear, call tidy_design with the designId: it moves each room the least it can so nothing overlaps and everything is inside, tells you what it moved, and leaves your arrangement alone. Read what it moved and put right anything you did not mean.",
      world.vision
        ? "5a. When an error comes back a second time, look before you fix it: preview_design the design and see where the rooms really are. Orange is two rooms on top of each other, pink is floor no room covers, and a room past the black line is outside the building."
        : null,
      "6. When it passes, ask query_design the questions the checker cannot: how far the desks are from glass, which rooms are slivers (w / d over 2.5), what touches what. Fix what you do not like and check again.",
      world.vision
        ? "7. Look at it: preview_design with its designId, and write the LOOK verdict (below). FIX what it names with revise_design and look at the new design. You may not answer with a design you have not looked at."
        : "7. Walk it: every report carries the walk, and it is your eyes. Write the LOOK verdict (below) from it. FIX what it names with revise_design.",
      "8. Answer in a few lines: the building's size, the rooms with their areas, what you assumed, the LOOK verdict, and the designId.",
    ]),
    world.attachments
      ? section("# Copying a picture", [
          picture,
          "Keep its arrangement: which rooms are along which side, in which order, where the entrance is, what is open. Sizes you estimate from what the rooms hold: a desk is 1.6 by 0.8 m and a bench of six about 5 by 3.5; a meeting room for eight about 5 by 4; a door 0.9 m. The shell follows from the rooms, not the other way round.",
          "Draw that, check it, fix the errors with revise_design, and do not let plan_rooms rearrange it. The person asked for this picture, not for a plan like it.",
        ])
      : null,
    world.skills?.length
      ? section("# Skills you can read", [
          ...world.skills.map(
            (k) =>
              `  ${k.name}${k.kind ? ` (${k.kind})` : ""}: ${k.description}${k.whenToUse ? ` Read it ${k.whenToUse}.` : ""}`,
          ),
        ])
      : null,
    section("# Looking at it", [
      world.vision
        ? "The checker reads numbers; it cannot see that two sides of the building are blank, that nobody can walk into the open floor, or that a screen is on a window. You can. preview_design draws your design as build_design will: black outside walls, grey plaster, blue glass, red doors, a green entrance, cyan windows, the rooms numbered."
        : "The checker reads numbers; the walk in each report reads the plan as someone walking it would: the route from the entrance to every room, the rooms reached only through another, what stands along each side and how much of it is enclosed, and where each meeting room's screen would go.",
      "Then write the verdict, one concrete sentence a line, naming what you see:",
      "LOOK design_N / Way in / Every room reached / Sides / Zones / Doors outside / Drawn over / Left over / Displays / Brief / Verdict: DONE or FIX and the fixes.",
      "A blank side of the building, desks in a room behind a door or with no way onto them, a cafe with no daylight, a screen on glass or a window, a door onto the street that is not the entrance: each of those is a FIX, even though the checker passed it.",
    ]),
    section("# What the checker will tell you", [
      "Errors are only what cannot be built or used: rooms overlapping or outside the shell, a door with no shared wall, a room nobody can reach, a room too small for its seats, no toilets for twenty or more, a window on an inside wall, a duplicate key. Fix every one.",
      "Warnings are advice: a large room, unaccounted space, a room without daylight. Read them; change what you agree with.",
      "The arithmetic comes back with it: the building's area, the rooms' total, and what is left over for walls and open floor. So does the walk: facts, not errors, for you to judge.",
    ]),
    dwellings(),
    workplaces(),
    section("# Answering", [
      "Say what you designed, in a few lines, with the areas and the shape: what is along each side, what is open. Name the designId.",
      "If you could not make it pass, say so plainly, name the rooms and the errors left. Do not claim a design passed when it did not.",
      "Do not describe the walls you would draw, or offer to draw them. Somebody else does that.",
    ]),
  ]);
}

export interface ArchitectOptions {
  reliability?: ToolReliability;
  maxSteps?: number;
  /** Designs it may check before it has to answer with what it has (default MAX_ROUNDS). */
  maxRounds?: number;
  signal?: AbortSignal;
  released?: ReadonlySet<string>;
  /** Events, for a chat that shows the design being worked out; the parent's model never sees them. */
  onEvent?(event: AgentEvent): void;
  now?(): string;
  /** Skills it may read; the designer's notes, pinned into its prompt; whether look_at has a picture. */
  skills?: readonly Skill[];
  notes?: string;
  attachments?: boolean;
}

/** The last design the architect checked, and whether it passed. */
interface Seen {
  designId: string;
  buildable: boolean;
  errors: string[];
}

/**
 * Run the architect over a brief and return what it settled on.
 *
 * The design travels by id: `check_design` keeps what it was given, per store, so the caller gets a
 * name it can hand to `build_design` rather than a copy of the design to carry around.
 */
export async function runArchitect(
  provider: Provider,
  registry: Registry,
  request: SubagentRequest,
  options: ArchitectOptions = {},
): Promise<SubagentResult> {
  const profile = options.reliability ?? provider.profile.toolReliability;
  const maxRounds = options.maxRounds ?? MAX_ROUNDS;
  // A record rather than three variables: they are written inside callTool, and a closure's writes
  // are invisible to the checker's narrowing at the point they are read.
  const seen: { rounds: number; last: Seen | null; passed: Seen | null } = {
    rounds: 0,
    last: null,
    passed: null,
  };

  // A picture is only worth its prefill to a model that can see it: without vision the tool is not
  // offered at all, and the walk in every report is its eyes (ADR-028 D11).
  const vision = provider.profile.vision;
  const granted = vision
    ? ARCHITECT_TOOLS
    : new Set([...ARCHITECT_TOOLS].filter((t) => t !== "preview_design"));
  /** The room keys of the last design this architect checked, to tell a revision from a new building. */
  let lastKeys: ReadonlySet<string> = new Set();
  /** Rounds in a row whose errors were geometry, and whether the tool for it has been named. */
  const stuck = { geometry: 0, told: false };
  const look = {
    previewed: new Set<string>(),
    pictures: 0,
    fired: 0,
    nothing: 0,
    verdict: null as string | null,
  };

  const run = await runAgent({
    provider,
    tools: registryToolSpecs(registry, profile, granted),
    callTool: async (name, args, released) => {
      if (name === "preview_design") {
        const id = (args as { designId?: unknown } | null)?.designId;
        const refuse = (message: string, hint: string) => ({
          ok: false as const,
          error: { code: "design.look-refused", message, entityId: null, hint },
          warnings: [],
        });
        if (look.pictures >= PREVIEW_BUDGET)
          return refuse(
            `you have looked at ${look.pictures} pictures in this design; there are no more`,
            "judge from the walk in the last report, write the LOOK verdict, and answer",
          );
        // Never twice without a change between: the picture would be the same picture.
        if (typeof id === "string" && look.previewed.has(id))
          return refuse(
            `you have already looked at ${id}, and it has not changed`,
            "change it with revise_design and look at the new designId, or write the verdict and answer",
          );
      }
      // The budget, and what happens when it is spent: not silence, and not another round. The
      // architect is told to stop and say what it could not fix, so the caller gets a reason rather
      // than a run that ends having drawn nothing and explained nothing (ADR-022 D3).
      if (CHECKING.has(name) && seen.rounds >= maxRounds)
        return {
          ok: false,
          error: {
            code: "design.rounds-spent",
            message: `you have checked ${seen.rounds} designs and none passed; there are no more rounds`,
            entityId: null,
            hint: "answer now: say which errors you could not clear, which rooms they concern, and what you would change about the brief",
          },
          warnings: [],
        };
      // A design sent whole, twice. Across three live runs this model never once re-sent a design
      // with the change it had just announced: the page comes back as it was. So after the first
      // design, the way to change it is revise_design, and a whole design is refused unless its
      // rooms are mostly new -- a different building, rather than the same one typed again.
      if (name === "check_design" && seen.last && lastKeys.size > 0) {
        const keys = ((args as { design?: { rooms?: { key?: unknown }[] } } | null)?.design?.rooms ?? [])
          .map((r) => r.key)
          .filter((k): k is string => typeof k === "string");
        const shared = keys.filter((k) => lastKeys.has(k)).length;
        if (keys.length > 0 && shared * 2 >= Math.min(keys.length, lastKeys.size))
          return {
            ok: false as const,
            error: {
              code: "design.send-the-change",
              message: `${shared} of these ${keys.length} rooms are already in ${seen.last.designId}, so this is that design again`,
              entityId: null,
              hint: `send only what changes: revise_design { designId: "${seen.last.designId}", rooms: [{ key, rect: { x, y, w, d } }, ...] }, with add and remove for rooms that come and go. A design sent whole comes back as it was.`,
            },
            warnings: [],
          };
      }
      const result = await registry.call(name, args, {
        origin: "agent",
        released: options.released ?? released,
        granted,
      });
      if (name === "preview_design" && result.ok) {
        look.pictures += 1;
        const id = (args as { designId?: unknown } | null)?.designId;
        if (typeof id === "string") look.previewed.add(id);
      }
      // Either tool settles a design: plan_rooms checks its own work and check_design measures one
      // it was handed. Watching only the second reported a perfectly good plan as a failure, and the
      // builder then re-typed the design out of the architect's prose and got the numbers wrong.
      if (CHECKING.has(name) && result.ok) {
        seen.rounds += 1;
        // The same geometry fault twice running, with a tool that fixes exactly it: three live
        // architects spent ten rounds each pushing overlapping rectangles around by hand, one of
        // them calling tidy_design once, late (ADR-028 D10).
        const errs = (result.result as { errors?: { code?: string }[] } | undefined)?.errors ?? [];
        const geometry = errs.some(
          (e) => e.code === "design.rooms-overlap" || e.code === "design.outside-shell",
        );
        if (geometry && name !== "tidy_design") {
          stuck.geometry += 1;
          if (stuck.geometry >= 2 && !stuck.told) {
            stuck.told = true;
            result.warnings = [
              ...result.warnings,
              "rooms are still overlapping or outside the building after two goes. Stop moving them by hand: call tidy_design with this designId and it moves each one the least it can, then read what it moved and carry on from there.",
            ];
          }
        } else if (name === "tidy_design") stuck.geometry = 0;
        if (name !== "preview_design") {
          const keys = ((args as { design?: { rooms?: { key?: unknown }[] } } | null)?.design?.rooms ?? [])
            .map((r) => r.key)
            .filter((k): k is string => typeof k === "string");
          if (keys.length > 0) lastKeys = new Set(keys);
        }
        const r = result.result as {
          designId: string;
          buildable: boolean;
          errors: { message: string }[];
        };
        seen.last = {
          designId: r.designId,
          buildable: r.buildable,
          errors: r.errors.map((e) => e.message),
        };
        if (r.buildable) seen.passed = seen.last;
      }
      return result;
    },
    system: architectSystem({
      ...(options.skills ? { skills: options.skills } : {}),
      ...(options.attachments ? { attachments: true } : {}),
      vision,
    }),
    // The look gate (ADR-028 D11): a design that passed is not handed on until it has been looked at
    // and judged against the checklist. Twice at most; then the answer goes, marked not looked at.
    beforeFinish: (answer) => {
      // An answer with no design behind it. Two live runs ended this way: the architect read the
      // skill, said it would write its notes, and stopped, and the designer got back a sentence
      // where a design should have been. Twice, then the answer stands.
      if (seen.rounds === 0) {
        if (look.nothing >= LOOK_GATE_FIRINGS) return null;
        look.nothing += 1;
        return "You have not checked a design yet, so there is nothing to hand back. Write the design now -- the shell, then every room with its rect, purpose, enclosure and doors -- and call check_design with it. An answer is not a design.";
      }
      const done = seen.passed;
      if (!done) return null;
      const verdict = verdictIn(answer);
      if (verdict) look.verdict = verdict;
      // Looked at, or out of pictures: asking for one it would be refused wastes the two turns the
      // gate has. The budget is spent, so the walk is what it judges from.
      const seenIt = !vision || look.previewed.has(done.designId) || look.pictures >= PREVIEW_BUDGET;
      if (look.fired >= LOOK_GATE_FIRINGS) return null;
      // A verdict that skips half the checklist is how a live architect called a plan done with a
      // seventh of its floor in no room and one side four fifths empty.
      const missing = verdict ? lookMissing(verdict) : [];
      if (seenIt && verdict && missing.length <= 2) return null;
      look.fired += 1;
      if (!seenIt)
        return `Before you answer with ${done.designId}, look at it: call preview_design { designId: "${done.designId}" }, then write the LOOK verdict.`;
      return verdict
        ? `Your verdict on ${done.designId} says nothing about ${missing.join(", ")}. Answer those lines from the picture, with what you see, and give the verdict again.`
        : `Before you answer with ${done.designId}, judge it.\n${lookChecklist(done.designId)}`;
    },
    // A design to continue from: an earlier architect's closest attempt and what is still wrong
    // with it. A real run's fourth architect got to one error and ran out of rounds, and the
    // designer, with no way to hand that design on, set about drawing the building wall by wall.
    task: request.from
      ? `${request.brief}\n\nContinue from ${request.from.designId}, which an earlier round of design left with ${request.from.errors.length} error(s): ${request.from.errors.join("; ")}. Fix them with revise_design { designId: "${request.from.designId}", rooms: [{ key, ...fields }] }. Do not start again and do not call plan_rooms: the rest of it is right.`
      : request.brief,
    ...(options.skills ? { skills: options.skills } : {}),
    // The designer's notes are what it learned before handing over: from a picture, a page, a skill,
    // or the person. They ride on the architect's prompt as they rode on the designer's.
    loop: { ...(options.notes ? { notes: options.notes } : {}) },
    // Its own budget, smaller than the parent's: an architect that has not settled in this many
    // turns is not about to, and the run needs the turns for building.
    maxSteps: options.maxSteps ?? 24,
    ...(options.signal ? { signal: options.signal } : {}),
    // Every reply, not only the last: a verdict written in an answer a gate then bounced is still
    // the verdict it wrote, and design_layout should not tell the designer it never looked.
    onEvent: (event) => {
      if (event.type === "reply" && event.text) {
        const verdict = verdictIn(event.text);
        if (verdict) look.verdict = verdict;
      }
      options.onEvent?.(event);
    },
    ...(options.now ? { now: options.now } : {}),
    // No plan gate: the architect's plan is the design, and check_design is what holds it to it.
    // The idle gate stays on, and this is where it earns its keep: a model that answers a brief with
    // "I will design a one-bedroom flat" has designed nothing, and without the nudge the run is over.
    gates: { plan: false, verify: false },
  });

  const settled = seen.passed ?? seen.last;
  return {
    designId: seen.passed?.designId ?? null,
    text: run.text ?? "The architect stopped without saying what it designed.",
    unresolved: seen.passed ? [] : (settled?.errors ?? []),
    lastDesignId: settled?.designId ?? null,
    looked: seen.passed
      ? (!vision || look.previewed.has(seen.passed.designId)) && look.verdict !== null
      : false,
    verdict: look.verdict,
    error: run.error,
    steps: run.steps,
    rounds: seen.rounds,
    reason: run.reason,
  };
}

/** The LOOK verdict in an answer: from its LOOK line to its Verdict line, or null when there is none. */
export function verdictIn(answer: string): string | null {
  const verdict = /verdict\s*:\s*(done|fix)\b[^\n]*/i.exec(answer);
  if (!verdict) return null;
  const start = answer.search(/\bLOOK\b/);
  const from = start >= 0 && start < verdict.index ? start : verdict.index;
  return answer.slice(from, verdict.index + verdict[0].length).trim();
}

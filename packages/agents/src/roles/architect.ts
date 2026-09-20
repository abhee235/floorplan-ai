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
import type { Registry, SubagentRequest, SubagentResult, ToolReliability } from "@fpv/tools";
import type { Provider } from "../provider.js";
import type { AgentEvent } from "../runner.js";
import { runAgent } from "../runner.js";
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
]);

/** The tools that settle a design: both answer with a designId and whether it passed. */
const CHECKING: ReadonlySet<string> = new Set(["plan_rooms", "check_design"]);

/** Rounds of propose-and-check before the architect has to answer with what it has. */
export const MAX_ROUNDS = 6;

export function architectSystem(): string {
  return join([
    [
      "You are the architect. You decide what a building should contain and you draw none of it: you have no tool that changes the drawing, and the drawing tools will refuse you if you try.",
      "Your whole job is one list of rooms, given to plan_rooms, and then a short answer saying what you settled on.",
    ].join("\n"),
    section("# What you decide, and what you do not", [
      "You decide the programme: which rooms the building needs, what each one is for, roughly how many square metres it wants, which rooms should be beside which, and how big the plot is if nobody said.",
      "You do not decide where the rooms go. plan_rooms works that out: it sizes the building, lays the rooms either side of a hallway, gives every room a door onto it and an outside wall for its window, and checks the result.",
      "Do not place rectangles yourself. Working out which of nine rooms overlaps which is the thing a program does in a millisecond and you do badly, and you will spend your whole budget on it.",
    ]),
    section("# How to go about it", [
      "1. get_scene with detail summary, so you know whether you are designing into an empty project or beside something already drawn.",
      "2. Write the programme down: every room the brief asked for, and the ones a building of that kind must have whether or not it was asked. A home has a kitchen, a bathroom and a living room, and a home without a separate dining room eats in the living room.",
      "3. Give each room an area in square metres that suits what it is for and how many people use it. A double bedroom is about 12, a main bedroom 14 to 16, a living room 18 to 24, a kitchen 8 to 12, a bathroom 4 to 6, a toilet 2.",
      "4. Call plan_rooms with the programme, and with one or two alternatives that differ in something you can name: a bigger living room and slightly smaller bedrooms, a separate dining room against a larger hall, a narrower plot. Each one is laid out and checked and the best is kept, so an alternative costs you nothing but the words.",
      "5. Read what it says: which one it kept and why, the building it chose, the size each room came out, and anything it could not fit.",
      "6. If a room came out too small or would not fit, change the programme -- fewer rooms, smaller areas, or a bigger plot -- and call plan_rooms again. Do not try to place the rooms yourself instead.",
      "7. When it passes, answer in two or three sentences: the building's size, the rooms with their areas, what you assumed, and the designId.",
    ]),
    section("# What the checker will tell you", [
      "plan_rooms checks its own work and hands you the result. A design that passes is ready to build; one that does not tells you which room is wrong and why.",
      "check_design is the same checker, if you ever need to measure a design you were given rather than one you asked for.",
      "The arithmetic comes back with it: the building's area, the rooms' total, and what is left over for walls. A large leftover means a room is missing.",
    ]),
    dwellings(),
    workplaces(),
    section("# Answering", [
      "Say what you designed, in a few lines, with the areas. Name the designId.",
      "If you could not fit what was asked for, say so plainly, name the rooms and what would have to change: a bigger plot, fewer bedrooms, a smaller living room. Do not claim a design passed when it did not.",
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

  const run = await runAgent({
    provider,
    tools: registryToolSpecs(registry, profile, ARCHITECT_TOOLS),
    callTool: async (name, args, released) => {
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
      const result = await registry.call(name, args, {
        origin: "agent",
        released: options.released ?? released,
        granted: ARCHITECT_TOOLS,
      });
      // Either tool settles a design: plan_rooms checks its own work and check_design measures one
      // it was handed. Watching only the second reported a perfectly good plan as a failure, and the
      // builder then re-typed the design out of the architect's prose and got the numbers wrong.
      if (CHECKING.has(name) && result.ok) {
        seen.rounds += 1;
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
    system: architectSystem(),
    task: request.brief,
    // Its own budget, smaller than the parent's: an architect that has not settled in this many
    // turns is not about to, and the run needs the turns for building.
    maxSteps: options.maxSteps ?? 16,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
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
    steps: run.steps,
    rounds: seen.rounds,
    reason: run.reason,
  };
}

// The registry: one definition per tool, called in-process by the app's agent and, through the
// optional MCP adapter in the host, by external agents (ADR-005 D1, ADR-006 D1).
import { checkDesign } from "@fpv/catalog";
import { type ChangeSet, CommandError, type Origin } from "@fpv/commands";
import { type Problem, type Project, validate } from "@fpv/ir";
import type { z } from "zod";
import { sizesFor, type ToolContext } from "./context.js";
import {
  byteLength,
  RESULT_CAP_BYTES,
  ToolError,
  type ToolFail,
  type ToolOk,
  type ToolResult,
} from "./envelope.js";

export type Tier = "primitive" | "semantic" | "both";
export type ToolReliability = "high" | "medium" | "low";

/** Per-call helpers handed to a tool's run function. */
export interface ToolCall {
  ctx: ToolContext;
  warn(message: string): void;
  /** Report the change set of a mutation so the envelope carries it. */
  changed(cs: ChangeSet | null): void;
  /**
   * Who asked for this call, for the commands it applies.
   *
   * Every tool used to write as "agent", including the ones the editor itself calls -- the catalog
   * panel's search, the file picker's import. The session log then said an agent had done what a
   * person did, which is the one question a log of this kind exists to answer (ADR-019 D2).
   */
  origin: Origin;
  /**
   * Another tool, called as this one was: the same origin, the same consent, the same grant. This
   * is how batch runs a list of tool calls without knowing what any of them does.
   */
  tools: { call(name: string, args: unknown): Promise<ToolResult> };
}

export type AnyObjectSchema = z.ZodObject<z.ZodRawShape>;

/** What a caller says about itself. Anything that does not say is the agent, which is the common case. */
export interface CallOptions {
  origin?: Origin;
  /**
   * Entity ids this call may change although a person made or touched them (ADR-023 D3).
   *
   * The run's selection when it started, plus whatever a consent question has since released.
   * Empty and absent mean the same thing, and both are the safe answer.
   */
  released?: ReadonlySet<string>;
  /**
   * The only tools this caller may reach (ADR-022 D1a). Absent means all of them.
   *
   * A role is what it can do, not what it was asked to do. Telling the architect in its prompt not
   * to draw is how a mid-sized model comes to draw anyway; taking create_walls away from it is how
   * it does not. The refusal is an ordinary tool error, so the model reads it and corrects itself.
   */
  granted?: ReadonlySet<string>;
}

export interface ToolDef<I extends AnyObjectSchema = AnyObjectSchema, O = unknown> {
  name: string;
  /** Shown to models verbatim; part of the spec. */
  description: string;
  tier: Tier;
  input: I;
  output: z.ZodType<O>;
  /** Mutating tools get the validation state appended as `problems` (ADR-006 D4). */
  mutating: boolean;
  timeoutMs: number;
  /** Result size cap in bytes; defaults to RESULT_CAP_BYTES. Image-carrying tools raise it. */
  resultCapBytes?: number;
  run(args: z.infer<I>, call: ToolCall): O | Promise<O>;
}

/**
 * How long a tool may take before the loop gives up on it.
 *
 * `subrun` is the odd one out and deliberately enormous. A tool that runs a nested agent is not a
 * computation that can hang; it is many model turns, each of which the host already allows five
 * minutes because a tool-calling turn on a local model takes them. It bounds itself three ways
 * already -- a step budget, a round budget and the abort signal a person's Cancel raises -- so this
 * is a backstop against a wedged process, not a limit on the work. At 120 seconds it was neither:
 * a local model could not finish an architect sub-run inside it, and every design failed on the
 * clock rather than on its merits.
 */
export const TIMEOUTS = {
  read: 5_000,
  command: 10_000,
  render: 30_000,
  slow: 120_000,
  subrun: 1_800_000,
} as const;

/** Define a tool with defaults filled in; keeps each tool file short. */
export function defineTool<I extends AnyObjectSchema, O>(
  def: Omit<ToolDef<I, O>, "timeoutMs"> & { timeoutMs?: number },
): ToolDef<I, O> {
  return { timeoutMs: def.mutating ? TIMEOUTS.command : TIMEOUTS.read, ...def };
}

/** Section 9 of spec 04: what each reliability profile is told about. */
const LOW_PROFILE = new Set([
  "get_scene",
  "describe_room",
  "validate",
  "render",
  "search_catalog",
  "create_room_from_brief",
  "furnish_room",
  "place_item",
  "arrange",
  "get_bom",
  "history",
  "batch",
  "project",
  "export",
  // A weak model still has to be able to say the whole brief. A storey, a plan to read, and the colour
  // of a pane of glass are not advanced moves — they are the difference between "three storeys with
  // tinted windows" being buildable and being refused for want of a tool nobody was told about.
  "add_level",
  "import_plan",
  "finish_opening",
  "finish_wall",
  // and the two a weak model needs most: they are what turn "three bedrooms and a hall" into
  // something measured, drawn in one step and impossible to get half right.
  "design_layout",
  "plan_rooms",
  "check_design",
  "build_design",
  "query_design",
  "revise_design",
  // What the model reads before it designs (ADR-027): simple, non-mutating, and a weak model with a
  // picture attached needs the first as much as a strong one.
  "look_at",
  "web_search",
  "read_page",
]);
const MEDIUM_HIDDEN = new Set(["modify_wall"]);

/**
 * Fields one entity recomputes because another changed, which nobody chose: a wall's mitres, a
 * room's list of its walls, the room an item is found to stand in, and the stamp itself.
 */
const DERIVED = new Set(["joins", "boundingWallIds", "roomId", "by"]);

/** The same entity but for the fields nobody edits directly. */
function sameButForDerived(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (DERIVED.has(k)) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

export class Registry {
  private readonly tools = new Map<string, ToolDef>();
  private seq = 0;

  constructor(readonly ctx: ToolContext) {}

  register(def: ToolDef<AnyObjectSchema, unknown>): this {
    if (this.tools.has(def.name)) throw new Error(`tool ${def.name} is already registered`);
    this.tools.set(def.name, def);
    return this;
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }

  /** Tools advertised to a model of the given reliability; every tool stays callable (ADR-006 D6). */
  advertised(profile: ToolReliability): ToolDef[] {
    const all = this.list();
    if (profile === "high") return all;
    if (profile === "medium") return all.filter((t) => !MEDIUM_HIDDEN.has(t.name));
    return all.filter((t) => LOW_PROFILE.has(t.name));
  }

  /** Call a tool by name with raw arguments; never throws. */
  async call(name: string, rawArgs: unknown, options: CallOptions = {}): Promise<ToolResult> {
    const started = Date.now();
    const origin = options.origin ?? "agent";
    const before = this.ctx.store.historyPosition;
    const was = this.ctx.store.project;
    let result =
      options.granted && !options.granted.has(name)
        ? fail(
            {
              code: "tool.not-granted",
              message: `${name} is not one of the tools this step may use`,
              entityId: null,
              hint: `use one of: ${[...options.granted].sort().join(", ")}`,
            },
            [],
          )
        : await this.invoke(name, rawArgs, origin, options);
    if (result.ok && origin === "agent") {
      const trespass = this.trespass(was, result.changed, options.released);
      if (trespass) {
        // Take the call back before answering. A tool does not know what it will touch until it
        // has, and the store knows how to undo; the model then asks, and repeats the call.
        while (this.ctx.store.historyPosition > before) this.ctx.store.undo();
        result = fail(trespass, result.warnings);
      }
    }
    this.ctx.transcript?.record({
      seq: (this.seq += 1),
      tool: name,
      args: rawArgs,
      result,
      at: this.ctx.now(),
      durationMs: Date.now() - started,
      origin,
    });
    return result;
  }

  private async invoke(
    name: string,
    rawArgs: unknown,
    origin: Origin,
    options: CallOptions,
  ): Promise<ToolResult> {
    const warnings: string[] = [];
    const def = this.tools.get(name);
    if (!def) {
      return fail(
        {
          code: "tool.unknown",
          message: `no tool named "${name}"`,
          entityId: null,
          hint: `tools: ${[...this.tools.keys()].join(", ")}`,
        },
        warnings,
      );
    }
    // Unknown keys never fail a call (spec 04 section 1).
    let args: unknown = rawArgs ?? {};
    if (typeof args === "object" && args !== null && !Array.isArray(args)) {
      const known = new Set(Object.keys(def.input.shape as Record<string, unknown>));
      const unknown = Object.keys(args).filter((k) => !known.has(k));
      if (unknown.length > 0) {
        warnings.push(`Unknown arguments ignored: ${unknown.join(", ")}`);
        args = Object.fromEntries(Object.entries(args).filter(([k]) => known.has(k)));
      }
    }
    const parsed = def.input.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      return fail(
        {
          code: "args.invalid",
          message: `${name}: ${issues.join("; ")}`,
          entityId: null,
          hint: `fields: ${Object.keys(def.input.shape as Record<string, unknown>).join(", ")}`,
        },
        warnings,
      );
    }
    let changed: ChangeSet | null = null;
    const call: ToolCall = {
      ctx: this.ctx,
      warn: (m) => warnings.push(m),
      changed: (cs) => {
        changed = cs;
      },
      origin,
      tools: { call: (inner, args) => this.call(inner, args, options) },
    };
    try {
      const value = await withTimeout(Promise.resolve(def.run(parsed.data, call)), def.timeoutMs, name);
      const out = def.output.safeParse(value);
      if (!out.success) {
        return fail(
          {
            code: "internal",
            message: `${name} produced a result that does not match its schema: ${out.error.issues[0]?.message ?? "?"}`,
            entityId: null,
            hint: null,
          },
          warnings,
        );
      }
      const cap = def.resultCapBytes ?? RESULT_CAP_BYTES;
      if (byteLength(out.data) > cap) {
        return fail(
          {
            code: "result.too-large",
            message: `${name} result exceeds ${cap} bytes`,
            entityId: null,
            hint: "narrow the call: pass levelId, types or bbox, or follow cursor pages",
          },
          warnings,
        );
      }
      const problems: Problem[] = def.mutating || changed ? this.problems() : [];
      return { ok: true, result: out.data, warnings, problems, changed } satisfies ToolOk;
    } catch (e) {
      if (e instanceof ToolError || e instanceof CommandError) return fail(e.toJSON(), warnings);
      if (e && typeof e === "object" && "code" in e && "message" in e && "entityId" in e) {
        const s = e as { code: string; message: string; entityId: string | null; hint?: string | null };
        return fail(
          { code: s.code, message: s.message, entityId: s.entityId, hint: s.hint ?? null },
          warnings,
        );
      }
      const message = e instanceof Error ? e.message : String(e);
      return fail({ code: "internal", message: `${name}: ${message}`, entityId: null, hint: null }, warnings);
    }
  }

  /**
   * The person's work this change set touched without leave, as the error to answer with (ADR-023 D4).
   *
   * The rule is enforced here rather than in the prompt because a rule that lives only in a prompt
   * is a rule the model keeps most of the time, and "most of the time" is exactly the failure that
   * costs a person their trust in the thing.
   */
  private trespass(
    was: Project,
    changed: ChangeSet | null,
    released: ReadonlySet<string> = new Set(),
  ): { code: string; message: string; entityId: string | null; hint: string } | null {
    if (!changed) return null;
    // "meta" is the project itself, which nobody authored: it is how a restore reports that the
    // whole document was replaced, and an undo is not a change of authorship.
    const suspects = [...changed.updated, ...changed.removed].filter(
      (r) => r.type !== "meta" && !released.has(r.id),
    );
    if (suspects.length === 0) return null;
    const now = this.ctx.store.project;
    const index = (p: Project) => {
      const m = new Map<string, Record<string, unknown>>();
      for (const list of [p.levels, p.walls, p.openings, p.rooms, p.items, p.zones, p.annotations])
        for (const e of list as unknown as Record<string, unknown>[]) m.set(e.id as string, e);
      return m;
    };
    const before = index(was);
    const after = index(now);
    const theirs = suspects
      .filter((r) => {
        // A removed entity is gone from the project, so it is read from the copy taken before the
        // call; one neither copy knows is left alone rather than guessed at.
        const by = (before.get(r.id) ?? after.get(r.id))?.by as
          | { touchedByPerson: boolean; createdBy: string }
          | undefined;
        if (!by || !(by.touchedByPerson || by.createdBy === "import")) return false;
        const old = before.get(r.id);
        const fresh = after.get(r.id);
        // Still theirs, but did this call really change it? Moving one wall re-mitres the walls it
        // joins, and creating a room adopts the items standing in it. Asking leave for those would
        // be asking about work nobody did, which teaches a person to wave the question away.
        return !old || !fresh || !sameButForDerived(old, fresh);
      })
      .map((r) => r.id);
    if (theirs.length === 0) return null;
    const named = theirs.slice(0, 3).join(", ");
    const more = theirs.length > 3 ? ` and ${theirs.length - 3} more` : "";
    return {
      code: "consent.needed",
      message: `${named}${more} ${theirs.length === 1 ? "was" : "were"} made or changed by the person; ask before changing ${theirs.length === 1 ? "it" : "them"}`,
      entityId: theirs[0] ?? null,
      hint: "call ask_user with kind 'consent' and these ids, then make this call again",
    };
  }

  /** IR validation plus the rules pack's design rules (spec 07 section 4) when a pack is loaded. */
  problems(): Problem[] {
    const project = this.ctx.store.project;
    const out = validate(project, { sizes: sizesFor(project, this.ctx.catalog) });
    if (this.ctx.rules) out.push(...checkDesign(project, this.ctx.rules, { catalog: this.ctx.catalog }));
    return out;
  }
}

function fail(error: ToolFail["error"], warnings: string[]): ToolFail {
  return { ok: false, error, warnings };
}

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolError("timeout", `${name} did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

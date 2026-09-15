// The registry: one definition per tool, called in-process by the app's agent and, through the
// optional MCP adapter in the host, by external agents (ADR-005 D1, ADR-006 D1).
import { checkDesign } from "@fpv/catalog";
import { type ChangeSet, CommandError } from "@fpv/commands";
import { type Problem, validate } from "@fpv/ir";
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
}

export type AnyObjectSchema = z.ZodObject<z.ZodRawShape>;

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

export const TIMEOUTS = { read: 5_000, command: 10_000, render: 30_000, slow: 120_000 } as const;

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
]);
const MEDIUM_HIDDEN = new Set(["modify_wall"]);

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
  async call(name: string, rawArgs: unknown): Promise<ToolResult> {
    const started = Date.now();
    const result = await this.invoke(name, rawArgs);
    this.ctx.transcript?.record({
      seq: (this.seq += 1),
      tool: name,
      args: rawArgs,
      result,
      at: this.ctx.now(),
      durationMs: Date.now() - started,
    });
    return result;
  }

  private async invoke(name: string, rawArgs: unknown): Promise<ToolResult> {
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

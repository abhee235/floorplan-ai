// The in-app agent, per project (P4-1, ADR-022).
//
// One run at a time for a project, because two agents drawing on one plan is not a feature anybody
// asked for and is a racing pair of hands nobody could watch. The run holds the conversation, so a
// follow-up ("now surround them with chairs") knows what "them" means; it holds the files somebody
// attached, so a model names an id and never carries bytes; and it turns the runner's events into
// the ones a browser draws, which is where images are taken out and previews are cut down.
//
// Everything a person sees comes from these events. Everything the drawing does comes from the
// change stream the bridge already broadcasts, because a tool call is a store command like any
// other. The two are correlated by the ids in `changed`, and neither has to know about the other.

import { mkdirSync } from "node:fs";
import { appendFile, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentEvent,
  type AskRequest,
  type ChatMessage,
  CONSENT_OPTIONS,
  type ContentPart,
  designerSystem,
  LOOP_TOOL_NAMES,
  type PlanItem,
  type Provider,
  registryToolSpecs,
  runAgent,
} from "@fpv/agents";
import { type AgentEventMsg, type AgentStateMsg, type AgentWireEvent, type ChangeSet } from "@fpv/commands";
import type { Attachment, ToolReliability } from "@fpv/tools";
import type { Held, Workspace } from "./workspace.js";

/** Text deltas are gathered for this long before a frame goes out, so a fast model is not a flood. */
const DELTA_MS = 50;
/** A tool result line in a card; the whole result goes to the model, never to the chat. */
const PREVIEW_CHARS = 400;
/** The largest attachment the bridge will take, matching what the plan reader accepts. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Events kept for a tab that reloads mid-run. Deltas are not among them; they are re-derivable noise. */
const REPLAY_KEEP = 400;
/** Runs kept on disk per project, as the session log keeps its own. */
const KEEP_RUNS = 20;

export interface AgentRunsOptions {
  /** Where conversations and runs are written; null keeps everything in memory. */
  dataDir?: string | null;
  provider?: Provider | null;
  /** What to say when there is no provider, or what this one is. */
  note?: string | null;
  now?(): string;
  maxSteps?: number;
  system?: string;
}

interface Active {
  runId: string;
  controller: AbortController;
  startedAt: string;
  status: "running" | "waiting" | "cancelling";
  /** Questions the model is waiting on, by the id the tab answers with. */
  parked: Map<
    string,
    { request: AskRequest; resolve(answers: Record<string, string>): void; reject(e: Error): void }
  >;
}

interface Held2 {
  conversation: ChatMessage[];
  plan: PlanItem[];
  attachments: Map<string, Attachment>;
  replay: AgentEventMsg[];
  seq: number;
  active: Active | null;
  loaded: boolean;
}

export type StartResult =
  | { ok: true; runId: string }
  | { ok: false; error: { code: string; message: string; hint: string | null } };

export class AgentRuns {
  private readonly projects = new Map<string, Held2>();
  private readonly listeners = new Set<(projectId: string, msg: AgentEventMsg) => void>();
  private readonly now: () => string;
  private runSeq = 0;

  constructor(
    private readonly workspace: Workspace,
    private readonly options: AgentRunsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Be told about every event of every project, for the bridge to broadcast. */
  onEvent(listener: (projectId: string, msg: AgentEventMsg) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** What a tab is told when it attaches to a project (ADR-022). */
  state(projectId: string): AgentStateMsg {
    const held = this.projects.get(projectId);
    const active = held?.active ?? null;
    return {
      type: "agent.state",
      projectId,
      available: Boolean(this.options.provider),
      model: this.options.provider?.model ?? null,
      note: this.options.note ?? null,
      run: active ? { runId: active.runId, status: active.status, startedAt: active.startedAt } : null,
      replay: held?.replay ?? [],
    };
  }

  /** Events from `from` onwards, for a tab that missed some. */
  history(projectId: string, from: number): AgentEventMsg[] {
    return (this.projects.get(projectId)?.replay ?? []).filter((m) => m.seq > from);
  }

  start(
    held: Held,
    req: {
      text: string;
      attachments?: { name: string; mime: string; data: string }[];
      reliability?: ToolReliability;
    },
  ): StartResult {
    const provider = this.options.provider;
    if (!provider)
      return {
        ok: false,
        error: {
          code: "agent.unavailable",
          message: this.options.note ?? "this host has no agent model configured",
          hint: "set FPV_AGENT_MODEL and FPV_AGENT_PROVIDER, or a role in the host's config",
        },
      };
    const mine = this.of(held.id);
    if (mine.active)
      return {
        ok: false,
        error: {
          code: "agent.busy",
          message: "the agent is already working on this project",
          hint: "wait for it to finish, or cancel it",
        },
      };
    const text = req.text.trim();
    if (!text && !(req.attachments ?? []).length)
      return {
        ok: false,
        error: { code: "agent.empty", message: "there is nothing to do", hint: "say what to build" },
      };

    // Attachments are decoded once and kept by id; the model names the id and the bytes stay here.
    const attached: { id: string; name: string; mime: string; bytes: number }[] = [];
    for (const a of req.attachments ?? []) {
      const bytes = Buffer.from(a.data, "base64");
      if (bytes.length > MAX_ATTACHMENT_BYTES)
        return {
          ok: false,
          error: {
            code: "agent.too-large",
            message: `${a.name} is ${Math.round(bytes.length / 1e6)} MB; the limit is ${Math.round(MAX_ATTACHMENT_BYTES / 1e6)} MB`,
            hint: null,
          },
        };
      const id = `a${mine.attachments.size + 1}`;
      mine.attachments.set(id, { id, name: a.name, mime: a.mime, bytes: new Uint8Array(bytes) });
      attached.push({ id, name: a.name, mime: a.mime, bytes: bytes.length });
    }
    // The session reads attachments through the context, as it reads plans and the catalog.
    held.session.ctx.attachments = {
      get: (id) => mine.attachments.get(id) ?? null,
      list: () =>
        [...mine.attachments.values()].map((a) => ({
          id: a.id,
          name: a.name,
          mime: a.mime,
          size: a.bytes.length,
        })),
    };

    this.runSeq += 1;
    const runId = `run_${this.runSeq}`;
    const controller = new AbortController();
    const active: Active = {
      runId,
      controller,
      startedAt: this.now(),
      status: "running",
      parked: new Map(),
    };
    mine.active = active;

    // A checkpoint before anything moves, so "undo this run" is one action rather than a hunt back
    // through a hundred history entries.
    let checkpointId: string | null = null;
    try {
      checkpointId = held.session.store.checkpoint(`before agent run ${this.runSeq}`);
    } catch {
      checkpointId = null; // a store without checkpoints still runs; the card simply cannot offer undo
    }

    const reliability = req.reliability ?? "high";
    this.emit(held.id, runId, {
      type: "run.started",
      at: this.now(),
      text,
      attachments: attached,
      model: provider.model,
      reliability,
      checkpointId,
    });
    held.session.log.write("agent", "agent", { event: "started", runId, task: text.slice(0, 200) });

    void this.run(held, mine, active, { text, attached, reliability, provider });
    return { ok: true, runId };
  }

  cancel(held: Held): boolean {
    const active = this.projects.get(held.id)?.active;
    if (!active) return false;
    active.status = "cancelling";
    active.controller.abort();
    // A parked question would otherwise keep the loop waiting for somebody who has gone.
    for (const parked of active.parked.values()) parked.reject(new Error("the run was cancelled"));
    active.parked.clear();
    return true;
  }

  /** A person answered a question the model asked. */
  answer(
    held: Held,
    questionId: string,
    answers: Record<string, string>,
    by: "person" | "review" = "person",
  ): boolean {
    const active = this.projects.get(held.id)?.active;
    const parked = active?.parked.get(questionId);
    if (!active || !parked) return false;
    active.parked.delete(questionId);
    active.status = "running";
    this.emit(held.id, active.runId, { type: "question.answered", id: questionId, answers, by });
    parked.resolve(answers);
    return true;
  }

  /**
   * The review panel committed a draft while the model was waiting to be told the scale.
   *
   * One instrument for the person, two ways in: they can type the answer in the chat or use the
   * overlay they were already looking at, and the model hears the same thing either way.
   */
  draftCommitted(held: Held, summary: string): boolean {
    const active = this.projects.get(held.id)?.active;
    if (!active) return false;
    const waiting = [...active.parked.values()].find((p) => p.request.kind === "scale");
    if (!waiting) return false;
    return this.answer(held, waiting.request.id, { [waiting.request.id]: summary }, "review");
  }

  /** Forget the conversation, so the next message starts a new one. */
  clear(projectId: string): void {
    const mine = this.projects.get(projectId);
    if (!mine) return;
    mine.conversation = [];
    mine.plan = [];
    mine.replay = [];
    mine.attachments.clear();
  }

  close(): void {
    for (const [, held] of this.projects) held.active?.controller.abort();
    this.listeners.clear();
  }

  // ---- the run itself --------------------------------------------------------

  private async run(
    held: Held,
    mine: Held2,
    active: Active,
    req: {
      text: string;
      attached: { id: string; name: string; mime: string; bytes: number }[];
      reliability: ToolReliability;
      provider: Provider;
    },
  ): Promise<void> {
    const { session } = held;
    const registry = session.registry;
    const mutating = new Set(
      registry
        .list()
        .filter((t) => t.mutating)
        .map((t) => t.name),
    );
    const flush = this.deltaFlusher(held.id, active.runId);
    try {
      const run = await runAgent({
        provider: req.provider,
        tools: registryToolSpecs(registry, req.reliability),
        callTool: (name, args, released) => registry.call(name, args, { origin: "agent", released }),
        // The prompt is built for this session, not for every session: a model that cannot see is
        // never told to look at a render, and a session without a rules pack is never told to
        // furnish a room from one.
        system:
          this.options.system ??
          designerSystem({
            vision: req.provider.profile.vision,
            low: req.reliability === "low",
            rules: Boolean(session.ctx.rules),
            viewer: Boolean(session.ctx.viewer),
            sourceImage: req.attached.some((a) => a.mime.startsWith("image/")),
          }),
        task: taskOf(req.text, req.attached, session.store.selection, req.provider, mine),
        // What they had selected when they asked is what they were pointing at: consent for this
        // run, without a question (ADR-023 D3).
        released: session.store.selection,
        history: mine.conversation,
        ...(this.options.maxSteps ? { maxSteps: this.options.maxSteps } : {}),
        signal: active.controller.signal,
        mutatingTools: mutating,
        verifyingTools: new Set(["validate", "get_bom", "compare_plan_image"]),
        loop: {
          plan: mine.plan,
          ask: (request) =>
            new Promise<Record<string, string>>((resolve, reject) => {
              active.status = "waiting";
              active.parked.set(request.id, { request, resolve, reject });
              this.emit(held.id, active.runId, {
                type: "question",
                step: 0,
                id: request.id,
                text: request.question,
                kind: request.kind,
                options:
                  request.kind === "consent" && request.options.length === 0
                    ? CONSENT_OPTIONS
                    : request.options,
                draftId: request.draftId,
                ids: request.ids,
              });
            }),
        },
        onEvent: (event) => {
          const wire = this.toWire(event, flush);
          if (wire) {
            flush.now();
            this.emit(held.id, active.runId, wire);
          }
        },
      });
      flush.now();
      mine.conversation = run.messages;
      mine.plan = run.plan;
      // Let go of the run BEFORE saying it is finished. A listener that hears "finished" and asks to
      // start another is right to expect one, and anything cleared after an await is cleared too late.
      mine.active = null;
      this.emit(held.id, active.runId, {
        type: "run.finished",
        at: this.now(),
        reason: run.reason,
        steps: run.steps,
        toolCalls: run.toolCalls,
        failedCalls: run.failedCalls,
        usage: run.usage,
        text: run.text,
        error: run.error,
      });
      session.log.write("agent", "agent", {
        event: "finished",
        runId: active.runId,
        reason: run.reason,
        steps: run.steps,
        tools: run.toolCalls,
        failed: run.failedCalls,
      });
      await this.persist(held.id, mine, active.runId);
    } catch (e) {
      flush.now();
      mine.active = null;
      this.emit(held.id, active.runId, {
        type: "run.finished",
        at: this.now(),
        reason: "provider-error",
        steps: 0,
        toolCalls: 0,
        failedCalls: 0,
        usage: { promptTokens: 0, completionTokens: 0 },
        text: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * The runner's event as a tab's event, or null for one a tab has no use for.
   *
   * This is where the two audiences part. The model already has the whole tool result in its
   * conversation; a card wants a line of text, what moved, and a picture if there was one.
   */
  private toWire(
    event: AgentEvent,
    flush: { text(step: number, text: string): void; reasoning(step: number, text: string): void },
  ): AgentWireEvent | null {
    switch (event.type) {
      case "step.started":
        return { type: "step.started", step: event.step, at: event.at };
      case "text.delta":
        flush.text(event.step, event.text);
        return null;
      case "reasoning.delta":
        flush.reasoning(event.step, event.text);
        return null;
      case "reply":
        return event.text?.trim()
          ? { type: "message", step: event.step, at: event.at, text: event.text }
          : null;
      case "tool.started":
        // The loop's own tools are not cards. plan_work speaks through the plan card it updates and
        // ask_user through the question it asks; a "plan work" row beside them is the same thing said
        // twice, in worse words.
        if (LOOP_TOOL_NAMES.has(event.name)) return null;
        return {
          type: "tool.started",
          step: event.step,
          at: event.at,
          id: event.id,
          name: event.name,
          args: event.args,
          summary: summarise(event.name, event.args),
        };
      case "tool.finished": {
        if (LOOP_TOOL_NAMES.has(event.name)) return null;
        const envelope = event.result as {
          ok?: boolean;
          result?: unknown;
          error?: { code: string; message: string; hint: string | null };
          warnings?: string[];
          problems?: { severity: string }[];
          changed?: ChangeSet | null;
        };
        const problems = envelope.problems ?? [];
        return {
          type: "tool.finished",
          step: event.step,
          at: event.at,
          id: event.id,
          name: event.name,
          ok: event.ok,
          preview: preview(envelope),
          error: envelope.error ?? null,
          warnings: envelope.warnings ?? [],
          problems: {
            errors: problems.filter((p) => p.severity === "error").length,
            warnings: problems.filter((p) => p.severity !== "error").length,
          },
          changed: envelope.changed ?? null,
          durationMs: event.durationMs,
          ...(displayFor(envelope) ? { display: displayFor(envelope) as never } : {}),
        };
      }
      case "plan.updated":
        return { type: "plan.updated", step: event.step, items: event.items };
      case "reminder":
        return { type: "reminder", step: event.step, gate: event.gate, text: event.text };
      case "retry":
        return { type: "retry", step: event.step, error: event.error, waitMs: event.waitMs };
      case "warning":
        return { type: "warning", step: event.step, message: event.message };
      default:
        // question, question.answered and done are emitted where they are decided, so the status they
        // carry and the event stay in step.
        return null;
    }
  }

  /** Gathers deltas so a fast model does not put twenty frames a second on every socket. */
  private deltaFlusher(projectId: string, runId: string) {
    let text = "";
    let reasoning = "";
    let step = 0;
    let timer: NodeJS.Timeout | null = null;
    const send = () => {
      timer = null;
      if (text) {
        this.emit(projectId, runId, { type: "text.delta", step, text });
        text = "";
      }
      if (reasoning) {
        this.emit(projectId, runId, { type: "reasoning.delta", step, text: reasoning });
        reasoning = "";
      }
    };
    const arm = () => {
      if (!timer) timer = setTimeout(send, DELTA_MS).unref?.() ?? setTimeout(send, DELTA_MS);
    };
    return {
      text(atStep: number, delta: string) {
        step = atStep;
        text += delta;
        arm();
      },
      reasoning(atStep: number, delta: string) {
        step = atStep;
        reasoning += delta;
        arm();
      },
      now() {
        if (timer) clearTimeout(timer);
        send();
      },
    };
  }

  private emit(projectId: string, runId: string, event: AgentWireEvent): void {
    const mine = this.of(projectId);
    mine.seq += 1;
    const msg: AgentEventMsg = { type: "agent.event", projectId, runId, seq: mine.seq, event };
    // Deltas are not replayed: a reloaded tab wants the answer, not the typing that produced it.
    if (event.type !== "text.delta" && event.type !== "reasoning.delta") {
      mine.replay.push(msg);
      if (mine.replay.length > REPLAY_KEEP) mine.replay.splice(0, mine.replay.length - REPLAY_KEEP);
    }
    for (const listener of this.listeners)
      try {
        listener(projectId, msg);
      } catch {
        // a tab's problem is its own; it must not stop the run
      }
    void this.append(projectId, runId, msg);
  }

  private of(projectId: string): Held2 {
    const found = this.projects.get(projectId);
    if (found) return found;
    const made: Held2 = {
      conversation: [],
      plan: [],
      attachments: new Map(),
      replay: [],
      seq: 0,
      active: null,
      loaded: false,
    };
    this.projects.set(projectId, made);
    return made;
  }

  // ---- what is written down --------------------------------------------------

  private dirFor(projectId: string): string | null {
    if (!this.options.dataDir) return null;
    const dir = join(this.options.dataDir, "agents", projectId);
    try {
      mkdirSync(join(dir, "runs"), { recursive: true });
      return dir;
    } catch {
      return null;
    }
  }

  /** Old runs go, the newest kept, as the session log prunes its own (ADR-019 D1). */
  private async pruneRuns(dir: string): Promise<void> {
    try {
      const runs = (await readdir(join(dir, "runs"))).filter((f) => f.endsWith(".jsonl")).sort();
      for (const old of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS)))
        await rm(join(dir, "runs", old), { force: true });
    } catch {
      // a directory that cannot be read is not a reason to fail a finished run
    }
  }

  private async append(projectId: string, runId: string, msg: AgentEventMsg): Promise<void> {
    const dir = this.dirFor(projectId);
    if (!dir) return;
    try {
      await appendFile(join(dir, "runs", `${runId}.jsonl`), `${JSON.stringify(msg)}\n`, "utf8");
    } catch {
      // a run that cannot be written down is still a run
    }
  }

  private async persist(projectId: string, mine: Held2, runId: string): Promise<void> {
    const dir = this.dirFor(projectId);
    if (!dir) return;
    try {
      // Images are replaced by a note: a conversation file is for reading back a conversation, and
      // a megabyte of base64 per render would make it useless for that and slow to load.
      const text = mine.conversation
        .map((m) => JSON.stringify({ ...m, content: withoutImages(m.content) }))
        .join("\n");
      await writeFile(join(dir, "conversation.jsonl"), `${text}\n`, "utf8");
      await writeFile(join(dir, "plan.json"), `${JSON.stringify(mine.plan, null, 2)}\n`, "utf8");
      void runId;
      await this.pruneRuns(dir);
    } catch {
      // nothing here is worth failing a finished run over
    }
  }

  /** Read a project's conversation back, so a follow-up after a restart still knows what was built. */
  async load(projectId: string): Promise<void> {
    const mine = this.of(projectId);
    if (mine.loaded) return;
    mine.loaded = true;
    const dir = this.dirFor(projectId);
    if (!dir) return;
    try {
      const text = await readFile(join(dir, "conversation.jsonl"), "utf8");
      mine.conversation = text
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as ChatMessage);
    } catch {
      // no conversation yet, which is the usual case
    }
    try {
      mine.plan = JSON.parse(await readFile(join(dir, "plan.json"), "utf8")) as PlanItem[];
    } catch {
      mine.plan = [];
    }
  }
}

// ---- the small decisions, out of the class ---------------------------------

function withoutImages(content: ChatMessage["content"]): ChatMessage["content"] {
  if (!Array.isArray(content)) return content;
  return content.map((p) => (p.type === "image_url" ? { type: "text" as const, text: "[image]" } : p));
}

/**
 * What the model is asked, which is the person's words plus what only the host knows: what they
 * attached, and what they had selected when they asked.
 */
function taskOf(
  text: string,
  attached: { id: string; name: string; mime: string; bytes: number }[],
  selection: readonly string[],
  provider: Provider,
  mine: { attachments: Map<string, Attachment> },
): string | ContentPart[] {
  const lines = [text];
  if (attached.length)
    lines.push(
      `Attached: ${attached.map((a) => `${a.name} (attachment ${a.id})`).join(", ")}. ` +
        "Read a plan with import_plan and the attachment's id; never paste its bytes.",
    );
  if (selection.length) lines.push(`Selected in the editor: ${selection.join(", ")}.`);
  const said = lines.join("\n\n");
  // A model that can see is shown the picture as well as told about it; one that cannot works from
  // the reader's report, which is the separate model import_plan uses either way.
  if (!provider.profile.vision) return said;
  const images = attached
    .filter((a) => a.mime.startsWith("image/"))
    .flatMap((a) => {
      const bytes = mine.attachments.get(a.id);
      return bytes
        ? [
            {
              type: "image_url" as const,
              image_url: { url: `data:${a.mime};base64,${Buffer.from(bytes.bytes).toString("base64")}` },
            },
          ]
        : [];
    });
  return images.length ? [{ type: "text", text: said }, ...images] : said;
}

/** A line for the card while a tool runs: what it is doing, in words. */
export function summarise(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 1);
  switch (name) {
    case "create_walls":
      return `Drawing ${count(a.points)} points of wall`;
    case "add_level":
      return `Adding ${a.count ?? 1} storey${(a.count as number) > 1 ? "s" : ""}`;
    case "create_room":
    case "create_room_from_brief":
      return `Making a room${a.name ? ` called ${String(a.name)}` : ""}`;
    case "place_item":
      return `Placing ${String(a.productId ?? (a.recipe as { kind?: string })?.kind ?? "an item")}`;
    case "arrange":
      return `Arranging ${String(a.pattern ?? "items")}`;
    case "furnish_room":
      return "Furnishing the room";
    case "add_opening":
      return `Adding a ${String(a.kind ?? "opening")}`;
    case "finish_opening":
    case "finish_wall":
      return `Painting the ${String(a.part ?? a.face ?? "surface")}`;
    case "validate":
      return "Checking the drawing";
    case "render":
      return "Looking at it";
    case "import_plan":
      return a.confirm ? "Committing the plan" : "Reading the plan";
    case "get_scene":
      return "Reading the project";
    case "get_bom":
      return "Counting the bill of materials";
    case "batch":
      return `Applying ${count(a.commands)} commands`;
    default:
      return name.replace(/_/g, " ");
  }
}

/** A short, readable line from a tool envelope, with nothing large in it. */
function preview(envelope: { ok?: boolean; result?: unknown; error?: { message: string } }): string {
  if (envelope.ok === false) return envelope.error?.message ?? "refused";
  const text = JSON.stringify(envelope.result, (key, value) =>
    key === "pngBase64" || key === "dataUrl" ? "[image]" : value,
  );
  if (!text) return "";
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}…`;
}

/** The picture or the draft a card can show, when a result carries one. */
function displayFor(envelope: {
  result?: unknown;
}): { kind: "image"; dataUrl: string; caption: string } | { kind: "draft"; draftId: string } | null {
  const result = envelope.result as
    | { images?: { name?: string; pngBase64?: string }[]; draftId?: string; status?: string }
    | undefined;
  const first = result?.images?.find((i) => typeof i.pngBase64 === "string" && i.pngBase64);
  if (first?.pngBase64)
    return {
      kind: "image",
      dataUrl: `data:image/png;base64,${first.pngBase64}`,
      caption: first.name ?? "render",
    };
  if (result?.draftId && result.status === "review") return { kind: "draft", draftId: result.draftId };
  return null;
}

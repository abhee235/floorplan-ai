// The agent runner (ADR-007 D3): one conversation loop over any Provider, with the tool registry's calls run
// in-process by the caller. A step is one model turn. Tool calls run in order; a malformed call becomes an error
// result the model can correct, never an exception. Every request, reply, retry and tool call is emitted as an
// event, so the host can write a transcript and a viewer can follow along.
import {
  type Budget,
  type CompactionOptions,
  compact,
  conversationBudget,
  conversationTokens,
  estimateTokens,
  needsCompaction,
  outputRoom,
} from "./compact.js";
import { afterGate, afterLoopTool, afterTool, type GateState, gateFor, newGateState } from "./gates.js";
import { extractJson, stripThinking } from "./json.js";
import {
  ASK_USER,
  ASK_USER_SPEC,
  type AskRequest,
  answerText,
  applyPlan,
  CONSENT_NO,
  CONSENT_NONE,
  describePlan,
  LOOP_TOOL_NAMES,
  PLAN_WORK,
  PLAN_WORK_SPEC,
  type PlanItem,
  parseAsk,
  planForPrompt,
} from "./loop-tools.js";
import {
  type ChatMessage,
  type Completion,
  type ContentPart,
  type Provider,
  ProviderError,
  type ToolCall,
  type ToolSpec,
  type Usage,
} from "./provider.js";

export type StopReason = "done" | "step-budget" | "provider-error" | "stalled" | "aborted" | "context-full";

export type AgentEvent =
  | { type: "step.started"; step: number; at: string; messages: number; tools: number }
  /** A piece of the answer, as the model writes it; only when the provider streams. */
  | { type: "text.delta"; step: number; at: string; text: string }
  /** A piece of the reasoning a server chooses to show; never fed back as an answer. */
  | { type: "reasoning.delta"; step: number; at: string; text: string }
  | {
      type: "reply";
      step: number;
      at: string;
      text: string | null;
      toolCalls: ToolCall[];
      /** True when the calls were read from the reply text rather than the tool-call field. */
      fromText: boolean;
      finishReason: string | null;
      usage: Usage;
      durationMs: number;
      attempts: number;
    }
  | { type: "retry"; step: number; at: string; error: string; waitMs: number }
  | { type: "warning"; step: number; at: string; message: string }
  /** A tool is about to run. The pair exists so a card can be drawn while the work happens. */
  | { type: "tool.started"; step: number; at: string; id: string; name: string; args: unknown }
  | {
      type: "tool.finished";
      step: number;
      at: string;
      id: string;
      name: string;
      args: unknown;
      ok: boolean;
      result: unknown;
      durationMs: number;
    }
  /** The model rewrote its plan, and this is the plan now. */
  | { type: "plan.updated"; step: number; at: string; items: PlanItem[] }
  /** The model asked the person something; the loop waits here until `ask` answers. */
  | { type: "question"; step: number; at: string; request: AskRequest }
  | { type: "question.answered"; step: number; at: string; id: string; answers: Record<string, string> }
  /** A gate spoke: the model was told why the run is not over. Never shown as the model's own words. */
  | { type: "reminder"; step: number; at: string; gate: "plan" | "verify" | "idle"; text: string }
  /** The conversation was made smaller to fit; the chat says so rather than letting it shift silently. */
  | {
      type: "compacted";
      step: number;
      at: string;
      before: number;
      after: number;
      dropped: Record<string, number>;
    }
  | {
      type: "done";
      at: string;
      reason: StopReason;
      steps: number;
      toolCalls: number;
      failedCalls: number;
      usage: Usage;
      text: string | null;
      error: string | null;
    };

export interface AgentOptions {
  provider: Provider;
  /** Tools advertised to the model; calls to other names still reach `callTool`, which rejects them. */
  tools: readonly ToolSpec[];
  /**
   * Runs one call and returns its envelope; expected not to throw (the registry never does).
   *
   * `released` is the set of entity ids the person has allowed this run to change although they
   * made or touched them (ADR-023 D3). The loop keeps it and grows it as consent is given; the
   * registry is what enforces it.
   */
  callTool(name: string, args: unknown, released: ReadonlySet<string>): Promise<unknown>;
  system: string;
  /** What to do. Image parts carry an attached plan to a model that can see one. */
  task: string | ContentPart[];
  /**
   * Earlier turns of the same conversation, so a follow-up ("now add chairs") knows what "the table"
   * means. The task is appended to these; the run returns the whole conversation for the next one.
   */
  history?: readonly ChatMessage[];
  /** Model turns before the run stops (default 40, the PRD P1-7 bound). */
  maxSteps?: number;
  /** Tool result text longer than this is cut, with a note telling the model to narrow the call. */
  maxResultChars?: number;
  /** Retries for transient provider failures: network errors, 429 and 5xx (default 2). */
  retries?: number;
  retryDelayMs?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** The plan this run starts with, and how a question reaches a person. */
  loop?: {
    plan?: readonly PlanItem[];
    /** Resolves when the person answers; rejects when the run is abandoned. */
    ask?(request: AskRequest): Promise<Record<string, string>>;
  };
  /**
   * How the conversation is kept inside the window (ADR-025).
   *
   * On by default. A caller that wants the old behaviour -- send everything and let the server cut
   * the front off -- has to ask for it, because that behaviour loses the system prompt first.
   */
  compaction?: CompactionOptions & { enabled?: boolean; reserve?: number };
  /** Which gates may speak; all three do unless a caller says otherwise. */
  gates?: { plan?: boolean; verify?: boolean; idle?: boolean };
  /**
   * Entities this run may change from the start, whoever made them: what the person had selected
   * when they asked. Selecting a thing and saying "turn this round" is consent (ADR-023 D3).
   */
  released?: Iterable<string>;
  /** Tool names that change the project, and the ones that check it, for the verify gate. */
  mutatingTools?: ReadonlySet<string>;
  verifyingTools?: ReadonlySet<string>;
  /**
   * Whether a render's images are put in front of a model that can see them. The picture is the only
   * way a model judges what it drew; without this it reads a description of its own work.
   */
  images?: { liftRenders?: boolean; maxPerTurn?: number };
  onEvent?(event: AgentEvent): void;
  now?(): string;
  sleep?(ms: number): Promise<void>;
}

export interface AgentRun {
  reason: StopReason;
  /** The model's final answer, reasoning blocks removed; null unless the run finished. */
  text: string | null;
  steps: number;
  toolCalls: number;
  failedCalls: number;
  usage: Usage;
  error: string | null;
  events: AgentEvent[];
  messages: ChatMessage[];
  /** The plan as the run left it, for the next turn of the same conversation. */
  plan: PlanItem[];
}

export const DEFAULT_MAX_STEPS = 40;
export const DEFAULT_MAX_RESULT_CHARS = 16_000;
/** The same failing call this many times in a row ends the run. */
const STALL_REPEATS = 3;
/** This many tool calls in a row made of at most two distinct calls is a loop, and ends the run. */
const LOOP_WINDOW = 8;

type Parsed = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/** Tool arguments as an object: empty means {}, fenced or wrapped JSON is recovered. */
export function parseToolArguments(raw: string): Parsed {
  const text = raw.trim();
  if (text === "") return { ok: true, value: {} };
  const asObject = (v: unknown): Parsed =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? { ok: true, value: v as Record<string, unknown> }
      : { ok: false, error: "the arguments are not an object" };
  try {
    return asObject(JSON.parse(text));
  } catch {
    try {
      return asObject(extractJson(text));
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/**
 * Tool calls some local models write into the reply text instead of the tool-call field:
 * `<tool_call>{"name": ..., "arguments": {...}}</tool_call>` blocks, or a reply that is only such an object.
 * Only names in `known` count, so ordinary JSON in an answer is left alone.
 */
export function toolCallsInText(
  text: string,
  known: ReadonlySet<string>,
  idPrefix = "text_call",
): { calls: ToolCall[]; rest: string } {
  const calls: ToolCall[] = [];
  const take = (json: string): boolean => {
    try {
      const v = JSON.parse(json) as { name?: unknown; arguments?: unknown; parameters?: unknown };
      if (typeof v.name !== "string" || !known.has(v.name)) return false;
      const args = v.arguments ?? v.parameters ?? {};
      calls.push({
        id: `${idPrefix}_${calls.length}`,
        name: v.name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      });
      return true;
    } catch {
      return false;
    }
  };
  const clean = stripThinking(text);
  const rest = clean.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (whole, json: string) =>
    take(json) ? "" : whole,
  );
  if (calls.length === 0) {
    const trimmed = clean.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}") && take(trimmed)) return { calls, rest: "" };
  }
  return { calls, rest: rest.trim() };
}

/** A tool envelope as message text: image data removed, long text cut with a note. */
export function toolResultText(result: unknown, maxChars = DEFAULT_MAX_RESULT_CHARS): string {
  const text = JSON.stringify(result, (key, value) =>
    key === "pngBase64" && typeof value === "string"
      ? `[image omitted: ${Math.round((value.length * 3) / 4)} bytes]`
      : value,
  );
  if (text === undefined) return "null";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)} ... [cut: ${text.length - maxChars} more characters; narrow the call]`;
}

const isOk = (result: unknown) =>
  typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === true;

/**
 * One streamed reply, gathered into the same Completion a whole answer gives.
 *
 * The pieces go out as they arrive and the assembled reply is what the loop works from, so nothing
 * downstream has to know whether this provider streams. A server sends the finish and the usage in
 * separate chunks, so both are kept as they come rather than the last one winning.
 */
/** The images in a tool result, as data URLs a model can be shown. */
function imagesIn(result: unknown): string[] {
  const images = (result as { result?: { images?: unknown } } | null)?.result?.images;
  if (!Array.isArray(images)) return [];
  return images.flatMap((i) => {
    const png = (i as { pngBase64?: unknown }).pngBase64;
    return typeof png === "string" && png ? [`data:image/png;base64,${png}`] : [];
  });
}

/**
 * Put a render in front of a model that can see, and take the last one away.
 *
 * A picture is the only way a model judges what it drew; without this it reads a description of its
 * own work and agrees with itself. Only the newest render stays: four images a turn would fill a
 * context window in ten turns, and an old picture of a room that has since changed is worse than no
 * picture at all.
 */
function liftImages(messages: ChatMessage[], result: unknown, max: number): void {
  const urls = imagesIn(result).slice(0, max);
  if (urls.length === 0) return;
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    if (!m.content.some((p) => p.type === "image_url")) continue;
    m.content = [{ type: "text", text: "[an earlier render, taken away to save room]" }];
  }
  messages.push({
    role: "user",
    content: [
      { type: "text", text: "This is what the editor draws now. Look at it, and say what is wrong." },
      ...urls.map((url) => ({ type: "image_url" as const, image_url: { url } })),
    ],
  });
}

async function streamed(
  provider: Provider,
  request: Parameters<Provider["complete"]>[0],
  onDelta: (event: { type: "text.delta" | "reasoning.delta"; text: string }) => void,
): Promise<Completion> {
  const stream = provider.stream?.(request);
  if (!stream) throw new ProviderError(provider.id, null, "this provider does not stream");
  let text = "";
  const parts = new Map<number, { id?: string; name?: string; arguments: string }>();
  let finishReason: string | null = null;
  const usage: Usage = { promptTokens: 0, completionTokens: 0 };
  for await (const event of stream) {
    if (event.type === "text") {
      text += event.delta;
      onDelta({ type: "text.delta", text: event.delta });
    } else if (event.type === "reasoning") {
      onDelta({ type: "reasoning.delta", text: event.delta });
    } else if (event.type === "tool_call") {
      const at = parts.get(event.index) ?? { arguments: "" };
      if (event.id) at.id = event.id;
      if (event.name) at.name = event.name;
      at.arguments += event.argumentsDelta;
      parts.set(event.index, at);
    } else {
      if (event.finishReason) finishReason = event.finishReason;
      if (event.usage) {
        usage.promptTokens += event.usage.promptTokens;
        usage.completionTokens += event.usage.completionTokens;
      }
    }
  }
  const toolCalls: ToolCall[] = [...parts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([i, c]) => ({ id: c.id ?? `call_${i}`, name: c.name ?? "", arguments: c.arguments || "{}" }));
  return { text: text || null, toolCalls, finishReason, usage, raw: null };
}

export async function runAgent(options: AgentOptions): Promise<AgentRun> {
  const now = options.now ?? (() => new Date().toISOString());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const retries = options.retries ?? 2;
  // The loop's own two tools ride alongside whatever the registry advertises, unless a caller has
  // already supplied them (the eval harness scripts its own conversations).
  const given = new Set(options.tools.map((t) => t.name));
  const tools: ToolSpec[] = [
    ...options.tools,
    ...(given.has(PLAN_WORK) ? [] : [PLAN_WORK_SPEC]),
    ...(options.loop?.ask && !given.has(ASK_USER) ? [ASK_USER_SPEC] : []),
  ];
  const known = new Set(tools.map((t) => t.name));
  const events: AgentEvent[] = [];
  const messages: ChatMessage[] = [...(options.history ?? []), { role: "user", content: options.task }];
  const usage: Usage = { promptTokens: 0, completionTokens: 0 };
  let plan: PlanItem[] = [...(options.loop?.plan ?? [])];
  const released = new Set<string>(options.released ?? []);
  let gates: GateState = newGateState();
  const mutating = options.mutatingTools ?? new Set<string>();
  const verifying = options.verifyingTools ?? new Set<string>();
  const liftRenders = options.images?.liftRenders !== false && options.provider.profile.vision;
  const maxImages = options.images?.maxPerTurn ?? 4;
  // What every prompt costs before a word of conversation: the system prompt and the tool schemas,
  // re-sent on every step. Measured at 48% of a 32,768-token window, which is why the floor
  // compaction can reach is an absolute number and not a share (ADR-025).
  const budget: Budget = {
    contextTokens: options.provider.profile.contextTokens,
    fixedTokens:
      estimateTokens(options.system) +
      estimateTokens(JSON.stringify(tools)) +
      estimateTokens(planForPrompt(plan)),
    ...(options.compaction?.reserve !== undefined ? { reserve: options.compaction.reserve } : {}),
  };
  const compaction = options.compaction?.enabled === false ? null : (options.compaction ?? {});
  // What one more step is likely to add, so the question is about the prompt about to be sent
  // rather than the one that already was. Seeded from the measured median and then learnt.
  let growth = 545;
  let lastConversation = 0;
  let steps = 0;
  let toolCalls = 0;
  let failedCalls = 0;
  const failures = new Map<string, number>();
  const recent: string[] = [];
  let lastPromptTokens = 0;
  let warnedTruncation = false;
  let warnedCramped = false;
  let stall: string | null = null;
  // The person said "leave all my work alone": every later consent question is answered for them.
  let consentWithheld = false;

  const emit = (event: AgentEvent) => {
    events.push(event);
    options.onEvent?.(event);
  };
  const finish = (reason: StopReason, text: string | null = null, error: string | null = null): AgentRun => {
    emit({
      type: "done",
      at: now(),
      reason,
      steps,
      toolCalls,
      failedCalls,
      usage: { ...usage },
      text,
      error,
    });
    return {
      reason,
      text,
      steps,
      toolCalls,
      failedCalls,
      usage: { ...usage },
      error,
      events,
      messages,
      plan,
    };
  };

  while (steps < maxSteps) {
    if (options.signal?.aborted) return finish("aborted");
    // A window that cannot hold the prompt is not a compaction problem: none of what overflows it
    // is conversation, so there is nothing to remove and no amount of cleverness helps. Said once,
    // before anything is sent, with the numbers (ADR-025 D8).
    if (steps === 0 && conversationBudget(budget) <= 0)
      return finish(
        "context-full",
        null,
        `${options.provider.model} has a ${budget.contextTokens}-token context, and the instructions and tool schemas alone are about ${budget.fixedTokens}. Give it a larger context, or use a model with one.`,
      );
    steps += 1;
    // As late as is safe and no earlier: a conversation that fits is never touched, because
    // rewriting it breaks the server's cached prefix and everything after the first changed message
    // is prefilled again (ADR-025 D2a).
    if (compaction && needsCompaction(messages, budget, growth)) {
      const result = compact(messages, budget, { ...compaction, growthPerStep: growth });
      // Only when something actually moved. The trigger above asks about the step that has not
      // happened yet, so it fires a little before the conversation is over the line and there is
      // genuinely nothing to remove; saying "compacted" then would be a lie in the chat.
      if (result.compacted) {
        messages.splice(0, messages.length, ...result.messages);
        emit({
          type: "compacted",
          step: steps,
          at: now(),
          before: result.before,
          after: result.after,
          dropped: result.dropped,
        });
      }
      // Compaction that has to run again almost immediately is the failure mode this was designed
      // against: each one breaks the cached prefix and is paid for in prefill. When it can no
      // longer buy a few steps, the window is too small for the work rather than the conversation
      // being too big, and saying so once is more use than saying it every step.
      if (result.compacted && !warnedCramped) {
        const stepsBought = (conversationBudget(budget) - result.after) / Math.max(1, growth);
        if (stepsBought < 3) {
          warnedCramped = true;
          emit({
            type: "warning",
            step: steps,
            at: now(),
            message: `there is only room for ${stepsBought.toFixed(1)} more steps after compacting, so this will compact again almost every step and each one costs time; ${options.provider.model} needs a larger context for work this size`,
          });
        }
      }
      if (result.overflows)
        return finish(
          "context-full",
          null,
          `the conversation will not fit in ${budget.contextTokens} tokens even with everything droppable dropped; start a new chat, or give the model a larger context`,
        );
    }
    emit({ type: "step.started", step: steps, at: now(), messages: messages.length, tools: tools.length });
    const started = Date.now();
    let completion: Completion | null = null;
    let attempts = 0;
    while (!completion) {
      attempts += 1;
      const request = {
        // The plan rides on the system prompt rather than in the conversation, so it survives
        // whatever is later done to the conversation to make it fit.
        system: `${options.system}${planForPrompt(plan)}`,
        messages,
        tools,
        temperature: 0,
        // A configured cap is a ceiling, never a promise of room: a model allowed eight thousand
        // tokens cannot have them in a window with three thousand left.
        ...(() => {
          const room = outputRoom(
            budget,
            budget.fixedTokens + conversationTokens(messages),
            options.maxTokens,
          );
          return room > 0 ? { maxTokens: room } : {};
        })(),
        ...(options.signal ? { signal: options.signal } : {}),
      };
      try {
        completion =
          options.provider.stream && options.provider.profile.streaming !== false
            ? await streamed(options.provider, request, (event) => emit({ ...event, step: steps, at: now() }))
            : await options.provider.complete(request);
      } catch (e) {
        if (options.signal?.aborted) return finish("aborted");
        const message = e instanceof Error ? e.message : String(e);
        const transient =
          e instanceof ProviderError && (e.status === null || e.status === 429 || e.status >= 500);
        if (!transient || attempts > retries) return finish("provider-error", null, message);
        const waitMs = (options.retryDelayMs ?? 1000) * 2 ** (attempts - 1);
        emit({ type: "retry", step: steps, at: now(), error: message, waitMs });
        await sleep(waitMs);
      }
    }
    // a server that cuts the prompt to its context length reports the same prompt size while the conversation grows
    const promptTokens = completion.usage.promptTokens;
    if (!warnedTruncation && steps > 1 && promptTokens > 0 && promptTokens === lastPromptTokens) {
      warnedTruncation = true;
      emit({
        type: "warning",
        step: steps,
        at: now(),
        message: `the prompt stayed at ${promptTokens} tokens while the conversation grew; the server is probably cutting it to its context length (for Ollama, start the server with OLLAMA_CONTEXT_LENGTH=32768 or more)`,
      });
    }
    lastPromptTokens = promptTokens;
    // What a step actually costs here, rather than what it cost on the machine this was measured on.
    const nowConversation = conversationTokens(messages);
    if (lastConversation > 0) growth = Math.max(growth, nowConversation - lastConversation);
    lastConversation = nowConversation;
    usage.promptTokens += completion.usage.promptTokens;
    usage.completionTokens += completion.usage.completionTokens;

    let calls = completion.toolCalls.filter((c) => c.name);
    let content = completion.text;
    let fromText = false;
    if (calls.length === 0 && content) {
      const found = toolCallsInText(content, known, `text_call_${steps}`);
      if (found.calls.length > 0) {
        calls = found.calls;
        content = found.rest || null;
        fromText = true;
      }
    }
    emit({
      type: "reply",
      step: steps,
      at: now(),
      text: content,
      toolCalls: calls,
      fromText,
      finishReason: completion.finishReason,
      usage: completion.usage,
      durationMs: Date.now() - started,
      attempts,
    });
    messages.push({
      role: "assistant",
      content: content && content.trim() ? content : null,
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
    });
    if (calls.length === 0) {
      // The model thinks it is finished. A gate may disagree, in which case it says why and the run
      // carries on; each one is bounded, so a model that means it is believed.
      const gate = gateFor(gates, plan, options.gates ?? {});
      if (gate) {
        gates = afterGate(gates, gate.gate);
        emit({ type: "reminder", step: steps, at: now(), gate: gate.gate, text: gate.text });
        messages.push({ role: "user", content: gate.text });
        continue;
      }
      return finish("done", stripThinking(content ?? "").trim() || null);
    }

    for (const call of calls) {
      toolCalls += 1;
      const callStarted = Date.now();
      const parsed = parseToolArguments(call.arguments);
      const args: unknown = parsed.ok ? parsed.value : call.arguments;
      emit({ type: "tool.started", step: steps, at: now(), id: call.id, name: call.name, args });
      let result: unknown;
      if (!parsed.ok) {
        result = {
          ok: false,
          error: {
            code: "args.json",
            message: `${call.name}: ${parsed.error}`,
            entityId: null,
            hint: 'send the arguments as one JSON object, e.g. {"detail": "summary"}',
          },
          warnings: [],
        };
      } else if (call.name === PLAN_WORK) {
        // The plan is the loop's own, so it is kept here and never reaches the project.
        const applied = applyPlan(plan, parsed.value);
        if (applied.ok) {
          plan = applied.items;
          emit({ type: "plan.updated", step: steps, at: now(), items: plan });
          result = { ok: true, result: { plan: plan.length, summary: applied.summary }, warnings: [] };
        } else {
          result = {
            ok: false,
            error: { code: "plan.invalid", message: applied.error, entityId: null, hint: applied.hint },
            warnings: [],
          };
        }
      } else if (call.name === ASK_USER && options.loop?.ask) {
        const asked = parseAsk(parsed.value, call.id);
        if (asked.ok && asked.request.kind === "consent" && consentWithheld) {
          // They have already said to leave their work alone. Asking again is the second question,
          // and the second question is what makes a person stop reading them.
          result = {
            ok: true,
            result: { answered: answerText(asked.request, { [asked.request.id]: CONSENT_NONE }) },
            warnings: [],
          };
        } else if (!asked.ok) {
          result = {
            ok: false,
            error: { code: "ask.invalid", message: asked.error, entityId: null, hint: asked.hint },
            warnings: [],
          };
        } else {
          emit({ type: "question", step: steps, at: now(), request: asked.request });
          try {
            // The loop stops here until a person answers. An abandoned run rejects this, which ends
            // the run rather than leaving it waiting for someone who has gone.
            const answers = await options.loop.ask(asked.request);
            emit({ type: "question.answered", step: steps, at: now(), id: call.id, answers });
            if (asked.request.kind === "consent") {
              const said = answers[asked.request.id] ?? answers.answer ?? Object.values(answers)[0] ?? "";
              // "none" answers every later question too: being asked twice is what stops a person reading.
              if (said === CONSENT_NONE) consentWithheld = true;
              else if (said !== CONSENT_NO) for (const id of asked.request.ids) released.add(id);
            }
            result = { ok: true, result: { answered: answerText(asked.request, answers) }, warnings: [] };
          } catch (e) {
            if (options.signal?.aborted) return finish("aborted");
            result = {
              ok: false,
              error: {
                code: "ask.unanswered",
                message: e instanceof Error ? e.message : String(e),
                entityId: null,
                hint: "decide for yourself and say what you assumed",
              },
              warnings: [],
            };
          }
        }
      } else {
        result = await options.callTool(call.name, parsed.value, released);
      }
      const ok = isOk(result);
      if (!ok) failedCalls += 1;
      gates = LOOP_TOOL_NAMES.has(call.name)
        ? afterLoopTool(gates)
        : afterTool(gates, call.name, ok, { mutating, verifying });
      emit({
        type: "tool.finished",
        step: steps,
        at: now(),
        id: call.id,
        name: call.name,
        args,
        ok,
        result,
        durationMs: Date.now() - callStarted,
      });
      messages.push({ role: "tool", toolCallId: call.id, content: toolResultText(result, maxChars) });
      if (liftRenders && ok) liftImages(messages, result, maxImages);
      const key = `${call.name}:${call.arguments}`;
      recent.push(key);
      if (!ok) {
        const count = (failures.get(key) ?? 0) + 1;
        failures.set(key, count);
        if (count >= STALL_REPEATS)
          stall = `the same failing call (${call.name}) was made ${STALL_REPEATS} times`;
      }
    }
    const window = recent.slice(-LOOP_WINDOW);
    const distinct = new Set(window).size;
    if (!stall && window.length === LOOP_WINDOW && distinct <= 2)
      stall = `the last ${LOOP_WINDOW} tool calls repeat the same ${distinct === 1 ? "call" : "two calls"}`;
    if (stall) return finish("stalled", null, stall);
    if (maxSteps - steps === 3)
      messages.push({
        role: "user",
        content:
          "Three model turns remain in the step budget. Finish the task now and reply with a short summary.",
      });
  }
  return finish("step-budget");
}

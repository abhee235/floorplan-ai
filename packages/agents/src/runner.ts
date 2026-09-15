// The agent runner (ADR-007 D3): one conversation loop over any Provider, with the tool registry's calls run
// in-process by the caller. A step is one model turn. Tool calls run in order; a malformed call becomes an error
// result the model can correct, never an exception. Every request, reply, retry and tool call is emitted as an
// event, so the host can write a transcript and a viewer can follow along.
import { extractJson, stripThinking } from "./json.js";
import {
  type ChatMessage,
  type Completion,
  type Provider,
  ProviderError,
  type ToolCall,
  type ToolSpec,
  type Usage,
} from "./provider.js";

export type StopReason = "done" | "step-budget" | "provider-error" | "stalled" | "aborted";

export type AgentEvent =
  | { type: "request"; step: number; at: string; messages: number; tools: number }
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
  | {
      type: "tool";
      step: number;
      at: string;
      id: string;
      name: string;
      args: unknown;
      ok: boolean;
      result: unknown;
      durationMs: number;
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
  /** Runs one call and returns its envelope; expected not to throw (the registry never does). */
  callTool(name: string, args: unknown): Promise<unknown>;
  system: string;
  task: string;
  /** Model turns before the run stops (default 40, the PRD P1-7 bound). */
  maxSteps?: number;
  /** Tool result text longer than this is cut, with a note telling the model to narrow the call. */
  maxResultChars?: number;
  /** Retries for transient provider failures: network errors, 429 and 5xx (default 2). */
  retries?: number;
  retryDelayMs?: number;
  maxTokens?: number;
  signal?: AbortSignal;
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

export async function runAgent(options: AgentOptions): Promise<AgentRun> {
  const now = options.now ?? (() => new Date().toISOString());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const retries = options.retries ?? 2;
  const known = new Set(options.tools.map((t) => t.name));
  const events: AgentEvent[] = [];
  const messages: ChatMessage[] = [{ role: "user", content: options.task }];
  const usage: Usage = { promptTokens: 0, completionTokens: 0 };
  let steps = 0;
  let toolCalls = 0;
  let failedCalls = 0;
  const failures = new Map<string, number>();
  const recent: string[] = [];
  let lastPromptTokens = 0;
  let warnedTruncation = false;
  let stall: string | null = null;

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
    return { reason, text, steps, toolCalls, failedCalls, usage: { ...usage }, error, events, messages };
  };

  while (steps < maxSteps) {
    if (options.signal?.aborted) return finish("aborted");
    steps += 1;
    emit({ type: "request", step: steps, at: now(), messages: messages.length, tools: options.tools.length });
    const started = Date.now();
    let completion: Completion | null = null;
    let attempts = 0;
    while (!completion) {
      attempts += 1;
      try {
        completion = await options.provider.complete({
          system: options.system,
          messages,
          tools: options.tools as ToolSpec[],
          temperature: 0,
          ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
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
    if (calls.length === 0) return finish("done", stripThinking(content ?? "").trim() || null);

    for (const call of calls) {
      toolCalls += 1;
      const callStarted = Date.now();
      const parsed = parseToolArguments(call.arguments);
      const args: unknown = parsed.ok ? parsed.value : call.arguments;
      const result = parsed.ok
        ? await options.callTool(call.name, parsed.value)
        : {
            ok: false,
            error: {
              code: "args.json",
              message: `${call.name}: ${parsed.error}`,
              entityId: null,
              hint: 'send the arguments as one JSON object, e.g. {"detail": "summary"}',
            },
            warnings: [],
          };
      const ok = isOk(result);
      if (!ok) failedCalls += 1;
      emit({
        type: "tool",
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

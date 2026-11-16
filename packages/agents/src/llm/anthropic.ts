// Claude, through Anthropic's own Messages API and SDK (ADR-029 D2, D3).
//
// Of the four wires this is the one our conversation is modelled on, so the translation is mostly
// renaming. What is left is the API's own rules:
//
// - The results of one turn go back in one user message, results first; a lifted picture follows
//   them in the same message. Our conversation keeps one result per message (messages.ts), so runs
//   of user messages are merged here.
// - Thinking comes back sealed: each block's signature binds it to the model and to the conversation
//   before it, and it goes back unchanged. The loop edits that conversation on purpose -- the plan and
//   the notes ride on the system prompt, an older picture is taken away when a newer one arrives, and
//   compaction rewrites old turns -- so the API is asked to drop a block that no longer matches
//   rather than refuse the request (`prefix_mismatch_behavior: drop_block`). Removing older thinking
//   from the front, as the loop also does (ADR-031 D2.6), is a change the API accepts.
// - Current models set their depth with an effort and think adaptively; thinking cannot be switched
//   off, a temperature is refused, and so is a token budget. Models from before 4.6 take a budget.
// - The prompt cache is asked for in three places: after the tools and after the system prompt, both
//   for an hour, so the next run of the same role starts warm; and at the end of the request, the
//   moving mark each step reads the conversation back from.
// - A model whose safety check declines a request that is fine hands it to another Claude model on
//   Anthropic's side (`fallbacks: "default"`); what the first one thought and called is not kept.
//
// The stream is read event by event rather than through the SDK's final-message helper, because the
// loop wants a call's arguments as the text the model wrote: its own repair ladder handles text that
// is not quite JSON, where the helper would throw. The calls are handed over once the stop reason
// says they are whole: a call cut off by the output cap, or in a reply that was declined, never runs.

import Anthropic from "@anthropic-ai/sdk";
import { type Block, dataUrl, type Message, pairedCalls, type ReasoningBlock } from "./messages.js";
import {
  type Completion,
  type CompletionRequest,
  DEFAULT_PROFILE,
  extraBodyOf,
  type FetchFn,
  type Provider,
  type ProviderConfig,
  ProviderError,
  type ReasoningEffort,
  reasoningOf,
  requestSignal,
  type ToolCall,
  type ToolSpec,
  type Usage,
} from "./provider.js";
import type { StreamEvent } from "./sse.js";

/** The name reasoning blocks from this wire carry, so only this wire is sent them back. */
export const ANTHROPIC_WIRE = "anthropic";
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** The most a current Claude model writes in one reply. */
const OUTPUT_MAX = 128_000;
/** The answer's share of a reply when nothing sets one: generous, because a cut-off design is a wasted turn. */
const DEFAULT_ANSWER = 32_000;
/** Room for the thinking on top of the answer's cap, by effort; unset is the model's own default. */
const THINKING_ROOM: Record<ReasoningEffort | "default", number> = {
  none: 4_096,
  low: 8_192,
  medium: 16_384,
  high: 32_768,
  default: 16_384,
};
/** The budget a model from before adaptive thinking is given, by effort. */
const THINKING_BUDGET: Record<Exclude<ReasoningEffort, "none">, number> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
};
const BINDING_BETA = "thinking-binding-controls-2026-08-01";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const INTERLEAVED_BETA = "interleaved-thinking-2025-05-14";
/** Tools and the system prompt are the same for every run of a role, so they are kept for an hour. */
const CACHE_HOUR = { type: "ephemeral", ttl: "1h" } as const;
/** An in-stream error carries no status; its type says which one it would have been, so it is retried. */
const STATUS_OF_TYPE: Record<string, number> = {
  overloaded_error: 529,
  api_error: 500,
  rate_limit_error: 429,
  timeout_error: 504,
};

type Param = Anthropic.Beta.Messages.BetaMessageParam;
type ContentParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type WireTool = Anthropic.Beta.Messages.BetaTool;
type WireEvent = Anthropic.Beta.Messages.BetaRawMessageStreamEvent;
type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** A Claude model id's generation (`claude-opus-5-5` is 5.5, `claude-haiku-4-5` is 4.5), or undefined. */
export function claudeVersion(model: string): { major: number; minor: number } | undefined {
  const m = /claude-[a-z]+-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(model);
  return m ? { major: Number(m[1]), minor: Number(m[2] ?? 0) } : undefined;
}

/** Claude 4.6 and later think adaptively, steered by effort; the older ones take a token budget, or none. */
export function thinksAdaptively(model: string): boolean {
  const v = claudeVersion(model);
  return !!v && (v.major > 4 || (v.major === 4 && v.minor >= 6));
}

/** The models whose safety checks can decline a request that is fine, and which another model can finish. */
const FALLS_BACK = /^claude-(?:fable-5-[12]|opus-5-5|opus-5|sonnet-5-5)$/;

function imageParam(url: string): ContentParam | undefined {
  const d = dataUrl(url);
  if (d) {
    const mime = d.mime === "image/jpg" ? "image/jpeg" : d.mime;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) return undefined;
    return { type: "image", source: { type: "base64", media_type: mime as ImageType, data: d.base64 } };
  }
  return /^https?:\/\//.test(url) ? { type: "image", source: { type: "url", url } } : undefined;
}

/** A call's arguments as the object this wire wants; history that will not parse goes as an empty object. */
function inputOf(args: string): Record<string, unknown> {
  try {
    const v = JSON.parse(args);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A kept reasoning block as it goes back: Claude's own, and only with its seal. */
function sealedBlock(b: Block & { type: "reasoning" }): ContentParam | undefined {
  if (b.wire !== ANTHROPIC_WIRE) return undefined;
  const d = b.data as { type?: unknown; signature?: unknown; data?: unknown } | null;
  if (d?.type === "thinking" && typeof d.signature === "string" && d.signature) return d as ContentParam;
  if (d?.type === "redacted_thinking" && typeof d.data === "string") return d as ContentParam;
  return undefined;
}

/** Our conversation as Claude messages. Exported for the wire-parity tests. */
export function toClaudeMessages(messages: readonly Message[]): Param[] {
  const out: Param[] = [];
  const push = (role: "user" | "assistant", blocks: ContentParam[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) {
      last.content.push(...blocks);
      return;
    }
    out.push({ role, content: [...blocks] });
  };
  for (const m of pairedCalls(messages)) {
    const blocks: Block[] =
      typeof m.content === "string" ? (m.content ? [{ type: "text", text: m.content }] : []) : m.content;
    const params: ContentParam[] = [];
    for (const b of blocks) {
      if (b.type === "text") {
        if (b.text.trim()) params.push({ type: "text", text: b.text });
      } else if (b.type === "image") {
        const image = imageParam(b.url);
        if (image) params.push(image);
      } else if (b.type === "tool_use")
        params.push({ type: "tool_use", id: b.id, name: b.name, input: inputOf(b.arguments) });
      else if (b.type === "tool_result")
        params.push({
          type: "tool_result",
          tool_use_id: b.toolUseId,
          content: b.content,
          ...(b.isError ? { is_error: true } : {}),
        });
      else if (b.type === "reasoning" && m.role === "assistant") {
        const sealed = sealedBlock(b);
        if (sealed) params.push(sealed);
      }
    }
    // Thinking alone is not a turn the API takes.
    if (m.role === "assistant" && !params.some((p) => p.type === "text" || p.type === "tool_use")) continue;
    push(m.role, params);
  }
  // Results first in every user message, wherever they were merged from.
  for (const p of out)
    if (p.role === "user" && Array.isArray(p.content))
      p.content.sort((a, b) => Number(b.type === "tool_result") - Number(a.type === "tool_result"));
  // The first message is the person's: a history cut at its head gets a line before the first reply.
  if (out[0]?.role === "assistant") out.unshift({ role: "user", content: "(The conversation so far.)" });
  return out;
}

/** The registry's tools as Claude's, with a cache mark after the last one. Exported for testing. */
export function toClaudeTools(tools: readonly ToolSpec[]): WireTool[] {
  return tools.map((t, i) => {
    const { $schema: _dialect, ...schema } = t.parameters as Record<string, unknown> & { $schema?: unknown };
    return {
      name: t.name,
      description: t.description,
      input_schema: { ...schema, type: "object" } as WireTool["input_schema"],
      // Arguments stream as they are written; the loop parses and validates them itself.
      eager_input_streaming: true,
      ...(i === tools.length - 1 ? { cache_control: CACHE_HOUR } : {}),
    };
  });
}

/** One step's request and the betas it needs. Exported for testing. */
export function claudeRequest(
  config: ProviderConfig,
  req: CompletionRequest,
): { body: Record<string, unknown>; betas: string[] } {
  const effort = reasoningOf(config);
  const answer = req.maxTokens ?? config.maxTokens ?? DEFAULT_ANSWER;
  const betas: string[] = [];
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: answer,
    messages: toClaudeMessages(req.messages),
    // The moving mark: the end of this request, read back by the next step.
    cache_control: { type: "ephemeral" },
  };
  if (req.system) body.system = [{ type: "text", text: req.system, cache_control: CACHE_HOUR }];
  if (req.tools?.length) body.tools = toClaudeTools(req.tools);
  if (thinksAdaptively(config.model)) {
    // Summarized, so the editor has something to show while the model thinks.
    body.thinking = {
      type: "adaptive",
      display: "summarized",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    };
    betas.push(BINDING_BETA);
    // "none" cannot switch thinking off on these models; the least it can be is low.
    if (effort) body.output_config = { effort: effort === "none" ? "low" : effort };
    // Thinking is paid out of the same cap, so it gets room on top of the answer's share.
    body.max_tokens = Math.min(answer + THINKING_ROOM[effort ?? "default"], OUTPUT_MAX);
  } else if (effort && effort !== "none") {
    const budget = THINKING_BUDGET[effort];
    body.thinking = { type: "enabled", budget_tokens: budget };
    body.max_tokens = answer + budget;
    if (req.tools?.length) betas.push(INTERLEAVED_BETA);
  }
  // Only Anthropic's own endpoint runs the fallback; a gateway in front of it may not know the field.
  const base = config.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  if ((!base || base === ANTHROPIC_BASE_URL) && FALLS_BACK.test(config.model)) {
    body.fallbacks = "default";
    betas.push(FALLBACK_BETA);
  }
  Object.assign(body, extraBodyOf(config));
  return { body, betas };
}

/** What a reply ended on, in the words the loop reads. */
function finishOf(stop: string): string {
  if (stop === "max_tokens" || stop === "model_context_window_exceeded") return "length";
  if (stop === "tool_use") return "tool_calls";
  if (stop === "end_turn" || stop === "stop_sequence") return "stop";
  return stop;
}

/** How many earlier thinking blocks the API left out of this request. */
function droppedIn(transformations: unknown): number {
  return Array.isArray(transformations)
    ? transformations.filter((t) => (t as { type?: unknown })?.type === "thinking_dropped").length
    : 0;
}

type Gathered =
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "redacted"; data: string }
  | { kind: "tool"; id: string; name: string; json: string };

/**
 * Claude's stream as the loop's stream events. Text and thinking are passed on as they arrive; the
 * calls and the sealed thinking are handed over at the end, once the stop reason says they are whole.
 * Exported for testing.
 */
export async function* fromClaudeEvents(
  id: string,
  events: AsyncIterable<WireEvent>,
): AsyncGenerator<StreamEvent> {
  const blocks: Gathered[] = [];
  const at = new Map<number, Gathered>();
  let usage: Usage = { promptTokens: 0, completionTokens: 0 };
  let stop: string | null = null;
  let category: string | null = null;
  let dropped = 0;
  const count = (
    u:
      | {
          input_tokens?: number | null;
          output_tokens?: number | null;
          cache_read_input_tokens?: number | null;
          cache_creation_input_tokens?: number | null;
        }
      | null
      | undefined,
  ) => {
    if (!u) return;
    const read = u.cache_read_input_tokens ?? usage.cacheReadTokens;
    const written = u.cache_creation_input_tokens ?? usage.cacheWriteTokens;
    // Claude counts the cached part apart; the loop's prompt is the whole prompt, as the context meter
    // and the truncation check both read it.
    const input =
      typeof u.input_tokens === "number" ? u.input_tokens + (read ?? 0) + (written ?? 0) : usage.promptTokens;
    usage = {
      promptTokens: input,
      completionTokens: u.output_tokens ?? usage.completionTokens,
      ...(read !== undefined ? { cacheReadTokens: read } : {}),
      ...(written !== undefined ? { cacheWriteTokens: written } : {}),
    };
  };
  for await (const ev of events) {
    if (ev.type === "message_start") {
      count(ev.message.usage);
      dropped = droppedIn((ev.message as { input_transformations?: unknown }).input_transformations);
    } else if (ev.type === "content_block_start") {
      const b = ev.content_block;
      let g: Gathered | undefined;
      if (b.type === "text") {
        if (b.text) yield { type: "text", delta: b.text };
      } else if (b.type === "thinking") g = { kind: "thinking", thinking: "", signature: b.signature ?? "" };
      else if (b.type === "redacted_thinking") g = { kind: "redacted", data: b.data };
      else if (b.type === "tool_use") g = { kind: "tool", id: b.id, name: b.name, json: "" };
      else if ((b as { type: string }).type === "fallback") blocks.length = 0; // another model goes on from here
      if (g) {
        blocks.push(g);
        at.set(ev.index, g);
      }
    } else if (ev.type === "content_block_delta") {
      const g = at.get(ev.index);
      const d = ev.delta;
      if (d.type === "text_delta") yield { type: "text", delta: d.text };
      else if (d.type === "thinking_delta" && g?.kind === "thinking") {
        g.thinking += d.thinking;
        if (d.thinking) yield { type: "reasoning", delta: d.thinking };
      } else if (d.type === "signature_delta" && g?.kind === "thinking") g.signature += d.signature;
      else if (d.type === "input_json_delta" && g?.kind === "tool") g.json += d.partial_json;
    } else if (ev.type === "message_delta") {
      stop = ev.delta.stop_reason ?? stop;
      category =
        (ev.delta as { stop_details?: { category?: string | null } | null }).stop_details?.category ??
        category;
      count(ev.usage);
      const again = (ev as { input_transformations?: unknown }).input_transformations;
      if (again !== undefined) dropped = droppedIn(again);
    }
  }
  // A stream that stops without saying how the reply ended was cut off on the way; it is tried again.
  if (stop === null) throw new ProviderError(id, null, "the stream ended before the reply did");
  if (stop === "refusal") {
    // Nothing of a declined reply runs; the person is told why it stopped.
    for (let i = blocks.length - 1; i >= 0; i -= 1) if (blocks[i]?.kind === "tool") blocks.splice(i, 1);
    yield {
      type: "text",
      delta: `\n\nClaude declined to go on with this${category ? `: its safety check (${category}) stopped the reply` : ""}.`,
    };
  } else if (finishOf(stop) === "length" && blocks.at(-1)?.kind === "tool") blocks.pop(); // its arguments were cut off
  let calls = 0;
  for (const g of blocks) {
    if (g.kind === "thinking") {
      // A block without its seal cannot go back, so it is not kept.
      if (g.signature)
        yield {
          type: "reasoning_block",
          block: {
            type: "reasoning",
            wire: ANTHROPIC_WIRE,
            data: { type: "thinking", thinking: g.thinking, signature: g.signature },
            ...(g.thinking ? { text: g.thinking } : {}),
          },
        };
    } else if (g.kind === "redacted")
      yield {
        type: "reasoning_block",
        block: { type: "reasoning", wire: ANTHROPIC_WIRE, data: { type: "redacted_thinking", data: g.data } },
      };
    else {
      yield { type: "tool_call", index: calls, id: g.id, name: g.name, argumentsDelta: g.json };
      calls += 1;
    }
  }
  const finishReason = stop === "tool_use" && calls === 0 ? "stop" : finishOf(stop);
  yield { type: "finish", finishReason, usage, ...(dropped ? { thinkingDropped: dropped } : {}) };
}

function toProviderError(id: string, e: unknown, failure: (e: unknown) => ProviderError): ProviderError {
  if (e instanceof ProviderError) return e;
  // Our own timeout and a dropped connection first: the request signal knows which fired, and says a
  // timeout as one, so the loop asks for a shorter reply instead of sending the same one again.
  if (e instanceof Anthropic.APIUserAbortError || e instanceof Anthropic.APIConnectionError)
    return failure(e);
  if (e instanceof Anthropic.APIError) {
    const body = (e.error as { error?: { type?: unknown; message?: unknown } } | undefined)?.error;
    const status = e.status ?? STATUS_OF_TYPE[String(body?.type ?? "")] ?? null;
    return new ProviderError(id, status, typeof body?.message === "string" ? body.message : e.message);
  }
  return failure(e);
}

/**
 * Whether Anthropic answers this key for this model, from its model list, which costs nothing; null
 * when it does, and the reason when not. An eval asks first, so a bad key is skipped, not scored.
 */
export async function claudeReachable(config: ProviderConfig): Promise<string | null> {
  if (!config.apiKey) return "no Anthropic API key";
  const base = config.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") || ANTHROPIC_BASE_URL;
  try {
    const client = new Anthropic({
      apiKey: config.apiKey,
      authToken: null,
      baseURL: base,
      maxRetries: 0,
      timeout: 10_000,
    });
    await client.models.retrieve(config.model);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function anthropicMessages(config: ProviderConfig, fetchFn?: FetchFn): Provider {
  // Every current Claude model can be shown a picture; a configuration that says otherwise wins.
  const profile = { ...DEFAULT_PROFILE, vision: true, ...config.profile };
  const effort = reasoningOf(config);
  const base = config.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") || ANTHROPIC_BASE_URL;
  const ms = config.timeoutMs ?? 120_000;
  // The key and the address as configured, never the shell's ANTHROPIC_* settings.
  const client = config.apiKey
    ? new Anthropic({
        apiKey: config.apiKey,
        authToken: null,
        baseURL: base,
        // The loop retries transient failures itself, with the events a person can see; the SDK doing
        // it silently underneath would double every wait.
        maxRetries: 0,
        // Longer than the request's own timeout, so that one fires first and says what happened.
        timeout: ms + 60_000,
        ...(config.headers ? { defaultHeaders: config.headers } : {}),
        // Only tests pass one; the SDK uses the global fetch otherwise.
        ...(fetchFn ? { fetch: fetchFn as unknown as typeof fetch } : {}),
      })
    : null;
  const adaptations = [
    `speaking Claude's Messages API${
      effort
        ? `, effort ${effort === "none" ? "low (thinking cannot be switched off on current models)" : effort}`
        : ""
    }`,
  ];

  async function* stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    if (!client) throw new ProviderError(config.id, 401, "no Anthropic API key: set ANTHROPIC_API_KEY");
    const { signal, failure } = requestSignal(config, req);
    const { body, betas } = claudeRequest(config, req);
    try {
      const events = await client.beta.messages.create(
        { ...body, stream: true, ...(betas.length ? { betas } : {}) } as never,
        { signal },
      );
      yield* fromClaudeEvents(config.id, events as unknown as AsyncIterable<WireEvent>);
    } catch (e) {
      throw toProviderError(config.id, e, failure);
    }
  }

  return {
    id: config.id,
    model: config.model,
    wire: "anthropic" as const,
    profile,
    adaptations,
    stream,
    /** One whole reply, streamed underneath so a long one cannot outlast an HTTP timeout. */
    async complete(req) {
      let text = "";
      const calls: ToolCall[] = [];
      const reasoning: ReasoningBlock[] = [];
      let finishReason: string | null = null;
      let usage: Usage = { promptTokens: 0, completionTokens: 0 };
      let thinkingDropped: number | undefined;
      for await (const e of stream(req)) {
        if (e.type === "text") text += e.delta;
        else if (e.type === "reasoning_block") reasoning.push(e.block);
        else if (e.type === "tool_call")
          calls.push({
            id: e.id ?? `call_${e.index}`,
            name: e.name ?? "",
            arguments: e.argumentsDelta || "{}",
          });
        else if (e.type === "finish") {
          finishReason = e.finishReason;
          if (e.usage) usage = e.usage;
          thinkingDropped = e.thinkingDropped;
        }
      }
      return {
        text: text || null,
        toolCalls: calls,
        finishReason,
        usage,
        ...(reasoning.length ? { reasoning } : {}),
        ...(thinkingDropped ? { thinkingDropped } : {}),
        raw: null,
      } satisfies Completion;
    },
  };
}

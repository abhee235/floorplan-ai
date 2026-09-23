// Ollama's own wire, behind the same Provider interface (ADR-007 D1, amended 2026-09-20).
//
// The one thing this buys that the OpenAI-compatible wire cannot: the context a model is loaded
// with. That format has no field for it, so Ollama's compatibility layer has nothing to map and
// ignores it wherever you put it. The number is not a nicety on a local machine -- a build whose
// architecture declares 262,144 tokens is sized for that declaration, the cache overflows the card,
// and a model that fits comfortably refuses to load.
//
// Everything else here is translation, and the differences from the compatible format are small but
// sharp: tool-call arguments arrive as an object rather than a string, tool calls carry no id at
// all, images ride beside the text rather than inside it, thinking has its own field, and the token
// counts are named after what the server did rather than after the request.

import {
  type ChatMessage,
  type Completion,
  type CompletionRequest,
  type ContentPart,
  DEFAULT_PROFILE,
  type Provider,
  type ProviderConfig,
  ProviderError,
  type ToolCall,
} from "./provider.js";
import type { StreamEvent } from "./sse.js";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The server's own address, given the OpenAI-compatible one we are configured with.
 *
 * A base URL for Ollama is conventionally `http://host:11434/v1`; the native endpoints sit at the
 * root beside that, not under it.
 */
export function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * Is this address Ollama?
 *
 * Asked of the server rather than taken from configuration, because the thing that decides which
 * wire works is what is listening, not what somebody typed. Any failure means no: an address that
 * does not answer this is treated as an ordinary OpenAI-compatible server, which is what it was
 * before this file existed.
 */
export async function looksLikeOllama(
  baseUrl: string,
  fetchFn: FetchFn = globalThis.fetch as FetchFn,
  timeoutMs = 2_000,
): Promise<boolean> {
  try {
    const res = await fetchFn(`${ollamaRoot(baseUrl)}/api/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string";
  } catch {
    return false;
  }
}

/**
 * A ceiling on the context we will ask for when the model does not say.
 *
 * A model that declares 262,144 tokens is telling us what it was trained for, not what will fit
 * beside its own weights on one card. Asking for the declaration is how a loadable model comes to
 * refuse to load, so the declaration is only ever a ceiling to come down from.
 */
export const ARCH_CONTEXT_CAP = 32_768;

export interface ModelLimits {
  /** What we would ask for: the model file's own setting, or the capped architecture ceiling. */
  contextTokens: number;
  /** What the architecture claims, before any capping. Reported so a person can see the difference. */
  declaredTokens: number | null;
  /** True when the number came from the model's own file rather than from our cap. */
  fromModelfile: boolean;
  /** What the server says it can do: "tools", "vision", "thinking", "completion". */
  capabilities: string[];
}

/** What a model says about itself, or null when the server will not say. */
export async function probeModel(
  baseUrl: string,
  model: string,
  fetchFn: FetchFn = globalThis.fetch as FetchFn,
  timeoutMs = 10_000,
): Promise<ModelLimits | null> {
  try {
    const res = await fetchFn(`${ollamaRoot(baseUrl)}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      parameters?: string;
      model_info?: Record<string, unknown>;
      capabilities?: unknown;
    };
    // `parameters` is the model file's own lines, as text: "num_ctx    32768".
    const own = /^\s*num_ctx\s+(\d+)/m.exec(body.parameters ?? "");
    const declared = Object.entries(body.model_info ?? {}).find(([k]) => k.endsWith(".context_length"));
    const declaredTokens = typeof declared?.[1] === "number" ? declared[1] : null;
    const fromModelfile = own !== null;
    return {
      contextTokens: fromModelfile
        ? Number(own[1])
        : Math.min(declaredTokens ?? ARCH_CONTEXT_CAP, ARCH_CONTEXT_CAP),
      declaredTokens,
      fromModelfile,
      capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : [],
    };
  } catch {
    return null;
  }
}

interface NativeMessage {
  role: string;
  content: string;
  images?: string[];
  thinking?: string;
  tool_calls?: { function: { name: string; arguments: unknown } }[];
}

const DATA_URL = /^data:[^;]+;base64,/;

/** Text and images travel in separate fields here, not as parts of one content array. */
function toNative(m: ChatMessage): NativeMessage {
  const out: NativeMessage = { role: m.role, content: "" };
  if (typeof m.content === "string") out.content = m.content;
  else if (Array.isArray(m.content)) {
    const parts = m.content as ContentPart[];
    out.content = parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("\n");
    const images = parts
      .filter((p) => p.type === "image_url")
      .map((p) => (p as { image_url: { url: string } }).image_url.url.replace(DATA_URL, ""));
    if (images.length) out.images = images;
  }
  if (m.toolCalls?.length)
    out.tool_calls = m.toolCalls.map((c) => ({
      // Arguments are an object on this wire. A model's own arguments are not always valid JSON, and
      // a message we are replaying is history rather than something to validate: if it will not
      // parse, it goes back as the string it was, which is what the model said.
      function: { name: c.name, arguments: safeParse(c.arguments) },
    }));
  // There are no tool-call ids on this wire: a result is matched to its call by the order results
  // are sent in, which is the order the calls came in, which is the order the loop runs them. So
  // `toolCallId` has nothing to map to and is dropped rather than translated into a lie.
  return out;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Ollama answers with argument objects and no ids; the loop wants strings and ids.
 *
 * The id has to be unique for the whole run, not for the message it arrived in. Numbering from zero
 * each time looked right and was not: one real run made 79 calls using 8 ids, `call_0` thirty-eight
 * times. Nothing refused it -- this wire matches results to calls by order -- but everything that
 * keys on the id quietly broke. Cards in the chat that were still running when the next `call_0`
 * arrived never stopped running, and compaction, which reads the id to learn which tool a result
 * came from, could name the wrong one.
 */
function callIds(): (calls?: { function?: { name?: string; arguments?: unknown } }[]) => ToolCall[] {
  let next = 0;
  return (calls = []) =>
    calls.map((c) => {
      next += 1;
      return {
        id: `call_${next}`,
        name: c.function?.name ?? "",
        arguments:
          typeof c.function?.arguments === "string"
            ? c.function.arguments
            : JSON.stringify(c.function?.arguments ?? {}),
      };
    });
}

interface NativeReply {
  message?: NativeMessage;
  done?: boolean;
  done_reason?: string | null;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** A provider that speaks Ollama's own endpoints. */
export function ollamaNative(
  config: ProviderConfig,
  fetchFn: FetchFn = globalThis.fetch as FetchFn,
): Provider {
  const profile = { ...DEFAULT_PROFILE, ...config.profile };
  const url = `${ollamaRoot(config.baseUrl)}/api/chat`;
  // Per provider, so ids stay unique for as long as the conversation does.
  const fromNativeCalls = callIds();

  const body = (req: CompletionRequest, streaming: boolean): Record<string, unknown> => {
    const messages: NativeMessage[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) messages.push(toNative(m));
    const options: Record<string, unknown> = {
      // The whole reason this wire exists.
      num_ctx: profile.contextTokens,
      temperature: req.temperature ?? config.temperature ?? 0,
    };
    const cap = req.maxTokens ?? config.maxTokens;
    if (cap) options.num_predict = cap;
    const extra = config.extraBody ?? {};
    // The compatible wire's reasoning switch, said the way this one says it. Everything else in the
    // extra body is a field of that other format and does not belong here.
    const think = extra.reasoning_effort !== undefined ? extra.reasoning_effort !== "none" : undefined;
    const out: Record<string, unknown> = {
      model: config.model,
      messages,
      stream: streaming,
      options: { ...options, ...(extra.options as Record<string, unknown> | undefined) },
    };
    if (think !== undefined) out.think = think;
    if (req.tools?.length)
      out.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    if (req.json) out.format = "json";
    return out;
  };

  const send = async (req: CompletionRequest, streaming: boolean): Promise<Response> => {
    const timer = AbortSignal.timeout(config.timeoutMs ?? 120_000);
    const signal = req.signal ? AbortSignal.any([req.signal, timer]) : timer;
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...config.headers },
        body: JSON.stringify(body(req, streaming)),
        signal,
      });
    } catch (e) {
      throw new ProviderError(config.id, null, e instanceof Error ? e.message : String(e));
    }
    // No quirk learning here. The quirks the other path learns are ways of spelling OpenAI's
    // parameters, and there is one server on this wire, which spells them one way.
    if (!res.ok) {
      const text = await res.text();
      throw new ProviderError(config.id, res.status, `HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return res;
  };

  return {
    id: config.id,
    model: config.model,
    profile,
    adaptations: [`talking to Ollama directly, with a ${profile.contextTokens}-token context`],
    async complete(req) {
      const res = await send(req, false);
      const text = await res.text();
      let raw: NativeReply;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new ProviderError(config.id, res.status, `the response is not JSON: ${text.slice(0, 200)}`);
      }
      if (raw.error) throw new ProviderError(config.id, res.status, raw.error.slice(0, 500));
      if (!raw.message) throw new ProviderError(config.id, res.status, "the response has no message");
      return {
        text: raw.message.content || null,
        toolCalls: fromNativeCalls(raw.message.tool_calls),
        finishReason: raw.done_reason ?? null,
        usage: {
          promptTokens: raw.prompt_eval_count ?? 0,
          completionTokens: raw.eval_count ?? 0,
        },
        raw,
      } satisfies Completion;
    },
    async *stream(req) {
      const res = await send(req, true);
      if (!res.body) throw new ProviderError(config.id, res.status, "the response has no body to stream");
      // Newline-delimited JSON, not server-sent events: one whole object per line, and the last one
      // carries the counts.
      for await (const line of lines(res.body)) {
        let chunk: NativeReply;
        try {
          chunk = JSON.parse(line);
        } catch {
          continue;
        }
        if (chunk.error) throw new ProviderError(config.id, res.status, chunk.error.slice(0, 500));
        const m = chunk.message;
        if (m?.thinking) yield { type: "reasoning", delta: m.thinking };
        if (m?.content) yield { type: "text", delta: m.content };
        // Ollama sends a tool call whole rather than in pieces, so each one is announced with all of
        // its arguments at once and no further deltas follow.
        for (const [i, call] of fromNativeCalls(m?.tool_calls).entries())
          yield { type: "tool_call", index: i, id: call.id, name: call.name, argumentsDelta: call.arguments };
        if (chunk.done)
          yield {
            type: "finish",
            finishReason: chunk.done_reason ?? null,
            usage: {
              promptTokens: chunk.prompt_eval_count ?? 0,
              completionTokens: chunk.eval_count ?? 0,
            },
          };
      }
    },
  };
}

/** The body, split on newlines, with a partial line held back until the rest of it arrives. */
export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let held = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    held += decoder.decode(chunk, { stream: true });
    let at = held.indexOf("\n");
    while (at >= 0) {
      const line = held.slice(0, at).trim();
      held = held.slice(at + 1);
      if (line) yield line;
      at = held.indexOf("\n");
    }
  }
  const last = held.trim();
  if (last) yield last;
}

// One provider interface over the OpenAI chat completions wire format (ADR-007 D1). The same code talks
// to OpenAI, OpenRouter and local servers (Ollama, vLLM, LM Studio) hosting Qwen models. No vendor SDK.

import { decodeChunk, type StreamEvent, sseData } from "./sse.js";

export interface ProviderProfile {
  vision: boolean;
  toolCalls: boolean;
  toolReliability: "high" | "medium" | "low";
  contextTokens: number;
  /** Ask for response_format json_object; never relied upon (ADR-007 D2). */
  jsonMode: boolean;
  /**
   * Whether replies may be streamed. Optional, and absent means yes: a profile written before there
   * was any streaming means "stream if you can", not "never". A server that cannot, or a run that
   * wants one whole answer, sets it false and the loop asks for a complete reply instead.
   */
  streaming?: boolean;
}

export const DEFAULT_PROFILE: ProviderProfile = {
  vision: false,
  toolCalls: true,
  toolReliability: "medium",
  contextTokens: 32_000,
  jsonMode: false,
  streaming: true,
};

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ToolCall {
  id: string;
  name: string;
  /** The raw JSON string the model produced; the runner parses and validates it. */
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface Completion {
  text: string | null;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage;
  raw: unknown;
}

export interface Provider {
  readonly id: string;
  readonly model: string;
  readonly profile: ProviderProfile;
  /** Request changes the provider learned from the server's refusals, e.g. "max_tokens is sent as max_completion_tokens". */
  readonly adaptations?: readonly string[];
  complete(req: CompletionRequest): Promise<Completion>;
  /**
   * The same request, answered in pieces as the model produces them (ADR-022).
   *
   * Optional so a provider written for something else still satisfies this interface; the loop falls
   * back to `complete` when it is missing or when the profile says not to stream.
   */
  stream?(req: CompletionRequest): AsyncIterable<StreamEvent>;
}

type QuirkKey = "maxCompletionTokens" | "noTemperature" | "reasoningNone" | "noStreamOptions";

/**
 * A request parameter an OpenAI-compatible server refused in a 400 reply, and how to send it instead. Newer
 * OpenAI models want max_completion_tokens, accept only their default temperature, and take function tools on
 * chat completions only with reasoning_effort "none"; other servers accept the plain parameters.
 */
export function parameterQuirk(errorText: string): { key: QuirkKey; note: string } | null {
  const t = errorText.toLowerCase();
  if (t.includes("max_tokens") && t.includes("max_completion_tokens"))
    return { key: "maxCompletionTokens", note: "max_tokens is sent as max_completion_tokens" };
  if (t.includes("reasoning_effort") && t.includes("none") && (t.includes("tool") || t.includes("function")))
    return { key: "reasoningNone", note: 'reasoning_effort "none" is sent with tools' };
  if (t.includes("stream_options"))
    return { key: "noStreamOptions", note: "stream_options is left off, so usage is not reported" };
  if (
    t.includes("temperature") &&
    (t.includes("unsupported") || t.includes("does not support") || t.includes("only the default"))
  )
    return { key: "noTemperature", note: "temperature is left at the model default" };
  return null;
}

export interface ProviderConfig {
  id: string;
  /** e.g. https://openrouter.ai/api/v1, http://127.0.0.1:11434/v1 */
  baseUrl: string;
  apiKey?: string | null;
  model: string;
  profile?: Partial<ProviderProfile>;
  timeoutMs?: number;
  /** Extra top-level request fields a server understands (for example a reasoning switch). */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | null,
    message: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = "ProviderError";
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

interface WireMessage {
  role: string;
  content: string | ContentPart[] | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function toWire(m: ChatMessage): WireMessage {
  const w: WireMessage = { role: m.role, content: m.content };
  if (m.toolCalls?.length)
    w.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
    }));
  if (m.toolCallId) w.tool_call_id = m.toolCallId;
  return w;
}

export function openAICompatible(
  config: ProviderConfig,
  fetchFn: FetchFn = globalThis.fetch as FetchFn,
): Provider {
  const profile = { ...DEFAULT_PROFILE, ...config.profile };
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  // learned from refusals and kept for the provider's lifetime, so only the first request pays the extra round trip
  const quirks: Record<QuirkKey, boolean> = {
    maxCompletionTokens: false,
    noTemperature: false,
    reasoningNone: false,
    noStreamOptions: false,
  };
  const adaptations: string[] = [];

  /** The request body, with whatever this server has already refused sent the way it wants it. */
  const buildBody = (req: CompletionRequest, streaming: boolean): Record<string, unknown> => {
    const messages: WireMessage[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push(...req.messages.map(toWire));
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      ...(quirks.noTemperature ? {} : { temperature: req.temperature ?? 0 }),
      stream: streaming,
      // Without this a streamed reply reports no tokens at all, and the context meter has nothing to
      // show; servers that refuse the option are learnt from their refusal like any other quirk.
      ...(streaming && !quirks.noStreamOptions ? { stream_options: { include_usage: true } } : {}),
      ...config.extraBody,
    };
    if (req.maxTokens)
      body[quirks.maxCompletionTokens ? "max_completion_tokens" : "max_tokens"] = req.maxTokens;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      if (quirks.reasoningNone && body.reasoning_effort === undefined) body.reasoning_effort = "none";
    }
    if (req.json && profile.jsonMode) body.response_format = { type: "json_object" };
    return body;
  };

  /**
   * One request, retried only to learn how this server wants its parameters spelt.
   *
   * A 400 arrives before any part of a reply does, so a stream and a whole completion can share this:
   * by the time bytes are flowing there is nothing left to adapt.
   */
  const send = async (req: CompletionRequest, streaming: boolean): Promise<Response> => {
    for (let attempt = 0; ; attempt += 1) {
      const timer = AbortSignal.timeout(config.timeoutMs ?? 120_000);
      const signal = req.signal ? AbortSignal.any([req.signal, timer]) : timer;
      let res: Response;
      try {
        res = await fetchFn(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
            ...config.headers,
          },
          body: JSON.stringify(buildBody(req, streaming)),
          signal,
        });
      } catch (e) {
        throw new ProviderError(config.id, null, e instanceof Error ? e.message : String(e));
      }
      if (res.ok) return res;
      const text = await res.text();
      // a refused parameter is changed once and the request sent again; anything else is an error
      const quirk = res.status === 400 && attempt < 4 ? parameterQuirk(text) : null;
      if (!quirk || quirks[quirk.key])
        throw new ProviderError(config.id, res.status, `HTTP ${res.status}: ${text.slice(0, 500)}`);
      quirks[quirk.key] = true;
      adaptations.push(quirk.note);
    }
  };

  return {
    id: config.id,
    model: config.model,
    profile,
    adaptations,
    async complete(req) {
      const res = await send(req, false);
      const text = await res.text();
      let raw: {
        choices?: {
          finish_reason?: string | null;
          message?: {
            content?: string | null;
            tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
          };
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        raw = JSON.parse(text);
      } catch {
        throw new ProviderError(config.id, res.status, `the response is not JSON: ${text.slice(0, 200)}`);
      }
      const choice = raw.choices?.[0];
      if (!choice?.message) throw new ProviderError(config.id, res.status, "the response has no message");
      return {
        text: choice.message.content ?? null,
        toolCalls: (choice.message.tool_calls ?? []).map((c, i) => ({
          id: c.id ?? `call_${i}`,
          name: c.function?.name ?? "",
          arguments: c.function?.arguments ?? "{}",
        })),
        finishReason: choice.finish_reason ?? null,
        usage: {
          promptTokens: raw.usage?.prompt_tokens ?? 0,
          completionTokens: raw.usage?.completion_tokens ?? 0,
        },
        raw,
      };
    },
    async *stream(req) {
      const res = await send(req, true);
      if (!res.body) throw new ProviderError(config.id, res.status, "the response has no body to stream");
      let known = 0;
      for await (const data of sseData(res.body)) {
        let chunk: unknown;
        try {
          chunk = JSON.parse(data);
        } catch {
          // A frame that is not JSON is not worth ending a reply over; a server that sends one sends
          // more, and the finish event is what the loop waits for.
          continue;
        }
        for (const event of decodeChunk(chunk, known)) {
          if (event.type === "tool_call") known = Math.max(known, event.index + 1);
          yield event;
        }
      }
    },
  };
}

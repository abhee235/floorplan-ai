// The OpenAI-compatible chat completions wire (ADR-029 D2): OpenRouter, vLLM, LM Studio and any server
// that speaks `/chat/completions`. OpenAI itself is on the Responses wire, because on this one its
// reasoning models refuse to think while they call tools.
//
// The conversation arrives in our own blocks and is translated here: a tool_use block is a tool call on
// the assistant message, a tool_result message is a `tool` message, an image block is an `image_url`
// part, and reasoning blocks are dropped, because this wire has nowhere to put them.

import { type Message, pairedCalls, textOf, toolResultOf, toolUsesOf } from "./messages.js";
import {
  type Completion,
  type CompletionRequest,
  DEFAULT_PROFILE,
  type FetchFn,
  type Provider,
  type ProviderConfig,
  ProviderError,
  reasoningOf,
  requestSignal,
} from "./provider.js";
import { decodeChunk, sseData } from "./sse.js";

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
    return {
      key: "reasoningNone",
      note: 'this server will not think while it calls tools, so reasoning_effort "none" is sent with them, whatever the configuration asked for; on OpenAI use the Responses wire (FPV_<ROLE>_API=openai-responses)',
    };
  if (t.includes("stream_options"))
    return { key: "noStreamOptions", note: "stream_options is left off, so usage is not reported" };
  if (
    t.includes("temperature") &&
    (t.includes("unsupported") || t.includes("does not support") || t.includes("only the default"))
  )
    return { key: "noTemperature", note: "temperature is left at the model default" };
  return null;
}

type WirePart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

interface WireMessage {
  role: string;
  content: string | WirePart[] | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/** Our conversation as chat messages. Exported for the wire-parity tests. */
export function toChatMessages(messages: readonly Message[], system?: string): WireMessage[] {
  const out: WireMessage[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of pairedCalls(messages)) {
    const result = toolResultOf(m);
    if (result) {
      out.push({ role: "tool", tool_call_id: result.toolUseId, content: result.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = textOf(m);
      const calls = toolUsesOf(m);
      out.push({
        role: "assistant",
        content: text.trim() ? text : null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      });
      continue;
    }
    if (typeof m.content === "string") {
      out.push({ role: "user", content: m.content });
      continue;
    }
    const parts: WirePart[] = [];
    for (const b of m.content) {
      if (b.type === "text") parts.push({ type: "text", text: b.text });
      else if (b.type === "image") parts.push({ type: "image_url", image_url: { url: b.url } });
      // A result inside a mixed user message cannot happen by the rules in messages.ts; if it ever
      // did, it goes as its own tool message rather than being lost.
      else if (b.type === "tool_result")
        out.push({ role: "tool", tool_call_id: b.toolUseId, content: b.content });
    }
    if (parts.length) out.push({ role: "user", content: parts });
  }
  return out;
}

export function openAIChat(config: ProviderConfig, fetchFn: FetchFn = globalThis.fetch as FetchFn): Provider {
  const profile = { ...DEFAULT_PROFILE, ...config.profile };
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const reasoning = reasoningOf(config);
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
    const body: Record<string, unknown> = {
      model: config.model,
      messages: toChatMessages(req.messages, req.system),
      ...(quirks.noTemperature ? {} : { temperature: req.temperature ?? config.temperature ?? 0 }),
      stream: streaming,
      // Without this a streamed reply reports no tokens at all, and the context meter has nothing to
      // show; servers that refuse the option are learnt from their refusal like any other quirk.
      ...(streaming && !quirks.noStreamOptions ? { stream_options: { include_usage: true } } : {}),
      ...(reasoning ? { reasoning_effort: reasoning } : {}),
      ...config.extraBody,
    };
    const cap = req.maxTokens ?? config.maxTokens;
    if (cap) body[quirks.maxCompletionTokens ? "max_completion_tokens" : "max_tokens"] = cap;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      // The server's refusal wins over the configured value: "Function tools with reasoning_effort
      // are not supported ... set reasoning_effort to 'none'" is not a preference. A person who set
      // FPV_AGENT_EXTRA_BODY={"reasoning_effort":"medium"} had the adaptation blocked by their own
      // setting and every run died on the same 400.
      if (quirks.reasoningNone) body.reasoning_effort = "none";
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
      const { signal, failure } = requestSignal(config, req);
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
        throw failure(e);
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
    wire: "openai-chat" as const,
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
      } satisfies Completion;
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

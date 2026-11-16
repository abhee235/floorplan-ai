// OpenAI's Responses wire, `/v1/responses` (ADR-029 D2).
//
// It exists because OpenAI's reasoning models will not think while they call tools on chat completions:
// "Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use
// function tools, use /v1/responses". Measured with the owner's key on 2026-09-24 for gpt-6-luna and
// gpt-6-sol alike; the chat adapter had been quietly switching reasoning off in answer.
//
// The shape is not messages. It is a flat list of items: the person's turns as `user` messages, the
// model's text as `assistant` messages of `output_text`, each call a `function_call` item and each
// result a `function_call_output` item, joined by `call_id`. The system prompt is `instructions`.
//
// We stay stateless (`store: false`) and send the whole history each turn, because compaction rewrites
// our history and a server holding its own copy would disagree with it. Reasoning is NOT replayed
// (ADR-031 D2.6, Cascade parity): its readable summary streams for the person to watch and is kept as a
// block for the transcript, and it never goes back on the wire.

import {
  type Block,
  type Message,
  pairedCalls,
  type ReasoningBlock,
  textOf,
  toolResultOf,
  toolUsesOf,
} from "./messages.js";
import {
  type Completion,
  type CompletionRequest,
  DEFAULT_PROFILE,
  extraBodyOf,
  type FetchFn,
  type Provider,
  type ProviderConfig,
  ProviderError,
  reasoningOf,
  requestSignal,
  type ToolCall,
  type Usage,
} from "./provider.js";
import { type StreamEvent, sseData } from "./sse.js";

/** The name reasoning blocks from this wire carry, so only this wire is sent them back. */
export const RESPONSES_WIRE = "openai-responses";

type Item = Record<string, unknown>;

/** Our conversation as Responses input items. Exported for the wire-parity tests. */
export function toResponsesInput(messages: readonly Message[]): Item[] {
  const input: Item[] = [];
  // A function_call_output whose call is not in the input is a 400 that replays on every later turn,
  // so a result whose call was compacted away or never sent is dropped rather than sent.
  const sent = new Set<string>();
  for (const m of pairedCalls(messages)) {
    const result = toolResultOf(m);
    if (result) {
      if (sent.has(result.toolUseId))
        input.push({ type: "function_call_output", call_id: result.toolUseId, output: result.content });
      continue;
    }
    if (m.role === "assistant") {
      // What it said, then its calls. Its reasoning stays home (ADR-031 D2.6).
      const text = textOf(m);
      if (text.trim()) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const c of toolUsesOf(m)) {
        input.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.arguments });
        sent.add(c.id);
      }
      continue;
    }
    if (typeof m.content === "string") {
      input.push({ role: "user", content: m.content });
      continue;
    }
    const content: Item[] = [];
    for (const b of m.content as Block[]) {
      if (b.type === "text") content.push({ type: "input_text", text: b.text });
      else if (b.type === "image") content.push({ type: "input_image", image_url: b.url });
      else if (b.type === "tool_result" && sent.has(b.toolUseId))
        input.push({ type: "function_call_output", call_id: b.toolUseId, output: b.content });
    }
    if (content.length) input.push({ role: "user", content });
  }
  return input;
}

interface OutputItem {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type?: string; text?: string }[];
  summary?: { type?: string; text?: string }[];
  encrypted_content?: string;
}

interface ResponseBody {
  status?: string;
  output?: OutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number };
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
}

const usageOf = (r: ResponseBody): Usage => ({
  promptTokens: r.usage?.input_tokens ?? 0,
  completionTokens: r.usage?.output_tokens ?? 0,
});

/** The words the chat wire used for how a reply ended, which is what the loop reads. */
function finishOf(r: ResponseBody, calls: number): string | null {
  if (r.status === "incomplete")
    return r.incomplete_details?.reason === "max_output_tokens"
      ? "length"
      : (r.incomplete_details?.reason ?? "incomplete");
  return calls > 0 ? "tool_calls" : "stop";
}

function reasoningBlock(item: OutputItem): ReasoningBlock {
  const text = (item.summary ?? [])
    .map((s) => s.text ?? "")
    .join("\n")
    .trim();
  return { type: "reasoning", wire: RESPONSES_WIRE, data: item, ...(text ? { text } : {}) };
}

function callOf(item: OutputItem, index: number): ToolCall {
  return {
    id: item.call_id ?? item.id ?? `call_${index}`,
    name: item.name ?? "",
    arguments: item.arguments || "{}",
  };
}

export function openAIResponses(
  config: ProviderConfig,
  fetchFn: FetchFn = globalThis.fetch as FetchFn,
): Provider {
  const profile = { ...DEFAULT_PROFILE, ...config.profile };
  const base = config.baseUrl.replace(/\/+$/, "");
  const url = `${base.endsWith("/v1") ? base : `${base}/v1`}/responses`;
  const effort = reasoningOf(config);
  const adaptations = [`speaking OpenAI's Responses wire${effort ? `, reasoning ${effort}` : ""}`];

  const body = (req: CompletionRequest, streaming: boolean): Record<string, unknown> => {
    const out: Record<string, unknown> = {
      model: config.model,
      input: toResponsesInput(req.messages),
      stream: streaming,
      store: false,
      // A readable summary of the reasoning, for the person watching; nothing to replay (ADR-031 D2.6).
      reasoning: effort === "none" ? { effort: "none" } : { ...(effort ? { effort } : {}), summary: "auto" },
    };
    if (req.system) out.instructions = req.system;
    if (req.tools?.length)
      out.tools = req.tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
    // Reasoning counts against this, so it caps thinking and answer together.
    const cap = req.maxTokens ?? config.maxTokens;
    if (cap) out.max_output_tokens = cap;
    if (req.json && profile.jsonMode) out.text = { format: { type: "json_object" } };
    // No temperature: reasoning models accept only their default, and refuse the field outright.
    return { ...out, ...extraBodyOf(config) };
  };

  const send = async (req: CompletionRequest, streaming: boolean): Promise<Response> => {
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
        body: JSON.stringify(body(req, streaming)),
        signal,
      });
    } catch (e) {
      throw failure(e);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new ProviderError(config.id, res.status, `HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return res;
  };

  return {
    id: config.id,
    model: config.model,
    wire: "openai-responses" as const,
    profile,
    adaptations,
    async complete(req) {
      const res = await send(req, false);
      const text = await res.text();
      let raw: ResponseBody;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new ProviderError(config.id, res.status, `the response is not JSON: ${text.slice(0, 200)}`);
      }
      if (raw.error?.message) throw new ProviderError(config.id, res.status, raw.error.message.slice(0, 500));
      const output = raw.output ?? [];
      const toolCalls = output.filter((o) => o.type === "function_call").map(callOf);
      const said = output
        .filter((o) => o.type === "message")
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text ?? "")
        .join("");
      const reasoning = output.filter((o) => o.type === "reasoning").map(reasoningBlock);
      return {
        text: said || null,
        toolCalls,
        finishReason: finishOf(raw, toolCalls.length),
        usage: usageOf(raw),
        ...(reasoning.length ? { reasoning } : {}),
        raw,
      } satisfies Completion;
    },
    async *stream(req): AsyncIterable<StreamEvent> {
      const res = await send(req, true);
      if (!res.body) throw new ProviderError(config.id, res.status, "the response has no body to stream");
      let calls = 0;
      for await (const data of sseData(res.body)) {
        let ev: {
          type?: string;
          delta?: string;
          item?: OutputItem;
          response?: ResponseBody;
          message?: string;
        };
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        switch (ev.type) {
          case "response.output_text.delta":
            if (ev.delta) yield { type: "text", delta: ev.delta };
            break;
          case "response.reasoning_summary_text.delta":
            if (ev.delta) yield { type: "reasoning", delta: ev.delta };
            break;
          case "response.output_item.done":
            // Calls arrive whole here, arguments and all, so there is nothing to stitch together.
            if (ev.item?.type === "function_call") {
              const call = callOf(ev.item, calls);
              yield {
                type: "tool_call",
                index: calls,
                id: call.id,
                name: call.name,
                argumentsDelta: call.arguments,
              };
              calls += 1;
            } else if (ev.item?.type === "reasoning")
              yield { type: "reasoning_block", block: reasoningBlock(ev.item) };
            break;
          case "response.completed":
          case "response.incomplete": {
            const r = ev.response ?? {};
            yield { type: "finish", finishReason: finishOf(r, calls), usage: usageOf(r) };
            break;
          }
          case "response.failed":
          case "error":
            // A server fault reported inside the stream: retried like any 5xx.
            throw new ProviderError(
              config.id,
              500,
              `the reply failed: ${ev.response?.error?.message ?? ev.message ?? "no reason given"}`,
            );
        }
      }
    },
  };
}

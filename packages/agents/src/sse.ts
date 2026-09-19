// Reading a server-sent event stream, and the chat-completions deltas that arrive over one.
//
// A streamed reply is the difference between watching an agent work and watching a spinner. The whole
// of the parsing is here, away from the provider, because it is the part that goes wrong quietly: a
// frame split across two network chunks, a server that ends its lines with CRLF, a tool call whose
// arguments arrive in fifteen pieces. Each of those is a test rather than an incident.
//
// Nothing here is OpenAI-specific except `decodeChunk`; the framing is the event-stream format itself.

import type { Usage } from "./provider.js";

/** What one streamed reply is made of, in the order it arrives. */
export type StreamEvent =
  | { type: "text"; delta: string }
  /** Reasoning a server chooses to show; not every one does, and it is never fed back as an answer. */
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: "finish"; finishReason: string | null; usage: Usage | null };

/** The payload a `data:` line carries when the stream is over. */
export const DONE = "[DONE]";

/**
 * A splitter for an event stream, fed whatever pieces of text arrive.
 *
 * It holds the tail of an unfinished line between calls, which is the whole point: a chunk boundary
 * lands in the middle of a JSON object often enough that a parser without this works in testing and
 * fails on a slow network.
 *
 * Returns each event's `data`, with the several data lines of one event joined by newlines as the
 * format says. Comments (lines starting with a colon) and fields we have no use for are dropped.
 */
export function sseReader(): { push(text: string): string[]; end(): string[] } {
  let tail = "";
  let data: string[] = [];
  const out: string[] = [];

  const line = (raw: string): void => {
    const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (l === "") {
      // A blank line ends an event. An event with no data at all dispatches nothing.
      if (data.length > 0) out.push(data.join("\n"));
      data = [];
      return;
    }
    if (l.startsWith(":")) return; // a comment, which some servers send as a keep-alive
    const colon = l.indexOf(":");
    const field = colon === -1 ? l : l.slice(0, colon);
    if (field !== "data") return;
    const value = colon === -1 ? "" : l.slice(colon + 1);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  };

  return {
    push(text) {
      out.length = 0;
      tail += text;
      const parts = tail.split("\n");
      // The last piece has no newline after it yet, so it waits for the next chunk.
      tail = parts.pop() ?? "";
      for (const p of parts) line(p);
      return [...out];
    },
    end() {
      out.length = 0;
      if (tail !== "") {
        line(tail);
        tail = "";
      }
      // A stream that stopped without a blank line still meant its last event.
      if (data.length > 0) {
        out.push(data.join("\n"));
        data = [];
      }
      return [...out];
    },
  };
}

interface WireDelta {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  tool_calls?: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

interface WireChunk {
  choices?: { delta?: WireDelta; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/**
 * The events in one chunk of a streamed chat completion.
 *
 * `known` is how many tool calls have been seen so far, for servers that leave out the `index` that
 * groups a call's fragments. Guessing is only safe in one direction: a fragment carrying a name starts
 * a new call, anything else continues the last one. A server that sends indices is believed.
 */
export function decodeChunk(chunk: unknown, known: number): StreamEvent[] {
  const c = chunk as WireChunk;
  const events: StreamEvent[] = [];
  const choice = c.choices?.[0];
  const delta = choice?.delta;
  if (delta?.content) events.push({ type: "text", delta: delta.content });
  const reasoning = delta?.reasoning ?? delta?.reasoning_content;
  if (reasoning) events.push({ type: "reasoning", delta: reasoning });
  for (const call of delta?.tool_calls ?? []) {
    const index = call.index ?? (call.function?.name ? known : Math.max(0, known - 1));
    events.push({
      type: "tool_call",
      index,
      ...(call.id ? { id: call.id } : {}),
      ...(call.function?.name ? { name: call.function.name } : {}),
      argumentsDelta: call.function?.arguments ?? "",
    });
    if (call.function?.name) known = Math.max(known, index + 1);
  }
  // Usage rides on a last chunk of its own when stream_options asked for it, with no choices at all.
  const usage = c.usage
    ? { promptTokens: c.usage.prompt_tokens ?? 0, completionTokens: c.usage.completion_tokens ?? 0 }
    : null;
  if (choice?.finish_reason || (usage && !choice))
    events.push({ type: "finish", finishReason: choice?.finish_reason ?? null, usage });
  return events;
}

/**
 * Every `data:` payload of a response body, decoded as text, until the stream says it is done.
 *
 * Takes the body rather than the response so a test can hand it anything that yields bytes.
 */
export async function* sseData(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  const reader = sseReader();
  const chunks =
    Symbol.asyncIterator in body
      ? (body as AsyncIterable<Uint8Array>)
      : streamToIterable(body as ReadableStream<Uint8Array>);
  for await (const bytes of chunks) {
    for (const data of reader.push(decoder.decode(bytes, { stream: true }))) {
      if (data === DONE) return;
      yield data;
    }
  }
  for (const data of reader.end()) {
    if (data === DONE) return;
    yield data;
  }
}

async function* streamToIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

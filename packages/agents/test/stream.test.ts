// A streamed reply from an OpenAI-compatible server (ADR-022).
//
// Streaming is what turns a multi-minute run from a spinner into something a person can watch, so
// these check the whole path: the body the provider asks for, the pieces it gives back, what it does
// with a server that refuses the option, and that an abort actually stops it.
import { describe, expect, it } from "vitest";
import { openAICompatible, type Provider, ProviderError, type StreamEvent } from "../src/index.js";

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const text = (delta: string) => frame({ choices: [{ delta: { content: delta } }] });
const DONE = "data: [DONE]\n\n";

/** A fetch whose body arrives in the pieces a test names, as a real one would. */
function streamingFetch(pieces: string[], options: { status?: number; error?: string } = {}) {
  const requests: Record<string, unknown>[] = [];
  const fetch = async (_url: string, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (options.status && options.status !== 200)
      return new Response(options.error ?? "no", { status: options.status });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of pieces) controller.enqueue(encoder.encode(p));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, requests };
}

const provider = (fetch: unknown) =>
  openAICompatible({ id: "test", baseUrl: "http://x/v1", model: "m" }, fetch as never);

/** The provider's stream, or a failed test: a provider without one is the fault being looked for. */
function streamOf(fetch: unknown, req: Parameters<NonNullable<Provider["stream"]>>[0]) {
  const p = provider(fetch);
  if (!p.stream) throw new Error("this provider does not stream");
  return { events: p.stream(req), adaptations: p.adaptations };
}

async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("streaming a reply", () => {
  it("asks for a stream and for the usage that a stream otherwise leaves out", async () => {
    const { fetch, requests } = streamingFetch([text("hi"), DONE]);
    await drain(streamOf(fetch, { messages: [{ role: "user", content: "hello" }] }).events);
    expect(requests[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it("gives back the text as it arrives, then the finish and the tokens", async () => {
    const { fetch } = streamingFetch([
      text("Draw"),
      text("ing "),
      text("walls"),
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      frame({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 9 } }),
      DONE,
    ]);
    const events = await drain(streamOf(fetch, { messages: [] }).events);
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta)).toEqual([
      "Draw",
      "ing ",
      "walls",
    ]);
    expect(events.at(-1)).toEqual({
      type: "finish",
      finishReason: null,
      usage: { promptTokens: 40, completionTokens: 9 },
    });
  });

  it("gives back a tool call assembled from however many pieces it came in", async () => {
    const { fetch } = streamingFetch([
      frame({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "create_walls" } }] } }],
      }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"lev' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'elId":"l1"}' } }] } }] }),
      frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      DONE,
    ]);
    const events = await drain(streamOf(fetch, { messages: [] }).events);
    const calls = events.filter((e) => e.type === "tool_call") as Extract<
      StreamEvent,
      { type: "tool_call" }
    >[];
    expect(calls.map((c) => c.argumentsDelta).join("")).toBe('{"levelId":"l1"}');
    expect(calls[0]?.name).toBe("create_walls");
    expect(new Set(calls.map((c) => c.index))).toEqual(new Set([0]));
  });

  it("learns that a server will not take stream_options, and asks again without it", async () => {
    let seen = 0;
    const encoder = new TextEncoder();
    const fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen += 1;
      if (body.stream_options)
        return new Response('{"error":{"message":"stream_options is not supported"}}', { status: 400 });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(encoder.encode(text("ok") + DONE));
            c.close();
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;
    const s = streamOf(fetch, { messages: [] });
    const events = await drain(s.events);
    expect(seen).toBe(2);
    expect(events).toEqual([{ type: "text", delta: "ok" }]);
    expect(s.adaptations).toContain("stream_options is left off, so usage is not reported");
  });

  it("reports a server that refuses outright, rather than an empty answer", async () => {
    const { fetch } = streamingFetch([], { status: 500, error: "the model server is unwell" });
    await expect(drain(streamOf(fetch, { messages: [] }).events)).rejects.toBeInstanceOf(ProviderError);
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const fetch = (async (_url: string, init?: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(encoder.encode(text("one")));
            // never closed: only the abort ends this
            init?.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
          },
        }),
        { status: 200 },
      )) as unknown as typeof globalThis.fetch;
    const events: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const e of streamOf(fetch, { messages: [], signal: controller.signal }).events) {
          events.push(e);
          controller.abort();
        }
      })(),
    ).rejects.toThrow();
    expect(events).toEqual([{ type: "text", delta: "one" }]);
  });
});

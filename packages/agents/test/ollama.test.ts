// Ollama's own wire (ADR-007 D1, amended 2026-09-20).
//
// The reason this file exists is one field. The OpenAI-compatible format has no way to say how big
// a context a model should be loaded with, and on a local machine that number is the difference
// between a model loading and the server answering 500. Everything else here is translation, and
// translation is where the mistakes live: arguments are an object on this wire rather than a string,
// tool calls carry no id, images travel beside the text, and the counts are named differently.
import { describe, expect, it } from "vitest";
import {
  ARCH_CONTEXT_CAP,
  looksLikeOllama,
  ollamaNative,
  ollamaRoot,
  probeModel,
  providerFor,
  type StreamEvent,
} from "../src/index.js";

/** A fetch that answers each address from a table and records what it was asked. */
function fakeFetch(routes: Record<string, () => Response>) {
  const seen: { url: string; body: Record<string, unknown> | null }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    seen.push({
      url,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    });
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) return new Response("no such route", { status: 404 });
    return route();
  };
  return { fetch, seen };
}

const json = (o: unknown) => () => new Response(JSON.stringify(o), { status: 200 });
const version = json({ version: "0.32.13" });
const ndjson = (objects: unknown[]) => () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        const encoder = new TextEncoder();
        // Split across chunk boundaries on purpose: a real body does not arrive in whole lines.
        const all = objects.map((o) => `${JSON.stringify(o)}\n`).join("");
        c.enqueue(encoder.encode(all.slice(0, 17)));
        c.enqueue(encoder.encode(all.slice(17)));
        c.close();
      },
    }),
    { status: 200 },
  );

const config = { id: "test", baseUrl: "http://127.0.0.1:11434/v1", model: "m" };

describe("finding the server", () => {
  it("looks for the native endpoints beside the compatible one, not under it", () => {
    expect(ollamaRoot("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
    expect(ollamaRoot("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434");
    expect(ollamaRoot("http://host:8000")).toBe("http://host:8000");
  });

  it("asks the server what it is rather than believing the configuration", async () => {
    const { fetch, seen } = fakeFetch({ "/api/version": version });
    expect(await looksLikeOllama(config.baseUrl, fetch as never)).toBe(true);
    expect(seen[0]?.url).toBe("http://127.0.0.1:11434/api/version");
  });

  it("says no to anything that is not obviously Ollama, and never throws", async () => {
    const nothing = fakeFetch({});
    expect(await looksLikeOllama("http://x/v1", nothing.fetch as never)).toBe(false);
    const wrong = fakeFetch({ "/api/version": json({ object: "list" }) });
    expect(await looksLikeOllama("http://x/v1", wrong.fetch as never)).toBe(false);
    const broken = async () => {
      throw new Error("connection refused");
    };
    expect(await looksLikeOllama("http://x/v1", broken as never)).toBe(false);
  });
});

describe("asking a model about itself", () => {
  it("believes the model's own file when it has one", async () => {
    const { fetch } = fakeFetch({
      "/api/show": json({
        parameters: "num_batch                      512\nnum_ctx                        32768\nnum_gpu 99",
        model_info: { "qwen35moe.context_length": 262144 },
        capabilities: ["completion", "tools", "thinking"],
      }),
    });
    const limits = await probeModel(config.baseUrl, "m", fetch as never);
    expect(limits).toMatchObject({
      contextTokens: 32768,
      declaredTokens: 262144,
      fromModelfile: true,
      capabilities: ["completion", "tools", "thinking"],
    });
  });

  it("caps what the architecture claims, because a claim is not a promise it will fit", async () => {
    // This is the failure that started all of it: no setting of its own, 262144 declared, a cache
    // sized for that, and a model which fits perfectly well refusing to load.
    const { fetch } = fakeFetch({
      "/api/show": json({ model_info: { "qwen35moe.context_length": 262144 }, capabilities: ["tools"] }),
    });
    const limits = await probeModel(config.baseUrl, "m", fetch as never);
    expect(limits?.contextTokens).toBe(ARCH_CONTEXT_CAP);
    expect(limits?.declaredTokens).toBe(262144);
    expect(limits?.fromModelfile).toBe(false);
  });

  it("answers null rather than guessing when the server will not say", async () => {
    expect(await probeModel(config.baseUrl, "m", fakeFetch({}).fetch as never)).toBeNull();
  });
});

describe("a whole reply on the native wire", () => {
  const reply = json({
    message: { role: "assistant", content: "Done.", tool_calls: [] },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 1200,
    eval_count: 40,
  });

  it("asks for the context the profile names, which is the whole point", async () => {
    const { fetch, seen } = fakeFetch({ "/api/chat": reply });
    const provider = ollamaNative({ ...config, profile: { contextTokens: 16384 } }, fetch as never);
    await provider.complete({ system: "sys", messages: [{ role: "user", content: "hi" }] });
    const body = seen[0]?.body as { options: Record<string, unknown>; messages: unknown[] };
    expect(body.options.num_ctx).toBe(16384);
    expect(seen[0]?.url).toBe("http://127.0.0.1:11434/api/chat");
    // The system prompt is a message here; there is no separate field for it.
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
  });

  it("sends the output cap under the name this wire uses", async () => {
    const { fetch, seen } = fakeFetch({ "/api/chat": reply });
    const provider = ollamaNative({ ...config, maxTokens: 8000 }, fetch as never);
    await provider.complete({ messages: [{ role: "user", content: "hi" }] });
    expect((seen[0]?.body as { options: { num_predict?: number } }).options.num_predict).toBe(8000);
  });

  it("reads the counts, which are named after what the server did", async () => {
    const { fetch } = fakeFetch({ "/api/chat": reply });
    const out = await ollamaNative(config, fetch as never).complete({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out).toMatchObject({
      text: "Done.",
      finishReason: "stop",
      usage: { promptTokens: 1200, completionTokens: 40 },
    });
  });

  it("gives tool calls the ids and string arguments the loop expects", async () => {
    // Both differences at once: arguments arrive as an object, and nothing has an id.
    const { fetch } = fakeFetch({
      "/api/chat": json({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "get_scene", arguments: { detail: "summary" } } },
            { function: { name: "validate", arguments: {} } },
          ],
        },
        done: true,
        done_reason: "stop",
      }),
    });
    const out = await ollamaNative(config, fetch as never).complete({
      messages: [{ role: "user", content: "look" }],
    });
    expect(out.text).toBeNull();
    expect(out.toolCalls).toEqual([
      { id: "call_0", name: "get_scene", arguments: '{"detail":"summary"}' },
      { id: "call_1", name: "validate", arguments: "{}" },
    ]);
  });

  it("sends a previous turn's tool calls back as objects, and keeps unparsable ones as they were", async () => {
    const { fetch, seen } = fakeFetch({ "/api/chat": reply });
    await ollamaNative(config, fetch as never).complete({
      messages: [
        { role: "assistant", content: null, toolCalls: [{ id: "a", name: "t", arguments: '{"x":1}' }] },
        { role: "assistant", content: null, toolCalls: [{ id: "b", name: "t", arguments: "{not json" }] },
        { role: "tool", content: "ok", toolCallId: "a" },
      ],
    });
    const messages = (seen[0]?.body as { messages: Record<string, unknown>[] }).messages;
    expect(messages[0]?.tool_calls).toEqual([{ function: { name: "t", arguments: { x: 1 } } }]);
    expect(messages[1]?.tool_calls).toEqual([{ function: { name: "t", arguments: "{not json" } }]);
    // No id to map to, so none is invented.
    expect(messages[2]).toEqual({ role: "tool", content: "ok" });
  });

  it("puts images beside the text rather than inside it", async () => {
    const { fetch, seen } = fakeFetch({ "/api/chat": reply });
    await ollamaNative(config, fetch as never).complete({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    });
    const messages = (seen[0]?.body as { messages: Record<string, unknown>[] }).messages;
    expect(messages[0]).toEqual({ role: "user", content: "what is this", images: ["AAAA"] });
  });

  it("says thinking off the way this wire says it", async () => {
    const off = fakeFetch({ "/api/chat": reply });
    await ollamaNative({ ...config, extraBody: { reasoning_effort: "none" } }, off.fetch as never).complete({
      messages: [{ role: "user", content: "hi" }],
    });
    expect((off.seen[0]?.body as { think?: boolean }).think).toBe(false);

    const on = fakeFetch({ "/api/chat": reply });
    await ollamaNative({ ...config, extraBody: { reasoning_effort: "low" } }, on.fetch as never).complete({
      messages: [{ role: "user", content: "hi" }],
    });
    expect((on.seen[0]?.body as { think?: boolean }).think).toBe(true);

    // Nothing said means nothing sent: the model's own default stands.
    const quiet = fakeFetch({ "/api/chat": reply });
    await ollamaNative(config, quiet.fetch as never).complete({
      messages: [{ role: "user", content: "hi" }],
    });
    expect((quiet.seen[0]?.body as { think?: boolean }).think).toBeUndefined();
  });

  it("turns a refusal into a provider error rather than an empty answer", async () => {
    const { fetch } = fakeFetch({
      "/api/chat": () => new Response(JSON.stringify({ error: "model not found" }), { status: 404 }),
    });
    await expect(
      ollamaNative(config, fetch as never).complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/model not found/);
  });
});

describe("a streamed reply", () => {
  it("reads whole objects out of a body that does not arrive in whole lines", async () => {
    const { fetch } = fakeFetch({
      "/api/chat": ndjson([
        { message: { role: "assistant", content: "", thinking: "Let me " }, done: false },
        { message: { role: "assistant", content: "", thinking: "count." }, done: false },
        { message: { role: "assistant", content: "Six " }, done: false },
        { message: { role: "assistant", content: "rooms." }, done: false },
        {
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 9,
          eval_count: 4,
        },
      ]),
    });
    const provider = ollamaNative(config, fetch as never);
    const events: StreamEvent[] = [];
    for await (const e of provider.stream?.({ messages: [{ role: "user", content: "hi" }] }) ?? [])
      events.push(e);
    expect(events.filter((e) => e.type === "reasoning").map((e) => e.delta)).toEqual(["Let me ", "count."]);
    expect(events.filter((e) => e.type === "text").map((e) => e.delta)).toEqual(["Six ", "rooms."]);
    expect(events.at(-1)).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: { promptTokens: 9, completionTokens: 4 },
    });
  });

  it("announces a tool call with all of its arguments at once, because that is how it arrives", async () => {
    const { fetch } = fakeFetch({
      "/api/chat": ndjson([
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "get_scene", arguments: { detail: "summary" } } }],
          },
          done: false,
        },
        { message: { role: "assistant", content: "" }, done: true, done_reason: "tool_calls" },
      ]),
    });
    const events: StreamEvent[] = [];
    for await (const e of ollamaNative(config, fetch as never).stream?.({
      messages: [{ role: "user", content: "hi" }],
    }) ?? [])
      events.push(e);
    expect(events[0]).toEqual({
      type: "tool_call",
      index: 0,
      id: "call_0",
      name: "get_scene",
      argumentsDelta: '{"detail":"summary"}',
    });
  });
});

describe("choosing a wire", () => {
  const chat = json({ message: { role: "assistant", content: "hi" }, done: true, done_reason: "stop" });
  const completions = json({
    choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });

  it("takes the native wire when the address answers as Ollama, and asks the model its size first", async () => {
    const { fetch, seen } = fakeFetch({
      "/api/version": version,
      "/api/show": json({ model_info: { "qwen35moe.context_length": 262144 } }),
      "/api/chat": chat,
    });
    const provider = providerFor(config, fetch as never);
    const out = await provider.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(out.text).toBe("hi");
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual(["/api/version", "/api/show", "/api/chat"]);
    // Capped, not the 262144 the model claims, which is what made a loadable model refuse to load.
    expect((seen[2]?.body as { options: { num_ctx: number } }).options.num_ctx).toBe(ARCH_CONTEXT_CAP);
    expect(provider.profile.contextTokens).toBe(ARCH_CONTEXT_CAP);
  });

  it("says which wire it settled on, and on what context", async () => {
    const { fetch } = fakeFetch({
      "/api/version": version,
      "/api/show": json({ parameters: "num_ctx 16384" }),
      "/api/chat": chat,
    });
    const provider = providerFor(config, fetch as never);
    // Before the first call nothing has been asked, so there is nothing to say.
    expect(provider.adaptations).toEqual([]);
    await provider.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(provider.adaptations?.join(" ")).toContain("Ollama directly");
    expect(provider.adaptations?.join(" ")).toContain("16384");
  });

  it("does not second-guess a context somebody configured on purpose", async () => {
    const { fetch, seen } = fakeFetch({ "/api/version": version, "/api/chat": chat });
    await providerFor({ ...config, profile: { contextTokens: 8192 } }, fetch as never).complete({
      messages: [{ role: "user", content: "hi" }],
    });
    // No /api/show at all: there is nothing to ask, because the answer was given.
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual(["/api/version", "/api/chat"]);
    expect((seen[1]?.body as { options: { num_ctx: number } }).options.num_ctx).toBe(8192);
  });

  it("leaves everything else exactly where it was", async () => {
    const { fetch, seen } = fakeFetch({ "/v1/chat/completions": completions });
    const out = await providerFor(
      { ...config, baseUrl: "https://api.openai.com/v1" },
      fetch as never,
    ).complete({ messages: [{ role: "user", content: "hi" }] });
    expect(out.text).toBe("hi");
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual(["/api/version", "/v1/chat/completions"]);
  });

  it("asks once, not once a step", async () => {
    const { fetch, seen } = fakeFetch({ "/api/version": version, "/api/show": json({}), "/api/chat": chat });
    const provider = providerFor(config, fetch as never);
    for (let i = 0; i < 3; i += 1) await provider.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(seen.filter((s) => s.url.endsWith("/api/version"))).toHaveLength(1);
    expect(seen.filter((s) => s.url.endsWith("/api/show"))).toHaveLength(1);
    expect(seen.filter((s) => s.url.endsWith("/api/chat"))).toHaveLength(3);
  });
});

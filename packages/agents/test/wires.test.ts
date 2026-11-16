// One adapter per wire over a conversation that belongs to no vendor (ADR-029).
//
// Each wire is checked for the thing that goes wrong on it: Responses for reasoning carried between
// turns and results joined to calls, Claude for signed thinking and a turn's results in one message,
// every wire for a call nobody answered. The fakes answer the way the servers were seen to answer on
// 2026-09-24 (docs/adr/ADR-029-one-adapter-per-wire.md).
import { describe, expect, it } from "vitest";
import {
  createProvider,
  fromLegacyMessages,
  type Message,
  type ProviderConfig,
  pairedCalls,
  runAgent,
  type StreamEvent,
  toChatMessages,
  toClaudeMessages,
  toolResultMessage,
  toResponsesInput,
  wireForName,
} from "../src/index.js";

const sse = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

/** Anthropic names every event on an event: line as well, and its SDK dispatches on that name. */
const namedSse = (events: ({ type: string } & Record<string, unknown>)[]) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

/** A conversation with a call, its result, a picture and some kept reasoning of each wire. */
const conversation: Message[] = [
  { role: "user", content: "draw the office" },
  {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        wire: "openai-responses",
        data: { type: "reasoning", id: "rs_1", encrypted_content: "E" },
      },
      { type: "reasoning", wire: "anthropic", data: { type: "thinking", thinking: "t", signature: "S" } },
      { type: "text", text: "Reading it first." },
      { type: "tool_use", id: "c1", name: "get_scene", arguments: '{"detail":"summary"}' },
      { type: "tool_use", id: "c2", name: "validate", arguments: "{}" },
    ],
  },
  toolResultMessage("c1", '{"ok":true}'),
  toolResultMessage("c2", '{"ok":false}', true),
  {
    role: "user",
    content: [
      { type: "text", text: "This is what it looks like." },
      { type: "image", url: "data:image/png;base64,QUJD" },
    ],
  },
];

describe("the conversation, on each wire", () => {
  it("chat completions: calls on the assistant, one tool message per result, no reasoning", () => {
    const wire = toChatMessages(conversation, "sys");
    expect(wire.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool", "user"]);
    expect(wire[2]?.tool_calls?.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(wire[2]?.content).toBe("Reading it first.");
    expect(wire[3]).toEqual({ role: "tool", tool_call_id: "c1", content: '{"ok":true}' });
    expect(wire[5]?.content).toEqual([
      { type: "text", text: "This is what it looks like." },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ]);
    expect(JSON.stringify(wire)).not.toContain("encrypted_content");
  });

  it("Responses: text, then calls and their outputs joined by call_id, and no reasoning replayed (ADR-031 D2.6)", () => {
    const input = toResponsesInput(conversation);
    expect(input.map((i) => i.type ?? i.role)).toEqual([
      "user",
      "assistant",
      "function_call",
      "function_call",
      "function_call_output",
      "function_call_output",
      "user",
    ]);
    expect(JSON.stringify(input)).not.toContain("encrypted_content");
    expect(input[4]).toEqual({ type: "function_call_output", call_id: "c1", output: '{"ok":true}' });
    expect((input[6] as { content: unknown[] }).content[1]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,QUJD",
    });
    // Claude's thinking is Claude's: it never goes to another vendor.
    expect(JSON.stringify(input)).not.toContain('"signature"');
  });

  it("Claude: its own thinking first, a turn's results in one user message, results before the picture", () => {
    const wire = toClaudeMessages(conversation);
    expect(wire.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const assistant = wire[1]?.content as { type: string }[];
    expect(assistant.map((b) => b.type)).toEqual(["thinking", "text", "tool_use", "tool_use"]);
    expect(assistant[0]).toEqual({ type: "thinking", thinking: "t", signature: "S" });
    expect(assistant[2]).toMatchObject({ type: "tool_use", id: "c1", input: { detail: "summary" } });
    const results = wire[2]?.content as { type: string; is_error?: boolean }[];
    expect(results.map((b) => b.type)).toEqual(["tool_result", "tool_result", "text", "image"]);
    expect(results[1]?.is_error).toBe(true);
    expect(results[3]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "QUJD" },
    });
  });

  it("no wire is sent a call nobody answered, or an answer to a call that is gone", () => {
    const broken: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "kept", name: "a", arguments: "{}" },
          { type: "tool_use", id: "cut", name: "b", arguments: "{}" },
        ],
      },
      toolResultMessage("kept", "ok"),
      toolResultMessage("orphan", "ok"),
    ];
    const paired = pairedCalls(broken);
    expect(paired).toHaveLength(3);
    expect(JSON.stringify(paired)).not.toContain('"cut"');
    expect(JSON.stringify(paired)).not.toContain('"orphan"');
    for (const wire of [toChatMessages(broken), toResponsesInput(broken), toClaudeMessages(broken)])
      expect(JSON.stringify(wire)).not.toMatch(/"(cut|orphan)"/);
  });
});

describe("a conversation saved before the change (ADR-029 D5)", () => {
  it("is read as ours: calls become tool_use, tool messages results, image parts images", () => {
    const old = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:x" } },
        ],
      },
      { role: "assistant", content: null, toolCalls: [{ id: "a", name: "t", arguments: "{}" }] },
      { role: "tool", toolCallId: "a", content: "ok" },
      { role: "system", content: "an old system prompt" },
      { role: "assistant", content: "done" },
      { role: "user", content: "thanks" },
    ];
    expect(fromLegacyMessages(old)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", url: "data:x" },
        ],
      },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "t", arguments: "{}" }] },
      toolResultMessage("a", "ok"),
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: "thanks" },
    ]);
  });

  it("leaves a conversation already in the new shape as it is", () => {
    expect(fromLegacyMessages(conversation)).toEqual(conversation);
  });
});

describe("which adapter speaks (ADR-029 D2)", () => {
  const base: ProviderConfig = { id: "env-agent", baseUrl: "https://example.test/v1", model: "m" };
  it("goes by the api, then by the provider's name", () => {
    expect(wireForName("openai")).toBe("openai-responses");
    expect(wireForName("Anthropic")).toBe("anthropic");
    expect(wireForName("openrouter")).toBe("openai-chat");
    expect(wireForName("env-agent")).toBeNull();
    expect(createProvider({ ...base, api: "openai-responses" }).adaptations?.[0]).toMatch(/Responses/);
    expect(createProvider({ ...base, id: "anthropic", apiKey: "k" }).adaptations?.[0]).toMatch(
      /Messages API/,
    );
  });
});

describe("OpenAI's Responses wire", () => {
  const config: ProviderConfig = {
    id: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-6-luna",
    apiKey: "k",
    api: "openai-responses",
    reasoning: "medium",
  };

  it("asks for reasoning and its readable summary, sends no temperature, and posts to /v1/responses", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
      );
    };
    const out = await createProvider(config, fetchFn).complete({
      system: "sys",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
      temperature: 0,
    });
    expect(out.text).toBe("hi");
    expect(seen[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(seen[0]?.body).toMatchObject({
      store: false,
      instructions: "sys",
      reasoning: { effort: "medium", summary: "auto" },
      tools: [{ type: "function", name: "t", description: "d", parameters: { type: "object" } }],
    });
    expect(seen[0]?.body).not.toHaveProperty("temperature");
    // Nothing to replay, so nothing is asked for (ADR-031 D2.6).
    expect(seen[0]?.body).not.toHaveProperty("include");
  });

  it("streams text, whole calls and the reasoning summary, and never sends reasoning back", async () => {
    const bodies: Record<string, unknown>[] = [];
    let turn = 0;
    const fetchFn = async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      turn += 1;
      if (turn === 1)
        return sse([
          { type: "response.reasoning_summary_text.delta", delta: "adding" },
          {
            type: "response.output_item.done",
            item: {
              type: "reasoning",
              id: "rs_1",
              encrypted_content: "ENC",
              summary: [{ type: "summary_text", text: "adding" }],
            },
          },
          {
            type: "response.output_item.done",
            item: { type: "function_call", call_id: "call_1", name: "add", arguments: '{"a":391,"b":551}' },
          },
          {
            type: "response.completed",
            response: { status: "completed", usage: { input_tokens: 74, output_tokens: 54 } },
          },
        ]);
      return sse([
        { type: "response.output_text.delta", delta: "942" },
        {
          type: "response.completed",
          response: { status: "completed", usage: { input_tokens: 143, output_tokens: 5 } },
        },
      ]);
    };
    const provider = createProvider(config, fetchFn);
    const events: StreamEvent[] = [];
    for await (const e of provider.stream?.({ messages: [{ role: "user", content: "sum" }] }) ?? [])
      events.push(e);
    expect(events.map((e) => e.type)).toEqual(["reasoning", "reasoning_block", "tool_call", "finish"]);

    // The loop from the start: the first reply calls, the second answers.
    turn = 0;
    const run = await runAgent({
      provider,
      tools: [{ name: "add", description: "add", parameters: { type: "object" } }],
      callTool: async () => ({ ok: true, result: { sum: 942 }, warnings: [] }),
      system: "sys",
      task: "what is 391 + 551?",
      gates: { plan: false, verify: false, idle: false },
    });
    expect(run.reason).toBe("done");
    expect(run.text).toBe("942");
    // The second request carries the call and its output, and no reasoning (ADR-031 D2.6).
    const second = bodies.at(-1)?.input as { type?: string; id?: string }[];
    expect(second.some((i) => i.type === "reasoning")).toBe(false);
    expect(second.some((i) => i.type === "function_call")).toBe(true);
  });

  it("reads an .env written for chat completions as its own reasoning setting, and does not send the field", async () => {
    const seen: Record<string, unknown>[] = [];
    const fetchFn = async (_url: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ status: "completed", output: [] }));
    };
    const { reasoning: _none, ...rest } = config;
    await createProvider({ ...rest, extraBody: { reasoning_effort: "high", user: "x" } }, fetchFn).complete({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(seen[0]).toMatchObject({ reasoning: { effort: "high" }, user: "x" });
    expect(seen[0]).not.toHaveProperty("reasoning_effort");
  });

  it("says a reply cut at the output limit ended on length, as the loop expects", async () => {
    const fetchFn = async () =>
      sse([
        { type: "response.output_text.delta", delta: "a long" },
        {
          type: "response.incomplete",
          response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
        },
      ]);
    const events: StreamEvent[] = [];
    for await (const e of createProvider(config, fetchFn).stream?.({
      messages: [{ role: "user", content: "x" }],
    }) ?? [])
      events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "length" });
  });
});

describe("Claude's Messages API", () => {
  const config: ProviderConfig = {
    id: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-opus-5-5",
    apiKey: "k",
    reasoning: "medium",
  };
  type Ev = { type: string } & Record<string, unknown>;
  const start = (usage: Record<string, number> = { input_tokens: 10, output_tokens: 0 }, extra = {}): Ev => ({
    type: "message_start",
    message: { id: "m", type: "message", role: "assistant", content: [], model: "x", usage, ...extra },
  });
  const thinking = (index: number, words: string, signature: string): Ev[] => [
    { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: words } },
    ...(signature
      ? [{ type: "content_block_delta", index, delta: { type: "signature_delta", signature } }]
      : []),
    { type: "content_block_stop", index },
  ];
  const call = (index: number, id: string, name: string, json: string[]): Ev[] => [
    { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } },
    ...json.map((partial_json) => ({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json },
    })),
    { type: "content_block_stop", index },
  ];
  const text = (index: number, words: string): Ev[] => [
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index, delta: { type: "text_delta", text: words } },
    { type: "content_block_stop", index },
  ];
  const end = (stop_reason: string, extra: Record<string, unknown> = {}): Ev[] => [
    { type: "message_delta", delta: { stop_reason, ...extra }, usage: { output_tokens: 30 } },
    { type: "message_stop" },
  ];
  /** A provider over a fake that records what was sent and answers with the given events. */
  const fake = (events: Ev[], over: Partial<ProviderConfig> = {}) => {
    const sent: { body: Record<string, unknown>; headers: Headers }[] = [];
    const fetchFn = async (_url: string, init?: RequestInit) => {
      sent.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return namedSse(events);
    };
    return { sent, provider: createProvider({ ...config, ...over }, fetchFn as never) };
  };
  const drain = async (stream: AsyncIterable<StreamEvent> | undefined) => {
    const out: StreamEvent[] = [];
    for await (const e of stream ?? []) out.push(e);
    return out;
  };
  const request = {
    system: "sys",
    messages: [{ role: "user" as const, content: "hi" }],
    tools: [
      { name: "get_scene", description: "d", parameters: { $schema: "x", type: "object" } },
      { name: "validate", description: "v", parameters: { type: "object" } },
    ],
    temperature: 0,
  };

  it("thinks adaptively at the effort, binds thinking leniently, caches tools, system and the tail, and asks for a fallback", async () => {
    const { sent, provider } = fake([start(), ...end("end_turn")], { maxTokens: 12_000 });
    await drain(provider.stream?.(request));
    const { body, headers } = sent[0] ?? { body: {}, headers: new Headers() };
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } }],
      thinking: {
        type: "adaptive",
        display: "summarized",
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      },
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
      fallbacks: "default",
      stream: true,
      // the configured answer, with room for the thinking on top
      max_tokens: 12_000 + 16_384,
    });
    expect(body).not.toHaveProperty("temperature");
    const tools = body.tools as Record<string, unknown>[];
    expect(tools[0]?.input_schema).not.toHaveProperty("$schema");
    expect(tools[0]).not.toHaveProperty("cache_control");
    expect(tools[1]).toMatchObject({
      eager_input_streaming: true,
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
    expect(headers.get("anthropic-beta")).toContain("thinking-binding-controls-2026-08-01");
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
  });

  it("hands over signed thinking, then whole calls, once the reply says how it ended", async () => {
    const { provider } = fake([
      start({
        input_tokens: 10,
        output_tokens: 0,
        cache_read_input_tokens: 90,
        cache_creation_input_tokens: 5,
      }),
      ...thinking(0, "plan it", "SIG"),
      ...call(1, "toolu_1", "get_scene", ['{"detail":', '"summary"}']),
      ...thinking(2, "", "SIG2"),
      ...call(3, "toolu_2", "validate", ["{}"]),
      ...end("tool_use"),
    ]);
    const events = await drain(provider.stream?.(request));
    expect(events.flatMap((e) => (e.type === "reasoning" ? [e.delta] : []))).toEqual(["plan it"]);
    // an empty progress note between calls is sealed all the same, and goes back
    expect(events.flatMap((e) => (e.type === "reasoning_block" ? [e.block.data] : []))).toEqual([
      { type: "thinking", thinking: "plan it", signature: "SIG" },
      { type: "thinking", thinking: "", signature: "SIG2" },
    ]);
    expect(events.flatMap((e) => (e.type === "tool_call" ? [e] : []))).toEqual([
      {
        type: "tool_call",
        index: 0,
        id: "toolu_1",
        name: "get_scene",
        argumentsDelta: '{"detail":"summary"}',
      },
      { type: "tool_call", index: 1, id: "toolu_2", name: "validate", argumentsDelta: "{}" },
    ]);
    // What was read from the cache and written to it is prompt all the same.
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      finishReason: "tool_calls",
      usage: { promptTokens: 105, completionTokens: 30, cacheReadTokens: 90, cacheWriteTokens: 5 },
    });
  });

  it("runs nothing of a declined reply and says why it stopped", async () => {
    const { provider } = fake([
      start(),
      ...call(0, "toolu_1", "create_walls", ["{}"]),
      ...end("refusal", { stop_details: { type: "refusal", category: "cyber" } }),
    ]);
    const events = await drain(provider.stream?.(request));
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
    expect(events.find((e) => e.type === "text")).toMatchObject({
      delta: expect.stringContaining("(cyber)"),
    });
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "refusal" });
  });

  it("does not run a call the output cap cut off", async () => {
    const { provider } = fake([
      start(),
      ...call(0, "toolu_1", "get_scene", ["{}"]),
      ...call(1, "toolu_2", "create_walls", ['{"walls":[{"x"']),
      ...end("max_tokens"),
    ]);
    const events = await drain(provider.stream?.(request));
    expect(events.flatMap((e) => (e.type === "tool_call" ? [e.name] : []))).toEqual(["get_scene"]);
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "length" });
  });

  it("keeps only what the fallback model thought and called", async () => {
    const { provider } = fake([
      start(),
      ...thinking(0, "first", "A"),
      ...call(1, "toolu_a", "create_walls", ["{}"]),
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "fallback", from: { model: "a" }, to: { model: "b" } },
      },
      { type: "content_block_stop", index: 2 },
      ...thinking(3, "second", "B"),
      ...call(4, "toolu_b", "get_scene", ["{}"]),
      ...end("tool_use"),
    ]);
    const events = await drain(provider.stream?.(request));
    expect(events.flatMap((e) => (e.type === "reasoning_block" ? [e.block.data] : []))).toEqual([
      { type: "thinking", thinking: "second", signature: "B" },
    ]);
    expect(events.flatMap((e) => (e.type === "tool_call" ? [e.id] : []))).toEqual(["toolu_b"]);
  });

  it("keeps no unsealed thinking, counts thinking the server left out, and retries a stream cut short", async () => {
    const { provider } = fake([
      start(undefined, {
        input_transformations: [{ type: "thinking_dropped", path: "messages.1.content.0" }],
      }),
      ...thinking(0, "unsealed", ""),
      ...text(1, "done"),
      ...end("end_turn"),
    ]);
    const events = await drain(provider.stream?.(request));
    expect(events.some((e) => e.type === "reasoning_block")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "stop", thinkingDropped: 1 });

    const cut = fake([start(), ...text(0, "half")]).provider;
    await expect(drain(cut.stream?.(request))).rejects.toMatchObject({ name: "ProviderError", status: null });
  });

  it("gives a model from before adaptive thinking a budget, without the binding it would refuse", async () => {
    const f = fake([start(), ...end("end_turn")], { model: "claude-haiku-4-5", reasoning: "low" });
    await drain(f.provider.stream?.(request));
    const { body, headers } = f.sent[0] ?? { body: {}, headers: new Headers() };
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2_048 });
    expect(body).not.toHaveProperty("output_config");
    expect(body).not.toHaveProperty("fallbacks");
    expect(headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14");
  });

  it("asks no gateway for a fallback, sees by default, and says when there is no key", async () => {
    const gateway = fake([start(), ...end("end_turn")], { baseUrl: "https://gateway.example/v1" });
    await drain(gateway.provider.stream?.(request));
    expect(gateway.sent[0]?.body).not.toHaveProperty("fallbacks");
    expect(gateway.sent[0]?.headers.get("anthropic-beta")).not.toContain("server-side-fallback");
    expect(gateway.provider.profile.vision).toBe(true);
    expect(fake([], { profile: { vision: false } }).provider.profile.vision).toBe(false);
    const keyless = createProvider({ ...config, apiKey: null });
    await expect(drain(keyless.stream?.(request))).rejects.toMatchObject({ status: 401 });
  });

  it("says a reply that outlasted the timeout timed out, so the loop asks for a shorter one", async () => {
    const hang = async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted"))),
      );
    const slow = createProvider({ ...config, timeoutMs: 30 }, hang as never);
    await expect(drain(slow.stream?.(request))).rejects.toThrow(/timed out after/);
  });

  it("answers a whole reply from the stream underneath", async () => {
    const { provider } = fake([
      start(),
      ...thinking(0, "t", "S"),
      ...text(1, "the answer"),
      ...end("end_turn"),
    ]);
    const done = await provider.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(done).toMatchObject({ text: "the answer", toolCalls: [], finishReason: "stop" });
    expect(done.reasoning?.[0]?.data).toEqual({ type: "thinking", thinking: "t", signature: "S" });
  });

  it("sends no turn of thinking alone, no unsealed thinking, and starts with the person", () => {
    const wire = toClaudeMessages([
      { role: "assistant", content: [{ type: "text", text: "Earlier, summarised." }] },
      { role: "user", content: "go on" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", wire: "anthropic", data: { type: "thinking", thinking: "x", signature: "S" } },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            wire: "anthropic",
            data: { type: "thinking", thinking: "no seal", signature: "" },
          },
          { type: "text", text: "ok" },
        ],
      },
    ]);
    expect(wire[0]).toEqual({ role: "user", content: "(The conversation so far.)" });
    expect(wire.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(wire[3]?.content).toEqual([{ type: "text", text: "ok" }]);
  });
});

import { ProductProposal } from "@fpv/catalog";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type Completion,
  completeJson,
  extractJson,
  JsonOutputError,
  openAICompatible,
  type Provider,
  ProviderError,
  stripThinking,
  verifierExtractor,
  verifierPrompt,
} from "../src/index.js";

function fakeFetch(reply: (body: Record<string, unknown>) => { status?: number; json: unknown }) {
  const requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, headers: init?.headers as Record<string, string>, body });
    const r = reply(body);
    return new Response(JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, requests };
}

const ok = (content: string | null, extra: Record<string, unknown> = {}) => ({
  json: {
    choices: [{ finish_reason: "stop", message: { content, ...extra } }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  },
});

describe("OpenAI-compatible provider (ADR-007 D1)", () => {
  it("sends the chat completions shape with system first, tools as functions, temperature 0 and the key", async () => {
    const { fetch, requests } = fakeFetch(() => ok("hello"));
    const p = openAICompatible(
      {
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1/",
        model: "qwen3.6:35b",
        apiKey: "k",
        extraBody: { think: false },
      },
      fetch,
    );
    const r = await p.complete({
      system: "be brief",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "get_scene", description: "read", parameters: { type: "object" } }],
      maxTokens: 50,
    });
    expect(r).toMatchObject({
      text: "hello",
      toolCalls: [],
      usage: { promptTokens: 11, completionTokens: 7 },
      finishReason: "stop",
    });
    const [req] = requests;
    expect(req?.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(req?.headers.authorization).toBe("Bearer k");
    expect(req?.body).toMatchObject({
      model: "qwen3.6:35b",
      temperature: 0,
      max_tokens: 50,
      think: false,
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "get_scene", description: "read", parameters: { type: "object" } },
        },
      ],
    });
    expect(req?.body).not.toHaveProperty("response_format");
  });

  it("adapts to a server that refuses max_tokens, temperature 0 or tools with reasoning, and remembers it", async () => {
    const { fetch, requests } = fakeFetch((body) => {
      if ("max_tokens" in body)
        return {
          status: 400,
          json: {
            error: {
              message:
                "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            },
          },
        };
      if (body.tools && body.reasoning_effort !== "none")
        return {
          status: 400,
          json: {
            error: {
              message:
                "Function tools with reasoning_effort are not supported for m in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
            },
          },
        };
      return ok("done");
    });
    const p = openAICompatible(
      { id: "openai", baseUrl: "https://api.openai.com/v1", model: "m", apiKey: "k" },
      fetch,
    );
    const req = {
      messages: [{ role: "user" as const, content: "hi" }],
      tools: [{ name: "get_scene", description: "read", parameters: { type: "object" } }],
      maxTokens: 100,
    };
    expect((await p.complete(req)).text).toBe("done");
    expect(requests).toHaveLength(3);
    expect(requests[2]?.body).toMatchObject({
      max_completion_tokens: 100,
      reasoning_effort: "none",
      temperature: 0,
    });
    expect(requests[2]?.body).not.toHaveProperty("max_tokens");
    expect(p.adaptations).toEqual([
      "max_tokens is sent as max_completion_tokens",
      'this server will not think while it calls tools, so reasoning_effort "none" is sent with them, whatever the configuration asked for',
    ]);
    await p.complete(req);
    expect(requests).toHaveLength(4);

    const refusesTemperature = fakeFetch((body) =>
      "temperature" in body
        ? {
            status: 400,
            json: {
              error: {
                message:
                  "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.",
              },
            },
          }
        : ok("fine"),
    );
    const q = openAICompatible({ id: "o", baseUrl: "https://x/v1", model: "m" }, refusesTemperature.fetch);
    expect((await q.complete({ messages: [{ role: "user", content: "hi" }] })).text).toBe("fine");
    expect(refusesTemperature.requests[1]?.body).not.toHaveProperty("temperature");

    const other = fakeFetch(() => ({ status: 400, json: { error: { message: "bad input" } } }));
    await expect(
      openAICompatible({ id: "o", baseUrl: "https://x/v1", model: "m" }, other.fetch).complete({
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("HTTP 400");
    expect(other.requests).toHaveLength(1);
  });

  it("parses tool calls, asks for JSON only when the profile supports it, and wraps HTTP errors", async () => {
    const { fetch, requests } = fakeFetch((body) =>
      body.model === "bad"
        ? { status: 429, json: { error: "slow down" } }
        : ok(null, {
            tool_calls: [{ id: "c1", type: "function", function: { name: "validate", arguments: "{}" } }],
          }),
    );
    const p = openAICompatible(
      { id: "or", baseUrl: "https://openrouter.ai/api/v1", model: "m", profile: { jsonMode: true } },
      fetch,
    );
    const r = await p.complete({ messages: [{ role: "user", content: "x" }], json: true });
    expect(r.toolCalls).toEqual([{ id: "c1", name: "validate", arguments: "{}" }]);
    expect(requests[0]?.body.response_format).toEqual({ type: "json_object" });
    const bad = openAICompatible({ id: "or", baseUrl: "https://openrouter.ai/api/v1", model: "bad" }, fetch);
    await expect(bad.complete({ messages: [] })).rejects.toBeInstanceOf(ProviderError);
    await expect(bad.complete({ messages: [] })).rejects.toThrow("HTTP 429");
  });
});

describe("structured output (ADR-007 D2)", () => {
  it("finds JSON after reasoning, inside fences, or inside prose, including braces in strings", () => {
    expect(stripThinking('<think>maybe {a}</think>{"a":1}')).toBe('{"a":1}');
    expect(extractJson('<think>let me think {"no": true}</think>\n{"a": 1}')).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n```json\n{"a": [1, 2]}\n```')).toEqual({ a: [1, 2] });
    expect(extractJson('The answer is {"note": "use {braces} and \\"quotes\\"", "n": 2}. Done.')).toEqual({
      note: 'use {braces} and "quotes"',
      n: 2,
    });
    expect(() => extractJson("no json here")).toThrow("contains no JSON");
    expect(() => extractJson('{"a": 1')).toThrow("not closed");
  });

  function scripted(replies: string[]): Provider & { seen: Completion[]; prompts: unknown[][] } {
    const prompts: unknown[][] = [];
    let i = 0;
    return {
      id: "scripted",
      model: "m",
      profile: {
        vision: false,
        toolCalls: true,
        toolReliability: "high",
        contextTokens: 8000,
        jsonMode: false,
      },
      seen: [],
      prompts,
      async complete(req) {
        prompts.push(req.messages.map((m) => m.content));
        const text = replies[Math.min(i, replies.length - 1)] as string;
        i += 1;
        return {
          text,
          toolCalls: [],
          finishReason: "stop",
          usage: { promptTokens: 5, completionTokens: 3 },
          raw: null,
        };
      },
    };
  }

  it("retries with the validation error fed back, and stops after three attempts", async () => {
    const schema = z.object({ n: z.number().int() });
    const p = scripted(['{"n": "three"}', '{"n": 3}']);
    const r = await completeJson(p, { system: "s", prompt: "give n", schema });
    expect(r).toMatchObject({
      value: { n: 3 },
      attempts: 2,
      usage: { promptTokens: 10, completionTokens: 6 },
    });
    expect(String(p.prompts[1]?.at(-1))).toContain("n: Expected number, received string");
    const never = scripted(["nope"]);
    const failure = completeJson(never, { system: "s", prompt: "give n", schema });
    await expect(failure).rejects.toBeInstanceOf(JsonOutputError);
    await expect(completeJson(scripted(["nope"]), { system: "s", prompt: "p", schema })).rejects.toThrow(
      "no valid JSON after 3 attempts",
    );
  });
});

describe("Catalog Verifier role (ADR-007 D3)", () => {
  it("prompts with the pages and schema and returns a validated proposal", async () => {
    const replies = [
      '<think>page 1 has it</think>{"found": true, "make": "Samsung", "model": "QM75C", "category": "monitor", "dims": {"w": 1673, "d": 60, "h": 963}}',
      '{"found": true, "make": "Samsung", "model": "QM75C", "category": "display", "dims": {"w": 1673, "d": 60, "h": 963}, "fieldSources": {"dims": "https://www.samsung.com/qm75c"}}',
    ];
    let i = 0;
    const prompts: string[] = [];
    const provider: Provider = {
      id: "local",
      model: "qwen",
      profile: {
        vision: false,
        toolCalls: true,
        toolReliability: "medium",
        contextTokens: 8000,
        jsonMode: false,
      },
      async complete(req) {
        prompts.push(String(req.messages[0]?.content));
        const text = replies[i] as string;
        i += 1;
        return {
          text,
          toolCalls: [],
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1 },
          raw: null,
        };
      },
    };
    const extractor = verifierExtractor(provider);
    expect(extractor.id).toBe("local:qwen");
    const input = {
      make: "Samsung",
      model: "QM75C",
      category: "display",
      pages: [{ url: "https://www.samsung.com/qm75c", text: "Samsung QM75C 1673.4 x 963.2 x 59.9 mm" }],
    };
    const proposal = await extractor.extract(input);
    expect(ProductProposal.safeParse(proposal).success).toBe(true);
    expect(proposal).toMatchObject({ category: "display", dims: { w: 1673, d: 60, h: 963 } });
    expect(i).toBe(2); // the invalid category was sent back once
    expect(prompts[0]).toContain("=== PAGE 1: https://www.samsung.com/qm75c ===");
    expect(verifierPrompt(input)).toContain('"fieldSources"');
  });
});

describe("a reply that outlasts the timeout (ADR-028 D11)", () => {
  it("is named as a timeout, with the seconds, and not as a network fault", async () => {
    // a server that never answers: the request's own timer is what ends it
    const hangs = async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
      });
    const p = openAICompatible({ id: "local", baseUrl: "http://x/v1", model: "m", timeoutMs: 20 }, hangs);
    await expect(p.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /timed out after 0s while the model was still writing/,
    );
  });
});

describe("a configured reasoning effort a server will not take (ADR-007 D1)", () => {
  it("is replaced by the one it insists on, rather than failing every request", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.tools && body.reasoning_effort !== "none")
        return new Response(
          JSON.stringify({
            error: {
              message:
                "Function tools with reasoning_effort are not supported for m in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const p = openAICompatible(
      // what a person writes in FPV_AGENT_EXTRA_BODY when they want it to think less, not none
      { id: "o", baseUrl: "https://x/v1", model: "m", extraBody: { reasoning_effort: "medium" } },
      fetch,
    );
    const out = await p.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "t", description: "t", parameters: { type: "object", properties: {} } }],
    });
    expect(out.text).toBe("ok");
    expect(bodies.map((b) => b.reasoning_effort)).toEqual(["medium", "none"]);
    expect(p.adaptations?.[0]).toContain("whatever the configuration asked for");
  });
});

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

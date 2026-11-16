// Cascade's context management inside a real run (ADR-031): the loop compacts before a call, forces a
// compaction when the server refuses a prompt as too long, measures what the wire adds, and keeps no
// reasoning but the newest.
import { describe, expect, it } from "vitest";
import {
  type AgentEvent,
  type Completion,
  type CompletionRequest,
  DEFAULT_PROFILE,
  estimateTokens,
  type Provider,
  ProviderError,
  runAgent,
} from "../src/index.js";

const tools = [
  { name: "describe_room", description: "describe a room", parameters: { type: "object", properties: {} } },
];
const fat = async () => ({ ok: true, result: { note: "x".repeat(2_400) }, warnings: [] });

/** A provider with a given window that calls describe_room `calls` times and then answers. */
function scripted(
  contextTokens: number,
  calls = 30,
  opts: { failAt?: number; reasoning?: boolean; promptTokens?: number } = {},
) {
  const requests: CompletionRequest[] = [];
  let i = 0;
  let failed = false;
  const provider: Provider = {
    id: "fake",
    model: "fake-model",
    profile: { ...DEFAULT_PROFILE, contextTokens, streaming: false },
    async complete(req) {
      requests.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) });
      if (opts.failAt !== undefined && i + 1 === opts.failAt && !failed) {
        failed = true;
        throw new ProviderError("fake", 400, "HTTP 400: This model's maximum context length is 12000 tokens");
      }
      i += 1;
      const done = i > calls;
      const reply: Completion = {
        text: done ? "Done." : null,
        toolCalls: done
          ? []
          : [{ id: `c${i}`, name: "describe_room", arguments: JSON.stringify({ roomId: `r${i}` }) }],
        finishReason: done ? "stop" : "tool_calls",
        usage: { promptTokens: opts.promptTokens ?? 0, completionTokens: 10 },
        ...(opts.reasoning
          ? {
              reasoning: [
                { type: "reasoning" as const, wire: "anthropic", data: { n: i }, text: `thought ${i}` },
              ],
            }
          : {}),
        raw: null,
      };
      return reply;
    },
  };
  return { provider, requests };
}

const base = {
  tools,
  system: "you draw floor plans",
  task: "build a one bedroom flat",
  maxSteps: 60,
  callTool: fat,
  gates: { plan: false, verify: false, idle: false },
};

describe("compaction inside a run (ADR-031)", () => {
  it("compacts before a call once the prompt crosses the plan's trigger, says what it did, and finishes", async () => {
    const { provider } = scripted(12_000);
    const events: AgentEvent[] = [];
    const run = await runAgent({ ...base, provider, onEvent: (e) => events.push(e) });
    expect(run.reason).toBe("done");
    const compacted = events.filter((e) => e.type === "compacted");
    expect(compacted.length).toBeGreaterThan(0);
    for (const e of compacted)
      if (e.type === "compacted") {
        expect(e.after).toBeLessThan(e.before);
        expect(e.forced).toBe(false);
        expect(e.label).not.toBe("");
      }
  });

  it("forces a compaction and retries when the server refuses the prompt as too long", async () => {
    const { provider, requests } = scripted(12_000, 12, { failAt: 10 });
    const events: AgentEvent[] = [];
    const run = await runAgent({ ...base, provider, onEvent: (e) => events.push(e) });
    expect(run.reason).toBe("done");
    const forced = events.filter((e) => e.type === "compacted" && e.forced);
    expect(forced).toHaveLength(1);
    // The tenth request was refused; the retry went out smaller than it.
    const refused = requests[9] as CompletionRequest;
    const retry = requests[10] as CompletionRequest;
    expect(estimateTokens(retry.messages)).toBeLessThan(estimateTokens(refused.messages));
  });

  it("refuses before sending anything when the instructions alone cannot fit the window", async () => {
    const { provider, requests } = scripted(2_000);
    const run = await runAgent({ ...base, provider, system: "x".repeat(20_000) });
    expect(run.reason).toBe("context-full");
    expect(run.error).toMatch(/instructions and tool schemas alone/);
    expect(requests).toHaveLength(0);
  });

  it("takes a hosted model's window from its name when nobody set one", async () => {
    // A default profile (32,000) on a model the map knows: the map's window governs, so a run that would
    // compact at 32k does not.
    const { provider } = scripted(DEFAULT_PROFILE.contextTokens, 30);
    const named = { ...provider, model: "gpt-6-luna" };
    const events: AgentEvent[] = [];
    const run = await runAgent({ ...base, provider: named, onEvent: (e) => events.push(e) });
    expect(run.reason).toBe("done");
    expect(events.some((e) => e.type === "compacted")).toBe(false);
  });

  it("compacts earlier when the server says the prompt is bigger than the estimate (measured overhead)", async () => {
    const quiet = scripted(40_000, 20);
    const loud = scripted(40_000, 20, { promptTokens: 31_000 });
    const quietEvents: AgentEvent[] = [];
    const loudEvents: AgentEvent[] = [];
    await runAgent({ ...base, provider: quiet.provider, onEvent: (e) => quietEvents.push(e) });
    await runAgent({ ...base, provider: loud.provider, onEvent: (e) => loudEvents.push(e) });
    expect(quietEvents.some((e) => e.type === "compacted")).toBe(false);
    expect(loudEvents.some((e) => e.type === "compacted")).toBe(true);
  });
});

describe("reasoning (ADR-031 D2.6)", () => {
  it("is kept on the newest assistant message only, so it never accumulates", async () => {
    const { provider, requests } = scripted(200_000, 5, { reasoning: true });
    const run = await runAgent({ ...base, provider });
    expect(run.reason).toBe("done");
    for (const r of requests) {
      const carrying = r.messages.filter(
        (m) =>
          m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "reasoning"),
      );
      expect(carrying.length).toBeLessThanOrEqual(1);
    }
    const kept = run.messages.filter(
      (m) =>
        m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "reasoning"),
    );
    expect(kept).toHaveLength(1);
  });
});

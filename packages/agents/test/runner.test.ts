// ADR-007 D3: the agent loop against a scripted provider: tool calls fed back in order, malformed and text-borne
// calls, retries, the step budget, stalls, result shaping, abort, and tools advertised by profile.
import { AV_CORE } from "@fpv/catalog";
import { describe, expect, it } from "vitest";
import { createSession } from "../../../apps/host/src/session.js";
import {
  type AgentEvent,
  type ChatMessage,
  type Completion,
  type CompletionRequest,
  type Provider,
  ProviderError,
  parseToolArguments,
  registryToolSpecs,
  runAgent,
  type ToolCall,
  toolCallsInText,
  toolResultText,
} from "../src/index.js";

const usage = { promptTokens: 10, completionTokens: 5 };
const reply = (text: string | null, toolCalls: ToolCall[] = []): Completion => ({
  text,
  toolCalls,
  finishReason: toolCalls.length ? "tool_calls" : "stop",
  usage,
  raw: null,
});
const call = (name: string, args: unknown, id = `c_${name}`): ToolCall => ({
  id,
  name,
  arguments: typeof args === "string" ? args : JSON.stringify(args),
});

/** A provider that answers from a script; each entry sees the request so far. */
function scripted(steps: ((req: CompletionRequest) => Completion | Error)[]): Provider & {
  requests: CompletionRequest[];
} {
  const requests: CompletionRequest[] = [];
  let i = 0;
  return {
    id: "fake",
    model: "fake-1",
    profile: {
      vision: false,
      toolCalls: true,
      toolReliability: "medium",
      contextTokens: 32000,
      jsonMode: false,
    },
    requests,
    async complete(req) {
      requests.push({ ...req, messages: [...req.messages] });
      const step = steps[Math.min(i, steps.length - 1)] as (r: CompletionRequest) => Completion | Error;
      i += 1;
      const out = step(req);
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

const tools = [
  { name: "get_scene", description: "scene", parameters: { type: "object", properties: {} } },
  { name: "validate", description: "validate", parameters: { type: "object", properties: {} } },
];
const noSleep = async () => {};

describe("agent runner (ADR-007 D3)", () => {
  it("runs tool calls in order, feeds results back by id, and ends on a plain answer", async () => {
    const calls: [string, unknown][] = [];
    const provider = scripted([
      () => reply(null, [call("get_scene", { detail: "summary" }, "a"), call("validate", {}, "b")]),
      () => ({
        ...reply("<think>checking</think>Built nothing; the scene is empty."),
        usage: { promptTokens: 30, completionTokens: 5 },
      }),
    ]);
    const events: AgentEvent[] = [];
    const run = await runAgent({
      provider,
      tools,
      system: "sys",
      task: "look",
      callTool: async (name, args) => {
        calls.push([name, args]);
        return { ok: true, result: { name }, warnings: [] };
      },
      onEvent: (e) => events.push(e),
    });
    expect(run).toMatchObject({ reason: "done", steps: 2, toolCalls: 2, failedCalls: 0 });
    expect(run.text).toBe("Built nothing; the scene is empty.");
    expect(run.usage).toEqual({ promptTokens: 40, completionTokens: 10 });
    expect(calls).toEqual([
      ["get_scene", { detail: "summary" }],
      ["validate", {}],
    ]);
    const second = provider.requests[1] as CompletionRequest;
    expect(second.temperature).toBe(0);
    expect(second.system).toBe("sys");
    expect(second.messages.map((m) => [m.role, m.toolCallId ?? null])).toEqual([
      ["user", null],
      ["assistant", null],
      ["tool", "a"],
      ["tool", "b"],
    ]);
    // A tool is announced before it runs and again when it is done, so a card can be drawn while the
    // work happens rather than appearing once it is over.
    expect(events.map((e) => e.type)).toEqual([
      "step.started",
      "reply",
      "tool.started",
      "tool.finished",
      "tool.started",
      "tool.finished",
      "step.started",
      "reply",
      "done",
    ]);
  });

  it("turns malformed arguments into an error the model can fix, recovers fenced JSON, and reads calls from text", async () => {
    expect(parseToolArguments("")).toEqual({ ok: true, value: {} });
    expect(parseToolArguments('```json\n{"a": 1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseToolArguments("[1]").ok).toBe(false);
    const known = new Set(["get_scene"]);
    expect(
      toolCallsInText(
        'Let me look.\n<tool_call>\n{"name": "get_scene", "arguments": {"detail": "summary"}}\n</tool_call>',
        known,
      ),
    ).toEqual({
      calls: [{ id: "text_call_0", name: "get_scene", arguments: '{"detail":"summary"}' }],
      rest: "Let me look.",
    });
    expect(toolCallsInText('{"name": "rm_rf", "arguments": {}}', known).calls).toEqual([]);

    const seen: unknown[] = [];
    const provider = scripted([
      () => reply(null, [call("validate", "{not json")]),
      () => reply('<tool_call>{"name": "validate", "arguments": {}}</tool_call>'),
      () => reply("done"),
    ]);
    const run = await runAgent({
      provider,
      tools,
      system: "s",
      task: "t",
      callTool: async (name, args) => {
        seen.push([name, args]);
        return { ok: true, result: {}, warnings: [] };
      },
    });
    expect(run).toMatchObject({ reason: "done", toolCalls: 2, failedCalls: 1 });
    expect(seen).toEqual([["validate", {}]]);
    const toolMsg = (provider.requests[1] as CompletionRequest).messages.at(-1) as ChatMessage;
    expect(JSON.parse(toolMsg.content as string)).toMatchObject({ ok: false, error: { code: "args.json" } });
    expect(run.events.find((e) => e.type === "reply" && e.fromText)).toBeDefined();
  });

  it("retries transient provider failures with backoff and stops on a permanent one", async () => {
    const waits: number[] = [];
    const flaky = scripted([
      () => new ProviderError("fake", 503, "busy"),
      () => new ProviderError("fake", null, "socket hang up"),
      () => reply("ok"),
    ]);
    const run = await runAgent({
      provider: flaky,
      tools,
      system: "s",
      task: "t",
      callTool: async () => ({ ok: true }),
      // This is about backoff, not about gates; the idle gate would ask the script for a turn it
      // does not have.
      gates: { idle: false },
      retryDelayMs: 100,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(run).toMatchObject({ reason: "done", steps: 1 });
    expect(waits).toEqual([100, 200]);
    const broken = await runAgent({
      provider: scripted([() => new ProviderError("fake", 400, "bad request")]),
      tools,
      system: "s",
      task: "t",
      callTool: async () => ({ ok: true }),
      gates: { idle: false },
      sleep: noSleep,
    });
    expect(broken).toMatchObject({ reason: "provider-error", error: "fake: bad request" });
  });

  it("stops at the step budget after warning the model, and stops when the same call keeps failing", async () => {
    const busy = scripted([(req) => reply(null, [call("get_scene", { page: req.messages.length })])]);
    const run = await runAgent({
      provider: busy,
      tools,
      system: "s",
      task: "t",
      maxSteps: 5,
      callTool: async () => ({ ok: true, result: {} }),
    });
    expect(run).toMatchObject({ reason: "step-budget", steps: 5, toolCalls: 5 });
    expect(
      (busy.requests[3] as CompletionRequest).messages.some(
        (m) => m.role === "user" && String(m.content).includes("Three model turns remain"),
      ),
    ).toBe(true);

    const stuck = await runAgent({
      provider: scripted([() => reply(null, [call("validate", { levelId: "nope" })])]),
      tools,
      system: "s",
      task: "t",
      callTool: async () => ({ ok: false, error: { code: "ref.missing", message: "no level" } }),
    });
    expect(stuck).toMatchObject({ reason: "stalled", steps: 3, failedCalls: 3 });
  });

  it("stops repeated failures that are not consecutive and loops of the same calls, and warns when the prompt stops growing", async () => {
    let n = 0;
    const alternating = scripted([
      () => {
        n += 1;
        return reply(null, [n % 2 ? call("get_scene", { detail: "summary" }) : call("create", {})]);
      },
    ]);
    const failing = await runAgent({
      provider: alternating,
      tools,
      system: "s",
      task: "t",
      callTool: async (name) =>
        name === "create" ? { ok: false, error: { code: "tool.unknown", message: "no tool" } } : { ok: true },
    });
    expect(failing).toMatchObject({ reason: "stalled", steps: 6, failedCalls: 3 });
    expect(failing.error).toContain("(create)");

    let m = 0;
    const circling = scripted([
      () => {
        m += 1;
        return reply(null, [m % 2 ? call("project", { op: "info" }) : call("get_scene", {})]);
      },
    ]);
    const circle = await runAgent({
      provider: circling,
      tools,
      system: "s",
      task: "t",
      callTool: async () => ({ ok: true }),
    });
    expect(circle).toMatchObject({ reason: "stalled", steps: 8, failedCalls: 0 });
    expect(circle.error).toBe("the last 8 tool calls repeat the same two calls");

    let page = 0;
    const flat = scripted([
      () => ({
        ...reply(null, [call("get_scene", { page: (page += 1) })]),
        usage: { promptTokens: 2050, completionTokens: 5 },
      }),
    ]);
    const events: AgentEvent[] = [];
    await runAgent({
      provider: flat,
      tools,
      system: "s",
      task: "t",
      maxSteps: 4,
      callTool: async () => ({ ok: true }),
      onEvent: (e) => events.push(e),
    });
    const warnings = events.filter((e) => e.type === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ step: 2 });
  });

  it("drops image data and cuts long results; an aborted run stops before the next turn", async () => {
    const text = toolResultText({ ok: true, result: { images: [{ pngBase64: "A".repeat(4000) }] } });
    expect(text).toContain("[image omitted: 3000 bytes]");
    expect(toolResultText({ big: "x".repeat(100) }, 40)).toMatch(/cut: \d+ more characters; narrow the call/);
    const controller = new AbortController();
    const run = await runAgent({
      provider: scripted([() => reply(null, [call("get_scene", {})])]),
      tools,
      system: "s",
      task: "t",
      signal: controller.signal,
      callTool: async () => {
        controller.abort();
        return { ok: true };
      },
    });
    expect(run).toMatchObject({ reason: "aborted", steps: 1 });
  });

  it("advertises the registry's tools for the profile as JSON Schema without the strict extras", () => {
    const { registry } = createSession({ rules: AV_CORE });
    const low = registryToolSpecs(registry, "low");
    const high = registryToolSpecs(registry, "high");
    expect(low.length).toBeLessThan(high.length);
    expect(low.map((t) => t.name)).toContain("create_room_from_brief");
    expect(low.map((t) => t.name)).not.toContain("create_walls");
    const brief = low.find((t) => t.name === "create_room_from_brief");
    expect(brief?.parameters).toMatchObject({ type: "object", required: ["brief"] });
    expect(brief?.parameters).not.toHaveProperty("$schema");
    expect(brief?.parameters).not.toHaveProperty("additionalProperties");
  });
});

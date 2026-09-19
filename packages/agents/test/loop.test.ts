// The loop's own two tools and its gates (ADR-022).
//
// These are what make a long build finish rather than stop after three rooms with "I have made a
// start". None of them touches the project: a plan is the model's working memory, a question is a
// conversation, and a gate is a sentence that costs one more turn.
import { describe, expect, it } from "vitest";
import {
  type AgentEvent,
  type AskRequest,
  afterGate,
  afterTool,
  applyPlan,
  type ChatMessage,
  type Completion,
  type CompletionRequest,
  DEFAULT_PROFILE,
  gateFor,
  newGateState,
  type PlanItem,
  type Provider,
  planForPrompt,
  runAgent,
} from "../src/index.js";

const reply = (
  text: string | null,
  calls: { id: string; name: string; args: unknown }[] = [],
): Completion => ({
  text,
  toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.args) })),
  finishReason: calls.length ? "tool_calls" : "stop",
  usage: { promptTokens: 1, completionTokens: 1 },
  raw: null,
});

function scripted(
  steps: ((req: CompletionRequest) => Completion)[],
  profile = {},
): Provider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  let i = 0;
  return {
    id: "fake",
    model: "fake-1",
    profile: { ...DEFAULT_PROFILE, ...profile },
    requests,
    async complete(req) {
      requests.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) as ChatMessage[] });
      const step = steps[Math.min(i, steps.length - 1)] as (r: CompletionRequest) => Completion;
      i += 1;
      return step(req);
    },
  };
}

const tools = [
  { name: "create_walls", description: "walls", parameters: { type: "object", properties: {} } },
];
const base = {
  tools,
  system: "sys",
  task: "build something",
  callTool: async () => ({ ok: true, result: {}, warnings: [] }),
  sleep: async () => {},
};

const item = (id: string, text: string, status: PlanItem["status"]): PlanItem => ({ id, text, status });

describe("the plan a model keeps", () => {
  it("takes a list, and says in one line where the work stands", () => {
    const r = applyPlan([], {
      items: [
        { id: "a", text: "outer walls", status: "done" },
        { id: "b", text: "rooms", status: "doing" },
        { id: "c", text: "furniture", status: "pending" },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toHaveLength(3);
    expect(r.summary).toContain("1 of 3 done");
    expect(r.summary).toContain("now: rooms");
  });

  it("refuses a list that quietly drops a job, and names the job", () => {
    const current = [item("a", "outer walls", "done"), item("b", "tint the windows", "pending")];
    const r = applyPlan(current, { items: [{ id: "a", text: "outer walls", status: "done" }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("tint the windows");
    expect(r.hint).toContain("skipped");
    // marking it skipped is how a job is dropped on purpose
    const said = applyPlan(current, {
      items: [
        { id: "a", text: "outer walls", status: "done" },
        { id: "b", text: "tint the windows", status: "skipped" },
      ],
    });
    expect(said.ok).toBe(true);
  });

  it("refuses two jobs in hand at once, and an item with no text", () => {
    const two = applyPlan([], {
      items: [
        { id: "a", text: "one", status: "doing" },
        { id: "b", text: "two", status: "doing" },
      ],
    });
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.error).toContain("doing");
    const empty = applyPlan([], { items: [{ text: "  ", status: "pending" }] });
    expect(empty.ok).toBe(false);
  });

  it("rides on the system prompt, so it survives whatever happens to the conversation", () => {
    const text = planForPrompt([item("a", "outer walls", "done"), item("b", "rooms", "doing")]);
    expect(text).toContain("[x] outer walls");
    expect(text).toContain("[>] rooms");
    expect(planForPrompt([])).toBe("");
  });
});

describe("the gates", () => {
  const open: PlanItem[] = [item("a", "tint the windows", "pending")];
  const sets = { mutating: new Set(["create_walls"]), verifying: new Set(["validate"]) };

  it("will not let a model stop with its own plan unfinished, but only so many times", () => {
    let state = newGateState();
    const first = gateFor(state, open);
    expect(first?.gate).toBe("plan");
    expect(first?.text).toContain("tint the windows");
    state = afterGate(state, "plan");
    expect(gateFor(state, open)?.gate).toBe("plan");
    state = afterGate(state, "plan");
    // twice is a reminder; a third time is nagging, and the model's answer stands
    expect(gateFor(state, open)).toBeNull();
  });

  it("re-arms when the model does something, so a nudge is per stall and not per run", () => {
    let state = afterGate(newGateState(), "plan");
    state = afterTool(state, "create_walls", true, sets);
    expect(gateFor(state, open)?.gate).toBe("plan");
  });

  it("asks for a check after a change, once, and a check clears it", () => {
    let state = afterTool(newGateState(), "create_walls", true, sets);
    const gate = gateFor(state, []);
    expect(gate?.gate).toBe("verify");
    expect(gate?.text).toContain("create_walls");
    state = afterGate(state, "verify");
    expect(gateFor(state, [])).toBeNull();

    let checked = afterTool(newGateState(), "create_walls", true, sets);
    checked = afterTool(checked, "validate", true, sets);
    expect(gateFor(checked, [])).toBeNull();
  });

  it("says nothing about a change that was refused", () => {
    const state = afterTool(newGateState(), "create_walls", false, sets);
    expect(gateFor(state, [])).toBeNull();
  });
});

describe("the loop with its tools", () => {
  it("keeps the plan itself, and never asks the caller to run it", async () => {
    const called: string[] = [];
    const run = await runAgent({
      ...base,
      provider: scripted([
        () =>
          reply(null, [
            { id: "c1", name: "plan_work", args: { items: [{ id: "a", text: "walls", status: "doing" }] } },
          ]),
        () =>
          reply(null, [
            { id: "c2", name: "plan_work", args: { items: [{ id: "a", text: "walls", status: "done" }] } },
          ]),
        () => reply("Built."),
      ]),
      callTool: async (name) => {
        called.push(name);
        return { ok: true, result: {}, warnings: [] };
      },
    });
    expect(called).toEqual([]); // the registry never sees plan_work
    expect(run.plan).toEqual([{ id: "a", text: "walls", status: "done" }]);
    expect(run.events.filter((e) => e.type === "plan.updated")).toHaveLength(2);
    expect(run.reason).toBe("done");
  });

  it("tells a model why its plan was refused, rather than dropping the job", async () => {
    const run = await runAgent({
      ...base,
      provider: scripted([
        () =>
          reply(null, [
            {
              id: "c1",
              name: "plan_work",
              args: {
                items: [
                  { id: "a", text: "walls", status: "pending" },
                  { id: "b", text: "windows", status: "pending" },
                ],
              },
            },
          ]),
        () =>
          reply(null, [
            { id: "c2", name: "plan_work", args: { items: [{ id: "a", text: "walls", status: "done" }] } },
          ]),
        () => reply("Done."),
      ]),
      gates: { plan: false },
    });
    const refused = run.events.find((e) => e.type === "tool.finished" && !e.ok) as Extract<
      AgentEvent,
      { type: "tool.finished" }
    >;
    expect((refused.result as { error: { message: string } }).error.message).toContain("windows");
    // the plan still holds both jobs
    expect(run.plan.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("stops at a question until a person answers, and tells the model what they said", async () => {
    const asked: AskRequest[] = [];
    const run = await runAgent({
      ...base,
      provider: scripted([
        () =>
          reply(null, [
            {
              id: "q1",
              name: "ask_user",
              args: {
                question: "Which room?",
                kind: "choice",
                options: [
                  { id: "a", label: "Boardroom" },
                  { id: "b", label: "Huddle" },
                ],
              },
            },
          ]),
        () => reply("Done."),
      ]),
      loop: {
        ask: async (request) => {
          asked.push(request);
          return { [request.id]: "a" };
        },
      },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.kind).toBe("choice");
    const answered = run.events.find((e) => e.type === "tool.finished" && e.name === "ask_user") as Extract<
      AgentEvent,
      { type: "tool.finished" }
    >;
    expect((answered.result as { result: { answered: string } }).result.answered).toContain("Boardroom");
    expect(run.events.some((e) => e.type === "question.answered")).toBe(true);
  });

  it("ends the run when a question is abandoned", async () => {
    const controller = new AbortController();
    const run = await runAgent({
      ...base,
      signal: controller.signal,
      provider: scripted([
        () => reply(null, [{ id: "q1", name: "ask_user", args: { question: "Which room?" } }]),
        () => reply("Done."),
      ]),
      loop: {
        ask: async () => {
          controller.abort();
          throw new Error("the run was abandoned");
        },
      },
    });
    expect(run.reason).toBe("aborted");
  });

  it("offers ask_user only when there is someone to ask", async () => {
    const withNobody = scripted([() => reply("Done.")]);
    await runAgent({ ...base, provider: withNobody });
    expect(withNobody.requests[0]?.tools?.map((t) => t.name)).toEqual(["create_walls", "plan_work"]);

    const withSomeone = scripted([() => reply("Done.")]);
    await runAgent({ ...base, provider: withSomeone, loop: { ask: async () => ({}) } });
    expect(withSomeone.requests[0]?.tools?.map((t) => t.name)).toContain("ask_user");
  });

  it("carries on rather than stopping, when a gate has something to say", async () => {
    const provider = scripted([
      () =>
        reply(null, [
          {
            id: "c1",
            name: "plan_work",
            args: {
              items: [
                { id: "a", text: "walls", status: "done" },
                { id: "b", text: "windows", status: "pending" },
              ],
            },
          },
        ]),
      () => reply("I have made a start."),
      () => reply("Finished the windows too."),
    ]);
    const run = await runAgent({ ...base, provider });
    const reminder = run.events.find((e) => e.type === "reminder") as Extract<
      AgentEvent,
      { type: "reminder" }
    >;
    expect(reminder.gate).toBe("plan");
    expect(reminder.text).toContain("windows");
    expect(run.text).toBe("Finished the windows too.");
    // the model was told, in the conversation, and the reminder is not the model's own words
    expect(provider.requests.at(-1)?.messages.at(-1)?.role).toBe("user");
  });
});

describe("a conversation that carries on", () => {
  it("starts from the turns before it, and gives back the whole conversation", async () => {
    const provider = scripted([() => reply("A table is in the middle.")]);
    const history: ChatMessage[] = [
      { role: "user", content: "Draw a 6 by 4 metre room" },
      { role: "assistant", content: "Drawn." },
    ];
    const run = await runAgent({ ...base, provider, task: "now add a table", history });
    expect(provider.requests[0]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(provider.requests[0]?.messages.at(-1)?.content).toBe("now add a table");
    // the next turn starts from this
    expect(run.messages.slice(0, 2)).toEqual(history);
    expect(run.messages.at(-1)?.role).toBe("assistant");
  });
});

describe("what a model is shown of its own work", () => {
  const renderResult = {
    ok: true,
    result: { views: [{ name: "plan" }], images: [{ name: "plan", pngBase64: "AAAA" }] },
    warnings: [],
  };

  it("puts a render in front of a model that can see, and takes the last one away", async () => {
    const provider = scripted(
      [
        () => reply(null, [{ id: "r1", name: "render", args: { view: "plan" } }]),
        () => reply(null, [{ id: "r2", name: "render", args: { view: "plan" } }]),
        () => reply("Looks right."),
      ],
      { vision: true },
    );
    await runAgent({ ...base, provider, callTool: async () => renderResult });
    const last = provider.requests.at(-1) as CompletionRequest;
    const images = last.messages.filter(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
    );
    expect(images).toHaveLength(1); // only the newest picture is still there
    const stale = last.messages.filter(
      (m) =>
        Array.isArray(m.content) && m.content.some((p) => p.type === "text" && p.text.includes("taken away")),
    );
    expect(stale).toHaveLength(1);
  });

  it("shows nothing to a model that cannot see", async () => {
    const provider = scripted([
      () => reply(null, [{ id: "r1", name: "render", args: {} }]),
      () => reply("Done."),
    ]);
    await runAgent({ ...base, provider, callTool: async () => renderResult });
    const last = provider.requests.at(-1) as CompletionRequest;
    expect(last.messages.some((m) => Array.isArray(m.content))).toBe(false);
  });
});

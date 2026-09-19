// The in-app agent, per project (P4-1, ADR-022).
//
// The runner's own rules are tested in @fpv/agents against scripts. These are the host's part: one
// run at a time, the conversation a follow-up needs, the events a tab draws, the checkpoint that
// makes a run undoable, and what happens to a question when the person walks away.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChatMessage,
  type Completion,
  type CompletionRequest,
  DEFAULT_PROFILE,
  type Provider,
} from "@fpv/agents";
import type { AgentEventMsg, AgentWireEvent } from "@fpv/commands";
import { describe, expect, it } from "vitest";
import { AgentRuns } from "../src/agent-runs.js";
import { Workspace } from "../src/workspace.js";

const NOW = "2026-09-19T12:00:00.000Z";
const temp = () => mkdtempSync(join(tmpdir(), "fpv-agent-"));

const reply = (
  text: string | null,
  calls: { id: string; name: string; args: unknown }[] = [],
): Completion => ({
  text,
  toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.args) })),
  finishReason: calls.length ? "tool_calls" : "stop",
  usage: { promptTokens: 3, completionTokens: 2 },
  raw: null,
});

function scripted(steps: ((req: CompletionRequest) => Completion)[]): Provider & {
  requests: CompletionRequest[];
} {
  const requests: CompletionRequest[] = [];
  let i = 0;
  return {
    id: "fake",
    model: "fake-1",
    profile: { ...DEFAULT_PROFILE },
    requests,
    async complete(req) {
      requests.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) as ChatMessage[] });
      const step = steps[Math.min(i, steps.length - 1)] as (r: CompletionRequest) => Completion;
      i += 1;
      // A turn of the real loop is never synchronous; without this the test never sees a run in flight.
      await new Promise((r) => setTimeout(r, 1));
      return step(req);
    },
  };
}

/** A workspace with one project, and an agent watching it. */
async function setup(steps: ((req: CompletionRequest) => Completion)[], options = {}) {
  const workspace = new Workspace({ now: () => NOW });
  const held = await workspace.create("Test");
  const seen: AgentEventMsg[] = [];
  const agent = new AgentRuns(workspace, {
    provider: scripted(steps),
    now: () => NOW,
    dataDir: null,
    ...options,
  });
  agent.onEvent((_projectId, msg) => seen.push(msg));
  const done = () =>
    new Promise<void>((resolve) => {
      const stop = agent.onEvent((_p, m) => {
        if (m.event.type === "run.finished") {
          stop();
          resolve();
        }
      });
    });
  const events = () => seen.map((m) => m.event);
  const of = <T extends AgentWireEvent["type"]>(type: T) =>
    events().filter((e) => e.type === type) as Extract<AgentWireEvent, { type: T }>[];
  return { workspace, held, agent, seen, events, of, done };
}

describe("one run at a time, per project", () => {
  it("says what it is doing from start to finish, in order", async () => {
    const { agent, held, done, events, of } = await setup([
      (_req) => reply(null, [{ id: "c1", name: "get_scene", args: { detail: "summary" } }]),
      () => reply("Read the project."),
    ]);
    const started = agent.start(held, { text: "look at this" });
    expect(started.ok).toBe(true);
    await done();

    const types = events().map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types.at(-1)).toBe("run.finished");
    expect(types).toContain("tool.started");
    expect(types).toContain("tool.finished");

    const finished = of("run.finished")[0];
    expect(finished?.reason).toBe("done");
    expect(finished?.text).toBe("Read the project.");

    // the card gets a line and what moved, never the whole result
    const tool = of("tool.finished")[0];
    expect(tool?.name).toBe("get_scene");
    expect(tool?.ok).toBe(true);
    expect(tool?.preview.length).toBeLessThanOrEqual(401);
    expect(of("tool.started")[0]?.summary).toBe("Reading the project");
  });

  it("says nothing about its own two tools: the plan card and the question are what they mean", async () => {
    const { agent, held, done, of, events } = await setup([
      () =>
        reply(null, [
          {
            id: "c1",
            name: "plan_work",
            args: { items: [{ id: "a", text: "walls", status: "done" }] },
          },
        ]),
      () => reply("Planned."),
    ]);
    agent.start(held, { text: "plan it" });
    await done();
    expect(of("plan.updated")).toHaveLength(1);
    // no "plan work" row beside the plan card, saying the same thing in worse words
    expect(events().filter((e) => e.type === "tool.started" || e.type === "tool.finished")).toEqual([]);
  });

  it("refuses a second run while one is in flight, and says why", async () => {
    const { agent, held, done } = await setup([() => reply("Done.")]);
    expect(agent.start(held, { text: "one" }).ok).toBe(true);
    const second = agent.start(held, { text: "two" });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("agent.busy");
      expect(second.error.hint).toContain("cancel");
    }
    await done();
    // and once it is over, another may start
    expect(agent.start(held, { text: "three" }).ok).toBe(true);
  });

  it("marks a checkpoint first, so a whole run is one undo", async () => {
    const { agent, held, done, of } = await setup([
      () =>
        reply(null, [
          {
            id: "c1",
            name: "create_walls",
            args: {
              levelId: "level_000000",
              points: [
                { x: 0, y: 0 },
                { x: 3000, y: 0 },
              ],
              closed: false,
            },
          },
        ]),
      () => reply("Drawn."),
    ]);
    agent.start(held, { text: "draw a wall" });
    await done();
    const checkpointId = of("run.started")[0]?.checkpointId;
    expect(checkpointId).toBeTruthy();
    expect(held.session.store.project.walls).toHaveLength(1);
    held.session.store.restore(checkpointId as string);
    expect(held.session.store.project.walls).toHaveLength(0);
  });

  it("gives up when there is no model, rather than pretending to think", async () => {
    const workspace = new Workspace({ now: () => NOW });
    const held = await workspace.create("Test");
    const agent = new AgentRuns(workspace, { provider: null, note: "no agent model here" });
    const r = agent.start(held, { text: "build something" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("agent.unavailable");
    expect(agent.state(held.id).available).toBe(false);
    expect(agent.state(held.id).note).toBe("no agent model here");
  });
});

describe("a conversation that carries on", () => {
  it("remembers the turn before, so a follow-up knows what it means", async () => {
    const provider = scripted([() => reply("Done.")]);
    const workspace = new Workspace({ now: () => NOW });
    const held = await workspace.create("Test");
    const agent = new AgentRuns(workspace, { provider, now: () => NOW, dataDir: null });
    const finished = () =>
      new Promise<void>((resolve) => {
        const stop = agent.onEvent((_p, m) => {
          if (m.event.type === "run.finished") {
            stop();
            resolve();
          }
        });
      });

    agent.start(held, { text: "draw a meeting room" });
    await finished();
    agent.start(held, { text: "now add a table" });
    await finished();

    // the second request carries the first exchange
    const second = provider.requests.at(-1) as CompletionRequest;
    const said = second.messages.filter((m) => m.role === "user").map((m) => String(m.content));
    expect(said[0]).toContain("draw a meeting room");
    expect(said.at(-1)).toContain("now add a table");

    // and clearing it starts from nothing again
    agent.clear(held.id);
    agent.start(held, { text: "start over" });
    await finished();
    const third = provider.requests.at(-1) as CompletionRequest;
    expect(third.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });
});

describe("asking a person", () => {
  const asking = (question: string) =>
    reply(null, [{ id: "q1", name: "ask_user", args: { question, kind: "text" } }]);

  it("waits for an answer and tells the model what was said", async () => {
    const { agent, held, done, of } = await setup([() => asking("Which room?"), () => reply("Done.")]);
    agent.start(held, { text: "put a table somewhere" });

    // the question reaches the tab, and the run says it is waiting
    const question = await waitFor(() => of("question")[0]);
    expect(question.text).toBe("Which room?");
    expect(agent.state(held.id).run?.status).toBe("waiting");

    expect(agent.answer(held, question.id, { [question.id]: "the boardroom" })).toBe(true);
    await done();
    const answered = of("question.answered")[0];
    expect(answered?.by).toBe("person");
    expect(of("run.finished")[0]?.reason).toBe("done");
  });

  it("takes the answer from the review panel when a draft is committed there", async () => {
    const { agent, held, done, of } = await setup([
      () => reply(null, [{ id: "q1", name: "ask_user", args: { question: "What scale?", kind: "scale" } }]),
      () => reply("Committed."),
    ]);
    agent.start(held, { text: "read this plan" });
    await waitFor(() => of("question")[0]);
    expect(agent.draftCommitted(held, "the person committed the draft")).toBe(true);
    await done();
    expect(of("question.answered")[0]?.by).toBe("review");
  });

  it("ends the run rather than waiting for somebody who has gone", async () => {
    const { agent, held, done, of } = await setup([() => asking("Which room?"), () => reply("Done.")]);
    agent.start(held, { text: "put a table somewhere" });
    await waitFor(() => of("question")[0]);
    expect(agent.cancel(held)).toBe(true);
    await done();
    expect(of("run.finished")[0]?.reason).toBe("aborted");
  });

  it("says so when an answer arrives for a question nobody asked", async () => {
    const { agent, held } = await setup([() => reply("Done.")]);
    expect(agent.answer(held, "q9", { q9: "yes" })).toBe(false);
  });
});

describe("a tab that arrives late", () => {
  it("is told what the agent is and what it has done, without the typing", async () => {
    const { agent, held, done } = await setup([
      () => reply(null, [{ id: "c1", name: "get_scene", args: { detail: "summary" } }]),
      () => reply("Read it."),
    ]);
    agent.start(held, { text: "look" });
    await done();

    const state = agent.state(held.id);
    expect(state.available).toBe(true);
    expect(state.model).toBe("fake-1");
    expect(state.run).toBeNull();
    const replayed = state.replay.map((m) => m.event.type);
    expect(replayed[0]).toBe("run.started");
    expect(replayed).toContain("tool.finished");
    // deltas are re-derivable noise; a reloaded tab wants the answer, not the typing
    expect(replayed).not.toContain("text.delta");

    // and it can ask for only what it missed
    const seq = state.replay[1]?.seq ?? 0;
    expect(agent.history(held.id, seq).every((m) => m.seq > seq)).toBe(true);
  });
});

describe("what a run writes down", () => {
  it("keeps the conversation and the run where a restart can read them", async () => {
    const dir = temp();
    const { agent, held, done } = await setup([() => reply("Done.")], { dataDir: dir });
    agent.start(held, { text: "draw something" });
    await done();
    await new Promise((r) => setTimeout(r, 20));

    const conversation = readFileSync(join(dir, "agents", held.id, "conversation.jsonl"), "utf8");
    expect(conversation).toContain("draw something");
    const run = readFileSync(join(dir, "agents", held.id, "runs", "run_1.jsonl"), "utf8");
    expect(run).toContain("run.started");
    expect(run).toContain("run.finished");
  });
});

/** Waits for something the run produces, without a fixed sleep. */
async function waitFor<T>(get: () => T | undefined, tries = 200): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    const found = get();
    if (found !== undefined) return found;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("it never arrived");
}

// The chat's transcript, built from the host's events (ADR-022).
//
// The rules that matter are not about pixels: what counts as one card, when a card stops spinning,
// what happens to a tool that was running when the run was cancelled, and what a tab does when it
// notices it missed something.
import type { AgentEventMsg, AgentStateMsg, AgentWireEvent } from "@fpv/commands";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AgentItem,
  type AgentState,
  AgentStore,
  emptyState,
  reduce,
  resetIds,
} from "../../src/editor/agent/agent-store.js";

let seq = 0;
const msg = (event: AgentWireEvent, at = (seq += 1)): AgentEventMsg => ({
  type: "agent.event",
  projectId: "p1",
  runId: "run_1",
  seq: at,
  event,
});

const started = (text = "build a boardroom"): AgentWireEvent => ({
  type: "run.started",
  at: "T",
  text,
  attachments: [],
  model: "m",
  reliability: "high",
  checkpointId: "cp_1",
});

type StopReason = Extract<AgentWireEvent, { type: "run.finished" }>["reason"];

const finished = (reason: StopReason = "done", error: string | null = null): AgentWireEvent => ({
  type: "run.finished",
  at: "T",
  reason,
  steps: 3,
  toolCalls: 1,
  failedCalls: 0,
  usage: { promptTokens: 10, completionTokens: 5 },
  text: "Built it.",
  error,
});

const toolStarted = (id: string, name: string, summary: string): AgentWireEvent => ({
  type: "tool.started",
  step: 1,
  at: "T",
  id,
  name,
  args: {},
  summary,
});

const toolFinished = (id: string, name: string, ok = true): AgentWireEvent => ({
  type: "tool.finished",
  step: 1,
  at: "T",
  id,
  name,
  ok,
  preview: ok ? '{"walls":4}' : "",
  error: ok ? null : { code: "wall.overlap", message: "those walls cross", hint: "move one" },
  warnings: [],
  problems: { errors: 0, warnings: 0 },
  changed: ok
    ? ({
        commandType: "wall.createChain",
        added: [{ type: "wall", id: "wall_1" }],
        updated: [],
        removed: [],
      } as never)
    : null,
  durationMs: 12,
});

/** Fold a list of events, as the store does. */
function fold(events: AgentWireEvent[], from: AgentState = emptyState()): AgentState {
  return events.reduce((s, e) => reduce(s, msg(e)), from);
}

beforeEach(() => {
  seq = 0;
  resetIds();
});

describe("what a run looks like as it happens", () => {
  it("opens with what the person asked, and ends only when the run says so", () => {
    let state = reduce(emptyState(), msg(started("draw a room")));
    expect(state.status).toBe("running");
    expect(state.items[0]).toMatchObject({ kind: "user", text: "draw a room" });
    expect(state.checkpointId).toBe("cp_1");

    // nothing in between may say the work is over
    for (const event of [
      { type: "step.started", step: 1, at: "T" } as AgentWireEvent,
      toolStarted("c1", "create_walls", "Drawing 4 points of wall"),
      toolFinished("c1", "create_walls"),
      { type: "message", step: 1, at: "T", text: "Drawn." } as AgentWireEvent,
    ]) {
      state = reduce(state, msg(event));
      expect(state.status).toBe("running");
    }
    state = reduce(state, msg(finished()));
    expect(state.status).toBe("done");
  });

  it("does not show the person's own message twice", () => {
    // The tab that typed it showed it at once, so that it did not sit there looking unsent; the
    // host's own run.started then says the same thing, and one of them has to go.
    const store = new AgentStore();
    store.said("draw a room", [], "T");
    store.handle(msg(started("draw a room")));
    expect(store.state.items.filter((i) => i.kind === "user")).toHaveLength(1);
  });

  it("gathers the typing of one step into one answer, and lets the host's copy settle it", () => {
    let state = fold([
      started(),
      { type: "text.delta", step: 1, text: "Drawing " },
      { type: "text.delta", step: 1, text: "the walls" },
    ]);
    const streaming = state.items.at(-1) as Extract<AgentItem, { kind: "assistant" }>;
    expect(streaming.text).toBe("Drawing the walls");
    expect(streaming.streaming).toBe(true);

    state = reduce(state, msg({ type: "message", step: 1, at: "T", text: "Drawing the walls now." }));
    const settled = state.items.filter((i) => i.kind === "assistant");
    expect(settled).toHaveLength(1); // the same card, not a second one
    expect((settled[0] as { text: string; streaming: boolean }).text).toBe("Drawing the walls now.");
    expect((settled[0] as { streaming: boolean }).streaming).toBe(false);
  });

  it("starts a new answer for a new step", () => {
    const state = fold([
      started(),
      { type: "text.delta", step: 1, text: "First." },
      { type: "text.delta", step: 2, text: "Second." },
    ]);
    expect(state.items.filter((i) => i.kind === "assistant")).toHaveLength(2);
  });

  it("turns a tool into one card that starts spinning and then settles", () => {
    const state = fold([
      started(),
      toolStarted("c1", "create_walls", "Drawing 4 points of wall"),
      toolFinished("c1", "create_walls"),
    ]);
    const tools = state.items.filter((i) => i.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      status: "ok",
      summary: "Drawing 4 points of wall",
      preview: '{"walls":4}',
      durationMs: 12,
    });
    // what moved rides along, so the card can offer to show it
    expect((tools[0] as { changed: { added: unknown[] } }).changed.added).toHaveLength(1);
  });

  it("keeps a refusal's reason and hint, which is what makes it worth showing", () => {
    const state = fold([
      started(),
      toolStarted("c1", "create_walls", "Drawing"),
      toolFinished("c1", "create_walls", false),
    ]);
    const tool = state.items.find((i) => i.kind === "tool") as Extract<AgentItem, { kind: "tool" }>;
    expect(tool.status).toBe("error");
    expect(tool.error?.message).toBe("those walls cross");
    expect(tool.error?.hint).toBe("move one");
  });

  it("stops a card spinning when the run ends under it", () => {
    const state = fold([started(), toolStarted("c1", "render", "Looking at it"), finished("aborted")]);
    const tool = state.items.find((i) => i.kind === "tool") as Extract<AgentItem, { kind: "tool" }>;
    expect(tool.status).toBe("interrupted");
    // and the person is told what stopping left behind
    const note = state.items.at(-1) as Extract<AgentItem, { kind: "note" }>;
    expect(note.text).toContain("Undo this run");
  });

  it("says why a run that did not finish did not finish", () => {
    expect((fold([started(), finished("step-budget")]).items.at(-1) as { text: string }).text).toContain(
      "ran out of steps",
    );
    expect(
      (fold([started(), finished("stalled", "the same call three times")]).items.at(-1) as { text: string })
        .text,
    ).toContain("circles");
    // a run that simply finished says nothing extra; the answer is the answer
    expect(fold([started(), finished("done")]).items.at(-1)?.kind).not.toBe("note");
  });
});

describe("the plan card", () => {
  const plan = (items: { id: string; text: string; status: string }[]): AgentWireEvent => ({
    type: "plan.updated",
    step: 1,
    items: items as never,
  });

  it("is one card, updated where it stands rather than added again", () => {
    const state = fold([
      started(),
      plan([{ id: "a", text: "walls", status: "doing" }]),
      toolStarted("c1", "create_walls", "Drawing"),
      toolFinished("c1", "create_walls"),
      plan([
        { id: "a", text: "walls", status: "done" },
        { id: "b", text: "furniture", status: "doing" },
      ]),
    ]);
    const plans = state.items.filter((i) => i.kind === "plan");
    expect(plans).toHaveLength(1);
    expect((plans[0] as { items: unknown[] }).items).toHaveLength(2);
    // it stays where it first appeared, so the transcript does not jump while somebody reads it
    expect(state.items.findIndex((i) => i.kind === "plan")).toBe(1);
  });
});

describe("a question", () => {
  const asked = (id = "q1"): AgentWireEvent => ({
    type: "question",
    step: 1,
    id,
    text: "Which room?",
    kind: "choice",
    options: [
      { id: "a", label: "Boardroom" },
      { id: "b", label: "Huddle" },
    ],
    draftId: null,
    ids: [],
  });

  it("puts the run in waiting, and shows what was answered", () => {
    let state = fold([started(), asked()]);
    expect(state.status).toBe("waiting");
    state = reduce(state, msg({ type: "question.answered", id: "q1", answers: { q1: "a" }, by: "person" }));
    expect(state.status).toBe("running");
    const card = state.items.find((i) => i.kind === "question") as Extract<AgentItem, { kind: "question" }>;
    expect(card.answered).toBe("Boardroom");
  });

  it("says when the answer came from the review panel instead", () => {
    let state = fold([started(), asked()]);
    state = reduce(
      state,
      msg({ type: "question.answered", id: "q1", answers: { q1: "committed" }, by: "review" }),
    );
    const card = state.items.find((i) => i.kind === "question") as Extract<AgentItem, { kind: "question" }>;
    expect(card.answered).toContain("review panel");
  });
});

describe("a tab that was not listening", () => {
  it("notices a gap in the sequence rather than showing a transcript with a hole in it", () => {
    let state = reduce(emptyState(), msg(started(), 1));
    expect(state.missed).toBe(false);
    state = reduce(state, msg(toolFinished("c1", "validate"), 7));
    expect(state.missed).toBe(true);
    expect(state.lastSeq).toBe(7);
  });

  it("rebuilds the transcript from the replay, through the same reducer", () => {
    const state: AgentStateMsg = {
      type: "agent.state",
      projectId: "p1",
      available: true,
      model: "gpt",
      note: null,
      run: { runId: "run_1", status: "running", startedAt: "T" },
      replay: [msg(started("draw a room"), 1), msg(toolStarted("c1", "create_walls", "Drawing"), 2)],
    };
    const rebuilt = reduce(emptyState(), state);
    expect(rebuilt.available).toBe(true);
    expect(rebuilt.model).toBe("gpt");
    expect(rebuilt.items.map((i) => i.kind)).toEqual(["user", "tool"]);
    // the host says the run is still going, which the replay alone could not
    expect(rebuilt.status).toBe("running");
  });

  it("does not leave a finished run looking live after a reload", () => {
    const state: AgentStateMsg = {
      type: "agent.state",
      projectId: "p1",
      available: true,
      model: "gpt",
      note: null,
      run: null,
      replay: [msg(started(), 1), msg(finished(), 2)],
    };
    expect(reduce(emptyState(), state).status).toBe("done");
  });

  it("says there is no agent when the host has none", () => {
    const state = reduce(emptyState(), {
      type: "agent.state",
      projectId: "p1",
      available: false,
      model: null,
      note: "no agent model configured",
      run: null,
      replay: [],
    });
    expect(state.available).toBe(false);
    expect(state.note).toContain("no agent model");
  });
});

describe("the store around it", () => {
  it("tells its subscribers only when something changed", () => {
    const store = new AgentStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.handle(msg(started()));
    expect(calls).toBe(1);
    expect(store.state.status).toBe("running");
  });

  it("shows the person's own message before the host has heard it", () => {
    const store = new AgentStore();
    store.said("draw a room", [], "T");
    expect(store.state.items[0]).toMatchObject({ kind: "user", text: "draw a room" });
    expect(store.state.status).toBe("running");
  });

  it("says a refusal rather than waiting for a run that never started", () => {
    const store = new AgentStore();
    store.said("draw a room", [], "T");
    store.refused("the agent is already working on this project");
    expect(store.state.status).toBe("idle");
    expect(store.state.items.at(-1)).toMatchObject({ tone: "error" });
  });

  it("keeps what the agent is when the conversation is cleared", () => {
    const store = new AgentStore();
    store.handle({
      type: "agent.state",
      projectId: "p1",
      available: true,
      model: "gpt",
      note: null,
      run: null,
      replay: [msg(started(), 1)],
    });
    store.clear();
    expect(store.state.items).toEqual([]);
    expect(store.state.available).toBe(true);
    expect(store.state.model).toBe("gpt");
  });
});

describe("the notes card (ADR-027 D2)", () => {
  it("is one card, updated where it stands", () => {
    const state = fold([
      started(),
      {
        type: "plan.updated",
        step: 0,
        items: [{ id: "a", text: "walls", status: "pending" }],
      },
      { type: "notes.updated", step: 1, text: "the picture shows a courtyard" },
      toolStarted("c1", "create_walls", "Drawing"),
      toolFinished("c1", "create_walls"),
      { type: "notes.updated", step: 2, text: "the picture shows a courtyard; the client wants glass" },
    ]);
    const notes = state.items.filter((i) => i.kind === "notes");
    expect(notes).toHaveLength(1);
    expect((notes[0] as { text: string }).text).toContain("wants glass");
    expect(state.items.findIndex((i) => i.kind === "notes")).toBe(2);
  });
});

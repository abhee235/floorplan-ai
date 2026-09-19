// @vitest-environment jsdom
//
// The chat's contents: what a person can do with a run, and what each card offers.
//
// These are about the seam between the transcript and the person — sending, stopping, answering,
// and getting from "it placed eight chairs" to seeing the eight chairs.

import type { AgentWireEvent } from "@fpv/commands";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPanel } from "../../src/editor/agent/AgentPanel.js";
import { type AgentState, AgentStore, resetIds } from "../../src/editor/agent/agent-store.js";

let seq = 0;
const event = (e: AgentWireEvent) => ({
  type: "agent.event" as const,
  projectId: "p1",
  runId: "run_1",
  seq: (seq += 1),
  event: e,
});

/** A store fed the events a test names, so the panel is driven the way the socket drives it. */
function stateOf(events: AgentWireEvent[], available = true): AgentState {
  seq = 0;
  resetIds();
  const store = new AgentStore();
  store.handle({
    type: "agent.state",
    projectId: "p1",
    available,
    model: "gpt-test",
    note: available ? null : "no agent model configured",
    run: null,
    replay: [],
  });
  for (const e of events) store.handle(event(e));
  return store.state;
}

const started: AgentWireEvent = {
  type: "run.started",
  at: "T",
  text: "draw a boardroom",
  attachments: [],
  model: "gpt-test",
  reliability: "high",
  checkpointId: "cp_1",
};

const finished: AgentWireEvent = {
  type: "run.finished",
  at: "T",
  reason: "done",
  steps: 4,
  toolCalls: 2,
  failedCalls: 0,
  usage: { promptTokens: 1, completionTokens: 1 },
  text: "Built it.",
  error: null,
};

function show(state: AgentState, handlers: Partial<Parameters<typeof AgentPanel>[0]> = {}) {
  const props = {
    state,
    onSend: vi.fn(),
    onCancel: vi.fn(),
    onAnswer: vi.fn(),
    onUndoRun: vi.fn(),
    onShow: vi.fn(),
    onCatchUp: vi.fn(),
    ...handlers,
  };
  render(<AgentPanel {...props} />);
  return props;
}

afterEach(cleanup);

describe("saying what you want", () => {
  it("sends what was typed, and empties the box", async () => {
    const props = show(stateOf([]));
    const user = userEvent.setup();
    const box = screen.getByRole("textbox", { name: "Ask the agent" });
    await user.type(box, "draw a 6 by 4 metre room");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(props.onSend).toHaveBeenCalledWith("draw a 6 by 4 metre room", []);
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("sends on Enter and makes a new line on Shift+Enter", async () => {
    const props = show(stateOf([]));
    const user = userEvent.setup();
    const box = screen.getByRole("textbox", { name: "Ask the agent" });
    await user.type(box, "one{Shift>}{Enter}{/Shift}two");
    expect(props.onSend).not.toHaveBeenCalled();
    await user.type(box, "{Enter}");
    expect(props.onSend).toHaveBeenCalledWith("one\ntwo", []);
  });

  it("sends nothing at all when there is nothing to send", async () => {
    const props = show(stateOf([]));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("will not take another message while it is working", () => {
    show(stateOf([started]));
    // jest-dom is not installed here, so the attribute is read directly, as the menu tests do.
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /Stop/ }).hasAttribute("disabled")).toBe(false);
  });
});

describe("while it works", () => {
  it("offers to stop, and only offers to undo once it has stopped", async () => {
    const props = show(stateOf([started]));
    const user = userEvent.setup();
    expect(screen.queryByRole("button", { name: /Undo this run/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Stop/ }));
    expect(props.onCancel).toHaveBeenCalled();

    cleanup();
    const after = show(stateOf([started, finished]));
    await user.click(screen.getByRole("button", { name: /Undo this run/ }));
    expect(after.onUndoRun).toHaveBeenCalledWith("cp_1");
  });

  it("shows a tool as a sentence, and offers to show what it changed", async () => {
    const props = show(
      stateOf([
        started,
        {
          type: "tool.started",
          step: 1,
          at: "T",
          id: "c1",
          name: "place_item",
          args: {},
          summary: "Placing 8 chairs",
        },
        {
          type: "tool.finished",
          step: 1,
          at: "T",
          id: "c1",
          name: "place_item",
          ok: true,
          preview: '{"items":8}',
          error: null,
          warnings: [],
          problems: { errors: 0, warnings: 0 },
          changed: {
            commandType: "item.place",
            added: [
              { type: "item", id: "item_1" },
              { type: "item", id: "item_2" },
            ],
            updated: [],
            removed: [],
          } as never,
          durationMs: 40,
        },
      ]),
    );
    expect(screen.getByText("Placing 8 chairs")).not.toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Show" }));
    expect(props.onShow).toHaveBeenCalledWith(["item_1", "item_2"]);
  });

  it("says what a refusal was, and what to do about it", () => {
    show(
      stateOf([
        started,
        {
          type: "tool.started",
          step: 1,
          at: "T",
          id: "c1",
          name: "create_walls",
          args: {},
          summary: "Drawing",
        },
        {
          type: "tool.finished",
          step: 1,
          at: "T",
          id: "c1",
          name: "create_walls",
          ok: false,
          preview: "",
          error: { code: "wall.overlap", message: "those walls cross", hint: "move one" },
          warnings: [],
          problems: { errors: 1, warnings: 0 },
          changed: null,
          durationMs: 3,
        },
      ]),
    );
    expect(screen.getByText(/those walls cross/)).not.toBeNull();
    expect(screen.getByText(/move one/)).not.toBeNull();
  });

  it("shows the plan as a list of jobs, with the one in hand marked", () => {
    show(
      stateOf([
        started,
        {
          type: "plan.updated",
          step: 1,
          items: [
            { id: "a", text: "outer walls", status: "done" },
            { id: "b", text: "the rooms", status: "doing" },
            { id: "c", text: "furniture", status: "pending" },
          ],
        },
      ]),
    );
    expect(screen.getByText(/1 of 3 done/)).not.toBeNull();
    expect(screen.getByText("the rooms")).not.toBeNull();
  });

  it("shows a render as a picture, because that is the point of asking for one", () => {
    show(
      stateOf([
        started,
        {
          type: "tool.started",
          step: 1,
          at: "T",
          id: "r1",
          name: "render",
          args: {},
          summary: "Looking at it",
        },
        {
          type: "tool.finished",
          step: 1,
          at: "T",
          id: "r1",
          name: "render",
          ok: true,
          preview: "{}",
          error: null,
          warnings: [],
          problems: { errors: 0, warnings: 0 },
          changed: null,
          durationMs: 900,
          display: { kind: "image", dataUrl: "data:image/png;base64,AAAA", caption: "plan" },
        },
      ]),
    );
    expect(screen.getByRole("img", { name: "plan" })).not.toBeNull();
  });
});

describe("answering it", () => {
  const asked: AgentWireEvent = {
    type: "question",
    step: 1,
    id: "q1",
    text: "Which room did you mean?",
    kind: "choice",
    options: [
      { id: "a", label: "Boardroom" },
      { id: "b", label: "Huddle" },
    ],
    draftId: null,
    ids: [],
  };

  it("offers the choices as buttons", async () => {
    const props = show(stateOf([started, asked]));
    await userEvent.setup().click(screen.getByRole("button", { name: "Boardroom" }));
    expect(props.onAnswer).toHaveBeenCalledWith("q1", "a");
  });

  it("takes a typed answer when there are no choices", async () => {
    const props = show(stateOf([started, { ...asked, kind: "text", options: [] } as AgentWireEvent]));
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Your answer" }), "the big one");
    await user.click(screen.getByRole("button", { name: "Answer" }));
    expect(props.onAnswer).toHaveBeenCalledWith("q1", "the big one");
  });

  it("points at the review panel when the question is a plan's scale", () => {
    show(stateOf([started, { ...asked, kind: "scale", options: [] } as AgentWireEvent]));
    expect(screen.getByText(/review panel/)).not.toBeNull();
  });

  it("shows what was answered once it has been", () => {
    show(
      stateOf([started, asked, { type: "question.answered", id: "q1", answers: { q1: "a" }, by: "person" }]),
    );
    expect(screen.getByText(/You said: Boardroom/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Boardroom" })).toBeNull();
  });
});

describe("when something is missing", () => {
  it("offers to catch up on what this tab did not hear", async () => {
    const store = new AgentStore();
    store.handle({
      type: "agent.state",
      projectId: "p1",
      available: true,
      model: "gpt-test",
      note: null,
      run: null,
      replay: [],
    });
    store.handle({ type: "agent.event", projectId: "p1", runId: "r", seq: 1, event: started });
    store.handle({ type: "agent.event", projectId: "p1", runId: "r", seq: 9, event: finished });
    const props = show(store.state);
    await userEvent.setup().click(screen.getByRole("button", { name: "Catch up" }));
    expect(props.onCatchUp).toHaveBeenCalled();
  });

  it("says there is no agent, rather than a box that refuses everything", () => {
    show(stateOf([], false));
    expect(screen.getByText(/no agent on this host/i)).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "Ask the agent" })).toBeNull();
  });
});

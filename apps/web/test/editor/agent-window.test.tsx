// @vitest-environment jsdom
//
// The chat window: where it sits, how it is moved, and the rule that it can always be got back.
//
// The placement maths is pure and tested first, because "a window dragged off the bottom of the
// screen cannot be dragged back" is a sentence a test can hold and a rendering cannot.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AgentWindow } from "../../src/editor/agent/AgentWindow.js";
import {
  afterDrag,
  afterResize,
  DEFAULT_PLACEMENT,
  docked,
  floated,
  MIN_HEIGHT,
  MIN_WIDTH,
  type Placement,
  readPlacement,
  rectOf,
  type Viewport,
  writePlacement,
} from "../../src/editor/agent/placement.js";

const view: Viewport = { width: 1400, height: 900, top: 76, bottom: 28 };

afterEach(cleanup);

describe("where the window sits", () => {
  it("docks to the right, full height between the bars", () => {
    const rect = rectOf(DEFAULT_PLACEMENT, view);
    expect(rect.left + rect.width).toBeLessThanOrEqual(view.width);
    expect(rect.top).toBeGreaterThanOrEqual(view.top);
    expect(rect.top + rect.height).toBeLessThanOrEqual(view.height - view.bottom);
    // tall, because a conversation beside a drawing is a column and not a box
    expect(rect.height).toBeGreaterThan(rect.width);
  });

  it("goes where it was put once it is floating", () => {
    const placement: Placement = { ...DEFAULT_PLACEMENT, mode: "floating", x: 300, y: 200 };
    expect(rectOf(placement, view)).toMatchObject({ left: 300, top: 200 });
  });

  it("always leaves something to grab, however far it is dragged", () => {
    const off: Placement = { ...DEFAULT_PLACEMENT, mode: "floating", x: 5000, y: 5000 };
    const rect = rectOf(off, view);
    expect(rect.left).toBeLessThan(view.width);
    expect(rect.top).toBeLessThan(view.height - view.bottom);

    const back: Placement = { ...DEFAULT_PLACEMENT, mode: "floating", x: -5000, y: -5000 };
    const there = rectOf(back, view);
    expect(there.left + there.width).toBeGreaterThan(0);
    expect(there.top).toBeGreaterThanOrEqual(view.top);
  });

  it("fits a window into a window smaller than it asked for", () => {
    const small: Viewport = { width: 320, height: 360, top: 76, bottom: 28 };
    const rect = rectOf(DEFAULT_PLACEMENT, small);
    expect(rect.width).toBeLessThanOrEqual(small.width);
    expect(rect.height).toBeGreaterThanOrEqual(MIN_HEIGHT);
  });
});

describe("moving it", () => {
  const rect = { left: 1000, top: 100, width: 380, height: 700 };

  it("undocks where it stood, rather than jumping out from under the pointer", () => {
    const moved = afterDrag(DEFAULT_PLACEMENT, rect, 20, 30);
    expect(moved.mode).toBe("floating");
    expect(moved).toMatchObject({ x: 1020, y: 130, width: 380, height: 700 });
  });

  it("resizes from the bottom left, and never below a usable size", () => {
    const bigger = afterResize(DEFAULT_PLACEMENT, rect, -100, 50);
    expect(bigger.width).toBe(480);
    expect(bigger.height).toBe(750);
    const tiny = afterResize(DEFAULT_PLACEMENT, rect, 5000, -5000);
    expect(tiny.width).toBe(MIN_WIDTH);
    expect(tiny.height).toBe(MIN_HEIGHT);
  });

  it("docks and undocks without losing its size", () => {
    const free = floated(DEFAULT_PLACEMENT, rect);
    expect(free).toMatchObject({ mode: "floating", x: 1000, y: 100, width: 380, height: 700 });
    expect(docked(free).mode).toBe("docked");
  });
});

describe("remembering where it was left", () => {
  const storage = (): Storage => {
    const held = new Map<string, string>();
    return {
      getItem: (k) => held.get(k) ?? null,
      setItem: (k, v) => void held.set(k, v),
      removeItem: (k) => void held.delete(k),
      clear: () => held.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  };

  it("comes back where it was", () => {
    const store = storage();
    const placement: Placement = {
      mode: "floating",
      x: 120,
      y: 60,
      width: 420,
      height: 400,
      minimised: true,
    };
    writePlacement(placement, store);
    expect(readPlacement(store)).toEqual(placement);
  });

  it("opens docked when there is nothing remembered, or nonsense is", () => {
    expect(readPlacement(storage())).toEqual(DEFAULT_PLACEMENT);
    const broken = storage();
    broken.setItem("fpv.agent.placement", "{not json");
    expect(readPlacement(broken)).toEqual(DEFAULT_PLACEMENT);
  });

  it("still opens when storage refuses to answer at all", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(readPlacement(blocked)).toEqual(DEFAULT_PLACEMENT);
    expect(() => writePlacement(DEFAULT_PLACEMENT, blocked)).not.toThrow();
  });
});

describe("the window itself", () => {
  const show = (open = true) =>
    render(
      <AgentWindow open={open} onClose={() => {}} title="Agent" subtitle="gpt">
        <p>the chat</p>
      </AgentWindow>,
    );

  it("shows nothing at all when it is closed", () => {
    show(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a dialog that does not take the editor over", () => {
    show();
    const window = screen.getByRole("dialog", { name: "Agent" });
    // deliberately not modal: the point of watching it work is that the editor still works
    expect(window.getAttribute("aria-modal")).toBeNull();
    expect(screen.getByText("the chat")).not.toBeNull();
  });

  it("minimises to something that brings it back", async () => {
    show();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Minimise the chat" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.getByRole("dialog", { name: "Agent" })).not.toBeNull();
  });

  it("offers to undock, and then to dock again", async () => {
    show();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Undock the chat" }));
    expect(screen.getByRole("button", { name: "Dock the chat to the right" })).not.toBeNull();
  });
});

describe("the two faults a real browser found", () => {
  const storage = (): Storage => {
    const held = new Map<string, string>();
    return {
      getItem: (k) => held.get(k) ?? null,
      setItem: (k, v) => void held.set(k, v),
      removeItem: (k) => void held.delete(k),
      clear: () => held.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  };

  it("does not start a drag from a press on one of the title bar's buttons", async () => {
    // What went wrong: the header took the pointer for every press inside it, buttons included,
    // and preventDefault on pointerdown cancels the click that would have followed. jsdom fires
    // click directly, so every earlier test passed while nothing worked.
    render(
      <AgentWindow open onClose={() => {}} title="Agent">
        <p>the chat</p>
      </AgentWindow>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Minimise the chat" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Agent" })).not.toBeNull();
  });

  it("gives back the window, not a pill, when somebody asks for the chat again", () => {
    // Left minimised between sessions, the shortcut used to toggle `open` under a pill in the far
    // corner, so the agent looked broken. Asking for it now clears the minimised state.
    const store = storage();
    writePlacement({ ...DEFAULT_PLACEMENT, minimised: true }, store);
    const view = render(
      <AgentWindow open={false} onClose={() => {}} title="Agent">
        <p>the chat</p>
      </AgentWindow>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(
      <AgentWindow open onClose={() => {}} title="Agent">
        <p>the chat</p>
      </AgentWindow>,
    );
    expect(screen.getByRole("dialog", { name: "Agent" })).not.toBeNull();
  });

  it("still minimises, and minimising does not immediately undo itself", async () => {
    render(
      <AgentWindow open onClose={() => {}} title="Agent">
        <p>the chat</p>
      </AgentWindow>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Minimise the chat" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.getByRole("dialog", { name: "Agent" })).not.toBeNull();
  });
});

// @vitest-environment jsdom
//
// Switching what is on screen must never replace the nodes the imperative app drew into.
//
// startApp appends canvases to the plan and viewport nodes and listens on them and on the Fit button. When
// the single-pane view modes rendered a container of their own, React replaced those nodes on every
// switch: the canvases went with the old ones, and the editor was blank until a reload. The real app needs
// WebGL, so it is stubbed here with one that marks the nodes it was handed, the way its canvases would.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppElements } from "../../src/app.js";
import { Replica } from "../../src/replica.js";

const handed: AppElements[] = [];

vi.mock("../../src/app.js", () => ({
  startApp: (el: AppElements) => {
    handed.push(el);
    for (const host of [el.plan, el.viewport]) {
      const canvas = document.createElement("canvas");
      canvas.dataset.stub = "canvas";
      host.appendChild(canvas);
    }
    const ok = async () => ({ id: "x", type: "result" as const, ok: true });
    return {
      replica: new Replica(),
      client: { close() {}, command: ok, undo: ok, redo: ok, select: ok },
      plan: {
        level: null,
        view: { scale: 1, offsetX: 0, offsetY: 0, width: 100, height: 100 },
        setOverlayExtra() {},
        invalidateOverlay() {},
        flush() {},
        fit() {},
        zoomAt() {},
        setLevel() {},
        toPlan: () => ({ x: 0, y: 0 }),
      },
      binding: { setWallPreview() {}, setRoomPreview() {} },
      review: { draw() {} },
      drawSelectionDrag() {},
      redraw() {},
      destroy() {},
    };
  },
}));

// Imported after the mock is declared; vitest hoists vi.mock, but the order reads as it runs.
const { EditorShell } = await import("../../src/editor/EditorShell.js");

beforeAll(() => {
  // jsdom has neither; the panel library and the scroll area both observe sizes.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof matchMedia;
});

afterEach(() => {
  cleanup();
  handed.length = 0;
});

const hidden = (el: Element | null): boolean => Boolean(el?.closest("[data-view-hidden]"));

describe("switching what is on screen (ADR-017 D1)", () => {
  it("keeps the nodes the app drew into, through every view mode and back", async () => {
    render(<EditorShell />);
    const user = userEvent.setup();
    expect(handed).toHaveLength(1);
    const { plan, viewport, fit } = handed[0] as AppElements;

    for (const mode of ["3D", "Plan", "Plan + 3D", "Plan", "3D", "Plan + 3D"]) {
      await user.click(screen.getByRole("radio", { name: mode }));
      // the same nodes, still in the document, still holding what the app put there
      expect(document.getElementById("plan")).toBe(plan);
      expect(document.getElementById("viewport")).toBe(viewport);
      expect(plan.isConnected && viewport.isConnected && fit.isConnected).toBe(true);
      expect(plan.querySelector("canvas[data-stub]")).not.toBeNull();
      expect(viewport.querySelector("canvas[data-stub]")).not.toBeNull();
      // and only the pane the mode asks for is taken out of the layout
      expect(hidden(plan), `${mode}: plan hidden`).toBe(mode === "3D");
      expect(hidden(viewport), `${mode}: 3D hidden`).toBe(mode === "Plan");
      expect(hidden(screen.getByRole("separator", { hidden: true })), `${mode}: divider hidden`).toBe(
        mode !== "Plan + 3D",
      );
    }
    // started once: a switch is not a restart
    expect(handed).toHaveLength(1);
  });
});

// @vitest-environment jsdom
//
// Switching what is on screen must never replace the nodes the imperative app drew into.
//
// startApp appends canvases to the plan and viewport nodes and listens on them and on the Fit button. When
// the single-pane view modes rendered a container of their own, React replaced those nodes on every
// switch: the canvases went with the old ones, and the editor was blank until a reload. The real app needs
// WebGL, so it is stubbed here with one that marks the nodes it was handed, the way its canvases would.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apply } from "@fpv/commands";
import { Project, sequentialIdGenerator } from "@fpv/ir";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppElements } from "../../src/app.js";
import { scaleLabel } from "../../src/editor/status.js";
import { Replica } from "../../src/replica.js";

const handed: AppElements[] = [];
const started: { replica: Replica }[] = [];

vi.mock("../../src/app.js", () => ({
  startApp: (el: AppElements) => {
    handed.push(el);
    for (const host of [el.plan, el.viewport]) {
      const canvas = document.createElement("canvas");
      canvas.dataset.stub = "canvas";
      host.appendChild(canvas);
    }
    const ok = async () => ({ id: "x", type: "result" as const, ok: true });
    // the catalog tab's search: one chair, and no generic shapes
    const tool = async (_name: string, args: Record<string, unknown>) => ({
      id: "x",
      type: "result" as const,
      ok: true,
      result: {
        ok: true,
        result:
          args.kind === "product"
            ? {
                hits: [
                  {
                    id: "acme-chair",
                    name: "Acme chair",
                    make: "Acme",
                    model: "C1",
                    category: "chair",
                    dims: { w: 600, d: 600, h: 900 },
                    verified: true,
                    price: null,
                  },
                ],
                total: 1,
                cursor: null,
              }
            : { hits: [], total: 0, cursor: null },
      },
    });
    const replica = new Replica();
    started.push({ replica });
    return {
      replica,
      client: {
        close() {},
        command: ok,
        undo: ok,
        redo: ok,
        select: ok,
        tool,
        // the texture list the material rows offer
        request: async () => ({ id: "x", type: "result" as const, ok: true, result: { textures: [] } }),
      },
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
  // cmdk keeps the highlighted catalog result in view
  Element.prototype.scrollIntoView ??= () => {};
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
  started.length = 0;
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

  it("shows the plan's scale whenever the app reports a new one, not only when the project changes", () => {
    render(<EditorShell />);
    const { onScale } = handed[0] as AppElements;
    expect(onScale).toBeTypeOf("function");
    const dpr = Math.min(2, window.devicePixelRatio);
    // the zoom cluster and the status bar both show it
    act(() => onScale?.(0.05));
    expect(screen.getAllByText(scaleLabel(0.05, dpr))).toHaveLength(2);
    act(() => onScale?.(0.5));
    expect(screen.getAllByText(scaleLabel(0.5, dpr))).toHaveLength(2);
    expect(screen.queryAllByText(scaleLabel(0.05, dpr))).toHaveLength(0);
  });

  it("names every control in the properties panel differently, so none is mistaken for another", () => {
    // From the repo root, where vitest runs: under jsdom import.meta.url is not a file URL.
    const file = join(process.cwd(), "tools", "fixtures", "six-wall-room.fpviz", "project.json");
    const base = Project.parse(JSON.parse(readFileSync(file, "utf8")));
    const made = apply(
      base,
      { type: "room.create", payload: { levelId: "level_000000", atPoint: { x: 2000, y: 2000 } } },
      { ids: sequentialIdGenerator(900), now: () => "2026-09-17T00:00:00.000Z" },
    );
    if (!made.ok) throw new Error(made.error.message);
    const project = made.project;
    render(<EditorShell />);
    const { replica } = started[0] as { replica: Replica };
    act(() => {
      replica.applySnapshot({ type: "snapshot", seq: 0, project, historyPosition: 0, savedPosition: 0 });
      replica.setSelection(["wall_000001", (project.rooms[0] as { id: string }).id]);
    });
    const panel = screen.getByRole("complementary", { name: "Properties" });
    const names = [...panel.querySelectorAll("input, button[role=combobox], button[role=checkbox]")].map(
      (el) => el.getAttribute("aria-label") ?? "",
    );
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((n) => n === "")).toEqual([]);
    const repeated = names.filter((n, k) => names.indexOf(n) !== k);
    expect(repeated).toEqual([]);
  });

  it("P3-5 sends the item tool to the catalog until a piece is picked, then arms it with the piece", async () => {
    render(<EditorShell />);
    const user = userEvent.setup();
    const plan = document.getElementById("plan") as HTMLElement;
    expect(screen.getByRole("tab", { name: "Properties" }).getAttribute("aria-selected")).toBe("true");
    await user.click(screen.getByRole("radio", { name: "Place item, I" }));
    // nothing picked yet: the catalog tab opens instead, and the tool stays as it was
    expect(screen.getByRole("tab", { name: "Catalog" }).getAttribute("aria-selected")).toBe("true");
    expect(plan.dataset.tool).toBe("select");
    await user.click(await screen.findByRole("option", { name: /Acme chair/ }));
    expect(plan.dataset.tool).toBe("item");
    // the catalog stays open while placing
    expect(screen.getByRole("tab", { name: "Catalog" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("status").textContent).toContain("Placing Acme chair");
    await user.keyboard("{Escape}");
    expect(plan.dataset.tool).toBe("select");
    // choosing the tool again, from another tab, opens the catalog with the same piece ready to place
    await user.click(screen.getByRole("tab", { name: "Properties" }));
    await user.click(screen.getByRole("radio", { name: "Place item, I" }));
    expect(plan.dataset.tool).toBe("item");
    expect(screen.getByRole("tab", { name: "Catalog" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("status").textContent).toContain("Placing Acme chair");
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(plan.dataset.tool).toBe("select");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

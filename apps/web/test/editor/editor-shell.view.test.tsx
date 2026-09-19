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
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppElements } from "../../src/app.js";
import { menus } from "../../src/editor/MainMenu.js";
import { scaleLabel } from "../../src/editor/status.js";
import { Replica } from "../../src/replica.js";

const handed: AppElements[] = [];
const started: { replica: Replica }[] = [];

vi.mock("../../src/app.js", () => ({
  CLIENT_VERSION: "0.0.0-test",
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

  it("gives the shell exactly as many children as its grid has rows", () => {
    // The rows are counted out in order, so a child that renders nothing at all shifts every row after
    // it up one track. It did: with no stale note to show, the plan took the note's `auto` track and
    // shrank to its contents while the status bar took the plan's `1fr`, leaving a field of white below
    // the window. Nothing in the DOM was missing, which is why only a screenshot showed it.
    render(<EditorShell />);
    const shell = document.querySelector("[class*='grid-rows-']") as HTMLElement;
    const tracks = (/grid-rows-\[([^\]]+)\]/.exec(shell.className)?.[1] ?? "").split("_").length;
    expect(tracks).toBeGreaterThan(1);
    expect(shell.children).toHaveLength(tracks);
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

  /**
   * The menus, against the registry the SHELL builds.
   *
   * There is a test beside MainMenu that claims to check this, and it cannot fail: it builds its
   * registry out of `menuCommandIds()`, so the menu is compared with itself. A line naming a command
   * nothing registers renders as nothing at all — `Lines` skips it deliberately — which is exactly how
   * the dead Export button survived. Counting the lines that actually rendered against the lines the
   * definition asks for is the check that was missing.
   *
   * The menus are opened with the KEYBOARD, not a click, and that is not a stylistic choice.
   * react-resizable-panels listens for pointerdown on the document and calls preventDefault when the
   * press lands on one of its drag handles. In jsdom every getBoundingClientRect is 0×0 at 0,0 and so
   * is the synthetic press, so every handle "contains" every press and every pointerdown in this shell
   * comes out prevented. Radix skips its own handler on a prevented event, so no popup in this tree can
   * ever be opened by clicking it here. A real browser has layout and is unaffected — the menus were
   * verified open in one.
   */
  const rendersAs = (entries: ReturnType<typeof menus>[number]["entries"]): number =>
    entries.reduce((n, entry) => {
      if (typeof entry === "string") return n + 1;
      if ("radio" in entry) return n + entry.radio.length;
      if ("separator" in entry || "label" in entry) return n;
      return n + 1; // a submenu, or the one dynamic line, shows as its trigger
    }, 0);

  /** Open one menu by name, the only way that works here. */
  async function openMenu(user: ReturnType<typeof userEvent.setup>, title: string): Promise<HTMLElement> {
    screen.getByRole("menuitem", { name: title }).focus();
    await user.keyboard("{Enter}");
    return screen.findByRole("menu");
  }

  it("draws every line its menus ask for, so a line naming no command cannot hide", async () => {
    render(<EditorShell />);
    const user = userEvent.setup();
    for (const menu of menus("both")) {
      const open = await openMenu(user, menu.title);
      const lines =
        within(open).queryAllByRole("menuitem").length + within(open).queryAllByRole("menuitemradio").length;
      expect(lines, `${menu.title} menu`).toBe(rendersAs(menu.entries));
      await user.keyboard("{Escape}");
    }
  });

  it("offers the project commands a person looks in File for (ADR-021)", async () => {
    render(<EditorShell />);
    const user = userEvent.setup();
    const open = await openMenu(user, "File");
    const titles = within(open)
      .getAllByRole("menuitem")
      .map((i) => (i.textContent ?? "").replace(/Ctrl\+\S+/, "").trim());
    // No Save as and no path anywhere: a project lives in the library from the moment it is made,
    // so save is only ever save (ADR-021).
    expect(titles).toEqual([
      "New project",
      "Your projects…",
      "Open recent",
      "Save",
      "Close project",
      "Import plan…",
      "Export",
    ]);
  });
});

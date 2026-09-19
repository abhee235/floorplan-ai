// @vitest-environment jsdom
//
// These exercise the select, room, item and measure tools. A Radix Select wants ResizeObserver and pointer
// capture, which jsdom does not have, so the shims below stand in for them; only a closed Select is
// rendered here, and nothing about its behaviour is under test.
//
// The inert-tool example has moved as tools landed: from room, to item, to measure, which is now the
// first tool on the rail with nothing behind it.
import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { Announcer } from "../../src/editor/announce.js";
import { CommandRegistry } from "../../src/editor/commands.js";
import { Toolbar } from "../../src/editor/Toolbar.js";
import { type ToolDefinition, toolById } from "../../src/editor/tools.js";
import { type Editor, EditorContext } from "../../src/editor/useEditor.js";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.hasPointerCapture ??= () => false;
});

function editorStub(tool: ToolDefinition, over: Partial<Editor> = {}): Editor {
  return {
    commands: new CommandRegistry(),
    announcer: new Announcer({ polite: { textContent: "" }, assertive: { textContent: "" } }),
    tool,
    setTool: () => {},
    view: "both",
    setView: () => {},
    option: (_t, id) => (id === "snapWalls" ? true : undefined),
    setOption: () => {},
    openPalette: () => {},
    recent: [],
    openRecent: () => {},
    open: [],
    currentProject: "",
    switchProject: () => {},
    snap: "",
    setSnap: () => {},
    pointer: null,
    setPointer: () => {},
    scale: 0,
    setScale: () => {},
    ...over,
  };
}

const show = (tool: ToolDefinition) =>
  render(
    <EditorContext.Provider value={editorStub(tool)}>
      {/* Undo and Redo are icon buttons wearing tooltips, as a ribbon draws them. */}
      <TooltipProvider>
        <Toolbar replica={null} level={null} onLevel={() => {}} />
      </TooltipProvider>
    </EditorContext.Provider>,
  );

describe("the toolbar (ADR-017 D1 amendment, D2)", () => {
  it("names the tool and the modifiers that invert its snapping (W-082)", () => {
    const { container } = show(toolById("select") as ToolDefinition);
    expect(container.textContent).toContain("Select");
    expect(container.textContent).toContain("Alt to bypass snapping");
    expect(container.textContent).not.toContain("Not built yet");
  });

  it("offers the snapping switches as checkboxes, with the preference reflected", () => {
    const { container } = show(toolById("select") as ToolDefinition);
    const boxes = container.querySelectorAll('[role="checkbox"]');
    expect(boxes.length).toBe(3);
    expect(container.textContent).toContain("Snap to walls");
    expect(container.textContent).toContain("Angle steps 15°");
  });

  it("admits when a tool has nothing behind it rather than pretending", () => {
    const { container } = show(toolById("measure") as ToolDefinition);
    expect(container.textContent).toContain("Measure");
    expect(container.textContent).toContain("Not built yet");
    // and it does not claim modifiers that would do nothing
    expect(container.textContent).not.toContain("to measure along an axis");
  });

  it("stops saying that once a tool's gestures land", () => {
    // The counterpart to the test above, and the reason it had to change: room used to be the example of
    // an unimplemented tool, and is not one any more. Without this, nothing would notice the next time a
    // tool graduates and the inert example quietly became a lie.
    const { container } = show(toolById("room") as ToolDefinition);
    expect(container.textContent).toContain("Draw room");
    expect(container.textContent).not.toContain("Not built yet");
    // P3-5: the item tool places from the catalog now
    const item = show(toolById("item") as ToolDefinition).container;
    expect(item.textContent).toContain("Place item");
    expect(item.textContent).not.toContain("Not built yet");
    expect(item.textContent).toContain("to bypass snapping");
  });

  it("is a toolbar, so assistive technology treats it as one group", () => {
    const { container } = show(toolById("select") as ToolDefinition);
    const bar = container.querySelector('[role="toolbar"]');
    expect(bar?.getAttribute("aria-label")).toBe("Toolbar");
    // The tool's own settings keep their name inside it: they are the part that changes as you work,
    // and the rest of the row does not.
    const settings = container.querySelector('[role="group"][aria-label="Settings for the active tool"]');
    expect(settings).not.toBeNull();
  });

  it("carries the level, the history and what is on screen, which the menu bar used to", () => {
    // They moved out of the menu bar on 2026-09-19: menus above, controls below, as a desktop
    // application separates them.
    const { container } = show(toolById("select") as ToolDefinition);
    for (const name of ["Level", "History", "What is on screen"])
      expect(container.querySelector(`[aria-label="${name}"]`), `the toolbar carries ${name}`).not.toBeNull();
  });
});

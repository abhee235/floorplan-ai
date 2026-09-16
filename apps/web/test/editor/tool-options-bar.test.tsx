// @vitest-environment jsdom
//
// These exercise the select and room tools, whose options are all checkboxes. The wall tool is left to the
// browser pass on purpose: its options include a Radix Select, which wants ResizeObserver and pointer
// capture that jsdom does not provide, so a failure there would say nothing about the behaviour under test.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Announcer } from "../../src/editor/announce.js";
import { CommandRegistry } from "../../src/editor/commands.js";
import { ToolOptionsBar } from "../../src/editor/ToolOptionsBar.js";
import { type ToolDefinition, toolById } from "../../src/editor/tools.js";
import { type Editor, EditorContext } from "../../src/editor/useEditor.js";

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
      <ToolOptionsBar />
    </EditorContext.Provider>,
  );

describe("the tool options bar (ADR-017 D2)", () => {
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
    const { container } = show(toolById("room") as ToolDefinition);
    expect(container.textContent).toContain("Draw room");
    expect(container.textContent).toContain("Not built yet");
    // and it does not claim modifiers that would do nothing
    expect(container.textContent).not.toContain("Alt to bypass snapping");
  });

  it("is a toolbar, so assistive technology treats it as one group", () => {
    const { container } = show(toolById("select") as ToolDefinition);
    const bar = container.querySelector('[role="toolbar"]');
    expect(bar?.getAttribute("aria-label")).toBe("Settings for the active tool");
  });
});

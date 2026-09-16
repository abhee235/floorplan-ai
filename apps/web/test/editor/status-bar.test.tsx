// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { Announcer } from "../../src/editor/announce.js";
import { CommandRegistry } from "../../src/editor/commands.js";
import { StatusBar } from "../../src/editor/StatusBar.js";
import { TOOLS, type ToolDefinition } from "../../src/editor/tools.js";
import { type Editor, EditorContext } from "../../src/editor/useEditor.js";
import { Replica } from "../../src/replica.js";

function editorStub(over: Partial<Editor> = {}): Editor {
  return {
    commands: new CommandRegistry(),
    announcer: new Announcer({ polite: { textContent: "" }, assertive: { textContent: "" } }),
    tool: TOOLS[0] as ToolDefinition,
    setTool: () => {},
    view: "both",
    setView: () => {},
    option: () => undefined,
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

const withEditor = (editor: Editor, node: React.ReactNode) => (
  <EditorContext.Provider value={editor}>{node}</EditorContext.Provider>
);

describe("the status bar (ADR-017 D1)", () => {
  it("keeps the activity span in place when the project arrives", () => {
    // The app writes its activity line straight into this node. While the status bar sat behind a branch
    // that flipped once the replica existed, React reconciled the span away and the app went on writing
    // into an element no longer on screen. Found in a browser; this is the guard.
    const ref = createRef<HTMLSpanElement>();
    const { rerender, container } = render(
      withEditor(editorStub(), <StatusBar replica={null} activityRef={ref} />),
    );

    const span = ref.current;
    expect(span).not.toBeNull();
    (span as HTMLSpanElement).textContent = "reading plan.dxf…";

    rerender(withEditor(editorStub(), <StatusBar replica={new Replica()} activityRef={ref} />));

    expect(ref.current).toBe(span); // the very same node, not a replacement
    expect(span?.isConnected).toBe(true);
    expect(container.contains(span as Node)).toBe(true);
    expect(span?.textContent).toBe("reading plan.dxf…");
  });

  it("says it is connecting until the project is there, then counts the problems", () => {
    const { rerender, container } = render(
      withEditor(editorStub(), <StatusBar replica={null} activityRef={createRef<HTMLSpanElement>()} />),
    );
    expect(container.textContent).toContain("Connecting");

    const replica = new Replica();
    replica.problems = [
      {
        code: "wall.overlap",
        severity: "error",
        entityId: "wall_1",
        message: "two walls overlap",
        hint: null,
        related: [],
      },
      {
        code: "room.open",
        severity: "warning",
        entityId: "room_1",
        message: "this room does not close",
        hint: null,
        related: [],
      },
    ];
    rerender(
      withEditor(editorStub(), <StatusBar replica={replica} activityRef={createRef<HTMLSpanElement>()} />),
    );
    expect(container.textContent).toContain("1 error, 1 warning");
  });

  it("states where the pointer is and what a snap caught", () => {
    const editor = editorStub({ pointer: { x: 8420, y: 3150 }, snap: "Snap: wall end" });
    const { container } = render(
      withEditor(editor, <StatusBar replica={null} activityRef={createRef<HTMLSpanElement>()} />),
    );
    expect(container.textContent).toContain("Snap: wall end");
    expect(container.textContent).toContain("8 420");
  });
});

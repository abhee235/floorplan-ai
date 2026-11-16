// @vitest-environment jsdom
//
// The mark that says the host is behind its own source: a mark in the app bar, never a strip across the
// editor, because a warning that takes a row of its own moves the plan under whoever is working in it.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Announcer, type LiveRegion } from "../../src/editor/announce.js";
import { StaleNote } from "../../src/editor/StaleNote.js";
import { type Editor, EditorContext } from "../../src/editor/useEditor.js";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const polite: LiveRegion = { textContent: "" };

function show(note: string | null) {
  polite.textContent = "";
  const editor = {
    announcer: new Announcer({ polite, assertive: { textContent: "" } }),
  } as Partial<Editor> as Editor;
  return render(
    <EditorContext.Provider value={editor}>
      <StaleNote note={note} />
    </EditorContext.Provider>,
  );
}

describe("the stale mark", () => {
  it("is not there at all when there is nothing to say", () => {
    const { container } = show(null);
    expect(container.textContent).toBe("");
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows nothing but a mark until it is pressed, and then says its piece", async () => {
    const user = userEvent.setup();
    const sentence = "The host started before the last change to the code. Restart it.";
    show(sentence);
    // the sentence is not on screen, so nothing in the editor moved to make room for it
    expect(screen.queryByText(sentence)).toBeNull();
    const mark = screen.getByRole("button", { name: "What is out of date" });
    await user.click(mark);
    expect(screen.getByRole("dialog").textContent).toBe(sentence);
  });

  it("reads itself out once, for someone who cannot see an amber triangle", () => {
    const sentence = "The app has not been built since the last change to it.";
    show(sentence);
    expect(polite.textContent).toContain("not been built");
  });
});

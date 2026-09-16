// @vitest-environment jsdom
//
// A typed value shows on the plan and in 3D as it is typed (P3-5 follow-up): each good value is previewed,
// one command is sent when the field commits, and nothing typed is left showing once the field lets go.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Announcer } from "../../src/editor/announce.js";
import { PropertyField } from "../../src/editor/PropertyField.js";
import type { EditCommand, EditOutcome } from "../../src/editor/selection.js";
import { type Editor, EditorContext } from "../../src/editor/useEditor.js";

afterEach(cleanup);

/** A position field: whole millimetres from 0 to 9000, sent as a move from where the item is. */
const positionEdit =
  (at: number) =>
  (text: string): EditOutcome => {
    const n = Number(text);
    if (text.trim() === "" || !Number.isInteger(n) || n < 0 || n > 9000)
      return { ok: false, message: "From 0 to 9000." };
    return {
      ok: true,
      command: n === at ? null : { type: "item.move", payload: { dx: n - at } },
      said: `${n} millimetres`,
    };
  };

function setup() {
  const editor = {
    announcer: new Announcer({ polite: { textContent: "" }, assertive: { textContent: "" } }),
  } as Partial<Editor> as Editor;
  const sent: EditCommand[] = [];
  const previews: (EditCommand | null)[] = [];
  const field = (at: number) => (
    <EditorContext.Provider value={editor}>
      <PropertyField
        id="item-x"
        label="Position X"
        value={String(at)}
        unit="mm"
        edit={positionEdit(at)}
        send={async (command) => {
          sent.push(command);
        }}
        preview={(command) => previews.push(command)}
      />
    </EditorContext.Provider>
  );
  const view = render(field(1000));
  const input = screen.getByRole("textbox") as HTMLInputElement;
  return { input, sent, previews, rerender: (at: number) => view.rerender(field(at)), unmount: view.unmount };
}

describe("typing a value", () => {
  it("shows each value as it is typed and sends one change on Enter", async () => {
    const { input, sent, previews } = setup();
    const user = userEvent.setup();
    await user.click(input);
    await user.keyboard("1500");
    // "1", "15", "150" and "1500" are all positions; each is shown, none is sent
    expect(previews.map((c) => c?.payload.dx)).toEqual([-999, -985, -850, 500]);
    expect(sent).toEqual([]);
    await user.keyboard("{Enter}");
    // the preview goes before the change is sent, so the host's patch lands on what it knows
    expect(previews.at(-1)).toBeNull();
    expect(sent).toEqual([{ type: "item.move", payload: { dx: 500 } }]);
  });

  it("measures the change from where typing began, though the panel is drawn from the preview", async () => {
    const { input, sent, rerender } = setup();
    const user = userEvent.setup();
    await user.click(input);
    await user.keyboard("15");
    // the preview moved the item, and the panel now describes it at 15
    rerender(15);
    await user.keyboard("00{Enter}");
    // measured from 15 this would be a move of 1485
    expect(sent).toEqual([{ type: "item.move", payload: { dx: 500 } }]);
  });

  it("shows nothing for a value that cannot be taken, or for the value already there", async () => {
    const { input, sent, previews } = setup();
    const user = userEvent.setup();
    await user.click(input);
    await user.keyboard("12");
    await user.keyboard("0000");
    // 120000 is out of range: the last preview is taken down rather than left standing
    expect(previews.at(-1)).toBeNull();
    await user.clear(input);
    await user.keyboard("1000");
    // back at 1000 there is nothing to show, and nothing to send
    expect(previews.at(-1)).toBeNull();
    await user.keyboard("{Enter}");
    expect(sent).toEqual([]);
  });

  it("puts everything back on Escape, and sends on leaving the field", async () => {
    const { input, sent, previews } = setup();
    const user = userEvent.setup();
    await user.click(input);
    await user.keyboard("2000{Escape}");
    expect(previews.at(-1)).toBeNull();
    expect(input.value).toBe("1000");
    expect(sent).toEqual([]);
    await user.keyboard("3000");
    await user.tab();
    expect(previews.at(-1)).toBeNull();
    expect(sent).toEqual([{ type: "item.move", payload: { dx: 2000 } }]);
  });

  it("takes its preview down if the field goes while a value is showing", async () => {
    const { input, previews, unmount } = setup();
    const user = userEvent.setup();
    await user.click(input);
    await user.keyboard("2500");
    expect(previews.at(-1)).not.toBeNull();
    unmount();
    expect(previews.at(-1)).toBeNull();
  });
});

// @vitest-environment jsdom
//
// Changing a number by dragging its name, or by the arrow keys (P3-5 follow-up): the value follows the
// drag, the change is previewed as it goes, and one command is sent when the drag ends.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Announcer } from "../../src/editor/announce.js";
import { PropertyField } from "../../src/editor/PropertyField.js";
import { paceOf, scrubKindOf, scrubStart, scrubText } from "../../src/editor/scrub.js";
import type { EditCommand, EditOutcome } from "../../src/editor/selection.js";
import { type Editor, EditorContext } from "../../src/editor/useEditor.js";

afterEach(cleanup);

describe("the scrub rules", () => {
  it("drags millimetres, degrees and seats, and nothing else", () => {
    expect(scrubKindOf("mm")).toMatchObject({ perPx: 1, decimals: 0 });
    expect(scrubKindOf("°")).toMatchObject({ perPx: 0.5, decimals: 1 });
    expect(scrubKindOf("seats")).toMatchObject({ perPx: 0.1 });
    expect(scrubKindOf(undefined)).toBeNull();
    expect(scrubKindOf("m²")).toBeNull();
  });

  it("goes ten times faster with Shift and ten times slower with Alt", () => {
    expect(paceOf({ shiftKey: false, altKey: false })).toBe(1);
    expect(paceOf({ shiftKey: true, altKey: false })).toBe(10);
    expect(paceOf({ shiftKey: false, altKey: true })).toBe(0.1);
  });

  it("starts from the field's number, grouped or not, or from what an empty field stands for", () => {
    const grouped = `1${String.fromCharCode(0x202f)}600`;
    expect(scrubStart(grouped)).toBe(1600);
    expect(scrubStart("-45.5")).toBe(-45.5);
    expect(scrubStart("", `level · 2${String.fromCharCode(0x202f)}700 mm`)).toBe(2700);
    expect(scrubStart("", "straight")).toBeNull();
    expect(scrubStart("")).toBeNull();
  });

  it("keeps whole millimetres and tenths of a degree", () => {
    const mm = scrubKindOf("mm");
    const deg = scrubKindOf("°");
    if (!mm || !deg) throw new Error("no kinds");
    expect(scrubText(mm, 100.6)).toBe("101");
    expect(scrubText(deg, 12.34)).toBe("12.3");
    expect(scrubText(deg, -0.01)).toBe("0");
  });
});

/** Whole millimetres from 1 to 500; 100 is what the field already holds. */
const edit = (text: string): EditOutcome => {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > 500) return { ok: false, message: "From 1 to 500." };
  return {
    ok: true,
    command: n === 100 ? null : { type: "wall.modify", payload: { thickness: n } },
    said: `${n} millimetres`,
  };
};

function setup() {
  const editor = {
    announcer: new Announcer({ polite: { textContent: "" }, assertive: { textContent: "" } }),
  } as Partial<Editor> as Editor;
  const sent: EditCommand[] = [];
  const previews: (EditCommand | null)[] = [];
  render(
    <EditorContext.Provider value={editor}>
      <PropertyField
        id="wall-thickness"
        label="Thickness"
        prefix="T"
        value="100"
        unit="mm"
        edit={edit}
        send={async (command) => {
          sent.push(command);
        }}
        preview={(command) => previews.push(command)}
      />
    </EditorContext.Provider>,
  );
  const input = screen.getByRole("textbox") as HTMLInputElement;
  // the letter inside the field, which is the handle; the name above it only names the field
  const handle = screen.getByText("T");
  return { input, handle, label: screen.getByText("Thickness"), sent, previews };
}

const drag = (
  handle: HTMLElement,
  moves: { x: number; shiftKey?: boolean }[],
  end: "up" | "escape" = "up",
) => {
  fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 10 });
  for (const m of moves)
    fireEvent.pointerMove(document, { clientX: m.x, clientY: 10, shiftKey: m.shiftKey ?? false });
  if (end === "up") fireEvent.pointerUp(document, { clientX: moves.at(-1)?.x ?? 100 });
  else fireEvent.keyDown(document, { key: "Escape" });
};

describe("dragging a number", () => {
  it("previews every step and sends one command, for the value where the drag ended", () => {
    const { input, handle, sent, previews } = setup();
    drag(handle, [{ x: 110 }, { x: 130 }, { x: 125 }]);
    expect(previews.slice(0, -1).map((c) => c?.payload.thickness)).toEqual([110, 130, 125]);
    // the preview is put back before the real command goes, so the host's reply lands on what it knows
    expect(previews.at(-1)).toBeNull();
    expect(sent).toEqual([{ type: "wall.modify", payload: { thickness: 125 } }]);
    expect(input.value).toBe("125");
  });

  it("goes ten times as far with Shift held", () => {
    const { handle, sent } = setup();
    drag(handle, [{ x: 104 }, { x: 110, shiftKey: true }]);
    expect(sent).toEqual([{ type: "wall.modify", payload: { thickness: 164 } }]);
  });

  it("stops at the last value the field takes, and sends nothing for a drag back to where it began", () => {
    const { handle, sent } = setup();
    drag(handle, [{ x: 600 }, { x: 900 }]);
    // 600 took the value to 600, past 500, so nothing was previewed or kept for it
    expect(sent).toEqual([]);
    cleanup();
    const second = setup();
    drag(second.handle, [{ x: 150 }, { x: 100 }]);
    expect(second.sent).toEqual([]);
  });

  it("puts everything back on Escape, and treats a press without movement as a click", () => {
    const { input, handle, sent, previews } = setup();
    drag(handle, [{ x: 140 }], "escape");
    expect(sent).toEqual([]);
    expect(previews.at(-1)).toBeNull();
    expect(input.value).toBe("100");
    // under the threshold: no preview, nothing sent
    const count = previews.length;
    drag(handle, [{ x: 101 }]);
    expect(previews).toHaveLength(count);
    expect(sent).toEqual([]);
  });

  it("makes the letter the handle, not the name, and says how to step the number", () => {
    const { input, label, handle } = setup();
    expect(handle.className).toContain("cursor-ew-resize");
    expect(label.className).not.toContain("cursor-ew-resize");
    const described = (input.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(described.join(" ")).toContain("Up and Down arrows change the number");
  });
});

describe("stepping a number from the keyboard", () => {
  it("steps by one, and by ten with Shift, sending each step", async () => {
    const { input, sent } = setup();
    const user = userEvent.setup();
    await user.click(input);
    await user.keyboard("{ArrowUp}");
    expect(sent.at(-1)).toEqual({ type: "wall.modify", payload: { thickness: 101 } });
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    // no host here answers with the new value, so the field still shows 100 and steps down from that
    expect(sent.at(-1)?.payload.thickness).toBe(90);
  });
});

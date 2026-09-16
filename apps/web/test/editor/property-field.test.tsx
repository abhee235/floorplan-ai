// @vitest-environment jsdom
//
// The field's side of an edit: the draft, the refusal, and the round trip. What typed text MEANS belongs to
// selection.ts and is tested there against the real reducer; here `edit` is a stand-in, so each case can
// say exactly what came back.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { Announcer, type LiveRegion } from "../../src/editor/announce.js";
import { PropertyField } from "../../src/editor/PropertyField.js";
import type { EditCommand, EditOutcome } from "../../src/editor/selection.js";
import { type Editor, EditorContext } from "../../src/editor/useEditor.js";

afterEach(cleanup);

/** Whole numbers only; 100 is what the field already holds, so it asks for nothing. */
const edit = (text: string): EditOutcome => {
  const n = Number(text);
  if (text.trim() === "" || !Number.isInteger(n)) return { ok: false, message: "Type a whole number." };
  const command = n === 100 ? null : { type: "wall.modify", payload: { thickness: n } };
  return { ok: true, command, said: `${n} millimetres` };
};

interface Setup {
  /** Stands in for the host: records the command, and may refuse it. */
  refuse?: string;
  editable?: boolean;
}

function setup({ refuse, editable = true }: Setup = {}) {
  const polite: LiveRegion = { textContent: "" };
  const assertive: LiveRegion = { textContent: "" };
  // The field reads nothing from the editor but its announcer.
  const editor = { announcer: new Announcer({ polite, assertive }) } as Partial<Editor> as Editor;
  const sent: EditCommand[] = [];

  const ui = (value: string) => (
    <EditorContext.Provider value={editor}>
      <PropertyField
        id="wall-thickness"
        label="Thickness"
        value={value}
        unit="mm"
        edit={editable ? edit : undefined}
        send={editable ? send : undefined}
      />
      <button type="button">elsewhere</button>
    </EditorContext.Provider>
  );
  const view = render(ui("100"));

  // The real host sends its patch BEFORE its reply, so the new value is in place by the time the promise
  // settles. Re-rendering here, ahead of resolving, is that order.
  async function send(command: EditCommand): Promise<void> {
    sent.push(command);
    if (refuse) throw new Error(refuse);
    view.rerender(ui(String(command.payload.thickness)));
  }

  const input = screen.getByRole("textbox") as HTMLInputElement;
  return { input, sent, polite, assertive, user: userEvent.setup() };
}

/** Keys that reach the document, where the shell listens. */
function keysAtDocument(): string[] {
  const seen: string[] = [];
  const listener = (e: KeyboardEvent) => seen.push(`${e.ctrlKey ? "Ctrl+" : ""}${e.key}`);
  document.addEventListener("keydown", listener);
  onTestFinished(() => document.removeEventListener("keydown", listener));
  return seen;
}

describe("a property field (ADR-017 D3)", () => {
  it("shows the bare number, and names its unit to a screen reader", () => {
    const { input } = setup();
    expect(input.value).toBe("100");
    expect(screen.getByLabelText("Thickness, in millimetres")).toBe(input);
    expect(input.readOnly).toBe(false);
  });

  it("selects the whole value on focus, so typing replaces it", async () => {
    const { input, user } = setup();
    await user.tab();
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
    await user.keyboard("120");
    expect(input.value).toBe("120");
  });

  it("sends what was typed on Enter, announces it, and stays for the next number", async () => {
    const { input, sent, polite, user } = setup();
    await user.tab();
    await user.keyboard("120{Enter}");
    expect(sent).toEqual([{ type: "wall.modify", payload: { thickness: 120 } }]);
    expect(input.value).toBe("120");
    expect(polite.textContent).toBe("Thickness 120 millimetres.");
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
  });

  it("sends what was typed when the field is left", async () => {
    const { input, sent, user } = setup();
    await user.tab();
    await user.keyboard("150");
    await user.tab();
    expect(document.activeElement).not.toBe(input);
    expect(sent).toEqual([{ type: "wall.modify", payload: { thickness: 150 } }]);
    expect(input.value).toBe("150");
  });

  it("sends nothing when the value typed is the one already there", async () => {
    const { sent, polite, user } = setup();
    await user.tab();
    await user.keyboard("100{Enter}");
    await user.tab();
    expect(sent).toEqual([]);
    expect(polite.textContent).toBe("");
  });

  it("puts the value back on Escape, and keeps the focus where it was", async () => {
    const { input, sent, user } = setup();
    await user.tab();
    await user.keyboard("7{Escape}");
    expect(input.value).toBe("100");
    expect(document.activeElement).toBe(input);
    await user.tab();
    expect(sent).toEqual([]);
  });

  it("keeps Escape from the shell only when there was something to put back", async () => {
    const seen = keysAtDocument();
    const { user } = setup();
    await user.tab();
    await user.keyboard("7{Escape}");
    expect(seen).not.toContain("Escape");
    // nothing typed now, so Escape goes on to the shell, which returns to the select tool
    await user.keyboard("{Escape}");
    expect(seen).toContain("Escape");
  });

  it("keeps undo with the text while typing, and leaves it to the shell otherwise", async () => {
    const seen = keysAtDocument();
    const { user } = setup();
    await user.tab();
    await user.keyboard("{Control>}z{/Control}");
    expect(seen).toContain("Ctrl+z");
    seen.length = 0;
    await user.keyboard("7{Control>}z{/Control}");
    expect(seen).not.toContain("Ctrl+z");
  });

  it("keeps nonsense in the field on Enter, marked, with the reason beside it", async () => {
    const { input, sent, assertive, user } = setup();
    await user.tab();
    await user.keyboard("abc{Enter}");
    expect(sent).toEqual([]);
    expect(input.value).toBe("abc");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = document.getElementById(input.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("Type a whole number.");
    expect(assertive.textContent).toBe("Thickness not changed. Type a whole number.");
    // typing again clears the mark, since the text it was about is gone
    await user.keyboard("{Backspace}");
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("puts the value back when the field is left with nonsense, and says what was kept", async () => {
    const { input, sent, user } = setup();
    await user.tab();
    await user.keyboard("abc");
    await user.tab();
    expect(sent).toEqual([]);
    expect(input.value).toBe("100");
    const described = document.getElementById(input.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("Type a whole number. Kept 100 mm.");
  });

  it("shows the host's refusal and puts the value back", async () => {
    const { input, sent, polite, assertive, user } = setup({ refuse: "start must differ from end" });
    await user.tab();
    await user.keyboard("120{Enter}");
    expect(sent).toHaveLength(1);
    expect(input.value).toBe("100");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById("wall-thickness-error")?.textContent).toBe(
      "Not changed: start must differ from end",
    );
    expect(assertive.textContent).toBe("Thickness not changed: start must differ from end");
    expect(polite.textContent).toBe("");
    // Escape clears the reason once it has been read
    await user.keyboard("{Escape}");
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("takes no typing on a read-only row, but can still be reached", async () => {
    const { input, sent, user } = setup({ editable: false });
    expect(input.readOnly).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(input);
    await user.keyboard("9{Enter}");
    expect(input.value).toBe("100");
    expect(sent).toEqual([]);
  });
});

describe("how a property row is labelled", () => {
  const editor = {
    announcer: new Announcer({ polite: { textContent: "" }, assertive: { textContent: "" } }),
  } as Partial<Editor> as Editor;
  const show = (props: Parameters<typeof PropertyField>[0]) =>
    render(
      <EditorContext.Provider value={editor}>
        <PropertyField {...props} />
      </EditorContext.Provider>,
    );

  it("prints only part of a name when a caption says so, and a screen reader hears all of it", () => {
    const { container } = show({
      id: "w-start-y",
      label: "Start Y",
      caption: "",
      prefix: "Y",
      value: "0",
      unit: "mm",
      edit,
      send: async () => {},
    });
    const input = screen.getByLabelText("Start Y, in millimetres");
    expect(input.id).toBe("w-start-y");
    // nothing printed beside the field: the only text in the label is the screen-reader-only part
    const label = container.querySelector("label");
    expect(label?.querySelector(".sr-only")?.textContent).toBe(label?.textContent);
    // the axis is printed inside the field, and kept from a screen reader, which has it in the label
    const prefix = [...container.querySelectorAll('[aria-hidden="true"]')].map((el) => el.textContent);
    expect(prefix).toEqual(["Y", "mm"]);
  });

  it("prints the caption of a pair's first row, and hears the rest after it", () => {
    const { container } = show({
      id: "w-start-x",
      label: "Start X",
      caption: "Start",
      prefix: "X",
      value: "0",
    });
    expect(container.querySelector("label")?.firstChild?.textContent).toBe("Start");
    expect(screen.getByLabelText("Start X").id).toBe("w-start-x");
  });

  it("shows a read-only choice by its label, not by the value the model stores", () => {
    show({
      id: "w-kind",
      label: "Kind",
      value: "interior",
      choices: [{ value: "interior", label: "Interior" }],
    });
    expect((screen.getByLabelText("Kind") as HTMLInputElement).value).toBe("Interior");
  });

  it("shows an editable choice as a list named by its label, holding the model's value", () => {
    show({
      id: "w-kind",
      label: "Kind",
      value: "interior",
      choices: [
        { value: "exterior", label: "Exterior" },
        { value: "interior", label: "Interior" },
      ],
      edit: (value) => ({ ok: true, command: null, said: value }),
      send: async () => {},
    });
    const list = screen.getByRole("combobox", { name: "Kind" });
    expect(list.textContent).toContain("Interior");
  });
});

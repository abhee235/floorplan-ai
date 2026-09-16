// @vitest-environment jsdom
//
// The field's side of an edit: the draft, the refusal, and the round trip. What typed text MEANS belongs to
// selection.ts and is tested there against the real reducer; here `edit` is a stand-in, so each case can
// say exactly what came back.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { Announcer, type LiveRegion } from "../../src/editor/announce.js";
import { NUMBER_HELP, PropertyField } from "../../src/editor/PropertyField.js";
import type { EditCommand, EditOutcome } from "../../src/editor/selection.js";
import { type Editor, EditorContext } from "../../src/editor/useEditor.js";

beforeAll(() => {
  // A reset button's tooltip measures itself with a ResizeObserver, which jsdom lacks. Without one, a hover
  // that opened the tooltip before the click landed threw, React took the field down, and the click was
  // lost: the reset test failed now and then, only when the run was slow enough for that to happen.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

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
    // the reason is the last thing described, after how the number can be stepped
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids.map((i) => document.getElementById(i)?.textContent)).toEqual([
      NUMBER_HELP,
      "Type a whole number.",
    ]);
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
    const last = (input.getAttribute("aria-describedby") ?? "").split(" ").at(-1) ?? "";
    expect(document.getElementById(last)?.textContent).toBe("Type a whole number. Kept 100 mm.");
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
    // nothing printed beside the field, and the whole name on the field itself, where no layout can
    // put a stray space into it
    expect(container.querySelector("label")?.textContent).toBe("");
    expect(input.getAttribute("aria-label")).toBe("Start Y, in millimetres");
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

  it("draws a pattern's picture beside its name, out of the accessibility tree (W-121)", () => {
    show({
      id: "w-pattern",
      label: "Plan pattern",
      value: "cross-hatch",
      choices: [
        { value: "solid", label: "Solid", swatch: "solid" },
        { value: "cross-hatch", label: "Cross-hatched", swatch: "cross-hatch" },
      ],
      edit: (value) => ({ ok: true, command: null, said: value }),
      send: async () => {},
    });
    const list = screen.getByRole("combobox", { name: "Plan pattern" });
    expect(list.textContent).toBe("Cross-hatched");
    const picture = list.querySelector("svg[aria-hidden='true']");
    // two sets of diagonals, clipped by an id a url() reference can name
    expect(picture?.querySelectorAll("line")).toHaveLength(14);
    expect(picture?.querySelector("clipPath")?.id).toMatch(/^pattern-[\w-]+$/);
    expect(picture?.querySelector("g")?.getAttribute("clip-path")).toBe(
      `url(#${picture?.querySelector("clipPath")?.id})`,
    );
  });
});

describe("a property field that may be empty", () => {
  /** Empty follows the level; a number is the wall's own. */
  const heightEdit =
    (current: string) =>
    (text: string): EditOutcome => {
      if (text.trim() === "")
        return {
          ok: true,
          command: current === "" ? null : { type: "wall.modify", payload: { height: null } },
          said: "follows the level",
        };
      const n = Number(text);
      if (!Number.isInteger(n)) return { ok: false, message: "Type a whole number." };
      return { ok: true, command: { type: "wall.modify", payload: { height: n } }, said: `${n} millimetres` };
    };

  function setupEmpty(start: string) {
    const polite: LiveRegion = { textContent: "" };
    const editor = {
      announcer: new Announcer({ polite, assertive: { textContent: "" } }),
    } as Partial<Editor> as Editor;
    const sent: EditCommand[] = [];
    const ui = (value: string) => (
      <EditorContext.Provider value={editor}>
        <TooltipProvider>
          <PropertyField
            id="wall-height"
            label="Height"
            value={value}
            unit="mm"
            empty={{ shown: "level · 2 700 mm", action: "Follow the level's height" }}
            hint="Empty follows the level, 2700 millimetres."
            edit={heightEdit(value)}
            send={send}
          />
        </TooltipProvider>
      </EditorContext.Provider>
    );
    const view = render(ui(start));
    async function send(command: EditCommand): Promise<void> {
      sent.push(command);
      const height = command.payload.height;
      view.rerender(ui(height === null ? "" : String(height)));
    }
    const input = screen.getByRole("textbox") as HTMLInputElement;
    const unitShown = () =>
      [...view.container.querySelectorAll('[aria-hidden="true"]')].some((el) => el.textContent === "mm");
    return { input, sent, polite, view, unitShown, user: userEvent.setup() };
  }

  it("shows what empty stands for, greyed in the field, and drops the unit beside it", () => {
    const { input, unitShown } = setupEmpty("");
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("level · 2 700 mm");
    expect(unitShown()).toBe(false);
  });

  it("brings the unit back as soon as something is typed", async () => {
    const { input, unitShown, user } = setupEmpty("");
    await user.click(input);
    await user.keyboard("3");
    expect(unitShown()).toBe(true);
  });

  it("describes itself to a screen reader, and adds the refusal after the description", async () => {
    const { input, user } = setupEmpty("");
    const described = () =>
      (input.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent);
    expect(described()).toEqual(["Empty follows the level, 2700 millimetres.", NUMBER_HELP]);
    await user.click(input);
    await user.keyboard("x{Enter}");
    expect(described()).toEqual([
      "Empty follows the level, 2700 millimetres.",
      NUMBER_HELP,
      "Type a whole number.",
    ]);
  });

  it("offers no reset while the field is already empty", () => {
    setupEmpty("");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("empties a filled field from its reset button, then hands the focus to the field", async () => {
    const { input, sent, polite, user } = setupEmpty("3000");
    const reset = screen.getByRole("button", { name: "Follow the level's height (Height)" });
    await user.click(reset);
    expect(sent).toEqual([{ type: "wall.modify", payload: { height: null } }]);
    expect(input.value).toBe("");
    expect(polite.textContent).toBe("Height follows the level.");
    // the button went with the value, so the focus did not go with the button
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("empties a filled field when its text is deleted and the field is left", async () => {
    const { input, sent, user } = setupEmpty("3000");
    await user.click(input);
    await user.keyboard("{Backspace}");
    await user.tab();
    expect(sent).toEqual([{ type: "wall.modify", payload: { height: null } }]);
    expect(input.value).toBe("");
  });

  it("says it was kept empty when left with nonsense", async () => {
    const { input, user } = setupEmpty("");
    await user.click(input);
    await user.keyboard("x");
    await user.tab();
    expect(input.value).toBe("");
    expect(document.getElementById("wall-height-error")?.textContent).toBe(
      "Type a whole number. Kept it empty.",
    );
  });
});

describe("a colour field", () => {
  const colourEdit =
    (current: string) =>
    (text: string): EditOutcome => {
      if (text.trim() === "")
        return {
          ok: true,
          command: current ? { type: "paint", payload: { color: null } } : null,
          said: "default",
        };
      const hex = /^#[0-9A-F]{6}$/i.test(text) ? text.toUpperCase() : null;
      if (!hex) return { ok: false, message: "Colour needs a hex value." };
      return {
        ok: true,
        command: hex === current ? null : { type: "paint", payload: { color: hex } },
        said: hex,
      };
    };

  function setupColour(start: string) {
    const editor = {
      announcer: new Announcer({ polite: { textContent: "" }, assertive: { textContent: "" } }),
    } as Partial<Editor> as Editor;
    const sent: EditCommand[] = [];
    const ui = (value: string) => (
      <EditorContext.Provider value={editor}>
        <TooltipProvider>
          <PropertyField
            id="w-colour-left"
            label="Colour, left side"
            caption="Colour"
            value={value}
            colour={{ effective: "#E8E6E1" }}
            empty={{ shown: "default", action: "Use the default colour" }}
            edit={colourEdit(value)}
            send={send}
          />
        </TooltipProvider>
      </EditorContext.Provider>
    );
    const view = render(ui(start));
    async function send(command: EditCommand): Promise<void> {
      sent.push(command);
      view.rerender(ui((command.payload.color as string | null) ?? ""));
    }
    const text = screen.getByRole("textbox") as HTMLInputElement;
    const swatch = screen.getByLabelText("Colour, left side, picker") as HTMLInputElement;
    return { text, swatch, sent, user: userEvent.setup() };
  }

  it("shows the default colour on its swatch while the value is empty", () => {
    const { text, swatch } = setupColour("");
    expect(swatch.type).toBe("color");
    expect(swatch.value).toBe("#e8e6e1");
    expect(text.value).toBe("");
    expect(text.placeholder).toBe("default");
  });

  it("previews a colour from the picker in the text, and sends it only when the picker settles", () => {
    const { text, swatch, sent } = setupColour("");
    fireEvent.input(swatch, { target: { value: "#00ff00" } });
    expect(text.value).toBe("#00FF00");
    expect(sent).toEqual([]);
    fireEvent.change(swatch, { target: { value: "#00ff00" } });
    expect(sent).toEqual([{ type: "paint", payload: { color: "#00FF00" } }]);
  });

  it("follows a typed colour on its swatch, and sends it on Enter", async () => {
    const { text, swatch, sent, user } = setupColour("");
    await user.click(text);
    await user.keyboard("#0000ff");
    expect(swatch.value).toBe("#0000ff");
    await user.keyboard("{Enter}");
    expect(sent).toEqual([{ type: "paint", payload: { color: "#0000FF" } }]);
  });

  it("makes room for both the swatch and the reset button once the side is painted", () => {
    const { text } = setupColour("#FF0000");
    expect(screen.getByRole("button", { name: "Use the default colour (Colour, left side)" })).toBeDefined();
    expect(text.className).toContain("pl-12");
  });
});

describe("a yes-or-no field", () => {
  it("is a named checkbox that sends its new state on a click, and follows the model", async () => {
    const editor = {
      announcer: new Announcer({ polite: { textContent: "" }, assertive: { textContent: "" } }),
    } as Partial<Editor> as Editor;
    const sent: EditCommand[] = [];
    const ui = (value: string) => (
      <EditorContext.Provider value={editor}>
        <PropertyField
          id="room-show-ceiling"
          label="Show ceiling"
          caption="Show"
          value={value}
          toggle
          edit={(text) => ({
            ok: true,
            command:
              text === value ? null : { type: "room.modify", payload: { ceilingVisible: text === "true" } },
            said: text === "true" ? "shown" : "hidden",
          })}
          send={async (command) => {
            sent.push(command);
            view.rerender(ui(String(command.payload.ceilingVisible)));
          }}
        />
      </EditorContext.Provider>
    );
    const view = render(ui("true"));
    const box = screen.getByRole("checkbox", { name: "Show ceiling" });
    expect(box.getAttribute("aria-checked")).toBe("true");
    await userEvent.setup().click(box);
    expect(sent).toEqual([{ type: "room.modify", payload: { ceilingVisible: false } }]);
    expect(screen.getByRole("checkbox", { name: "Show ceiling" }).getAttribute("aria-checked")).toBe("false");
    // the printed label is the caption, and clicking it reaches the box
    expect(view.container.querySelector("label")?.textContent).toBe("Show");
  });
});

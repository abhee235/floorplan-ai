import { describe, expect, it } from "vitest";
import {
  chordFromEvent,
  describeChord,
  describeShortcut,
  isInsidePopup,
  isTypingTarget,
  type KeyLike,
  matchesChord,
  normaliseKey,
  parseChord,
} from "../../src/index.js";

const press = (key: string, mods: Partial<Omit<KeyLike, "key">> = {}): KeyLike => ({
  key,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("shortcut parsing (ADR-017 D4)", () => {
  it("reads modifiers and lower-cases a letter", () => {
    expect(parseChord("Ctrl+Shift+Z")).toEqual({
      key: "z",
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
    });
    expect(parseChord("W").key).toBe("w");
  });

  it("gives one spelling to keys people write several ways", () => {
    expect(parseChord("Esc").key).toBe("Escape");
    expect(parseChord("escape").key).toBe("Escape");
    expect(normaliseKey("Escape")).toBe("Escape");
    expect(parseChord("Space").key).toBe(" ");
    expect(parseChord("Del").key).toBe("Delete");
    expect(parseChord("Left").key).toBe("ArrowLeft");
  });

  it("spells the function keys as events do, whatever case they were written in", () => {
    // "f7" would otherwise never match an event's "F7"
    expect(parseChord("f7").key).toBe("F7");
    expect(matchesChord(parseChord("Ctrl+f12"), press("F12", { ctrlKey: true }))).toBe(true);
    // a name we do not know is kept as written rather than guessed at
    expect(normaliseKey("ContextMenu")).toBe("ContextMenu");
  });

  it("reads the plus key itself", () => {
    expect(parseChord("Ctrl++")).toMatchObject({ key: "+", ctrl: true });
  });

  it("refuses a typo when the command is registered rather than never firing", () => {
    expect(() => parseChord("Ctrl+Shft+Z")).toThrow(/unknown modifier/);
    expect(() => parseChord("Ctrl")).toThrow(/ends with a modifier/);
    expect(() => parseChord("")).toThrow(/empty shortcut/);
  });
});

describe("shortcut matching", () => {
  it("compares every modifier", () => {
    const undo = parseChord("Ctrl+Z");
    expect(matchesChord(undo, press("z", { ctrlKey: true }))).toBe(true);
    expect(matchesChord(undo, press("z"))).toBe(false);
    expect(matchesChord(undo, press("z", { ctrlKey: true, altKey: true }))).toBe(false);
    // redo is a different chord, so Ctrl+Shift+Z must not fire undo
    expect(matchesChord(undo, press("Z", { ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("ignores shift for punctuation, which already carries it", () => {
    // "?" is Shift+/ on most layouts: comparing the flag would stop the help shortcut ever matching
    expect(matchesChord(parseChord("?"), press("?", { shiftKey: true }))).toBe(true);
    expect(matchesChord(parseChord("["), press("[", {}))).toBe(true);
  });

  it("reads a chord back off an event", () => {
    expect(chordFromEvent(press("K", { ctrlKey: true }))).toEqual({
      key: "k",
      ctrl: true,
      shift: false,
      alt: false,
      meta: false,
    });
  });
});

describe("how a shortcut prints", () => {
  it("uses the symbols the keyboard map shows", () => {
    expect(describeShortcut("Ctrl+Shift+Z")).toBe("Ctrl ⇧ Z");
    expect(describeShortcut("Ctrl+K")).toBe("Ctrl K");
    expect(describeShortcut("Del")).toBe("Del");
    expect(describeShortcut("Space")).toBe("Space");
    expect(describeShortcut("Left")).toBe("←");
  });

  it("uses the platform's own modifier keys on a Mac", () => {
    expect(describeChord(parseChord("Cmd+K"), true)).toBe("⌘ K");
    expect(describeChord(parseChord("Ctrl+Alt+F"), true)).toBe("⌃ ⌥ F");
  });
});

describe("where a bare letter is typing, not a shortcut", () => {
  it("holds off inside text entry", () => {
    expect(isTypingTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "number" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("does not hold off on controls that never swallow a letter", () => {
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget({ tagName: "CANVAS" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("leaves keys to an open list, menu or dialog, so typing to find an option picks no tool", () => {
    const inside = (selector: string) => ({ closest: (s: string) => (s.includes(selector) ? {} : null) });
    expect(isInsidePopup(inside('[role="listbox"]'))).toBe(true);
    expect(isInsidePopup(inside('[role="menu"]'))).toBe(true);
    expect(isInsidePopup(inside('[role="dialog"]'))).toBe(true);
    expect(isInsidePopup({ closest: () => null })).toBe(false);
    expect(isInsidePopup({})).toBe(false);
    expect(isInsidePopup(null)).toBe(false);
  });
});

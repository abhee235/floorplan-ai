import { describe, expect, it } from "vitest";
import {
  checkTool,
  checkTools,
  phraseText,
  TOOLS,
  t,
  toolById,
  toolForKey,
  toolReady,
} from "../../src/index.js";

describe("the tools on the rail (ADR-017 D2)", () => {
  it("is the set the design names, in rail order", () => {
    expect(TOOLS.map((t) => t.id)).toEqual([
      "select",
      "wall",
      "room",
      "opening",
      "item",
      "zone",
      "measure",
      "annotate",
      "pan",
    ]);
    expect(TOOLS.map((t) => t.shortcut)).toEqual(["V", "W", "R", "O", "I", "Z", "M", "T", "Space"]);
  });

  it("refuses a tool that does not say how it is used", () => {
    // ADR-017: a tool must state its options, its shortcut and its keyboard path, or it cannot be added
    const half = { ...(TOOLS[1] as (typeof TOOLS)[number]), keyboard: [], modifiers: [t(" ")] };
    expect(checkTool(half)).toEqual(["a sentence naming its modifiers", "a keyboard path"]);
    expect(() => checkTools([half])).toThrow(/cannot go on the rail without/);
  });

  it("accepts every tool that is actually on the rail", () => {
    expect(() => checkTools()).not.toThrow();
    for (const tool of TOOLS) expect(checkTool(tool)).toEqual([]);
  });

  it("gives each tool a different letter, so no shortcut is shadowed", () => {
    const letters = TOOLS.map((t) => t.shortcut.toLowerCase());
    expect(new Set(letters).size).toBe(letters.length);
  });

  it("finds a tool by its letter, whatever case it was typed in", () => {
    expect(toolForKey("w")?.id).toBe("wall");
    expect(toolForKey("W")?.id).toBe("wall");
    expect(toolForKey(" ")?.id).toBe("pan"); // events spell the space bar " "
    expect(toolForKey("q")).toBeNull();
  });

  it("states which tools actually do something, so the rail cannot pretend", () => {
    // this list is the promise the UI makes; extend it as each tool's gestures land
    expect(TOOLS.filter((t) => toolReady(t)).map((t) => t.id)).toEqual([
      "select",
      "wall",
      "room",
      "item",
      "zone",
      "pan",
    ]);
    expect(toolReady("opening")).toBe(false);
    expect(toolReady("wall")).toBe(true);
    expect(toolReady("room")).toBe(true);
  });

  it("finds a tool by id", () => {
    expect(toolById("measure")?.title).toBe("Measure");
    expect(toolById("nothing")).toBeNull();
  });

  it("gives the drawing tools the snapping switches the modifiers invert (W-082)", () => {
    const wall = toolById("wall");
    expect(wall?.options.map((o) => o.id)).toContain("snapWalls");
    expect(wall?.options.map((o) => o.id)).toContain("thickness");
    // The sentence still reads the same; it is just built from parts now so the keys can be drawn as keys.
    expect(phraseText(wall?.modifiers ?? [])).toMatch(/Shift.*align.*Alt.*bypass/);
    expect(wall?.modifiers.filter((p) => "key" in p)).toEqual([{ key: "Shift" }, { key: "Alt" }]);
  });
});

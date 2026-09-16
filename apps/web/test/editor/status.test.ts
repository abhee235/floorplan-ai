import { describe, expect, it } from "vitest";
import {
  type CommandMatch,
  CommandRegistry,
  countsText,
  describeLength,
  formatMm,
  paletteSections,
  parseMm,
  pointerText,
  problemSummary,
  scaleLabel,
} from "../../src/index.js";

const NARROW = " ";

describe("lengths in words and figures", () => {
  it("groups thousands for the eye, as a drawing writes them", () => {
    expect(formatMm(12250)).toBe(`12${NARROW}250`);
    expect(formatMm(4250.4)).toBe(`4${NARROW}250`);
    expect(formatMm(900)).toBe("900");
    expect(formatMm(-12250)).toBe(`-12${NARROW}250`);
  });

  it("leaves a screen reader plain digits, which it reads as a number", () => {
    expect(describeLength(4250)).toBe("4250 millimetres");
  });

  it("reads a typed length back as whole millimetres", () => {
    expect(parseMm("120")).toBe(120);
    expect(parseMm(" 120 ")).toBe(120);
    expect(parseMm("120.4")).toBe(120);
    expect(parseMm("120.5")).toBe(121);
    expect(parseMm(".5")).toBe(1);
    expect(parseMm("-40")).toBe(-40);
  });

  it("reads back what formatMm writes, whatever space groups the thousands", () => {
    expect(parseMm(formatMm(12250))).toBe(12250);
    expect(parseMm("12 250")).toBe(12250);
    expect(parseMm("12 250")).toBe(12250);
  });

  it("takes a typed unit, and a bare number as millimetres", () => {
    expect(parseMm("120mm")).toBe(120);
    expect(parseMm("12 cm")).toBe(120);
    expect(parseMm("1.2 m")).toBe(1200);
    expect(parseMm("1.2M")).toBe(1200);
  });

  it("refuses what is not a length rather than guessing", () => {
    for (const text of ["", " ", "abc", "12 ft", "1,200", "1.2.3", "mm", "1e3", "Infinity", "12-3"])
      expect(parseMm(text), text).toBeNull();
  });

  it("states where the pointer is, and says nothing when it is off the plan", () => {
    expect(pointerText({ x: 8420, y: 3150 })).toBe(`x 8${NARROW}420 · y 3${NARROW}150 mm`);
    expect(pointerText(null)).toBe("");
  });
});

describe("problems in words, never a code (ADR-017 D3)", () => {
  it("says so when there are none", () => {
    expect(problemSummary([])).toEqual({ text: "No problems", tone: "ok" });
  });

  it("counts errors and warnings, singular and plural", () => {
    expect(problemSummary([{ severity: "error" }])).toEqual({ text: "1 error", tone: "error" });
    expect(problemSummary([{ severity: "warning" }, { severity: "warning" }])).toEqual({
      text: "2 warnings",
      tone: "warning",
    });
    expect(problemSummary([{ severity: "error" }, { severity: "warning" }])).toEqual({
      text: "1 error, 1 warning",
      tone: "error",
    });
  });
});

describe("the zoom readout", () => {
  it("states the drawing scale, not the pixel count", () => {
    // one millimetre of screen to fifty of plan, at 96 CSS pixels to the inch
    const pixelsPerMm = 96 / 25.4 / 50;
    expect(scaleLabel(pixelsPerMm)).toBe("1:50");
  });

  it("accounts for a dense display, where a device pixel is not a CSS pixel", () => {
    const pixelsPerMm = (2 * (96 / 25.4)) / 50;
    expect(scaleLabel(pixelsPerMm, 2)).toBe("1:50");
  });

  it("turns the ratio round when the plan is larger than life", () => {
    expect(scaleLabel((96 / 25.4) * 4)).toBe("4:1");
  });

  it("says nothing rather than a nonsense scale before the view exists", () => {
    expect(scaleLabel(0)).toBe("—");
  });
});

describe("what this level holds", () => {
  it("counts in words, singular and plural", () => {
    expect(countsText({ walls: [1, 2], rooms: [1], items: [] })).toBe("2 walls · 1 room · 0 items");
    expect(countsText(null)).toBe("Nothing loaded yet");
  });
});

describe("the palette's sections", () => {
  const commands = new CommandRegistry().add(
    { id: "tool.select", title: "Select", group: "Tools", run: () => {} },
    { id: "edit.undo", title: "Undo", group: "Edit", run: () => {} },
    { id: "tool.wall", title: "Draw wall", group: "Tools", run: () => {} },
  );

  it("keeps each group together, in the order its first row ranked", () => {
    const sections = paletteSections(commands.match(""));
    expect(sections.map((s) => s.group)).toEqual(["Tools", "Edit"]);
    expect(sections[0]?.items.map((m) => m.command.id)).toEqual(["tool.select", "tool.wall"]);
  });

  it("drops a group whose rows all failed to match", () => {
    const sections = paletteSections(commands.match("wall"));
    expect(sections.map((s) => s.group)).toEqual(["Tools"]);
  });

  it("copes with nothing matching at all", () => {
    expect(paletteSections([] as CommandMatch[])).toEqual([]);
  });
});

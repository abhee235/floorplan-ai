// The colour arithmetic behind the colour picker (P3-5 follow-up).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Project } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import {
  channelValues,
  cmykToRgb,
  fromChannels,
  harmonies,
  hexToHsv,
  hexToRgb,
  hslToHsv,
  hsvToHex,
  hsvToHsl,
  isLight,
  projectColours,
  rgbToCmyk,
  rgbToHex,
} from "../../src/editor/colour.js";

describe("colour models", () => {
  it("reads and writes hex as the model keeps it", () => {
    expect(hexToRgb("#e8e6e1")).toEqual({ r: 232, g: 230, b: 225 });
    expect(hexToRgb("abc")).toEqual({ r: 170, g: 187, b: 204 });
    expect(hexToRgb("not a colour")).toBeNull();
    expect(rgbToHex({ r: 232, g: 230, b: 225 })).toBe("#E8E6E1");
    expect(rgbToHex({ r: 300, g: -4, b: 12.6 })).toBe("#FF000D");
  });

  it("goes to HSV and back without losing a colour", () => {
    expect(hexToHsv("#FF0000")).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv("#00FF00")?.h).toBeCloseTo(120);
    for (let n = 0; n < 4096; n += 37) {
      const hex = rgbToHex({ r: (n * 7) % 256, g: (n * 13) % 256, b: (n * 29) % 256 });
      expect(hsvToHex(hexToHsv(hex) as NonNullable<ReturnType<typeof hexToHsv>>), hex).toBe(hex);
    }
  });

  it("keeps the hue it is given for a colour that has none", () => {
    expect(hexToHsv("#808080", 210)).toMatchObject({ h: 210, s: 0 });
    expect(hexToHsv("#000000", 45)).toMatchObject({ h: 45, v: 0 });
    // a colour with a hue of its own keeps that
    expect(hexToHsv("#0000FF", 45)?.h).toBeCloseTo(240);
  });

  it("converts between HSV and HSL, and RGB and CMYK", () => {
    expect(hsvToHsl({ h: 0, s: 1, v: 1 })).toEqual({ h: 0, s: 1, l: 0.5 });
    const back = hslToHsv({ h: 30, s: 0.4, l: 0.6 });
    const hsl = hsvToHsl(back);
    expect(hsl.s).toBeCloseTo(0.4);
    expect(hsl.l).toBeCloseTo(0.6);
    expect(rgbToCmyk({ r: 255, g: 0, b: 0 })).toEqual({ c: 0, m: 1, y: 1, k: 0 });
    expect(rgbToCmyk({ r: 0, g: 0, b: 0 })).toEqual({ c: 0, m: 0, y: 0, k: 1 });
    expect(cmykToRgb({ c: 0, m: 1, y: 1, k: 0 })).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("shows whole numbers per model, and reads a changed one back as a colour", () => {
    const oak = hexToHsv("#C9A27E") as NonNullable<ReturnType<typeof hexToHsv>>;
    expect(channelValues("rgb", oak)).toEqual({ r: 201, g: 162, b: 126 });
    expect(channelValues("hsv", oak)).toEqual({ h: 29, s: 37, v: 79 });
    expect(Object.keys(channelValues("cmyk", oak))).toEqual(["c", "m", "y", "k"]);
    expect(hsvToHex(fromChannels("rgb", { r: 201, g: 162, b: 0 }, oak.h))).toBe("#C9A200");
    // out-of-range numbers are held in range rather than refused
    expect(hsvToHex(fromChannels("rgb", { r: 999, g: -5, b: 0 }, 0))).toBe("#FF0000");
    expect(hsvToHex(fromChannels("hsl", { h: 0, s: 100, l: 50 }, 0))).toBe("#FF0000");
    expect(hsvToHex(fromChannels("cmyk", { c: 0, m: 100, y: 100, k: 0 }, 0))).toBe("#FF0000");
  });
});

describe("the colour guide", () => {
  it("offers turns of the wheel and shades of the same hue", () => {
    const rows = harmonies({ h: 0, s: 1, v: 1 });
    expect(rows.map((r) => r.name)).toEqual(["Analogous", "Shades", "Triad", "Tetrad"]);
    expect(rows.find((r) => r.name === "Triad")?.colours).toEqual(["#FF0000", "#00FF00", "#0000FF"]);
    expect(rows.find((r) => r.name === "Tetrad")?.colours).toEqual([
      "#FF0000",
      "#80FF00",
      "#00FFFF",
      "#8000FF",
    ]);
    expect(rows.find((r) => r.name === "Analogous")?.colours[2]).toBe("#FF0000");
    expect(rows.find((r) => r.name === "Shades")?.colours).toHaveLength(5);
  });
});

describe("the colours a project uses", () => {
  const fixtureDir = fileURLToPath(
    new URL("../../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url),
  );
  const fixture = () => Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));

  it("counts every colour the model holds, most used first", () => {
    const p = fixture();
    const [a, b, c] = p.walls;
    if (!a || !b || !c) throw new Error("the fixture should have three walls");
    const paint = (color: string) => ({
      color,
      textureId: null,
      placement: null,
      mirrorForLeftSide: false,
      shininess: null,
    });
    a.finishes = { ...a.finishes, left: paint("#3E5C76"), right: paint("#D9A441") };
    b.finishes = { ...b.finishes, left: paint("#3E5C76") };
    c.skirting = { left: { thickness: 10, height: 80, color: "#1F1F1F" }, right: null };
    const colours = projectColours(p);
    expect(colours[0]).toBe("#3E5C76");
    expect(colours).toContain("#D9A441");
    expect(colours).toContain("#1F1F1F");
    expect(projectColours(p, 1)).toEqual(["#3E5C76"]);
  });

  it("tells a light colour from a dark one", () => {
    expect(isLight("#FFFFFF")).toBe(true);
    expect(isLight("#E8E6E1")).toBe(true);
    expect(isLight("#1F1F1F")).toBe(false);
    expect(isLight("#3E5C76")).toBe(false);
  });
});

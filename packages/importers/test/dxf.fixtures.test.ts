// PRD P2-1 acceptance: every fixture DXF in tools/fixtures/plans reaches wall recall 0.9 and opening recall
// 0.8 against its expected draft (spec 06 A4), with the scale found within 2 percent.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dxfToDraft, type ExpectedPlan, PlanDraft, scoreDraft } from "../src/index.js";

const DIR = fileURLToPath(new URL("../../../tools/fixtures/plans/", import.meta.url));
const names = readdirSync(DIR)
  .filter((f) => f.endsWith(".dxf"))
  .map((f) => f.slice(0, -4))
  .sort();

function load(name: string) {
  const expected = JSON.parse(readFileSync(`${DIR}${name}.expected.json`, "utf8")) as ExpectedPlan;
  const { draft, report } = dxfToDraft(readFileSync(`${DIR}${name}.dxf`, "utf8"), { file: `${name}.dxf` });
  return { expected, draft, report, score: scoreDraft(draft, expected) };
}

describe("plan fixtures", () => {
  it("there are at least three fixture plans", () => {
    expect(names.length).toBeGreaterThanOrEqual(3);
  });

  for (const name of names)
    it(`${name}: wall recall 0.9, opening recall 0.8, scale within 2 percent, rooms found`, () => {
      const { draft, score } = load(name);
      expect(() => PlanDraft.parse(draft)).not.toThrow();
      expect(score.wallRecall, JSON.stringify(score)).toBeGreaterThanOrEqual(0.9);
      expect(score.wallPrecision, JSON.stringify(score)).toBeGreaterThanOrEqual(0.9);
      expect(score.openingRecall, JSON.stringify(score.missedOpenings)).toBeGreaterThanOrEqual(0.8);
      expect(score.scaleErrorPct).not.toBeNull();
      expect(score.scaleErrorPct as number).toBeLessThan(2);
      expect(score.missedRooms).toEqual([]);
    });

  it("office-mm: header units confirmed by dimension text, frozen and furniture layers ignored, names and capacities read", () => {
    const { draft, report } = load("office-mm");
    expect(draft.units).toMatchObject({ detected: "mm", scaleSource: "dimension-text" });
    expect(draft.questions).toEqual([]);
    expect(report.wallLayers).toEqual(["A-WALL"]);
    expect(report.layers.find((l) => l.name === "A-WALL-DEMO")).toMatchObject({ frozen: true });
    const board = draft.rooms.find((r) => r.name === "BOARDROOM");
    expect(board).toMatchObject({ purpose: "boardroom", capacity: 12 });
    expect(board?.polygon).toHaveLength(4);
    expect(draft.rooms.find((r) => r.name === "OPEN OFFICE")?.purpose).toBe("open-office");
    // exterior 250 and partitions 100 are told apart
    expect(new Set(draft.walls.map((w) => w.kind))).toEqual(new Set(["exterior", "partition"]));
    expect(
      draft.walls.every((w) => Math.abs((w.thickness ?? 0) - (w.kind === "exterior" ? 250 : 100)) < 1),
    ).toBe(true);
    const doors = draft.openings.filter((o) => o.kind === "door");
    expect(doors.map((o) => [Math.round(o.width ?? 0), o.hinge !== null])).toEqual([
      [1000, true],
      [900, true],
      [900, true],
    ]);
  });

  it("lshape-metres: no header units, scale from dimension text, French layers, passage kept", () => {
    const { draft } = load("lshape-metres");
    expect(draft.units).toMatchObject({ detected: "m", scaleSource: "dimension-text" });
    expect(draft.units.checks.length).toBe(3);
    expect(draft.openings.some((o) => o.kind === "passage")).toBe(true);
    expect(draft.rooms.map((r) => [r.name, r.purpose, r.polygon])).toEqual([
      ["Meeting Room", "meeting", null],
      ["Open Office", "open-office", null],
      ["Reception", "reception", null],
    ]);
  });

  it("rotated-inches: feet-and-inches dimensions agree with the header", () => {
    const { draft } = load("rotated-inches");
    expect(draft.units).toMatchObject({ detected: "in", scaleSource: "dimension-text" });
    expect(draft.rooms.find((r) => r.name === "Training Room")).toMatchObject({
      purpose: "training",
      capacity: 20,
    });
  });

  it("a drawing with neither units nor dimensions guesses and asks", () => {
    const text = readFileSync(`${DIR}lshape-metres.dxf`, "utf8").replace(
      /\r\nCOTES\r\n/g,
      "\r\nIGNORED-GRID\r\n",
    );
    const { draft } = dxfToDraft(text.replace(/DIMENSION/g, "XDIMENSION"));
    expect(draft.units).toMatchObject({ scaleSource: "guess", mmPerUnit: 1000 });
    expect(draft.questions.some((q) => q.kind === "scale")).toBe(true);
  });
});

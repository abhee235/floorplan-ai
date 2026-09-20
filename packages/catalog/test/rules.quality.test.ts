// How good a layout is, as distinct from whether it is correct (ADR-022 D2, amended).
//
// The measure exists because the checker passed the office nobody could have worked in: no errors,
// every room reachable, a clean route from the door, and fifteen rooms 2.7 m wide by 11.2 m deep.
// These tests are about the thing a person sees in the first second and the checker cannot say.
import { Design, type DesignInput } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { layoutQuality, type Programme, packProgramme } from "../src/index.js";

const shell = { x: 0, y: 0, w: 12000, d: 8000, wallMm: 230, interiorWallMm: 115 };
const design = (rooms: NonNullable<DesignInput["rooms"]>, kind = "workplace"): Design =>
  Design.parse({ brief: "b", kind, levelId: null, shell, rooms, circulation: [], assumptions: [] });

type Purpose = NonNullable<DesignInput["rooms"]>[number]["purpose"];

const room = (
  key: string,
  purpose: Purpose,
  rect: { x: number; y: number; w: number; d: number },
  extra: { window?: boolean } = {},
) => ({
  key,
  name: key,
  purpose,
  rect,
  capacity: null,
  doorsTo: [],
  window: extra.window ?? false,
});

describe("what makes a room a room", () => {
  it("counts anything longer than two and a half times its width as a sliver", () => {
    const q = layoutQuality(
      design([
        room("square", "meeting", { x: 230, y: 230, w: 4000, d: 4000 }),
        room("slice", "meeting", { x: 4345, y: 230, w: 1300, d: 7540 }),
      ]),
    );
    expect(q.slivers.map((s) => s.key)).toEqual(["slice"]);
    expect(q.proportion).toBe(0.5);
  });

  it("says nothing about a corridor, which is meant to be long", () => {
    const q = layoutQuality(
      design([
        room("room", "meeting", { x: 230, y: 230, w: 4000, d: 4000 }),
        room("hall", "corridor", { x: 230, y: 4345, w: 11540, d: 1500 }),
      ]),
    );
    expect(q.slivers).toEqual([]);
    expect(q.proportion).toBe(1);
  });
});

describe("daylight", () => {
  it("counts a habitable room away from every outside wall as dark", () => {
    const q = layoutQuality(
      design([
        room("edge", "meeting", { x: 230, y: 230, w: 4000, d: 3000 }),
        room("middle", "meeting", { x: 4000, y: 3000, w: 3000, d: 2000 }),
      ]),
    );
    expect(q.daylight).toBe(0.5);
  });

  it("does not ask a store cupboard for a window", () => {
    const q = layoutQuality(design([room("store", "storage", { x: 4000, y: 3000, w: 2000, d: 2000 })]));
    expect(q.daylight).toBe(1);
  });
});

describe("circulation", () => {
  it("is scored as a band, because too little is as bad as too much", () => {
    const maze = layoutQuality(design([room("all", "open-office", { x: 230, y: 230, w: 11540, d: 7540 })]));
    expect(maze.circulation).toBe(0);
    // No circulation at all still scores something, because everything else about it may be fine.
    expect(maze.score).toBeGreaterThan(0.5);
    expect(maze.score).toBeLessThan(0.9);
  });
});

describe("adjacency", () => {
  const two = [
    room("a", "meeting", { x: 230, y: 230, w: 4000, d: 3000 }),
    room("b", "meeting", { x: 4345, y: 230, w: 4000, d: 3000 }),
    room("far", "meeting", { x: 230, y: 4000, w: 4000, d: 3000 }),
  ];

  it("counts a pair that shares a wall and not a pair that does not", () => {
    // a and b sit side by side with one wall between them; far is across the plan from both.
    expect(layoutQuality(design(two), { nextTo: { a: ["b"] } }).adjacency).toBe(1);
    expect(layoutQuality(design(two), { nextTo: { b: ["far"] } }).adjacency).toBe(0);
    expect(layoutQuality(design(two), { nextTo: { a: ["b", "far"] } }).adjacency).toBe(0.5);
  });

  it("is full marks when the brief asked for nothing", () => {
    expect(layoutQuality(design(two)).adjacency).toBe(1);
  });
});

describe("the baseline it was written to measure", () => {
  const OFFICE: Programme = {
    brief: "an office for a hundred people",
    kind: "workplace",
    rooms: [
      { key: "open", name: "Open office", purpose: "open-office", targetM2: 1000 },
      { key: "caf", name: "Cafeteria", purpose: "cafeteria", targetM2: 120 },
      { key: "m4a", name: "Meeting 4A", purpose: "meeting", targetM2: 12 },
      { key: "m4b", name: "Meeting 4B", purpose: "meeting", targetM2: 12 },
      { key: "m6a", name: "Meeting 6A", purpose: "meeting", targetM2: 18 },
      { key: "m6b", name: "Meeting 6B", purpose: "meeting", targetM2: 18 },
      { key: "m8a", name: "Meeting 8A", purpose: "meeting", targetM2: 23 },
      { key: "m8b", name: "Meeting 8B", purpose: "meeting", targetM2: 23 },
      { key: "board", name: "Boardroom", purpose: "boardroom", targetM2: 40 },
      { key: "train", name: "Training", purpose: "training", targetM2: 80 },
      { key: "rec", name: "Reception", purpose: "reception", targetM2: 30 },
      { key: "wc", name: "Toilets", purpose: "restroom", targetM2: 20 },
    ],
  };

  it("scores the comb badly, which is the whole point of it existing", () => {
    // If this ever starts passing above 0.8 without the packer changing, the measure has drifted
    // and stopped describing the drawing the owner objected to.
    const q = layoutQuality(Design.parse(packProgramme(OFFICE).design));
    expect(q.score).toBeLessThan(0.8);
    expect(q.slivers.length).toBeGreaterThan(0);
  });

  it("is a number between nought and one, whatever it is given", () => {
    const one = design([room("only", "storage", { x: 230, y: 230, w: 2000, d: 2000 })]);
    for (const q of [layoutQuality(one), layoutQuality(Design.parse(packProgramme(OFFICE).design))]) {
      expect(q.score).toBeGreaterThanOrEqual(0);
      expect(q.score).toBeLessThanOrEqual(1);
    }
  });
});

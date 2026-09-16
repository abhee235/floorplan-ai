import type { Wall } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { type AimOptions, angleOf, clampLength, pointAt, WallTool } from "../../src/index.js";

/** A wall with only the fields snapping reads; the rest never reaches the magnetism helpers. */
const wall = (id: string, start: [number, number], end: [number, number], joined = false): Wall =>
  ({
    id,
    levelId: "level_000000",
    start: { x: start[0], y: start[1] },
    end: { x: end[0], y: end[1] },
    thickness: 100,
    joins: { start: null, end: joined ? { wallId: "other", end: "start" as const } : null },
  }) as unknown as Wall;

/** One screen pixel is one millimetre, so the 2 px snap tolerance reads as 2 mm. */
const opts = (over: Partial<AimOptions> = {}): AimOptions => ({
  walls: [],
  pixelMm: 1,
  magnetism: true,
  ...over,
});

const tool = () => new WallTool({ levelId: "level_000000", thickness: 100, kind: "interior" });

describe("drawing a chain of walls (W-067)", () => {
  it("grows from the last point, and never commits a wall of no length", () => {
    const t = tool();
    t.place({ x: 0, y: 0 }, opts());
    expect(t.drawing).toBe(true);
    expect(t.place({ x: 0, y: 0 }, opts())).toMatchObject({ placed: false });
    t.place({ x: 3000, y: 0 }, opts());
    expect(t.points).toHaveLength(2);
    expect(t.anchor).toEqual({ x: 3000, y: 0 });
  });

  it("emits one chain command for the whole gesture", () => {
    const t = tool();
    t.place({ x: 0, y: 0 }, opts());
    t.place({ x: 3000, y: 0 }, opts());
    t.place({ x: 3000, y: 2000 }, opts());
    expect(t.end()).toEqual({
      type: "wall.createChain",
      payload: {
        levelId: "level_000000",
        points: [
          { x: 0, y: 0 },
          { x: 3000, y: 0 },
          { x: 3000, y: 2000 },
        ],
        closed: false,
        thickness: 100,
        kind: "interior",
      },
    });
  });

  it("has nothing to commit from a single point", () => {
    const t = tool();
    t.place({ x: 0, y: 0 }, opts());
    expect(t.end()).toBeNull();
  });

  it("keeps the walls already drawn when the chain is abandoned (W-090)", () => {
    const t = tool();
    t.place({ x: 0, y: 0 }, opts());
    t.place({ x: 3000, y: 0 }, opts());
    t.place({ x: 3000, y: 2000 }, opts());
    // Escape ends the gesture; the two finished walls are committed, not rolled back
    expect(t.end()?.payload.points).toHaveLength(3);
  });

  it("takes back one segment at a time while drawing", () => {
    const t = tool();
    t.place({ x: 0, y: 0 }, opts());
    t.place({ x: 3000, y: 0 }, opts());
    expect(t.undoSegment()).toBe(true);
    expect(t.points).toHaveLength(1);
    t.undoSegment();
    expect(t.undoSegment()).toBe(false);
  });
});

describe("what the next point catches", () => {
  it("snaps the start to a free wall end within two pixels (W-068)", () => {
    const t = tool();
    const walls = [wall("wall_1", [0, 0], [2000, 0])];
    const aim = t.aim({ x: 2001, y: 0 }, opts({ walls }));
    expect(aim.point).toEqual({ x: 2000, y: 0 });
    expect(aim.snap).toBe("free-end");
    expect(aim.announcement).toContain("snapped to the end of wall wall_1");
  });

  it("leaves a joined end alone, having no free end to offer", () => {
    const t = tool();
    const walls = [wall("wall_1", [0, 0], [2000, 0], true)];
    expect(t.aim({ x: 2001, y: 0 }, opts({ walls })).snap).not.toBe("free-end");
  });

  it("closes the loop back at the first point once three walls are drawn (W-070)", () => {
    const t = tool();
    t.place({ x: 0, y: 0 }, opts());
    t.place({ x: 3000, y: 0 }, opts());
    t.place({ x: 3000, y: 3000 }, opts());
    const aim = t.aim({ x: 1, y: 0 }, opts());
    expect(aim.snap).toBe("close");
    const result = t.place({ x: 1, y: 0 }, opts());
    expect(result.closed).toBe(true);
    const command = t.end();
    expect(command?.payload.closed).toBe(true);
    expect(command?.payload.points).toHaveLength(3); // the first point is not repeated
  });

  it("does not close a chain of only two walls", () => {
    const t = tool();
    t.place({ x: 0, y: 0 }, opts());
    t.place({ x: 3000, y: 0 }, opts());
    expect(t.aim({ x: 1, y: 0 }, opts()).snap).not.toBe("close");
  });

  it("snaps the direction to fifteen degree steps (W-077)", () => {
    const t = tool();
    t.place({ x: 0, y: 0 }, opts());
    // 20 mm up over 100 along is about 11 degrees, which rounds onto the 15 degree ray
    const aim = t.aim({ x: 100, y: 20 }, opts());
    expect(Math.round(aim.angleDeg)).toBe(15);
  });

  it("lets Alt bypass snapping, inverting the preference (W-082)", () => {
    const t = tool();
    t.place({ x: 0, y: 0 }, opts());
    const free = t.aim({ x: 100, y: 20 }, opts({ altHeld: true }));
    expect(free.point).toEqual({ x: 100, y: 20 });
    expect(free.snap).toBe("none");
    // and with the preference off, Alt turns snapping back on
    const snapped = t.aim({ x: 100, y: 20 }, opts({ magnetism: false, altHeld: true }));
    expect(snapped.snap).toBe("angle");
  });
});

describe("drawing by typing (ADR-017 D4)", () => {
  it("offers a first wall along +x, then squares the next one to it (W-073, W-074)", () => {
    const t = tool();
    expect(t.seed()).toEqual({ lengthMm: 3000, angleDeg: 0 });
    t.place({ x: 0, y: 0 }, opts());
    t.place({ x: 3000, y: 0 }, opts());
    // the wall ran along +x, so the next is seeded ninety degrees round, at the same length
    expect(t.seed()).toEqual({ lengthMm: 3000, angleDeg: 270 });
  });

  it("reads a typed angle as absolute for the first wall and relative after it (W-076)", () => {
    const t = tool();
    t.place({ x: 0, y: 0 }, opts());
    const first = t.typedPoint(200, 0);
    expect(first?.x).toBeCloseTo(200);
    expect(first?.y).toBeCloseTo(0);
    t.place(first as { x: number; y: number }, opts());
    // 270 relative to a wall running along +x turns onto -y
    const second = t.typedPoint(200, 270);
    expect(second?.x).toBeCloseTo(200);
    expect(second?.y).toBeCloseTo(-200);
  });

  it("clamps a typed length, and takes a negative one as its size (W-072)", () => {
    expect(clampLength(-7.55)).toBeCloseTo(7.55);
    expect(clampLength(0)).toBe(0.001);
    expect(clampLength(5_000_000)).toBe(1_000_000);
  });

  it("has no point to offer before the chain has started", () => {
    expect(tool().typedPoint(200, 0)).toBeNull();
  });
});

describe("angles on a plan, where y points up", () => {
  it("measures from +x anticlockwise", () => {
    expect(angleOf({ x: 0, y: 0 }, { x: 1, y: 0 })).toBe(0);
    expect(angleOf({ x: 0, y: 0 }, { x: 0, y: 1 })).toBe(90);
    expect(angleOf({ x: 0, y: 0 }, { x: -1, y: 0 })).toBe(180);
    expect(angleOf({ x: 0, y: 0 }, { x: 0, y: -1 })).toBe(270);
  });

  it("goes back the way it came", () => {
    const p = pointAt({ x: 10, y: 10 }, 100, 90);
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(110);
  });
});

describe("what a screen reader hears while drawing (ADR-017 D5)", () => {
  it("names the wall, its length and its angle", () => {
    const t = tool();
    t.place({ x: 0, y: 0 }, opts());
    const aim = t.aim({ x: 4250, y: 0 }, opts());
    expect(aim.announcement).toBe("Wall 1, 4250 millimetres at 0 degrees.");
  });

  it("says so when a wall would have no length", () => {
    const t = tool();
    t.place({ x: 0, y: 0 }, opts());
    expect(t.place({ x: 0, y: 0 }, opts()).announcement).toBe("That wall would have no length.");
  });
});

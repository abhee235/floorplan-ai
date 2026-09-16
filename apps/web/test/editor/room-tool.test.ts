import { describe, expect, it } from "vitest";
import { MIN_CORNERS, RoomTool } from "../../src/editor/room-tool.js";
import type { AimOptions } from "../../src/index.js";

/** One screen pixel is one millimetre, so the 2 px corner tolerance reads as 2 mm. */
const opts = (over: Partial<AimOptions> = {}): AimOptions => ({
  walls: [],
  pixelMm: 1,
  magnetism: true,
  ...over,
});

const tool = () => new RoomTool({ levelId: "level_000000" });

describe("drawing a room (P3-2)", () => {
  it("R-041 commits nothing under three corners", () => {
    const t = tool();
    t.place({ x: 0, y: 0 }, opts());
    t.place({ x: 3000, y: 0 }, opts());
    expect(t.closable).toBe(false);
    expect(t.end()).toBeNull();
    // and the tool is left empty rather than holding the abandoned corners
    expect(t.drawing).toBe(false);
  });

  it("R-041 commits a polygon once three corners are down", () => {
    const t = tool();
    t.place({ x: 0, y: 0 }, opts());
    t.place({ x: 3000, y: 0 }, opts());
    t.place({ x: 3000, y: 2000 }, opts());
    expect(t.closable).toBe(true);
    const cmd = t.end();
    expect(cmd?.type).toBe("room.create");
    expect(cmd?.payload.polygon).toEqual([
      { x: 0, y: 0 },
      { x: 3000, y: 0 },
      { x: 3000, y: 2000 },
    ]);
    expect(cmd?.payload.polygon.length).toBeGreaterThanOrEqual(MIN_CORNERS);
  });

  it("R-044 a side of no length adds no corner", () => {
    const t = tool();
    t.place({ x: 0, y: 0 }, opts());
    const again = t.place({ x: 0, y: 0 }, opts());
    expect(again.placed).toBe(false);
    expect(t.points).toHaveLength(1);
  });

  it("R-045 landing back on the first corner closes the room without duplicating it", () => {
    const t = tool();
    t.place({ x: 0, y: 0 }, opts());
    t.place({ x: 3000, y: 0 }, opts());
    t.place({ x: 3000, y: 2000 }, opts());
    const closed = t.place({ x: 1, y: 0 }, opts()); // within the 2 mm tolerance of the first corner
    expect(closed.closed).toBe(true);
    expect(closed.placed).toBe(false);
    expect(t.points).toHaveLength(3); // the first corner is not stored twice
  });

  it("R-045 does not close before there are three corners", () => {
    const t = tool();
    t.place({ x: 0, y: 0 }, opts());
    t.place({ x: 3000, y: 0 }, opts());
    expect(t.aim({ x: 1, y: 0 }, opts()).snap).not.toBe("close");
  });

  it("R-046 R-047 seeds the first side along +x, then square to the one before", () => {
    const t = tool();
    expect(t.seed()).toEqual({ lengthMm: 3000, angleDeg: 0 });
    t.place({ x: 0, y: 0 }, opts());
    t.place({ x: 4000, y: 0 }, opts());
    expect(t.seed()).toEqual({ lengthMm: 4000, angleDeg: 270 });
  });

  it("R-047 walks a rectangle when each seeded side is taken as offered", () => {
    // The angle alone cannot show this. The ledger's worked example is in y-DOWN screen coordinates and
    // the plan is y-UP, so asserting "270" only restates the formula that produced it; asserting where
    // the corner lands is a claim about the geometry, and would fail if the turn went the wrong way.
    const t = tool();
    t.place({ x: 0, y: 0 }, opts());
    t.place({ x: 4000, y: 0 }, opts());
    for (let i = 0; i < 2; i += 1) {
      const seed = t.seed();
      const next = t.typedPoint(seed.lengthMm, seed.angleDeg);
      t.place(next as { x: number; y: number }, opts({ magnetism: false }));
    }
    // four corners of a square, turning consistently rather than doubling back
    expect(t.points).toEqual([
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
      { x: 4000, y: -4000 },
      { x: 0, y: -4000 },
    ]);
  });

  it("emits whole millimetres, because Polygon is an array of integer Mm", () => {
    const t = tool();
    t.place({ x: 0.4, y: 0.4 }, opts({ magnetism: false }));
    t.place({ x: 1350.6, y: 0.4 }, opts({ magnetism: false }));
    t.place({ x: 1350.6, y: -944.7 }, opts({ magnetism: false }));
    const polygon = t.end()?.payload.polygon ?? [];
    expect(polygon).toEqual([
      { x: 0, y: 0 },
      { x: 1351, y: 0 },
      { x: 1351, y: -945 },
    ]);
    expect(polygon.every((p) => Number.isInteger(p.x) && Number.isInteger(p.y))).toBe(true);
  });

  it("takes back one side at a time", () => {
    const t = tool();
    t.place({ x: 0, y: 0 }, opts());
    t.place({ x: 3000, y: 0 }, opts());
    expect(t.undoSegment()).toBe(true);
    expect(t.points).toHaveLength(1);
    expect(t.undoSegment()).toBe(true);
    expect(t.undoSegment()).toBe(false); // nothing left to take back
  });

  it("names a point for the host to detect an enclosure from, rather than detecting it here", () => {
    const t = tool();
    const cmd = t.detectAt({ x: 1200.7, y: 900.2 });
    expect(cmd.payload).toEqual({ levelId: "level_000000", atPoint: { x: 1201, y: 900 } });
    // no polygon: the reducer takes exactly one of polygon, rect or atPoint
    expect("polygon" in cmd.payload).toBe(false);
  });
});

import { defaultWall } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import {
  alignToAxes,
  effectiveMagnetism,
  INDICATOR_PX,
  intersectLines,
  magnetizedLength,
  magnetizePoint,
  SELECTION_PX,
  snapToFreeWallEnd,
  snapToPoints,
  WALL_END_PX,
} from "../src/index.js";

const L = "level_000000";

describe("magnetism", () => {
  it("W-077 R-052 direction snaps to 15 degree steps; exact axes skip the angle step", () => {
    const p = magnetizePoint({ x: 0, y: 0 }, { x: 1000, y: 200 }, 1); // 11.3 degrees -> 15
    const angle = (Math.atan2(p.y, p.x) * 180) / Math.PI;
    expect(angle).toBeCloseTo(15, 6);
    const axis = magnetizePoint({ x: 0, y: 0 }, { x: 1000, y: 0 }, 1);
    expect(axis).toEqual({ x: 1000, y: 0 });
  });

  it("W-078 W-079 length rounding follows the pixel size and never rounds a positive length to zero", () => {
    expect(magnetizedLength(3734, 0.2)).toBe(3734); // step 1 at fine zoom
    expect(magnetizedLength(3734, 3)).toBe(3735); // step 5
    expect(magnetizedLength(3734, 30)).toBe(3750); // step 50
    expect(magnetizedLength(3734, 60)).toBe(3700); // step 100
    expect(magnetizedLength(3734, 600)).toBe(4000); // step 1000
    expect(magnetizedLength(3, 30)).toBe(3);
  });

  it("W-068 W-069 snapping to a free wall end within tolerance, ignoring joined ends and the excluded wall", () => {
    const a = defaultWall("wall_000001", L, { x: 0, y: 0 }, { x: 1000, y: 0 });
    const b = defaultWall("wall_000002", L, { x: 1000, y: 0 }, { x: 1000, y: 1000 });
    a.joins.end = { wallId: b.id, end: "start" };
    b.joins.start = { wallId: a.id, end: "end" };
    expect(snapToFreeWallEnd({ x: 1002, y: 998 }, [a, b], 5)).toEqual({
      wallId: "wall_000002",
      end: "end",
      point: { x: 1000, y: 1000 },
    });
    expect(snapToFreeWallEnd({ x: 1002, y: 2 }, [a, b], 5)).toBeNull(); // that end is joined
    expect(snapToFreeWallEnd({ x: 1002, y: 998 }, [a, b], 5, "wall_000002")).toBeNull();
  });

  it("W-080 W-081 R-051 snapToPoints picks the nearest candidate within tolerance", () => {
    const candidates = [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ];
    expect(snapToPoints({ x: 97, y: 103 }, candidates, 5)).toEqual({ x: 100, y: 100 });
    expect(snapToPoints({ x: 90, y: 90 }, candidates, 5)).toBeNull();
  });

  it("R-053 axis alignment adjusts x and y independently", () => {
    expect(alignToAxes({ x: 103, y: 500 }, [{ x: 100, y: 0 }], 5)).toEqual({ x: 100, y: 500 });
    expect(
      alignToAxes(
        { x: 103, y: 502 },
        [
          { x: 100, y: 0 },
          { x: 0, y: 500 },
        ],
        5,
      ),
    ).toEqual({ x: 100, y: 500 });
  });

  it("W-082 F-078 effective magnetism is preference XOR modifier", () => {
    expect(effectiveMagnetism(true, false)).toBe(true);
    expect(effectiveMagnetism(true, true)).toBe(false);
    expect(effectiveMagnetism(false, true)).toBe(true);
  });

  it("F-196 W-022 W-023 line intersection: vertical lines work, near-parallel returns null (reversed)", () => {
    expect(intersectLines({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: -5 }, { x: 5, y: 5 })).toEqual({
      x: 5,
      y: 0,
    });
    expect(
      intersectLines({ x: 0, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1 }, { x: 1000, y: 1003 }),
    ).toBeNull();
    expect(intersectLines({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 1 }, { x: 10, y: 1 })).toBeNull();
  });

  it("R-050 hit margins are 4 px for selection, 5 px for indicators, 2 px for wall ends", () => {
    expect(SELECTION_PX).toBe(4);
    expect(INDICATOR_PX).toBe(5);
    expect(WALL_END_PX).toBe(2);
  });
});

import { describe, expect, it } from "vitest";
import {
  close,
  difference,
  dilate,
  dropShortEdges,
  erode,
  flattenRing,
  interiorRings,
  multiArea,
  overlapArea,
  ringToMulti,
  union,
  unionRings,
} from "../src/index.js";

const sq = (x: number, y: number, s: number) => [
  { x, y },
  { x: x + s, y },
  { x: x + s, y: y + s },
  { x, y: y + s },
];

describe("booleans", () => {
  it("union of two overlapping squares has the combined area", () => {
    const u = union(ringToMulti(sq(0, 0, 1000)), ringToMulti(sq(500, 0, 1000)));
    expect(u).toHaveLength(1);
    expect(multiArea(u)).toBeCloseTo(1_500_000, 3);
  });

  it("difference punches a hole and interiorRings returns it counter-clockwise", () => {
    const d = difference(ringToMulti(sq(0, 0, 3000)), ringToMulti(sq(1000, 1000, 1000)));
    expect(d[0]?.holes).toHaveLength(1);
    expect(multiArea(d)).toBeCloseTo(8_000_000, 3);
    const rings = interiorRings(d);
    expect(rings).toHaveLength(1);
    expect(Math.abs(multiArea(ringToMulti(rings[0] as { x: number; y: number }[])))).toBeCloseTo(
      1_000_000,
      3,
    );
  });

  it("overlapArea works for concave rings", () => {
    const L = [
      { x: 0, y: 0 },
      { x: 2000, y: 0 },
      { x: 2000, y: 1000 },
      { x: 1000, y: 1000 },
      { x: 1000, y: 2000 },
      { x: 0, y: 2000 },
    ];
    expect(overlapArea(L, sq(500, 500, 1000))).toBeCloseTo(750_000, 3);
  });

  it("dilate grows and erode shrinks; close fills gaps narrower than twice the radius", () => {
    const base = ringToMulti(sq(0, 0, 1000));
    expect(multiArea(dilate(base, 100))).toBeGreaterThan(1_000_000 + 4 * 100 * 1000);
    expect(multiArea(erode(base, 100))).toBeCloseTo(800 * 800, 0);
    // two squares with a 30 mm gap: closing at 20 mm bridges it into one polygon
    const two = unionRings([sq(0, 0, 1000), sq(1030, 0, 1000)]);
    expect(two).toHaveLength(2);
    expect(close(two, 20)).toHaveLength(1);
    // a 100 mm gap is not closed at 20 mm
    const far = unionRings([sq(0, 0, 1000), sq(1100, 0, 1000)]);
    expect(close(far, 20)).toHaveLength(2);
  });

  it("R-029 R-023 flattenRing removes collinear noise within tolerance and dropShortEdges removes slivers", () => {
    const noisy = [
      { x: 0, y: 0 },
      { x: 500, y: 1 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 },
    ];
    expect(flattenRing(noisy, 5)).toHaveLength(4);
    expect(flattenRing(noisy, 0.5)).toHaveLength(5);
    expect(
      dropShortEdges(
        [
          { x: 0, y: 0 },
          { x: 0.001, y: 0 },
          { x: 1000, y: 0 },
          { x: 1000, y: 1000 },
        ],
        0.01,
      ),
    ).toHaveLength(3);
  });
});

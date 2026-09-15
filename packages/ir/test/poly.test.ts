import { describe, expect, it } from "vitest";
import { poly } from "../src/index.js";

const square = [
  { x: 0, y: 0 },
  { x: 1000, y: 0 },
  { x: 1000, y: 1000 },
  { x: 0, y: 1000 },
];

describe("polygon area and winding", () => {
  it("R-004 shoelace signed area is positive counter-clockwise and negative clockwise", () => {
    expect(poly.signedArea(square)).toBe(1_000_000);
    expect(poly.signedArea(poly.reversed(square))).toBe(-1_000_000);
  });

  it("R-005 a zero-area ring is neither clockwise nor counter-clockwise", () => {
    const line = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 500, y: 0 },
    ];
    expect(poly.isClockwise(line)).toBe(false);
    expect(poly.isCounterClockwise(line)).toBe(false);
    expect(poly.area(line)).toBe(0);
  });

  it("R-006 area is absolute, independent of winding", () => {
    expect(poly.area(square)).toBe(poly.area(poly.reversed(square)));
  });

  it("R-007 R-008 R-009 R-150 self-touching and self-intersecting rings are not simple (reversed: rejected)", () => {
    const figureEight = [
      { x: 0, y: 0 },
      { x: 1000, y: 1000 },
      { x: 1000, y: 0 },
      { x: 0, y: 1000 },
    ];
    expect(poly.isSimple(figureEight)).toBe(false);
    const withBridge = [
      { x: 0, y: 0 },
      { x: 3000, y: 0 },
      { x: 3000, y: 3000 },
      { x: 0, y: 3000 },
      { x: 0, y: 1000 },
      { x: 1000, y: 1000 },
      { x: 1000, y: 2000 },
      { x: 2000, y: 2000 },
      { x: 2000, y: 1000 },
      { x: 0, y: 1000 },
    ];
    expect(poly.isSimple(withBridge)).toBe(false);
    expect(poly.isSimple(square)).toBe(true);
  });

  it("R-010 collinear rings have zero area and are not simple", () => {
    const collinear = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 500, y: 0 },
    ];
    expect(poly.area(collinear)).toBe(0);
    expect(poly.isSimple(collinear)).toBe(false);
  });

  it("R-011 consecutive duplicates and a closing point are removed by dedupe", () => {
    const messy = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 },
      { x: 0, y: 0 },
    ];
    expect(poly.dedupe(messy)).toEqual(square);
    expect(poly.area(messy)).toBe(1_000_000);
  });
});

describe("hit tests", () => {
  it("R-016 pointIndexAt uses a Chebyshev box and returns the first match", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 3000, y: 4000 },
    ];
    expect(poly.pointIndexAt(pts, { x: 3000, y: 3000 }, 1500)).toBe(1); // Euclidean distance is 1000, within box
    expect(poly.pointIndexAt(pts, { x: 3000, y: 3000 }, 500)).toBe(-1);
  });

  it("R-017 F-018 containment with a margin counts points just outside an edge", () => {
    expect(poly.containsPointWithMargin(square, { x: 1500, y: 500 }, 1000)).toBe(true);
    expect(poly.containsPointWithMargin(square, { x: 1500, y: 500 }, 0)).toBe(false);
    expect(poly.containsPoint(square, { x: 500, y: 500 })).toBe(true);
    expect(poly.containsPoint(square, { x: 1000, y: 500 })).toBe(true); // on the edge
  });

  it("R-018 translating by zero returns equal points", () => {
    expect(poly.translate(square, 0, 0)).toEqual(square);
    expect(poly.translate(square, 10, -5)[0]).toEqual({ x: 10, y: -5 });
  });
});

describe("pole of inaccessibility", () => {
  it("R-012 an L-shaped room's label anchor is inside the wide arm, not the bounding-box centre", () => {
    const L = [
      { x: 0, y: 0 },
      { x: 8000, y: 0 },
      { x: 8000, y: 3000 },
      { x: 5000, y: 3000 },
      { x: 5000, y: 5000 },
      { x: 0, y: 5000 },
    ];
    const p = poly.poleOfInaccessibility(L);
    expect(poly.containsPoint(L, p)).toBe(true);
    // the bounding-box centre (4000, 2500) is inside too, but the pole must be at least as deep as it
    const depthPole = poly.signedDistanceToRing(L, [], p);
    const depthCentre = poly.signedDistanceToRing(L, [], { x: 4000, y: 2500 });
    expect(depthPole).toBeGreaterThanOrEqual(depthCentre);
    expect(depthPole).toBeGreaterThan(2000);
  });

  it("respects holes", () => {
    const hole = poly.reversed([
      { x: 400, y: 400 },
      { x: 600, y: 400 },
      { x: 600, y: 600 },
      { x: 400, y: 600 },
    ]);
    const p = poly.poleOfInaccessibility(square, [hole]);
    expect(poly.containsPoint(hole, p)).toBe(false);
  });
});

describe("overlap", () => {
  it("convexOverlapArea of two offset squares", () => {
    const b = poly.translate(square, 500, 500);
    expect(poly.convexOverlapArea(square, b)).toBe(250_000);
    expect(poly.convexOverlapArea(square, poly.translate(square, 2000, 0))).toBe(0);
  });
});

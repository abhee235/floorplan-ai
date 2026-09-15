import { poly } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { triangulate, triangulatedArea } from "../src/index.js";

describe("triangulate", () => {
  it("R-077 R-079 a square with a hole triangulates to the correct area with no bridging code", () => {
    const outer = [
      { x: 0, y: 0 },
      { x: 3000, y: 0 },
      { x: 3000, y: 3000 },
      { x: 0, y: 3000 },
    ];
    const hole = poly.reversed([
      { x: 1000, y: 1000 },
      { x: 2000, y: 1000 },
      { x: 2000, y: 2000 },
      { x: 1000, y: 2000 },
    ]);
    const t = triangulate(outer, [hole]);
    expect(t.indices.length % 3).toBe(0);
    expect(triangulatedArea(t)).toBeCloseTo(8_000_000, 3);
  });

  it("an L shape triangulates to its area", () => {
    const L = [
      { x: 0, y: 0 },
      { x: 8000, y: 0 },
      { x: 8000, y: 3000 },
      { x: 5000, y: 3000 },
      { x: 5000, y: 5000 },
      { x: 0, y: 5000 },
    ];
    expect(triangulatedArea(triangulate(L))).toBeCloseTo(34_000_000, 3);
  });
});

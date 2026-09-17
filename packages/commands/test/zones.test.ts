// How a zone lays its pieces out (spec 03 section 4): the step follows the piece as it is turned, the
// block sits in the middle of the zone, and a bench puts desks back to back.
import type { Point } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { arrangePlacements } from "../src/index.js";

const DESK = { w: 1600, d: 800, h: 750 };
const rect = (w: number, h: number): Point[] => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];
const rule = (over: Partial<Parameters<typeof arrangePlacements>[1]> = {}) => ({
  pattern: "grid" as const,
  productId: null,
  recipe: null,
  count: 500,
  spacing: { x: 400, y: 400 },
  facing: 0,
  margin: 0,
  ...over,
});

/** The steps between neighbouring values, rounded; repeats collapsed, so an even grid reads as one step. */
const steps = (values: number[]): number[] => {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const all = sorted.slice(1).map((v, i) => Math.round(v - (sorted[i] as number)));
  return all.filter((v, i) => v !== all[i - 1]);
};

describe("laying pieces out in a zone", () => {
  it("steps by the piece as it is turned, not as it was measured", () => {
    const facingNorth = arrangePlacements(rect(20_000, 20_000), rule(), DESK).placements;
    // 1600 across and 800 deep: 2000 between columns, 1200 between rows
    expect(steps(facingNorth.map((p) => p.position.x))).toEqual([2000]);
    expect(steps(facingNorth.map((p) => p.position.y))).toEqual([1200]);

    // turned to face east it is 800 across and 1600 deep, and the steps swap over
    const facingEast = arrangePlacements(rect(20_000, 20_000), rule({ facing: 270 }), DESK).placements;
    expect(steps(facingEast.map((p) => p.position.x))).toEqual([1200]);
    expect(steps(facingEast.map((p) => p.position.y))).toEqual([2000]);
    // and more fit across, because a turned desk is narrower
    const columns = (ps: typeof facingNorth) => new Set(ps.map((p) => p.position.x)).size;
    expect(columns(facingEast)).toBeGreaterThan(columns(facingNorth));
  });

  it("leaves the same room at both edges, rather than packing into one corner", () => {
    // 10 000 across holds five 1600 desks with 400 between them: 9 600 used, 400 left over
    const placements = arrangePlacements(rect(10_000, 4000), rule(), DESK).placements;
    const xs = placements.map((p) => p.position.x);
    const left = Math.min(...xs) - 1600 / 2;
    const right = 10_000 - (Math.max(...xs) + 1600 / 2);
    expect(left).toBe(200);
    expect(right).toBe(200);
  });

  it("keeps the margin clear inside the edge, and still centres what is left", () => {
    const placements = arrangePlacements(rect(10_000, 4000), rule({ margin: 1000 }), DESK).placements;
    const xs = placements.map((p) => p.position.x);
    expect(Math.min(...xs) - 800).toBeGreaterThanOrEqual(1000);
    expect(10_000 - (Math.max(...xs) + 800)).toBeGreaterThanOrEqual(1000);
    expect(Math.min(...xs) - 800).toBe(10_000 - (Math.max(...xs) + 800));
  });

  it("puts a bench's desks back to back, with the gap between the pairs", () => {
    const placements = arrangePlacements(
      rect(4000, 20_000),
      rule({ pattern: "bench", count: 8 }),
      DESK,
    ).placements;
    const ys = [...new Set(placements.map((p) => p.position.y))].sort((a, b) => a - b);
    // touching within a pair, then the gap between pairs: 800, 1200, 800 ...
    expect(steps(ys)).toEqual([800, 1200, 800]);
    // and the two halves of a pair face opposite ways
    const facing = (y: number) => placements.find((p) => p.position.y === y)?.rotation;
    expect(facing(ys[0] as number)).toBe(0);
    expect(facing(ys[1] as number)).toBe(180);
    expect(facing(ys[2] as number)).toBe(0);
  });

  it("holds ten when the zone was drawn to hold exactly ten", () => {
    // 10 x 1600 with 400 between them is 19 600 across; the pieces then sit ON the zone's edge, where
    // containment used to go either way and a row could vanish.
    const placements = arrangePlacements(rect(19_600, 800), rule(), DESK).placements;
    expect(placements).toHaveLength(10);
  });

  it("places nothing at all when the zone is smaller than one piece", () => {
    expect(arrangePlacements(rect(1000, 700), rule(), DESK).placements).toEqual([]);
    expect(arrangePlacements(rect(4000, 4000), rule({ margin: 1800 }), DESK).placements).toEqual([]);
  });

  it("stops at the number asked for", () => {
    const three = arrangePlacements(rect(20_000, 20_000), rule({ count: 3 }), DESK);
    expect(three.placements).toHaveLength(3);
    expect(three.requested).toBe(3);
  });
});

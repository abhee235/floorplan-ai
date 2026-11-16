// How a zone lays its pieces out (spec 03 section 4): the step follows the piece as it is turned, the
// block sits in the middle of the zone, and a bench puts desks back to back.
import type { Point } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { arrangePlacements } from "../src/index.js";
import { BOX, fixture, LEVEL, ok } from "./helpers.js";

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

describe("moving and reshaping a zone", () => {
  /** A cluster of boxes on empty ground, well clear of the fixture's room. */
  function withCluster() {
    const p = fixture();
    const r = ok(p, {
      type: "item.arrange",
      payload: {
        target: {
          levelId: LEVEL,
          polygon: [
            { x: 20_000, y: 0 },
            { x: 26_000, y: 0 },
            { x: 26_000, y: 4000 },
            { x: 20_000, y: 4000 },
          ],
        },
        rule: {
          pattern: "grid" as const,
          productId: null,
          recipe: BOX.recipe,
          count: 100,
          spacing: { x: 400, y: 400 },
          facing: 0,
          margin: 300,
        },
      },
    });
    const zone = r.project.zones[0] as NonNullable<(typeof r.project.zones)[number]>;
    return { project: r.project, zone };
  }

  const shifted = (polygon: readonly { x: number; y: number }[], dx: number, dy: number) =>
    polygon.map((q) => ({ x: q.x + dx, y: q.y + dy }));

  it("walks its pieces along when it is only moved, keeping their ids", () => {
    const { project, zone } = withCluster();
    const before = project.items.filter((i) => zone.generatedItemIds.includes(i.id));
    const r = ok(project, {
      type: "zone.modify",
      payload: { zoneId: zone.id, changes: { polygon: shifted(zone.polygon, 1500, -700) } },
    });
    const after = r.project.zones[0]?.generatedItemIds as string[];
    expect(after).toEqual(zone.generatedItemIds);
    expect(r.changes.added).toHaveLength(0);
    expect(r.changes.removed).toHaveLength(0);
    for (const was of before) {
      const now = r.project.items.find((i) => i.id === was.id);
      expect(now?.position).toEqual({ x: was.position.x + 1500, y: was.position.y - 700 });
    }
  });

  it("lays them out again when the shape changes, not just the place", () => {
    const { project, zone } = withCluster();
    const wider = [
      { x: 20_000, y: 0 },
      { x: 34_000, y: 0 },
      { x: 34_000, y: 4000 },
      { x: 20_000, y: 4000 },
    ];
    const r = ok(project, {
      type: "zone.modify",
      payload: { zoneId: zone.id, changes: { polygon: wider } },
    });
    const after = r.project.zones[0]?.generatedItemIds as string[];
    expect(after.length).toBeGreaterThan(zone.generatedItemIds.length);
    expect(r.changes.removed.length).toBe(zone.generatedItemIds.length);
    expect(r.project.items.filter((i) => i.tags.includes("generated"))).toHaveLength(after.length);
  });

  it("puts a cluster back together when it has parted company with its pieces", () => {
    // What an older host left behind: the outline was moved and the pieces were not. Moving it again
    // must not carry the mistake to a new place.
    const { project, zone } = withCluster();
    const strayed = ok(project, {
      type: "item.move",
      payload: { itemIds: [...zone.generatedItemIds], dx: 40_000, dy: 0 },
    });
    const away = strayed.project.items.filter((i) => zone.generatedItemIds.includes(i.id));
    expect(away.every((i) => i.position.x > 50_000)).toBe(true);

    const r = ok(strayed.project, {
      type: "zone.modify",
      payload: { zoneId: zone.id, changes: { polygon: shifted(zone.polygon, 1000, 0) } },
    });
    const now = r.project.zones[0] as NonNullable<(typeof r.project.zones)[number]>;
    const pieces = r.project.items.filter((i) => now.generatedItemIds.includes(i.id));
    expect(pieces.length).toBeGreaterThan(0);
    // every piece is back inside the zone, where the rule puts them
    const b = {
      minX: Math.min(...now.polygon.map((q) => q.x)),
      maxX: Math.max(...now.polygon.map((q) => q.x)),
    };
    for (const piece of pieces) {
      expect(piece.position.x).toBeGreaterThan(b.minX);
      expect(piece.position.x).toBeLessThan(b.maxX);
    }
  });

  it("still carries the pieces along when only one of them was moved out", () => {
    const { project, zone } = withCluster();
    const one = zone.generatedItemIds[0] as string;
    const nudged = ok(project, { type: "item.move", payload: { itemIds: [one], dx: 40_000, dy: 0 } });
    const r = ok(nudged.project, {
      type: "zone.modify",
      payload: { zoneId: zone.id, changes: { polygon: shifted(zone.polygon, 1000, 0) } },
    });
    // the ids are the same, so nothing was laid out again: the odd one out is respected
    expect(r.project.zones[0]?.generatedItemIds).toEqual(zone.generatedItemIds);
    expect(r.project.items.find((i) => i.id === one)?.position.x).toBeGreaterThan(50_000);
  });

  it("leaves its pieces alone when something other than the shape changes", () => {
    const { project, zone } = withCluster();
    const r = ok(project, { type: "zone.modify", payload: { zoneId: zone.id, changes: { name: "Bank A" } } });
    expect(r.project.zones[0]?.name).toBe("Bank A");
    expect(r.project.zones[0]?.generatedItemIds).toEqual(zone.generatedItemIds);
    expect(r.changes.added).toHaveLength(0);
    expect(r.changes.removed).toHaveLength(0);
  });
});

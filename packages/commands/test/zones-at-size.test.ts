// P3-6's acceptance: two hundred desks arranged in under a second, and moved again without the cost
// turning quadratic.
//
// The budgets here are deliberately far above what the work takes — this is a guard against an accident
// of order, not a stopwatch. A machine under load must not turn this red, but an arrange that started
// scanning every item for every placement would blow through it by a mile.
import type { Point } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { createStore } from "../src/index.js";
import { ctx, fixture, LEVEL } from "./helpers.js";

const DESK = { kind: "table", size: { w: 1600, d: 800, h: 750 }, shape: "rect" } as const;
const GAP = 600;
const MARGIN = 300;

/** A rectangle with room for at least `n` desks of the size above. */
function areaFor(n: number): Point[] {
  const perRow = Math.ceil(Math.sqrt(n * 0.6));
  const rows = Math.ceil(n / perRow);
  const w = perRow * (DESK.size.w + GAP) + GAP + 2 * MARGIN;
  const d = rows * (DESK.size.d + GAP) + GAP + 2 * MARGIN;
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: d },
    { x: 0, y: d },
  ];
}

const arrange = (polygon: Point[], count: number) => ({
  type: "item.arrange",
  payload: {
    target: { polygon, levelId: LEVEL },
    rule: {
      pattern: "rows" as const,
      productId: null,
      recipe: DESK,
      count,
      spacing: { x: GAP, y: GAP },
      facing: 180,
      margin: MARGIN,
    },
  },
});

describe("a cluster at the size the brief asks for", () => {
  it("arranges two hundred desks in well under a second", () => {
    const s = createStore(fixture(), ctx(1000));
    const before = s.project.items.length;
    const started = performance.now();
    const result = s.apply(arrange(areaFor(200), 200), "editor");
    const ms = performance.now() - started;

    expect(result.ok).toBe(true);
    expect(s.project.items.length - before).toBe(200);
    expect(ms).toBeLessThan(1000);
  });

  it("moves all two hundred as one command, without laying them out again", () => {
    const s = createStore(fixture(), ctx(2000));
    s.apply(arrange(areaFor(200), 200), "editor");
    const zone = s.project.zones[0];
    expect(zone).toBeDefined();
    const was = new Map(s.project.items.map((i) => [i.id, { ...i.position }]));

    const started = performance.now();
    const moved = s.apply(
      {
        type: "zone.modify",
        payload: {
          zoneId: (zone as { id: string }).id,
          changes: {
            polygon: (zone as { polygon: Point[] }).polygon.map((p) => ({ x: p.x + 1000, y: p.y })),
          },
        },
      },
      "editor",
    );
    const ms = performance.now() - started;

    expect(moved.ok).toBe(true);
    expect(ms).toBeLessThan(1000);
    // Carried across, not rebuilt: the same pieces, each a thousand to the right. A fresh layout would
    // have new ids, and undoing the move would not put the old ones back.
    const after = s.project.items.filter((i) => was.has(i.id));
    expect(after).toHaveLength(was.size);
    const shifted = after.filter((i) => {
      const from = was.get(i.id) as { x: number; y: number };
      return Math.round(i.position.x - from.x) === 1000 && Math.round(i.position.y - from.y) === 0;
    });
    expect(shifted.length).toBe(200);
  });

  it("costs about twice as much for twice as many, not four times", () => {
    // The shape of the cost, which is what a budget alone cannot catch: an arrange that looked at every
    // item already placed for each new one would show up here as a square, however fast the machine is.
    const time = (n: number): number => {
      const s = createStore(fixture(), ctx(10_000));
      s.apply(arrange(areaFor(n), n), "editor"); // warm
      const s2 = createStore(fixture(), ctx(20_000));
      const started = performance.now();
      s2.apply(arrange(areaFor(n), n), "editor");
      return performance.now() - started;
    };
    const hundred = Math.max(time(100), 0.05);
    const fourHundred = time(400);
    // Four times the desks; linear would be about 4x, quadratic about 16x. Ten is a wide gate that
    // still shuts on a square.
    expect(fourHundred / hundred).toBeLessThan(10);
  });
});

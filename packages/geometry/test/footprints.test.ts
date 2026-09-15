import { defaultWall, type Wall } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { cornerRef, wallFootprints, wallFootprintUnjoined, wallSidePolygon } from "../src/index.js";

const L = "level_000000";
const mk = (id: string, sx: number, sy: number, ex: number, ey: number, t = 10, over: Partial<Wall> = {}) =>
  defaultWall(id, L, { x: sx, y: sy }, { x: ex, y: ey }, { thickness: t, ...over });

function join(a: Wall, aEnd: "start" | "end", b: Wall, bEnd: "start" | "end") {
  a.joins[aEnd] = { wallId: b.id, end: bEnd };
  b.joins[bEnd] = { wallId: a.id, end: aEnd };
}

describe("unjoined footprint", () => {
  it("W-001 W-002 W-003 four points ordered left-start, left-end, right-end, right-start with y up", () => {
    expect(wallFootprintUnjoined(mk("wall_000001", 0, 0, 100, 0))).toEqual([
      { x: 0, y: 5 },
      { x: 100, y: 5 },
      { x: 100, y: -5 },
      { x: 0, y: -5 },
    ]);
    expect(cornerRef(4, "start", "left")).toEqual({ index: 0, adjacent: 1 });
    expect(cornerRef(4, "end", "right")).toEqual({ index: 2, adjacent: 3 });
    expect(cornerRef(4, "start", "right")).toEqual({ index: 3, adjacent: 2 });
  });

  it("W-005 an arc extent on a zero-length wall falls back to the straight footprint", () => {
    const fp = wallFootprintUnjoined(mk("wall_000002", 5, 5, 5, 5, 8, { arcExtent: 180 }));
    expect(fp).toHaveLength(4);
  });

  it("W-012 footprints are fresh arrays each call", () => {
    const w = mk("wall_000003", 0, 0, 100, 0);
    const a = wallFootprintUnjoined(w);
    (a[0] as { x: number }).x = 999;
    expect(wallFootprintUnjoined(w)[0]?.x).toBe(0);
  });
});

describe("joins", () => {
  it("W-018 W-019 a right-angle head-to-tail join mitres both walls to the same corner", () => {
    const a = mk("wall_000001", 0, 0, 100, 0);
    const b = mk("wall_000002", 100, 0, 100, 100);
    join(a, "end", b, "start");
    const fps = wallFootprints([a, b]);
    const fa = fps.get(a.id) as { x: number; y: number }[];
    const fb = fps.get(b.id) as { x: number; y: number }[];
    // a's left-end corner (index 1) meets b's left-start corner (index 0): outer corner at (95, 5)
    expect(fa[1]).toEqual({ x: 95, y: 5 });
    expect(fb[0]).toEqual({ x: 95, y: 5 });
    // right side: a right-end (index 2) meets b right-start (index 3): inner corner at (105, -5)
    expect(fa[2]).toEqual({ x: 105, y: -5 });
    expect(fb[3]).toEqual({ x: 105, y: -5 });
  });

  it("W-020 a head-to-head join pairs left with right", () => {
    const a = mk("wall_000001", 0, 0, 100, 0);
    const b = mk("wall_000002", 100, 100, 100, 0); // ends at the shared point
    join(a, "end", b, "end");
    const fps = wallFootprints([a, b]);
    const fa = fps.get(a.id) as { x: number; y: number }[];
    const fb = fps.get(b.id) as { x: number; y: number }[];
    // b runs downward; its left side is +x. a's left (y=+5) meets b's right (x=95).
    expect(fa[1]).toEqual({ x: 95, y: 5 });
    expect(fb[2]).toEqual({ x: 95, y: 5 }); // b right-end corner
    expect(fa[2]).toEqual({ x: 105, y: -5 });
    expect(fb[1]).toEqual({ x: 105, y: -5 }); // b left-end corner
  });

  it("W-021 W-023 W-024 W-025 near-parallel, collinear and folded-back joins keep butt ends", () => {
    const a = mk("wall_000001", 0, 0, 100, 0);
    const b = mk("wall_000002", 100, 0, 200, 0); // collinear
    join(a, "end", b, "start");
    const fps = wallFootprints([a, b]);
    expect(fps.get(a.id)?.[1]).toEqual({ x: 100, y: 5 });
    expect(fps.get(b.id)?.[0]).toEqual({ x: 100, y: 5 });
    const c = mk("wall_000003", 0, 0, 100, 0);
    const d = mk("wall_000004", 100, 0, 0, 0.5); // 0.29 degrees off: within the clamp? intersection is far away
    join(c, "end", d, "start");
    const fps2 = wallFootprints([c, d]);
    // the mitre would be over 1000 mm away; clamp is 20 mm, so corners stay unmitred
    expect(fps2.get(c.id)?.[1]).toEqual({ x: 100, y: 5 });
    const e = mk("wall_000005", 0, 0, 100, 0);
    const f = mk("wall_000006", 100, 0, 0, 0); // 180 degree fold
    join(e, "end", f, "start");
    const fps3 = wallFootprints([e, f]);
    expect(fps3.get(e.id)?.[1]).toEqual({ x: 100, y: 5 });
    expect(fps3.get(f.id)?.[0]).toEqual({ x: 100, y: -5 });
  });

  it("W-008 W-026 different thicknesses land on the neighbour's side lines and the clamp uses the thicker wall", () => {
    const a = mk("wall_000001", 0, 0, 100, 0, 10);
    const b = mk("wall_000002", 100, 0, 100, 100, 30);
    join(a, "end", b, "start");
    const fps = wallFootprints([a, b]);
    expect(fps.get(a.id)?.[1]).toEqual({ x: 85, y: 5 });
    expect(fps.get(a.id)?.[2]).toEqual({ x: 115, y: -5 });
    expect(fps.get(b.id)?.[0]).toEqual({ x: 85, y: 5 });
  });

  it("W-027 W-028 the shared corner is identical on both walls and independent of wall order", () => {
    const a = mk("wall_000001", 0, 0, 1000, 0);
    const b = mk("wall_000002", 1000, 0, 1500, 700);
    join(a, "end", b, "start");
    const one = wallFootprints([a, b]);
    const two = wallFootprints([b, a]);
    expect(one.get(a.id)?.[1]).toEqual(one.get(b.id)?.[0]);
    expect(one.get(a.id)).toEqual(two.get(a.id));
    expect(one.get(b.id)).toEqual(two.get(b.id));
  });

  it("W-016 a two-wall closed loop of straight walls is resolved by the join record, not coordinates", () => {
    // Two walls forming a degenerate loop: a from A to B, b from B back to A, joined at both ends.
    const a = mk("wall_000001", 0, 0, 1000, 0);
    const b = mk("wall_000002", 1000, 0, 0, 0);
    join(a, "end", b, "start");
    join(a, "start", b, "end");
    expect(() => wallFootprints([a, b])).not.toThrow();
  });

  it("wallSidePolygon returns the half slab to the centreline (W-106)", () => {
    const fp = wallFootprintUnjoined(mk("wall_000001", 0, 0, 100, 0));
    expect(wallSidePolygon(fp, "left")).toEqual([
      { x: 0, y: 5 },
      { x: 100, y: 5 },
      { x: 100, y: 0 },
      { x: 0, y: 0 },
    ]);
  });
});

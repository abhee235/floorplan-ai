import { defaultWall } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { arcSegmentCount, tessellateArc, wallFootprintUnjoined } from "../src/index.js";

const L = "level_000000";
const arc = (extent: number, t = 100) =>
  defaultWall("wall_000001", L, { x: 0, y: 0 }, { x: 1000, y: 0 }, { thickness: t, arcExtent: extent });

describe("arc tessellation", () => {
  it("W-048 a null or zero extent is straight", () => {
    expect(tessellateArc(arc(0))).toBeNull();
    expect(tessellateArc(defaultWall("wall_000002", L, { x: 0, y: 0 }, { x: 1000, y: 0 }))).toBeNull();
  });

  it("W-049 a 180 degree arc on a 1000 chord has radius 500 centred on the chord midpoint", () => {
    const t = tessellateArc(arc(180)) as NonNullable<ReturnType<typeof tessellateArc>>;
    expect(t.radius).toBeCloseTo(500, 6);
    expect(t.centre.x).toBeCloseTo(500, 6);
    expect(Math.abs(t.centre.y)).toBeLessThan(1e-6);
  });

  it("W-052 W-053 segment count grows with the square root of the outer arc length and segments are equal", () => {
    expect(arcSegmentCount(1000)).toBe(10);
    expect(arcSegmentCount(1)).toBe(4);
    const t = tessellateArc(arc(180, 100)) as NonNullable<ReturnType<typeof tessellateArc>>;
    expect(t.left).toHaveLength(t.segments + 1);
    // first and last points lie on the start and end of the wall's left side (distance to centre = outer radius)
    const dist = (p: { x: number; y: number }) => Math.hypot(p.x - t.centre.x, p.y - t.centre.y);
    expect(dist(t.left[0] as { x: number; y: number })).toBeCloseTo(550, 6);
    expect(dist(t.left[t.left.length - 1] as { x: number; y: number })).toBeCloseTo(550, 6);
  });

  it("W-055 positive extent puts the outer arc on the left side, negative on the right", () => {
    const pos = tessellateArc(arc(180, 100)) as NonNullable<ReturnType<typeof tessellateArc>>;
    const mid = pos.left[Math.floor(pos.left.length / 2)] as { x: number; y: number };
    expect(mid.y).toBeGreaterThan(500); // bulges toward +y (left of a +x chord)
    expect(Math.hypot(mid.x - pos.centre.x, mid.y - pos.centre.y)).toBeCloseTo(550, 6);
    const neg = tessellateArc(arc(-180, 100)) as NonNullable<ReturnType<typeof tessellateArc>>;
    const midN = neg.left[Math.floor(neg.left.length / 2)] as { x: number; y: number };
    expect(midN.y).toBeLessThan(-400);
    expect(Math.hypot(midN.x - neg.centre.x, midN.y - neg.centre.y)).toBeCloseTo(450, 6);
  });

  it("W-056 the interior radius clamps at zero for over-thick arcs", () => {
    const t = tessellateArc(arc(180, 2000)) as NonNullable<ReturnType<typeof tessellateArc>>;
    for (const p of t.right) {
      expect(Math.hypot(p.x - t.centre.x, p.y - t.centre.y)).toBeLessThan(1e-6);
    }
  });

  it("W-058 a tiny extent still produces at least four segments", () => {
    const t = tessellateArc(arc(1)) as NonNullable<ReturnType<typeof tessellateArc>>;
    expect(t.segments).toBeGreaterThanOrEqual(4);
    // nearly straight: every left point is within 20 mm of the chord line y = 50
    for (const p of t.left) expect(Math.abs(p.y - 50)).toBeLessThan(20);
  });

  it("W-059 W-003 an arc footprint honours the index contract", () => {
    const fp = wallFootprintUnjoined(arc(90, 100));
    const n = fp.length / 2;
    expect(fp[0]).toEqual(expect.objectContaining({ x: expect.any(Number) }));
    // left-start near the start point, right-start (last) near the start point too
    const start = { x: 0, y: 0 };
    const d = (p: { x: number; y: number }) => Math.hypot(p.x - start.x, p.y - start.y);
    expect(d(fp[0] as { x: number; y: number })).toBeCloseTo(50, 6);
    expect(d(fp[2 * n - 1] as { x: number; y: number })).toBeCloseTo(50, 6);
    const end = { x: 1000, y: 0 };
    const de = (p: { x: number; y: number }) => Math.hypot(p.x - end.x, p.y - end.y);
    expect(de(fp[n - 1] as { x: number; y: number })).toBeCloseTo(50, 6);
    expect(de(fp[n] as { x: number; y: number })).toBeCloseTo(50, 6);
  });
});

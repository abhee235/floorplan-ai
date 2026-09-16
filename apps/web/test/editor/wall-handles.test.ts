import { INDICATOR_PX, wallFootprintUnjoined } from "@fpv/geometry";
import type { Point, Wall } from "@fpv/ir";
import { defaultWall, derive } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import {
  arcExtentThrough,
  handleAnchors,
  handleAt,
  handleCommand,
  indicatorMarginMm,
  MAX_ARC_EXTENT_DEG,
  previewWall,
} from "../../src/editor/wall-handles.js";

const LEVEL = "level_000001";

function wall(start: Point, end: Point, over: Partial<Wall> = {}): Wall {
  return defaultWall("wall_000001", LEVEL, start, end, { thickness: 200, ...over });
}

/**
 * The midpoint of a wall's own arc: the point its bulge passes through.
 *
 * Taken as half the swept angle from the start rather than by pushing out from the chord midpoint, so
 * that a half turn — where the centre sits on the chord and that direction has no length — is not a
 * special case, and so that an arc past the half turn takes its own long way round rather than the
 * complementary arc's midpoint.
 */
function apexOf(w: Wall): Point {
  const arc = derive.arcParams(w);
  if (!arc) throw new Error("not an arc");
  const from = Math.atan2(w.start.y - arc.centre.y, w.start.x - arc.centre.x);
  const half = from - ((w.arcExtent as number) * Math.PI) / 360;
  return { x: arc.centre.x + Math.cos(half) * arc.radius, y: arc.centre.y + Math.sin(half) * arc.radius };
}

describe("wall handles", () => {
  it("W-085 the arc handle sits on a side surface, not on the centreline", () => {
    const w = wall({ x: 0, y: 0 }, { x: 4000, y: 0 });
    const anchors = handleAnchors(w, wallFootprintUnjoined(w));
    if (!anchors) throw new Error("no anchors");
    // Along the wall it is at the middle; across it, out on a face rather than on the centreline.
    expect(anchors.arc.at.x).toBeCloseTo(2000, 6);
    expect(Math.abs(anchors.arc.at.y)).toBeCloseTo(100, 6);
    expect(anchors.start.at).toEqual({ x: 0, y: 0 });
    expect(anchors.end.at).toEqual({ x: 4000, y: 0 });
  });

  it("W-085 a press on the middle cross-section is the arc handle", () => {
    const w = wall({ x: 0, y: 0 }, { x: 4000, y: 0 });
    const fp = wallFootprintUnjoined(w);
    expect(handleAt(w, fp, { x: 2000, y: 0 }, 50)).toBe("arc");
  });

  it("presses on the end caps are the resize handles", () => {
    const w = wall({ x: 0, y: 0 }, { x: 4000, y: 0 });
    const fp = wallFootprintUnjoined(w);
    expect(handleAt(w, fp, { x: 0, y: 40 }, 50)).toBe("start");
    expect(handleAt(w, fp, { x: 4000, y: -40 }, 50)).toBe("end");
    expect(handleAt(w, fp, { x: 1200, y: 0 }, 50)).toBeNull();
  });

  it("an endpoint wins over the arc handle where the two regions overlap", () => {
    // A wall shorter than twice the margin: every region covers every other.
    const w = wall({ x: 0, y: 0 }, { x: 100, y: 0 });
    const fp = wallFootprintUnjoined(w);
    expect(handleAt(w, fp, { x: 50, y: 0 }, 500)).toBe("start");
  });

  it("W-091 the touch margin is three times the mouse margin", () => {
    expect(indicatorMarginMm(1, false)).toBe(INDICATOR_PX);
    expect(indicatorMarginMm(1, true)).toBe(3 * INDICATOR_PX);
    // Screen pixels over the scale, so the target keeps its size on screen as the plan zooms.
    expect(indicatorMarginMm(0.5, false)).toBe(INDICATOR_PX / 0.5);
  });

  it("W-060 the arc extent takes its sign from the side the drag is on", () => {
    const start = { x: 0, y: 0 };
    const end = { x: 4000, y: 0 };
    const left = arcExtentThrough(start, end, { x: 2000, y: 600 });
    const right = arcExtentThrough(start, end, { x: 2000, y: -600 });
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect((left as number) > 0).toBe(true);
    expect((right as number) < 0).toBe(true);
    expect(left).toBeCloseTo(-(right as number), 6);
  });

  it("W-060 the magnitude passes a half turn and clamps at three quarters", () => {
    const start = { x: 0, y: 0 };
    const end = { x: 4000, y: 0 };
    // A drag barely past the chord is a shallow arc; a deep one exceeds a half turn.
    expect(arcExtentThrough(start, end, { x: 2000, y: 100 }) as number).toBeLessThan(90);
    expect(arcExtentThrough(start, end, { x: 2000, y: 2000 }) as number).toBeCloseTo(180, 6);
    expect(arcExtentThrough(start, end, { x: 2000, y: 3800 }) as number).toBeGreaterThan(180);
    // Deep enough to ask for more than three quarters of a turn: held at the limit.
    expect(arcExtentThrough(start, end, { x: 2000, y: 20000 })).toBe(MAX_ARC_EXTENT_DEG);
  });

  it("W-060 a collinear drag is a straight wall, stored as a null extent", () => {
    const start = { x: 0, y: 0 };
    const end = { x: 4000, y: 0 };
    expect(arcExtentThrough(start, end, { x: 2000, y: 0 })).toBeNull();
    expect(arcExtentThrough(start, start, { x: 10, y: 10 })).toBeNull();
  });

  it("W-062 snapping rounds the extent to whole degrees", () => {
    const start = { x: 0, y: 0 };
    const end = { x: 4000, y: 0 };
    const through = { x: 2100, y: 731 };
    const free = arcExtentThrough(start, end, through) as number;
    const snapped = arcExtentThrough(start, end, through, true) as number;
    expect(Number.isInteger(snapped)).toBe(true);
    expect(Math.abs(snapped - free)).toBeLessThanOrEqual(0.5);
  });

  it("the extent through an arc's own apex is the extent it already has", () => {
    for (const extent of [45, 90, 180, -90, 240]) {
      const w = wall({ x: 0, y: 0 }, { x: 4000, y: 0 }, { arcExtent: extent });
      const back = arcExtentThrough(w.start, w.end, apexOf(w));
      expect(back as number).toBeCloseTo(extent, 4);
    }
  });

  it("a preview moves the dragged end only, rounded to whole millimetres", () => {
    const w = wall({ x: 0, y: 0 }, { x: 4000, y: 0 });
    const moved = previewWall(w, "end", { x: 4500.6, y: 120.2 });
    expect(moved?.end).toEqual({ x: 4501, y: 120 });
    expect(moved?.start).toEqual({ x: 0, y: 0 });
    // A drag onto the opposite end would make a zero-length wall, which the host refuses.
    expect(previewWall(w, "start", { x: 4000, y: 0 })).toBeNull();
  });

  it("a drag that changes nothing commits no command", () => {
    const w = wall({ x: 0, y: 0 }, { x: 4000, y: 0 });
    const same = previewWall(w, "end", { x: 4000, y: 0 }) as Wall;
    expect(handleCommand(w, "end", same)).toBeNull();

    const moved = previewWall(w, "end", { x: 4200, y: 0 }) as Wall;
    expect(handleCommand(w, "end", moved)).toEqual({
      type: "wall.modify",
      payload: { wallId: w.id, changes: { end: { x: 4200, y: 0 } } },
    });
  });

  it("bending commits the extent and straightening commits a null", () => {
    const straight = wall({ x: 0, y: 0 }, { x: 4000, y: 0 });
    const bent = previewWall(straight, "arc", { x: 2000, y: 2000 }) as Wall;
    expect(handleCommand(straight, "arc", bent)).toEqual({
      type: "wall.modify",
      payload: { wallId: straight.id, changes: { arcExtent: 180 } },
    });

    const curved = wall({ x: 0, y: 0 }, { x: 4000, y: 0 }, { arcExtent: 90 });
    const flattened = previewWall(curved, "arc", { x: 2000, y: 0 }) as Wall;
    expect(handleCommand(curved, "arc", flattened)).toEqual({
      type: "wall.modify",
      payload: { wallId: curved.id, changes: { arcExtent: null } },
    });
  });
});

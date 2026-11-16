// Measuring a distance on the plan: the rules, with no canvas involved.
//
// This is the tool that catches a wrong scale. An imported drawing's scale comes from a dimension
// string a model read, or from a guess, and a scale wrong by a fifth makes every area and every BOM
// quantity wrong by a fifth with nothing downstream able to notice.
import { apply, type Ctx } from "@fpv/commands";
import { type Project, sequentialIdGenerator } from "@fpv/ir";
import { blankProject } from "@fpv/tools";
import { describe, expect, it } from "vitest";
import {
  aimEnd,
  formatDistance,
  measure,
  nearestCorner,
  SNAP_PX,
  describe as say,
} from "../../src/editor/measure-tool.js";

const NOW = "2026-09-19T10:00:00.000Z";
const LEVEL = "level_000000";
// ONE generator for the file: a fresh one restarts at wall_000001 and the store refuses the duplicate.
const ids = sequentialIdGenerator(1);
const ctx = (): Ctx => ({ ids, now: () => NOW });

/** A project with one 5 m wall running east from the origin. */
function oneWall(): Project {
  const r = apply(
    blankProject("Test", NOW, "testproject0"),
    {
      type: "wall.create",
      payload: { levelId: LEVEL, start: { x: 0, y: 0 }, end: { x: 5000, y: 0 } },
    },
    ctx(),
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}

const settings = (over: Partial<Parameters<typeof aimEnd>[3]> = {}) => ({
  units: "mm" as const,
  axisLocked: false,
  magnetism: true,
  ...over,
});

describe("how a distance reads", () => {
  it("groups millimetres without a comma, because a comma is a decimal point elsewhere", () => {
    expect(formatDistance(3550, "mm")).toBe(`3${" "}550 mm`);
    expect(formatDistance(900, "mm")).toBe("900 mm");
    expect(formatDistance(12345.6, "mm")).toBe(`12${" "}346 mm`);
    expect(formatDistance(3550, "mm")).not.toContain(",");
  });

  it("writes metres without trailing zeroes", () => {
    expect(formatDistance(3550, "m")).toBe("3.55 m");
    expect(formatDistance(4000, "m")).toBe("4 m");
    expect(formatDistance(1234, "m")).toBe("1.234 m");
  });

  it("writes feet and inches in eighths, as a tape is read", () => {
    expect(formatDistance(914.4, "ft")).toBe(`3' 0"`); // exactly three feet
    expect(formatDistance(0, "ft")).toBe(`0' 0"`);
    // 1 m is 3 feet 3 and 3/8 inches
    expect(formatDistance(1000, "ft")).toBe(`3' 3 3/8"`);
    // and a measurement that rounds up to twelve inches carries into the next foot
    expect(formatDistance(914.4 - 0.5, "ft")).toBe(`3' 0"`);
  });
});

describe("where an end lands", () => {
  it("catches the corner of a wall, joined or not", () => {
    const p = oneWall();
    // At this zoom a plan millimetre is a screen pixel, so the reach is SNAP_PX millimetres.
    const got = aimEnd({ x: 4996, y: 4 }, p, LEVEL, settings(), 1, null);
    expect(got.point).toEqual({ x: 5000, y: 0 });
    expect(got.note).toBe("corner");

    // and a point beyond that reach is left where it is, rather than pulled from across the room
    const far = aimEnd({ x: 4980, y: 12 }, p, LEVEL, settings(), 1, null);
    expect(far.point).toEqual({ x: 4980, y: 12 });
  });

  it("leaves the point alone when nothing is near and nothing is held", () => {
    const p = oneWall();
    const got = aimEnd({ x: 2500, y: 2000 }, p, LEVEL, settings(), 1, null);
    expect(got.point).toEqual({ x: 2500, y: 2000 });
    expect(got.note).toBe("");
  });

  it("holds the line to an axis when Shift is held, choosing the longer one", () => {
    const p = oneWall();
    const from = { x: 0, y: 0 };
    const across = aimEnd({ x: 3000, y: 400 }, p, LEVEL, settings({ axisLocked: true }), 1, from);
    expect(across.point).toEqual({ x: 3000, y: 0 });
    expect(across.note).toBe("axis");
    const up = aimEnd({ x: 400, y: 3000 }, p, LEVEL, settings({ axisLocked: true }), 1, from);
    expect(up.point).toEqual({ x: 0, y: 3000 });
  });

  it("prefers a corner to an axis: a corner is a place, an axis is only a direction", () => {
    const p = oneWall();
    const got = aimEnd({ x: 4995, y: 5 }, p, LEVEL, settings({ axisLocked: true }), 1, { x: 0, y: 2000 });
    expect(got.note).toBe("corner");
    expect(got.point).toEqual({ x: 5000, y: 0 });
  });

  it("ignores corners on another level, and obeys the snap tolerance", () => {
    const p = oneWall();
    expect(nearestCorner({ x: 4990, y: 0 }, p, "level_999999", 100)).toBeNull();
    expect(nearestCorner({ x: 4990, y: 0 }, p, LEVEL, 5)).toBeNull();
    expect(nearestCorner({ x: 4990, y: 0 }, p, LEVEL, 100)).toEqual({ x: 5000, y: 0 });
    // the tolerance grows as the plan zooms out, which is what keeps a corner catchable
    expect(SNAP_PX).toBeGreaterThan(0);
  });

  it("does not snap at all when magnetism is off", () => {
    const p = oneWall();
    const got = aimEnd({ x: 4996, y: 4 }, p, LEVEL, settings({ magnetism: false }), 1, null);
    expect(got.point).toEqual({ x: 4996, y: 4 });
  });
});

describe("what a measurement says", () => {
  it("gives the distance, both axis differences and the angle", () => {
    const m = measure({ x: 0, y: 0 }, { x: 3000, y: 4000 }, "mm");
    expect(m.distanceMm).toBeCloseTo(5000, 6);
    expect(m.dxMm).toBe(3000);
    expect(m.dyMm).toBe(4000);
    expect(m.angleDeg).toBeCloseTo(53.13, 2);
    expect(m.text).toBe(`5${" "}000 mm`);
  });

  it("keeps the angle between 0 and 360 whichever way the line is drawn", () => {
    expect(measure({ x: 0, y: 0 }, { x: -1000, y: 0 }, "mm").angleDeg).toBeCloseTo(180, 6);
    expect(measure({ x: 0, y: 0 }, { x: 0, y: -1000 }, "mm").angleDeg).toBeCloseTo(270, 6);
    expect(measure({ x: 0, y: 0 }, { x: 1000, y: 0 }, "mm").angleDeg).toBeCloseTo(0, 6);
  });

  it("reads out the distance, how far across and how far up, and what it caught", () => {
    const m = measure({ x: 0, y: 0 }, { x: 3000, y: 4000 }, "m", "corner");
    const text = say(m, "m");
    expect(text).toContain("5 m");
    expect(text).toContain("3 m across");
    expect(text).toContain("4 m up");
    expect(text).toContain("corner");
  });

  it("measures nothing as nothing rather than as a mistake", () => {
    const m = measure({ x: 1000, y: 1000 }, { x: 1000, y: 1000 }, "mm");
    expect(m.distanceMm).toBe(0);
    expect(m.text).toBe("0 mm");
  });
});

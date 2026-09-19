// Putting a door, a window or a passage in a wall: the rules, with no canvas involved.
import { apply, type Ctx } from "@fpv/commands";
import { derive, type Project, sequentialIdGenerator } from "@fpv/ir";
import { blankProject } from "@fpv/tools";
import { describe, expect, it } from "vitest";
import {
  addCommand,
  aimOnWall,
  aimOpening,
  alongWall,
  END_MARGIN_MM,
  MIDDLE_SNAP_MM,
  slide,
  wallUnder,
} from "../../src/editor/opening-tool.js";

const NOW = "2026-09-19T10:00:00.000Z";
const LEVEL = "level_000000";
// ONE generator for the whole file. A fresh one per call restarts at wall_000001, so a second wall
// gets the id the first already has and the store refuses it.
const ids = sequentialIdGenerator(1);
const ctx = (): Ctx => ({ ids, now: () => NOW });

/** A project with one straight 5 m wall running east along y = 0. */
function oneWall(over: { thickness?: number; length?: number } = {}): Project {
  const project = blankProject("Test", NOW, "testproject0");
  const r = apply(
    project,
    {
      type: "wall.create",
      payload: {
        levelId: LEVEL,
        start: { x: 0, y: 0 },
        end: { x: over.length ?? 5000, y: 0 },
        thickness: over.thickness ?? 100,
      },
    },
    ctx(),
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}

const settings = (over: Partial<Parameters<typeof aimOpening>[3]> = {}) => ({
  kind: "door" as const,
  widthMm: 900,
  freehand: false,
  ...over,
});

describe("finding the wall under the pointer", () => {
  it("takes a pointer on the wall, and nothing when it is too far away", () => {
    const p = oneWall();
    const wall = p.walls[0];
    expect(wallUnder(p, LEVEL, { x: 2500, y: 0 })?.id).toBe(wall?.id);
    // just outside the half-thickness plus the reach
    expect(wallUnder(p, LEVEL, { x: 2500, y: 400 })).toBeNull();
  });

  it("ignores walls on another level", () => {
    const p = oneWall();
    expect(wallUnder(p, "level_999999", { x: 2500, y: 0 })).toBeNull();
  });

  it("takes the nearer wall where two meet, not the first one found", () => {
    // A second wall running north from the far end; a pointer near the corner belongs to one of them.
    const first = oneWall();
    const r = apply(
      first,
      {
        type: "wall.create",
        payload: { levelId: LEVEL, start: { x: 5000, y: 0 }, end: { x: 5000, y: 4000 } },
      },
      ctx(),
    );
    if (!r.ok) throw new Error(r.error.message);
    const p = r.project;
    // well up the second wall: the answer must be the second, though the first is listed before it
    expect(wallUnder(p, LEVEL, { x: 5000, y: 2000 })?.id).toBe(p.walls[1]?.id);
  });

  it("measures how far along a wall a point falls", () => {
    const p = oneWall();
    const wall = p.walls[0];
    if (!wall) throw new Error("no wall");
    expect(alongWall(wall, { x: 2500, y: 0 }).fraction).toBeCloseTo(0.5, 6);
    expect(alongWall(wall, { x: 0, y: 0 }).fraction).toBeCloseTo(0, 6);
    // past the end clamps rather than running off
    expect(alongWall(wall, { x: 9000, y: 0 }).fraction).toBe(1);
    expect(alongWall(wall, { x: 2500, y: 120 }).awayMm).toBeCloseTo(120, 6);
  });
});

describe("where the opening lands", () => {
  it("pulls to the middle of the wall when the pointer is near it", () => {
    const p = oneWall();
    const near = aimOpening(p, LEVEL, { x: 2500 + MIDDLE_SNAP_MM - 50, y: 0 }, settings());
    expect(near?.snapped).toBe(true);
    expect(near?.position).toBeCloseTo(0.5, 6);
    expect(near?.note).toContain("middle of the wall");
  });

  it("leaves it where the pointer is when Alt is held", () => {
    const p = oneWall();
    const at = { x: 2500 + MIDDLE_SNAP_MM - 50, y: 0 };
    const free = aimOpening(p, LEVEL, at, settings({ freehand: true }));
    expect(free?.snapped).toBe(false);
    expect(free?.position).not.toBeCloseTo(0.5, 6);
    expect(free?.note).toContain("mm along");
  });

  it("keeps the whole opening on the wall, with a jamb at each end", () => {
    const p = oneWall();
    const wall = p.walls[0];
    if (!wall) throw new Error("no wall");
    // asked for the very start: the centre moves in by half the width plus the margin
    const aim = aimOnWall(p, wall, 0, settings({ freehand: true }));
    expect(aim.position * 5000).toBeCloseTo(900 / 2 + END_MARGIN_MM, 6);
    const far = aimOnWall(p, wall, 1, settings({ freehand: true }));
    expect(far.position * 5000).toBeCloseTo(5000 - (900 / 2 + END_MARGIN_MM), 6);
    expect(aim.refusal).toBeNull();
  });

  it("refuses a wall too short to hold it, and says both numbers", () => {
    const p = oneWall({ length: 800 });
    const wall = p.walls[0];
    if (!wall) throw new Error("no wall");
    const aim = aimOnWall(p, wall, 0.5, settings());
    expect(aim.refusal).toContain("800");
    expect(aim.refusal).toContain("1000"); // 900 plus two 50 mm jambs
    expect(addCommand(aim)).toBeNull();
  });

  it("refuses to put one on top of another, naming what is there", () => {
    const p = oneWall();
    const wall = p.walls[0];
    if (!wall) throw new Error("no wall");
    const first = aimOnWall(p, wall, 0.5, settings());
    const command = addCommand(first);
    expect(command).not.toBeNull();
    const r = apply(p, command, ctx());
    if (!r.ok) throw new Error(r.error.message);

    // a second door 200 mm away overlaps the first
    const clash = aimOnWall(r.project, wall, 0.5 + 200 / 5000, settings({ freehand: true }));
    expect(clash.refusal).toBe("There is already a door here");
    expect(addCommand(clash)).toBeNull();

    // but one at the far end is fine
    const clear = aimOnWall(r.project, wall, 0.9, settings({ freehand: true }));
    expect(clear.refusal).toBeNull();
  });

  it("gives the ghost the kind's own shape, so what is drawn is what is placed", () => {
    const p = oneWall();
    const door = aimOpening(p, LEVEL, { x: 2500, y: 0 }, settings());
    const window = aimOpening(p, LEVEL, { x: 2500, y: 0 }, settings({ kind: "window" }));
    expect(door?.preview.kind).toBe("door");
    expect(door?.preview.sill).toBe(0);
    expect(door?.preview.swing).not.toBeNull();
    // a window sits off the floor and does not swing
    expect(window?.preview.sill ?? 0).toBeGreaterThan(0);
    expect(window?.preview.swing).toBeNull();
    expect(door?.footprint.length).toBeGreaterThan(2);
  });

  it("sends exactly one opening.add, with what the aim settled on", () => {
    const p = oneWall();
    const aim = aimOpening(p, LEVEL, { x: 1200, y: 0 }, settings({ kind: "window", widthMm: 1400 }));
    if (!aim) throw new Error("no aim");
    expect(addCommand(aim)).toEqual({
      type: "opening.add",
      payload: { wallId: p.walls[0]?.id, kind: "window", position: aim.position, width: 1400 },
    });
  });

  it("says nothing at all when the pointer is on no wall", () => {
    const p = oneWall();
    expect(aimOpening(p, LEVEL, { x: 2500, y: 2000 }, settings())).toBeNull();
  });
});

describe("sliding it along with the arrow keys", () => {
  it("moves by the distance asked for and does not snap back to the middle", () => {
    const p = oneWall();
    const wall = p.walls[0];
    if (!wall) throw new Error("no wall");
    const middle = aimOnWall(p, wall, 0.5, settings());
    expect(middle.snapped).toBe(true);
    const moved = slide(p, wall, middle, 100, settings());
    expect(moved.position * 5000).toBeCloseTo(2600, 6);
    expect(moved.snapped).toBe(false);
  });

  it("stops at the end of the wall rather than sliding off it", () => {
    const p = oneWall();
    const wall = p.walls[0];
    if (!wall) throw new Error("no wall");
    let aim = aimOnWall(p, wall, 0.5, settings());
    for (let i = 0; i < 40; i += 1) aim = slide(p, wall, aim, 500, settings());
    expect(aim.position * 5000).toBeCloseTo(5000 - (900 / 2 + END_MARGIN_MM), 6);
    expect(aim.refusal).toBeNull();
  });
});

describe("openings in a curved wall", () => {
  it("catches a curved wall the pointer is actually on", () => {
    // The distance test is arc-aware, so a press on the curve finds the wall. WHERE along it the
    // opening lands is measured along the chord, because every other helper in the IR does the same
    // (see alongWall) — an opening in a curved wall is a known, pre-existing rough edge.
    const flat = oneWall();
    const r = apply(
      flat,
      {
        type: "wall.create",
        payload: { levelId: LEVEL, start: { x: 0, y: 3000 }, end: { x: 4000, y: 3000 }, arcExtent: 90 },
      },
      ctx(),
    );
    if (!r.ok) throw new Error(r.error.message);
    const arc = r.project.walls[1];
    if (!arc) throw new Error("no arc");
    const params = derive.arcParams(arc);
    if (!params) throw new Error("not an arc");
    // a point on the curve itself, at the top of the bulge
    const onCurve = { x: params.centre.x, y: params.centre.y + params.radius };
    expect(wallUnder(r.project, LEVEL, onCurve)?.id).toBe(arc.id);
    const aim = aimOpening(r.project, LEVEL, onCurve, settings({ freehand: true }));
    expect(aim?.wallId).toBe(arc.id);
    expect(aim?.refusal).toBeNull();
  });
});

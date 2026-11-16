// Baseboards (ADR-014 D8). The six-wall fixture's south wall runs (0,0) to (8000,0), 100 mm thick, joined at
// both ends, with a 900 mm door centred in it; its left side is the room side, y = 50 from x = 50 to 7950.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultWall, type Level, Project, poly, type Wall } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { buildWalls, type GeometryPart, partArea, partBounds, skirtingOutlines } from "../src/index.js";

const fixtureDir = fileURLToPath(new URL("../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const project = Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));
const level = project.levels[0] as Level;
const ctx = { level, isLowest: true, isHighest: true };
const SOUTH = "wall_000001";

const withSkirting = (id: string, skirting: Wall["skirting"], over: Partial<Wall> = {}) =>
  project.walls.map((w) => (w.id === id ? { ...w, skirting, ...over } : w));
const partOf = (parts: GeometryPart[], id: string, kind: string) =>
  parts.find((p) => p.entityId === id && p.part === kind);
/** Plan millimetres and elevation for every vertex of a part (the engine writes metres, three.js frame). */
const vertices = (part: GeometryPart) => {
  const out: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < part.positions.length; i += 3)
    out.push({
      x: (part.positions[i] as number) * 1000,
      y: -(part.positions[i + 2] as number) * 1000,
      z: (part.positions[i + 1] as number) * 1000,
    });
  return out;
};
const board = { thickness: 20, height: 100, color: null };

describe("baseboards (ADR-014 D8)", () => {
  it("W-107 W-099 a baseboard is a strip out from its side, on the floor, as high as it says", () => {
    const parts = buildWalls(withSkirting(SOUTH, { left: board, right: null }), project.openings, ctx);
    const left = partOf(parts, SOUTH, "skirting-left") as GeometryPart;
    expect(left).toBeDefined();
    expect(partOf(parts, SOUTH, "skirting-right")).toBeUndefined();
    const b = partBounds(left);
    // plan y 50..70 is three.js z -0.07..-0.05; elevation 0..100 is y 0..0.1
    expect(b.min[2]).toBeCloseTo(-0.07, 6);
    expect(b.max[2]).toBeCloseTo(-0.05, 6);
    expect(b.min[1]).toBeCloseTo(0, 6);
    expect(b.max[1]).toBeCloseTo(0.1, 6);
  });

  it("W-113 O-059 a door breaks the baseboard, square across, and the corners close on the join lines", () => {
    const parts = buildWalls(withSkirting(SOUTH, { left: board, right: null }), project.openings, ctx);
    const left = partOf(parts, SOUTH, "skirting-left") as GeometryPart;
    // nothing over the door (x 3550..4450), give or take float32's hundredth of a millimetre
    expect(vertices(left).some((v) => v.x > 3550.01 && v.x < 4449.99)).toBe(false);
    // Two runs. Front: (3550 - 70) + (7930 - 4450) long, 100 high. Top: trapezoids 3500/3480 long, 20 deep.
    // Ends: two on the 45-degree join lines (20 * sqrt 2 wide) and two square at the door (20 wide).
    const front = (3480 + 3480) * 100;
    const top = 2 * ((3500 + 3480) / 2) * 20;
    const ends = 2 * 20 * Math.SQRT2 * 100 + 2 * 20 * 100;
    expect(partArea(left)).toBeCloseTo((front + top + ends) / 1e6, 6);
  });

  it("W-099 stands on the floor of an upper level, not on the wall's bottom inside the slab", () => {
    const upper = { level: { ...level, elevation: 3000 }, isLowest: false, isHighest: true };
    const parts = buildWalls(withSkirting(SOUTH, { left: board, right: null }), project.openings, upper);
    expect(partBounds(partOf(parts, SOUTH, "wall-left") as GeometryPart).min[1]).toBeLessThan(3);
    const b = partBounds(partOf(parts, SOUTH, "skirting-left") as GeometryPart);
    expect(b.min[1]).toBeCloseTo(3, 6);
    expect(b.max[1]).toBeCloseTo(3.1, 6);
  });

  it("W-100 never rises above the wall where the wall is lower", () => {
    const low = withSkirting(
      SOUTH,
      { left: { thickness: 20, height: 150, color: null }, right: null },
      { height: 80 },
    );
    const b = partBounds(
      partOf(buildWalls(low, project.openings, ctx), SOUTH, "skirting-left") as GeometryPart,
    );
    expect(b.max[1]).toBeCloseTo(0.08, 6);
  });

  it("W-112 takes the side's own colour, its own quiet colour otherwise, and is frame on glass", () => {
    const red = {
      color: "#FF0000",
      textureId: null,
      placement: null,
      mirrorForLeftSide: false,
      shininess: null,
    };
    const walls = withSkirting(
      SOUTH,
      { left: board, right: board },
      { finishes: { left: red, right: null, top: null } },
    );
    const parts = buildWalls(walls, project.openings, ctx);
    expect(partOf(parts, SOUTH, "skirting-left")?.materialKey).toBe("wall-skirting|#FF0000|");
    expect(partOf(parts, SOUTH, "skirting-right")?.materialKey).toBe("wall-skirting");
    const glass = buildWalls(
      withSkirting(SOUTH, { left: board, right: null }, { kind: "glass" }),
      project.openings,
      ctx,
    );
    expect(partOf(glass, SOUTH, "skirting-left")?.materialKey).toBe("wall-glass-frame");
  });

  it("W-057 (reversed) on the inside of a tight curve the baseboard stops at the centre", () => {
    // a semicircle of radius 5 with walls 8 thick: the inside face is 1 from the centre, the baseboard 3
    const L = level.id;
    const arc = defaultWall("wall_arc001", L, { x: 0, y: 0 }, { x: 10, y: 0 }, { thickness: 8 });
    const tight: Wall = {
      ...arc,
      arcExtent: 180,
      skirting: { left: null, right: { thickness: 3, height: 50, color: null } },
    };
    const part = partOf(buildWalls([tight], [], ctx), "wall_arc001", "skirting-right") as GeometryPart;
    expect(part).toBeDefined();
    const distances = vertices(part).map((v) => Math.hypot(v.x - 5, v.y));
    expect(distances.every(Number.isFinite)).toBe(true);
    // unclamped, the offset would pass the centre and land 2 beyond it
    expect(Math.max(...distances)).toBeLessThanOrEqual(1 + 1e-6);
  });

  it("is left out entirely when a side has no baseboard", () => {
    const parts = buildWalls(project.walls, project.openings, ctx);
    expect(parts.some((p) => p.part === "skirting-left" || p.part === "skirting-right")).toBe(false);
  });

  it("W-112 a baseboard's own colour wins over its side's, and keeps the side's shininess", () => {
    const glossRed = {
      color: "#FF0000",
      textureId: null,
      placement: null,
      mirrorForLeftSide: false,
      shininess: 0.6,
    };
    const walls = withSkirting(
      SOUTH,
      { left: { ...board, color: "#FFFFFF" }, right: null },
      { finishes: { left: glossRed, right: null, top: null } },
    );
    const parts = buildWalls(walls, project.openings, ctx);
    expect(partOf(parts, SOUTH, "skirting-left")?.materialKey).toBe("wall-skirting|#FFFFFF|0.6");
  });

  it("W-107 W-113 gives the plan the same strips the model builds: one ring per unbroken stretch", () => {
    const walls = withSkirting(SOUTH, { left: board, right: null });
    const outlines = skirtingOutlines(walls, project.openings, ctx);
    expect(outlines.map((o) => [o.wallId, o.side, o.rings.length])).toEqual([[SOUTH, "left", 2]]);
    // the two rings together are the top of the 3D strip: trapezoids 3500 and 3480 long, 20 deep, twice
    const area = (outlines[0]?.rings ?? []).reduce((sum, ring) => sum + Math.abs(poly.area(ring)), 0);
    expect(area).toBeCloseTo(2 * ((3500 + 3480) / 2) * 20, 6);
    // and nothing crosses the door
    for (const ring of outlines[0]?.rings ?? [])
      expect(ring.some((p) => p.x > 3550.01 && p.x < 4449.99)).toBe(false);
    expect(skirtingOutlines(project.walls, project.openings, ctx)).toEqual([]);
  });
});

// ADR-014 D7 step 3, PRD P2-6: a shaped opening cuts its product's cut-out path out of both faces of its wall
// and gets a reveal through the thickness instead of sill, head and jambs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cutOutRings, cutOutTolerance } from "@fpv/catalog";
import { defaultOpening, defaultWall, type Level, type Opening, Project, type Wall } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import {
  buildWalls,
  type CutOutSpec,
  cutOutSource,
  type GeometryPart,
  partArea,
  partBounds,
} from "../src/index.js";

const fixtureDir = fileURLToPath(new URL("../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const project = Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));
const level = project.levels[0] as Level;
const H = level.height;
const ctx = { level, isLowest: true, isHighest: true };

const ARCH = "M0,1 V0.5 A0.5,0.5 0 0 1 1,0.5 V1 Z";
const specs: Record<string, CutOutSpec> = {
  arch: { cutOutPath: ARCH },
  wedge: { cutOutPath: "M0,1 V0 L1,1 Z" },
  chamfer: { cutOutPath: "M0,1 L0,0 L0.5,0 L1,0.5 L1,1 Z" },
  middle: { embed: { width: 0.5, left: 0.25 } },
  broken: { cutOutPath: "M0,0 Zzz" },
  square: { cutOutPath: "M0,0 v1 h1 v-1 z" },
};
const wall = defaultWall("wall_r00001", level.id, { x: 0, y: 0 }, { x: 4000, y: 0 }, { thickness: 200 });

function door(productId: string, over: Partial<Opening> = {}): Opening {
  return defaultOpening("opening_r00001", level.id, wall.id, "door", {
    position: 0.5,
    width: 1000,
    height: 2000,
    sill: 0,
    productId,
    ...over,
  });
}

function build(openings: Opening[], w: Wall = wall) {
  const cutOuts = cutOutSource((id) => specs[id]);
  return { parts: buildWalls([w], openings, { ...ctx, cutOuts }), cutOuts };
}

const part = (parts: GeometryPart[], id: string, kind: string) =>
  parts.find((p) => p.entityId === id && p.part === kind);
const area = (p: GeometryPart | undefined) => partArea(p as GeometryPart);

describe("reveals for shaped openings (PRD P2-6)", () => {
  it("O-069 O-073 O-076 an arched door cuts its arch out of both faces; a reveal replaces sill, head and jambs", () => {
    const { parts } = build([door("arch")]);
    const hole = 1000 * 1000 + (Math.PI * 500 * 1000) / 2; // lower half rectangle plus a half ellipse 500 x 1000
    expect(area(part(parts, wall.id, "wall-left"))).toBeCloseTo((4000 * H - hole) / 1e6, 2);
    expect(area(part(parts, wall.id, "wall-right"))).toBeCloseTo((4000 * H - hole) / 1e6, 2);
    for (const kind of ["opening-sill", "opening-head", "opening-jamb"])
      expect(part(parts, "opening_r00001", kind)).toBeUndefined();
    const reveal = part(parts, "opening_r00001", "opening-reveal");
    // two 1000 mm verticals and the half ellipse (Ramanujan), through the 200 mm thickness; no face on the floor line
    const a = 500;
    const b = 1000;
    const halfEllipse = (Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)))) / 2;
    expect(area(reveal)).toBeCloseTo(((2000 + halfEllipse) * 200) / 1e6, 2);
    const bounds = partBounds(reveal as GeometryPart);
    expect(bounds.max[2] - bounds.min[2]).toBeCloseTo(0.2, 6);
    expect(bounds.max[1]).toBeCloseTo(2, 3);
    expect(cutOutRings("M0,0 v1 h1 v-1 z")).toEqual([
      [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 1, y: 0 },
      ],
    ]);
    // the default square is the rectangle: jambs, no reveal
    const square = build([door("square")]).parts;
    expect(part(square, "opening_r00001", "opening-jamb")).toBeDefined();
    expect(part(square, "opening_r00001", "opening-reveal")).toBeUndefined();
  });

  it("O-074 curves are flattened to 0.5 mm on the opening's larger side", () => {
    expect(cutOutTolerance(100, 200)).toBe(0.0025);
    const rings = cutOutRings(ARCH, 0.0025) as { x: number; y: number }[][];
    expect(rings).toHaveLength(1);
    for (const p of rings[0] ?? [])
      if (p.y < 0.5) expect(Math.abs(Math.hypot(p.x - 0.5, p.y - 0.5) - 0.5)).toBeLessThan(1e-9);
    let twice = 0;
    const r = rings[0] ?? [];
    for (let i = 0; i < r.length; i += 1) {
      const p = r[i] as { x: number; y: number };
      const q = r[(i + 1) % r.length] as { x: number; y: number };
      twice += p.x * q.y - q.x * p.y;
    }
    expect(Math.abs(twice / 2)).toBeCloseTo(0.5 + Math.PI / 8, 2);
    expect(r.length).toBeGreaterThan(8);
  });

  it("O-075 an embed sub-rectangle cuts only its part of the opening's box", () => {
    const { parts } = build([door("middle")]);
    expect(area(part(parts, wall.id, "wall-left"))).toBeCloseTo((4000 * H - 500 * 2000) / 1e6, 3);
    // two 2000 mm jambs and the 500 mm head, through 200 mm
    expect(area(part(parts, "opening_r00001", "opening-reveal"))).toBeCloseTo((4500 * 200) / 1e6, 3);
  });

  it("O-079 reversed, C-050: an invalid path cuts the plain rectangle, never an offset one", () => {
    const { parts } = build([door("broken")]);
    expect(area(part(parts, wall.id, "wall-left"))).toBeCloseTo((4000 * H - 1000 * 2000) / 1e6, 3);
    expect(part(parts, "opening_r00001", "opening-jamb")).toBeDefined();
    expect(part(parts, "opening_r00001", "opening-reveal")).toBeUndefined();
  });

  it("O-080 O-081 openings sharing a product and size parse the path once; the path comes with the snapshot, so the first build is final", () => {
    const { parts, cutOuts } = build([
      door("arch", { position: 0.25 }),
      { ...door("arch", { position: 0.75 }), id: "opening_r00002" },
    ]);
    expect(cutOuts.stats.parses).toBe(1);
    expect(part(parts, "opening_r00001", "opening-reveal")).toBeDefined();
    expect(part(parts, "opening_r00002", "opening-reveal")).toBeDefined();
  });

  it("O-070 O-071 O-082 the shape follows its wall on both faces; an arc wall cuts a rectangle", () => {
    const { parts } = build([door("wedge")]);
    // a right triangle is half the box on each face
    expect(area(part(parts, wall.id, "wall-left"))).toBeCloseTo((4000 * H - 1e6) / 1e6, 3);
    expect(area(part(parts, wall.id, "wall-right"))).toBeCloseTo((4000 * H - 1e6) / 1e6, 3);
    const arcWall = { ...wall, arcExtent: 90 };
    const arc = build([door("arch")], arcWall).parts;
    expect(part(arc, "opening_r00001", "opening-jamb")).toBeDefined();
    expect(part(arc, "opening_r00001", "opening-reveal")).toBeUndefined();
  });

  it("O-072 a mirrored opening mirrors its shape", () => {
    const apexX = (mirrored: boolean) => {
      const reveal = part(build([door("wedge", { mirrored })]).parts, "opening_r00001", "opening-reveal");
      const pos = (reveal as GeometryPart).positions;
      let best = { y: -Infinity, x: 0 };
      for (let i = 0; i < pos.length; i += 3)
        if ((pos[i + 1] as number) > best.y + 1e-6) best = { y: pos[i + 1] as number, x: pos[i] as number };
      return best.x;
    };
    expect(apexX(false)).toBeCloseTo(1.5, 3); // the vertical edge at the opening's start
    expect(apexX(true)).toBeCloseTo(2.5, 3);
  });

  it("O-054 O-073 edges on the wall's top line get no reveal face", () => {
    const { parts } = build([door("chamfer", { height: H })]);
    // left vertical H, chamfer from (500, H) to (1000, H/2), right vertical H/2; the top edge lies on the wall top
    const edges = H + Math.hypot(500, H / 2) + H / 2;
    expect(area(part(parts, "opening_r00001", "opening-reveal"))).toBeCloseTo((edges * 200) / 1e6, 3);
  });
});

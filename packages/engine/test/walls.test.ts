import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultOpening, defaultWall, type Level, Project } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { buildWalls, partArea, partBounds, wallElevations } from "../src/index.js";

const fixtureDir = fileURLToPath(new URL("../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const project = Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));
const level = project.levels[0] as Level;
const ctx = { level, isLowest: true, isHighest: true };
const L = level.id;

const partsOf = (parts: ReturnType<typeof buildWalls>, id: string, kind: string) =>
  parts.filter((p) => p.entityId === id && p.part === kind);

describe("wall faces", () => {
  const parts = buildWalls(project.walls, project.openings, ctx);

  it("W-106 W-119 every wall gets left, right, top and two end caps", () => {
    for (const w of project.walls) {
      expect(partsOf(parts, w.id, "wall-left")).toHaveLength(1);
      expect(partsOf(parts, w.id, "wall-right")).toHaveLength(1);
      expect(partsOf(parts, w.id, "wall-top")).toHaveLength(1);
      expect(partsOf(parts, w.id, "wall-end-start")).toHaveLength(1);
      expect(partsOf(parts, w.id, "wall-end-end")).toHaveLength(1);
    }
  });

  it("O-051 O-052 O-065 O-066 the door cuts both faces of its wall; no sill at sill 0; head and jambs exist", () => {
    const left = partsOf(parts, "wall_000001", "wall-left")[0];
    const right = partsOf(parts, "wall_000001", "wall-right")[0];
    // mitred left side runs (50,50)..(7950,50): 7900 mm long; minus the 900 x 2100 door
    expect(partArea(left as NonNullable<typeof left>)).toBeCloseTo((7900 * 2700 - 900 * 2100) / 1e6, 3);
    // outer (right) side runs (-50,-50)..(8050,-50): 8100 mm long
    expect(partArea(right as NonNullable<typeof right>)).toBeCloseTo((8100 * 2700 - 900 * 2100) / 1e6, 3);
    expect(partsOf(parts, "opening_000001", "opening-sill")).toHaveLength(0);
    expect(partsOf(parts, "opening_000001", "opening-head")).toHaveLength(1);
    const jambs = partsOf(parts, "opening_000001", "opening-jamb")[0] as NonNullable<(typeof parts)[number]>;
    expect(jambs.indices.length / 3).toBe(4); // two quads
    expect(partArea(jambs)).toBeCloseTo((2 * 100 * 2100) / 1e6, 3);
  });

  it("W-097 W-098 W-104 lowest and highest level: bottom at the elevation, top at the wall height with no shifts; an upper level wall already runs below its slab so a low door needs no nudge", () => {
    const left = partsOf(parts, "wall_000002", "wall-left")[0] as NonNullable<(typeof parts)[number]>;
    const b = partBounds(left);
    expect(b.min[1]).toBeCloseTo(0, 6);
    expect(b.max[1]).toBeCloseTo(2.7, 6);
    const el = wallElevations(project.walls[0] as (typeof project.walls)[number], {
      level: { ...level, elevation: 3000, floorThickness: 300 },
      isLowest: false,
      isHighest: false,
    });
    expect(el.bottom).toBe(3000 - 300 + 1);
    expect(el.top(0)).toBe(3000 + 2700 + 1);
    const upperLevel = { ...level, id: "level_000001", elevation: 3000, floorThickness: 300, index: 1 };
    const w = defaultWall("wall_zz0009", upperLevel.id, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const lowDoor = defaultOpening("opening_zz0009", upperLevel.id, w.id, "door", {
      position: 0.5,
      width: 900,
      height: 2100,
      sill: 50,
    });
    const up = buildWalls([w], [lowDoor], { level: upperLevel, isLowest: false, isHighest: true });
    const face = partsOf(up, w.id, "wall-left")[0] as NonNullable<(typeof parts)[number]>;
    expect(partBounds(face).min[1]).toBeCloseTo((3000 - 300 + 1) / 1000, 6);
    expect(partsOf(up, lowDoor.id, "opening-sill")).toHaveLength(1);
  });

  it("W-108 W-109 W-110 the top face covers the footprint and end caps are full height", () => {
    const top = partsOf(parts, "wall_000002", "wall-top")[0] as NonNullable<(typeof parts)[number]>;
    // wall 2 footprint after mitres is a trapezoid: inner side 2900 (50..2950), outer side 3100 (-50..3050)
    expect(partArea(top)).toBeCloseTo((100 * (2900 + 3100)) / 2 / 1e6, 3);
    // a mitred end cap spans the diagonal of the corner (100 * sqrt 2 wide) and the full height
    const cap = partsOf(parts, "wall_000003", "wall-end-end")[0] as NonNullable<(typeof parts)[number]>;
    expect(partArea(cap)).toBeCloseTo((Math.hypot(100, 100) * 2700) / 1e6, 3);
    const free = buildWalls(
      [{ ...(project.walls[2] as (typeof project.walls)[number]), joins: { start: null, end: null } }],
      [],
      ctx,
    );
    const freeCap = partsOf(free, "wall_000003", "wall-end-end")[0] as NonNullable<(typeof parts)[number]>;
    expect(partArea(freeCap)).toBeCloseTo((100 * 2700) / 1e6, 3);
  });
});

describe("openings and slopes", () => {
  it("O-053 O-057 O-067 O-068 a window has a sill and a head; below and above bands exist", () => {
    const w = defaultWall("wall_zz0001", L, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const win = defaultOpening("opening_zz0001", L, w.id, "window", {
      position: 0.5,
      width: 1200,
      height: 1200,
      sill: 900,
    });
    const parts = buildWalls([w], [win], ctx);
    expect(partsOf(parts, win.id, "opening-sill")).toHaveLength(1);
    expect(partsOf(parts, win.id, "opening-head")).toHaveLength(1);
    const left = partsOf(parts, w.id, "wall-left")[0] as NonNullable<(typeof parts)[number]>;
    expect(partArea(left)).toBeCloseTo((4000 * 2700 - 1200 * 1200) / 1e6, 3);
    expect(left.indices.length / 3).toBe(8); // four bands: left, below, above, right
  });

  it("O-054 W-123 an opening reaching the top leaves no head and no band above it", () => {
    const w = defaultWall("wall_zz0002", L, { x: 0, y: 0 }, { x: 4000, y: 0 }, { height: 2100 });
    const door = defaultOpening("opening_zz0002", L, w.id, "door", {
      position: 0.5,
      width: 900,
      height: 2100,
    });
    const parts = buildWalls([w], [door], ctx);
    expect(partsOf(parts, door.id, "opening-head")).toHaveLength(0);
    const left = partsOf(parts, w.id, "wall-left")[0] as NonNullable<(typeof parts)[number]>;
    expect(left.indices.length / 3).toBe(4); // only the two side bands
  });

  it("W-093 W-102 W-103 a sloped top follows the height at end; the head is clipped under a low top", () => {
    const w = defaultWall(
      "wall_zz0003",
      L,
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
      { height: 2700, heightAtEnd: 1500 },
    );
    const parts = buildWalls([w], [], ctx);
    const left = partsOf(parts, w.id, "wall-left")[0] as NonNullable<(typeof parts)[number]>;
    expect(partArea(left)).toBeCloseTo((4000 * (2700 + 1500)) / 2 / 1e6, 3);
    const endCap = partsOf(parts, w.id, "wall-end-end")[0] as NonNullable<(typeof parts)[number]>;
    expect(partBounds(endCap).max[1]).toBeCloseTo(1.5, 6);
  });

  it("W-111 W-125 W-126 an arc wall produces one band per tessellation segment, a top ring, and cuts its openings by arc distance", () => {
    const w = defaultWall("wall_zz0004", L, { x: 0, y: 0 }, { x: 4000, y: 0 }, { arcExtent: 90 });
    const parts = buildWalls([w], [], ctx);
    const left = partsOf(parts, w.id, "wall-left")[0] as NonNullable<(typeof parts)[number]>;
    expect(left.indices.length / 3).toBeGreaterThan(8);
    const top = partsOf(parts, w.id, "wall-top")[0] as NonNullable<(typeof parts)[number]>;
    expect(top.indices.length).toBeGreaterThan(0);
    const door = defaultOpening("opening_zz0004", L, w.id, "door", {
      position: 0.5,
      width: 900,
      height: 2100,
    });
    const cut = buildWalls([w], [door], ctx);
    expect(partsOf(cut, door.id, "opening-head")).toHaveLength(1);
    const jambs = partsOf(cut, door.id, "opening-jamb")[0] as NonNullable<(typeof parts)[number]>;
    expect(jambs.indices.length / 3).toBe(4);
    // the door is 900 mm wide on the centreline; a positive extent bulges left, so the left side is the
    // outer arc (radius 2828 + 50) and loses proportionally more (radial jambs)
    const fullLeft = partArea(partsOf(parts, w.id, "wall-left")[0] as NonNullable<(typeof parts)[number]>);
    const cutLeft = partArea(partsOf(cut, w.id, "wall-left")[0] as NonNullable<(typeof parts)[number]>);
    const outer = 900 * ((2828.4 + 50) / 2828.4);
    expect(fullLeft - cutLeft).toBeCloseTo((outer * 2100) / 1e6, 1); // tessellation chords shave a little
  });

  it("O-055 O-056 an opening head above a sloping top is clipped to the top; no lintel is generated where none fits", () => {
    const w = defaultWall(
      "wall_zz0006",
      L,
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
      { height: 2700, heightAtEnd: 1500 },
    );
    // window near the low end: head at 2400 is above the top there (about 1650 mm)
    const win = defaultOpening("opening_zz0006", L, w.id, "window", {
      position: 0.875,
      width: 1000,
      height: 1500,
      sill: 900,
    });
    const parts = buildWalls([w], [win], ctx);
    expect(partsOf(parts, win.id, "opening-head")).toHaveLength(0);
    expect(partsOf(parts, win.id, "opening-sill")).toHaveLength(1);
    const jambs = partsOf(parts, win.id, "opening-jamb")[0] as NonNullable<(typeof parts)[number]>;
    expect(partBounds(jambs).max[1]).toBeLessThanOrEqual(1.5 + ((2700 - 1500) * (1 - 0.75)) / 1000 + 1e-6);
    const left = partsOf(parts, w.id, "wall-left")[0] as NonNullable<(typeof parts)[number]>;
    // no band above the opening: face = full trapezoid minus the part of the opening under the top
    const topAt = (u: number) => 2700 - (1200 * u) / 4000;
    const removed = ((Math.min(2400, topAt(3000)) - 900 + (Math.min(2400, topAt(4000)) - 900)) / 2) * 1000;
    expect(partArea(left)).toBeCloseTo((4000 * (2700 + 1500)) / 2 / 1e6 - removed / 1e6, 2);
  });

  it("W-134 walls on another level are not built", () => {
    const w = defaultWall("wall_zz0005", "level_zzzzzz", { x: 0, y: 0 }, { x: 4000, y: 0 });
    expect(buildWalls([w], [], ctx)).toHaveLength(0);
  });
});

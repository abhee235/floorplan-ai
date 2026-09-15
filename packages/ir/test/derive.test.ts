import { describe, expect, it } from "vitest";
import { defaultItem, defaultOpening, defaultWall, derive, type Level, type Wall } from "../src/index.js";
import { EXPECTED, fixture, LEVEL } from "./helpers.js";

const level = (p: ReturnType<typeof fixture>): Level => p.levels[0] as Level;
const wall = (p: ReturnType<typeof fixture>, id: string): Wall => p.walls.find((w) => w.id === id) as Wall;

describe("walls", () => {
  it("fixture wall lengths and compass sides match expected.json", () => {
    const p = fixture();
    for (const [id, len] of Object.entries(EXPECTED.wallLengthsMm))
      expect(derive.wallLength(wall(p, id))).toBe(len);
    for (const [id, side] of Object.entries(EXPECTED.wallCompassLeftSide)) {
      expect(derive.wallCompassSide(wall(p, id), "left", p.meta.north)).toBe(side);
    }
  });

  it("W-092 R-123 a null height falls back to the level height", () => {
    const p = fixture();
    expect(derive.wallHeight(wall(p, "wall_000001"), level(p))).toBe(2700);
    wall(p, "wall_000001").height = 2400;
    expect(derive.wallHeight(wall(p, "wall_000001"), level(p))).toBe(2400);
  });

  it("W-093 W-094 W-095 trapezoidal walls and max height", () => {
    const w = defaultWall(
      "wall_zz0001",
      LEVEL,
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { height: 2500, heightAtEnd: 1500 },
    );
    const l = {
      id: LEVEL,
      name: "L",
      elevation: 0,
      height: 2700,
      floorThickness: 300,
      index: 0,
      viewable: true,
      backgroundImage: null,
    };
    expect(derive.isTrapezoidal(w)).toBe(true);
    expect(derive.wallMaxHeight(w, l)).toBe(2500);
    expect(derive.isTrapezoidal({ ...w, heightAtEnd: null })).toBe(false);
  });

  it("W-096 R-113 F-016 F-017 level membership is the explicit levelId (reversed: no height-overlap rule)", () => {
    const p = fixture();
    expect(derive.levelOf(p, "level_000000")?.id).toBe("level_000000");
    expect(derive.levelOf(p, "level_zzzzzz")).toBeNull();
  });

  it("W-001 W-002 W-003 unjoined footprint order is left-start, left-end, right-end, right-start with y up", () => {
    const w = defaultWall("wall_zz0002", LEVEL, { x: 0, y: 0 }, { x: 100, y: 0 }, { thickness: 10 });
    expect(derive.wallFootprintUnjoined(w)).toEqual([
      { x: 0, y: 5 },
      { x: 100, y: 5 },
      { x: 100, y: -5 },
      { x: 0, y: -5 },
    ]);
    const up = defaultWall("wall_zz0003", LEVEL, { x: 0, y: 0 }, { x: 0, y: 100 }, { thickness: 10 });
    expect(derive.wallFootprintUnjoined(up)[0]).toEqual({ x: -5, y: 0 });
  });

  it("W-049 W-051 arc walls: centre, radius, and arc length versus chord", () => {
    const w = defaultWall("wall_zz0004", LEVEL, { x: 0, y: 0 }, { x: 1000, y: 0 }, { arcExtent: 180 });
    const p = derive.arcParams(w);
    expect(p?.radius).toBeCloseTo(500, 6);
    expect(p?.centre.x).toBeCloseTo(500, 6);
    expect(Math.abs(p?.centre.y ?? 1)).toBeLessThan(1e-6);
    expect(derive.wallArcLength(w)).toBeCloseTo(Math.PI * 500, 6);
    expect(derive.wallLength(w)).toBe(1000);
  });

  it("compassOf respects a rotated north", () => {
    expect(derive.compassOf(90, 90)).toBe("north");
    expect(derive.compassOf(0, 90)).toBe("east");
    expect(derive.compassOf(180, 90)).toBe("west");
    expect(derive.compassOf(270, 90)).toBe("south");
    expect(derive.compassOf(0, 0)).toBe("north");
  });
});

describe("openings", () => {
  it("openingAlongInterval and centre on the fixture door", () => {
    const p = fixture();
    const o = p.openings[0] as (typeof p.openings)[number];
    const w = wall(p, o.wallId);
    expect(derive.openingAlongInterval(o, w)).toEqual({ from: 3550, to: 4450 });
    expect(derive.openingCentre(o, w)).toEqual({ x: 4000, y: 0 });
  });

  it("O-051 the opening footprint spans the wall thickness plus 1 mm each side", () => {
    const p = fixture();
    const o = defaultOpening("opening_zz0001", LEVEL, "wall_000001", "door", { position: 0.5, width: 1000 });
    const fp = derive.openingFootprint(o, wall(p, "wall_000001"));
    expect(fp).toEqual([
      { x: 3500, y: 51 },
      { x: 4500, y: 51 },
      { x: 4500, y: -51 },
      { x: 3500, y: -51 },
    ]);
  });
});

describe("rooms", () => {
  it("R-006 R-131 the expected room polygon has the expected area", () => {
    const p = fixture();
    const room = {
      ...p,
      polygon: EXPECTED.detectedRoomPolygonWithoutThreshold,
    };
    const r = { ...p.rooms[0], polygon: room.polygon, holes: [] } as unknown as (typeof p.rooms)[number];
    expect(derive.roomArea({ ...r, polygon: room.polygon, holes: [] })).toBe(
      EXPECTED.detectedRoomAreaMm2WithoutThreshold,
    );
  });

  it("R-012 the label anchor is inside the polygon and applies the offset", () => {
    const p = fixture();
    const r = {
      id: "room_zz0001",
      levelId: LEVEL,
      name: null,
      polygon: EXPECTED.detectedRoomPolygonWithoutThreshold,
      holes: [],
      purpose: "meeting" as const,
      capacity: null,
      ceilingHeight: null,
      finishes: { floor: null, ceiling: null },
      floorVisible: true,
      ceilingVisible: true,
      label: { offset: { x: 100, y: 0 }, angle: 0, showArea: true },
      source: "manual" as const,
      boundingWallIds: [],
      properties: {},
    };
    const anchor = derive.roomLabelAnchor(r);
    expect(derive.roomContains(r, { x: anchor.x - 100, y: anchor.y })).toBe(true);
    expect(p.meta.units).toBe("mm");
  });

  it("containingRoom picks the smallest room containing the point", () => {
    const p = fixture();
    const big = [
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
      { x: 4000, y: 4000 },
      { x: 0, y: 4000 },
    ];
    const small = [
      { x: 1000, y: 1000 },
      { x: 2000, y: 1000 },
      { x: 2000, y: 2000 },
      { x: 1000, y: 2000 },
    ];
    const mk = (id: string, polygon: { x: number; y: number }[]) => ({
      id,
      levelId: LEVEL,
      name: null,
      polygon,
      holes: [],
      purpose: "other" as const,
      capacity: null,
      ceilingHeight: null,
      finishes: { floor: null, ceiling: null },
      floorVisible: true,
      ceilingVisible: true,
      label: { offset: { x: 0, y: 0 }, angle: 0, showArea: true },
      source: "manual" as const,
      boundingWallIds: [],
      properties: {},
    });
    p.rooms.push(mk("room_zz0002", big), mk("room_zz0003", small));
    expect(derive.containingRoom(p, LEVEL, { x: 1500, y: 1500 })?.id).toBe("room_zz0003");
    expect(derive.containingRoom(p, LEVEL, { x: 3500, y: 3500 })?.id).toBe("room_zz0002");
    expect(derive.containingRoom(p, LEVEL, { x: 9000, y: 9000 })).toBeNull();
  });
});

describe("items", () => {
  const box = {
    kind: "recipe" as const,
    recipe: { kind: "box" as const, size: { w: 400, d: 200, h: 100 }, label: "b" },
  };

  it("F-006 F-007 footprint is centred on position with corners back-left, back-right, front-right, front-left", () => {
    const item = defaultItem("item_zz0001", LEVEL, box, { x: 1000, y: 1000 });
    expect(derive.itemFootprint(item, { w: 400, d: 200, h: 100 })).toEqual([
      { x: 800, y: 1100 },
      { x: 1200, y: 1100 },
      { x: 1200, y: 900 },
      { x: 800, y: 900 },
    ]);
    const rotated = derive.itemFootprint({ ...item, rotation: 90 }, { w: 400, d: 200, h: 100 });
    expect(rotated[0]?.x).toBeCloseTo(900, 6);
    expect(rotated[0]?.y).toBeCloseTo(800, 6);
  });

  it("F-012 ground elevation adds the level elevation and allows negatives", () => {
    const item = defaultItem("item_zz0002", LEVEL, box, { x: 0, y: 0 }, { elevation: -10 });
    const l = {
      id: LEVEL,
      name: "L",
      elevation: 250,
      height: 2700,
      floorThickness: 300,
      index: 0,
      viewable: true,
      backgroundImage: null,
    };
    expect(derive.itemGroundElevation(item, l)).toBe(240);
  });

  it("F-019 a corner hit must be closer to that corner than to its neighbours", () => {
    const fp = [
      { x: 0, y: 0 },
      { x: 2000, y: 0 },
      { x: 2000, y: 2000 },
      { x: 0, y: 2000 },
    ];
    expect(derive.footprintCornerAt(fp, { x: 1000, y: 0 }, 1500)).toBe(-1); // midway between two corners
    expect(derive.footprintCornerAt(fp, { x: 100, y: 50 }, 200)).toBe(0);
  });

  it("F-020 parallel-to-wall tolerance is 1 degree straight and 10 degrees on arcs; zero-length never", () => {
    const w = defaultWall("wall_zz0005", LEVEL, { x: 0, y: 0 }, { x: 1000, y: 0 });
    const item = defaultItem("item_zz0003", LEVEL, box, { x: 0, y: 0 });
    expect(derive.isParallelToWall({ ...item, rotation: 0.5 }, w)).toBe(true);
    expect(derive.isParallelToWall({ ...item, rotation: 180.5 }, w)).toBe(true);
    expect(derive.isParallelToWall({ ...item, rotation: 5 }, w)).toBe(false);
    expect(derive.isParallelToWall({ ...item, rotation: 5 }, { ...w, arcExtent: 90 })).toBe(true);
    expect(derive.isParallelToWall(item, { ...w, end: { x: 0, y: 0 } })).toBe(false);
  });

  it("recipe sizes: display from diagonal, cylinder from diameter", () => {
    const d = derive.recipeSize({ kind: "display", diagonalIn: 75, bezelMm: 0 });
    expect(d.w).toBe(1660);
    expect(d.h).toBe(934);
    expect(derive.recipeSize({ kind: "cylinder", diameter: 300, height: 400, label: "c" })).toEqual({
      w: 300,
      d: 300,
      h: 400,
    });
  });
});

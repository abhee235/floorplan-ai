import { describe, expect, it } from "vitest";
import {
  defaultItem,
  defaultRoom,
  defaultWall,
  type NormalizeNote,
  normalizeDeg,
  normalizeItem,
  normalizeProject,
  normalizeRoom,
  normalizeWall,
} from "../src/index.js";
import { fixture, LEVEL } from "./helpers.js";

describe("angles", () => {
  it("F-001 F-002 F-003 R-020 angles normalise into [0, 360) and idempotently", () => {
    expect(normalizeDeg(-90)).toBe(270);
    expect(normalizeDeg(360)).toBe(0);
    expect(normalizeDeg(725)).toBe(5);
    expect(normalizeDeg(normalizeDeg(-0.5))).toBe(normalizeDeg(-0.5));
    const item = defaultItem(
      "item_zz0001",
      LEVEL,
      { kind: "recipe", recipe: { kind: "box", size: { w: 1, d: 1, h: 1 }, label: "b" } },
      { x: 0, y: 0 },
    );
    // rotation is validated by the schema, so normalisation is applied to raw values before parse in commands
    expect(normalizeItem({ ...item, rotation: 0 }).rotation).toBe(0);
  });
});

describe("walls", () => {
  it("W-050 an arc extent of exactly zero is stored as null", () => {
    const w = defaultWall("wall_zz0001", LEVEL, { x: 0, y: 0 }, { x: 1000, y: 0 }, { arcExtent: 0 });
    expect(normalizeWall(w).arcExtent).toBeNull();
    const w2 = defaultWall("wall_zz0002", LEVEL, { x: 0, y: 0 }, { x: 1000, y: 0 }, { arcExtent: 90 });
    expect(normalizeWall(w2).arcExtent).toBe(90);
  });

  it("W-094 heightAtEnd equal to height is stored as null", () => {
    const w = defaultWall(
      "wall_zz0003",
      LEVEL,
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { height: 2500, heightAtEnd: 2500 },
    );
    expect(normalizeWall(w).heightAtEnd).toBeNull();
    const sloped = defaultWall(
      "wall_zz0004",
      LEVEL,
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { height: 2500, heightAtEnd: 2000 },
    );
    expect(normalizeWall(sloped).heightAtEnd).toBe(2000);
  });
});

describe("rooms", () => {
  it("R-011 duplicate points are removed with a note, never stored", () => {
    const notes: NormalizeNote[] = [];
    const r = defaultRoom("room_zz0001", LEVEL, [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 },
      { x: 0, y: 0 },
    ]);
    const n = normalizeRoom(r, notes);
    expect(n.polygon).toHaveLength(4);
    expect(notes.map((x) => x.code)).toContain("room.points-deduped");
  });

  it("a clockwise polygon is reoriented counter-clockwise and holes clockwise, with notes", () => {
    const notes: NormalizeNote[] = [];
    const r = defaultRoom(
      "room_zz0002",
      LEVEL,
      [
        { x: 0, y: 0 },
        { x: 0, y: 1000 },
        { x: 1000, y: 1000 },
        { x: 1000, y: 0 },
      ],
      {
        holes: [
          [
            { x: 200, y: 200 },
            { x: 400, y: 200 },
            { x: 400, y: 400 },
            { x: 200, y: 400 },
          ],
        ],
      },
    );
    const n = normalizeRoom(r, notes);
    expect(n.polygon[0]).toEqual({ x: 1000, y: 0 });
    expect(n.polygon[1]).toEqual({ x: 1000, y: 1000 });
    expect(notes.map((x) => x.code)).toEqual(
      expect.arrayContaining(["room.reoriented", "room.hole-reoriented"]),
    );
  });
});

describe("project", () => {
  it("R-106 levels are sorted by elevation then index", () => {
    const p = fixture();
    const base = p.levels[0] as (typeof p.levels)[number];
    p.levels = [
      { ...base, id: "level_000003", elevation: 3000, index: 0 },
      { ...base, id: "level_000002", elevation: 0, index: 1 },
      base,
    ];
    const n = normalizeProject(p);
    expect(n.levels.map((l) => l.id)).toEqual(["level_000000", "level_000002", "level_000003"]);
  });
});

import { defaultLevel, defaultRoom, poly } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { buildRooms, ceilingElevation, partArea, partBounds } from "../src/index.js";

const level = defaultLevel("level_000000", { elevation: 0, height: 2700, floorThickness: 300 });
const upper = defaultLevel("level_000001", { elevation: 3000, height: 2700, floorThickness: 300 });
const L = level.id;
const Lshape = [
  { x: 50, y: 50 },
  { x: 7950, y: 50 },
  { x: 7950, y: 2950 },
  { x: 4950, y: 2950 },
  { x: 4950, y: 4950 },
  { x: 50, y: 4950 },
];
const kind = (parts: ReturnType<typeof buildRooms>, id: string, k: string) =>
  parts.filter((p) => p.entityId === id && p.part === k);

describe("floors and ceilings", () => {
  it("R-061 R-062 R-075 R-076 R-077 the floor triangulates to the room area at the level elevation, facing up", () => {
    const r = defaultRoom("room_zz0001", L, Lshape);
    const parts = buildRooms([r], { level, isLowest: true });
    const floor = kind(parts, r.id, "floor")[0] as NonNullable<(typeof parts)[number]>;
    expect(partArea(floor)).toBeCloseTo(32.71, 3);
    expect(partBounds(floor).max[1]).toBeCloseTo(0, 6);
    expect(floor.normals[1]).toBe(1);
  });

  it("R-068 R-069 R-070 R-071 R-080 reversed: the ceiling is at the level height or the room override, facing down", () => {
    const r = defaultRoom("room_zz0002", L, Lshape);
    const parts = buildRooms([r], { level, isLowest: true });
    const ceiling = kind(parts, r.id, "ceiling")[0] as NonNullable<(typeof parts)[number]>;
    expect(partBounds(ceiling).min[1]).toBeCloseTo(2.7, 6);
    expect(ceiling.normals[1]).toBe(-1);
    expect(ceilingElevation({ ...r, ceilingHeight: 2400 }, level)).toBe(2400);
    const low = buildRooms([{ ...r, ceilingHeight: 2400 }], { level, isLowest: true });
    expect(
      partBounds(kind(low, r.id, "ceiling")[0] as NonNullable<(typeof parts)[number]>).min[1],
    ).toBeCloseTo(2.4, 6);
  });

  it("R-063 R-064 R-084 no underside or slab side on the lowest level; both on an upper level", () => {
    const r = defaultRoom("room_zz0003", L, Lshape);
    const lowest = buildRooms([r], { level, isLowest: true });
    expect(kind(lowest, r.id, "floor-bottom")).toHaveLength(0);
    expect(kind(lowest, r.id, "floor-side")).toHaveLength(0);
    const up = buildRooms([{ ...r, levelId: upper.id }], { level: upper, isLowest: false });
    const bottom = kind(up, r.id, "floor-bottom")[0] as NonNullable<(typeof lowest)[number]>;
    expect(partBounds(bottom).max[1]).toBeCloseTo(2.7, 6);
    const side = kind(up, r.id, "floor-side")[0] as NonNullable<(typeof lowest)[number]>;
    expect(partArea(side)).toBeCloseTo((poly.perimeter(Lshape) * 300) / 1e6, 3);
  });

  it("R-065 R-066 R-067 a later overlapping room subtracts the earlier one from its floor; the earlier keeps its area", () => {
    const a = defaultRoom("room_zz0004", L, [
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
      { x: 4000, y: 4000 },
      { x: 0, y: 4000 },
    ]);
    const b = defaultRoom("room_zz0005", L, [
      { x: 2000, y: 2000 },
      { x: 6000, y: 2000 },
      { x: 6000, y: 6000 },
      { x: 2000, y: 6000 },
    ]);
    const parts = buildRooms([a, b], { level, isLowest: true });
    expect(partArea(kind(parts, a.id, "floor")[0] as NonNullable<(typeof parts)[number]>)).toBeCloseTo(16, 3);
    expect(partArea(kind(parts, b.id, "floor")[0] as NonNullable<(typeof parts)[number]>)).toBeCloseTo(12, 3);
  });

  it("R-078 R-079 holes are subtracted and need no bridging; floor and ceiling visibility flags are honoured", () => {
    const r = defaultRoom(
      "room_zz0006",
      L,
      [
        { x: 0, y: 0 },
        { x: 3000, y: 0 },
        { x: 3000, y: 3000 },
        { x: 0, y: 3000 },
      ],
      {
        holes: [
          poly.reversed([
            { x: 1000, y: 1000 },
            { x: 2000, y: 1000 },
            { x: 2000, y: 2000 },
            { x: 1000, y: 2000 },
          ]),
        ],
        ceilingVisible: false,
      },
    );
    const parts = buildRooms([r], { level, isLowest: true });
    expect(partArea(kind(parts, r.id, "floor")[0] as NonNullable<(typeof parts)[number]>)).toBeCloseTo(8, 3);
    expect(kind(parts, r.id, "ceiling")).toHaveLength(0);
    const hidden = buildRooms([{ ...r, floorVisible: false }], { level, isLowest: true });
    expect(kind(hidden, r.id, "floor")).toHaveLength(0);
  });

  it("R-082 R-083 R-086 floor UVs are plan metres; rooms on another level are skipped", () => {
    const r = defaultRoom("room_zz0007", L, Lshape);
    const parts = buildRooms([r], { level, isLowest: true });
    const floor = kind(parts, r.id, "floor")[0] as NonNullable<(typeof parts)[number]>;
    expect(floor.uvs[0]).toBeCloseTo(floor.positions[0] as number, 6);
    expect(buildRooms([{ ...r, levelId: "level_zzzzzz" }], { level, isLowest: true })).toHaveLength(0);
  });
});

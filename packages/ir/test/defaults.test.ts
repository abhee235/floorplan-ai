import { describe, expect, it } from "vitest";
import {
  DEFAULTS,
  defaultItem,
  defaultLevel,
  defaultOpening,
  defaultRoom,
  defaultWall,
  Item,
  idType,
  Level,
  Opening,
  Room,
  randomIdGenerator,
  sequentialIdGenerator,
  shininessPreset,
  Wall,
} from "../src/index.js";
import { LEVEL } from "./helpers.js";

describe("defaults produce schema-valid entities", () => {
  it("R-116 a new level is viewable with index 0", () => {
    const l = defaultLevel("level_zz0001");
    expect(Level.safeParse(l).success).toBe(true);
    expect(l.viewable).toBe(true);
    expect(l.index).toBe(0);
    expect(l.height).toBe(DEFAULTS.levelHeight);
  });

  it("R-002 a new room shows floor, ceiling and area with a zero label offset", () => {
    const r = defaultRoom("room_zz0001", LEVEL, [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
    ]);
    expect(Room.safeParse(r).success).toBe(true);
    expect(r.floorVisible).toBe(true);
    expect(r.ceilingVisible).toBe(true);
    expect(r.label.showArea).toBe(true);
    expect(r.label.offset).toEqual({ x: 0, y: 0 });
    expect(r.finishes).toEqual({ floor: null, ceiling: null });
  });

  it("wall defaults take thickness from the kind", () => {
    expect(defaultWall("wall_zz0001", LEVEL, { x: 0, y: 0 }, { x: 1, y: 0 }).thickness).toBe(120);
    expect(
      defaultWall("wall_zz0002", LEVEL, { x: 0, y: 0 }, { x: 1, y: 0 }, { kind: "exterior" }).thickness,
    ).toBe(300);
    expect(Wall.safeParse(defaultWall("wall_zz0003", LEVEL, { x: 0, y: 0 }, { x: 1, y: 0 })).success).toBe(
      true,
    );
  });

  it("opening defaults per kind (spec 03 opening.add)", () => {
    const door = defaultOpening("opening_zz0001", LEVEL, "wall_zz0001", "door");
    const window = defaultOpening("opening_zz0002", LEVEL, "wall_zz0001", "window");
    expect(Opening.safeParse(door).success).toBe(true);
    expect([door.width, door.height, door.sill]).toEqual([900, 2100, 0]);
    expect([window.width, window.height, window.sill]).toEqual([1200, 1200, 900]);
    expect(window.swing).toBeNull();
    expect(door.swing).not.toBeNull();
  });

  it("F-008 a placed item is visible, floor mounted, with no overrides", () => {
    const i = defaultItem(
      "item_zz0001",
      LEVEL,
      { kind: "recipe", recipe: { kind: "chair", size: { w: 600, d: 600, h: 900 } } },
      { x: 0, y: 0 },
    );
    expect(Item.safeParse(i).success).toBe(true);
    expect(i.visible).toBe(true);
    expect(i.mount.kind).toBe("floor");
    expect(i.size).toBeNull();
    expect(i.parentId).toBeNull();
  });

  it("F-186 shininess presets", () => {
    expect(shininessPreset("shiny")).toBe(0.5);
    expect(shininessPreset("matt")).toBe(0);
    expect(shininessPreset("default")).toBeNull();
  });
});

describe("ids", () => {
  it("P-031 ids carry their type prefix and a six-character base36 suffix", () => {
    const gen = randomIdGenerator();
    const id = gen.next("wall");
    expect(id).toMatch(/^wall_[0-9a-z]{6}$/);
    expect(idType(id)).toBe("wall");
    expect(idType("nope")).toBeNull();
  });

  it("random ids never repeat within a project", () => {
    let calls = 0;
    const rand = () => {
      calls += 1;
      return calls <= 6 ? 0 : 0.5; // first id is all zeros, then a different one
    };
    const gen = randomIdGenerator(new Set(["wall_000000"]), rand);
    expect(gen.next("wall")).not.toBe("wall_000000");
  });

  it("sequential ids are deterministic for fixtures", () => {
    const gen = sequentialIdGenerator();
    expect(gen.next("wall")).toBe("wall_000001");
    expect(gen.next("wall")).toBe("wall_000002");
    expect(gen.next("room")).toBe("room_000001");
  });
});

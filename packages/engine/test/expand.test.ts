import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apply, type ChangeSet, type Ctx } from "@fpv/commands";
import { Project, type Project as ProjectT, sequentialIdGenerator } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { expand } from "../src/index.js";

const fixtureDir = fileURLToPath(new URL("../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const fixture = (): ProjectT => Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));
const ctx: Ctx = { ids: sequentialIdGenerator(700), now: () => "2026-09-15T00:00:00.000Z" };
const L = "level_000000";
const BOX = {
  kind: "recipe" as const,
  recipe: { kind: "box" as const, size: { w: 600, d: 400, h: 500 }, label: "b" },
};

function run(p: ProjectT, command: unknown): { project: ProjectT; changes: ChangeSet } {
  const r = apply(p, command, ctx);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return { project: r.project, changes: r.changes };
}

describe("expand", () => {
  it("W-119 W-120 W-121 W-122 S-008 S-012 O-111 R-133 a wall change rebuilds the wall and its joined neighbours only, never rooms, openings or items", () => {
    const p = fixture();
    const before = run(p, {
      type: "room.create",
      payload: {
        levelId: L,
        polygon: [
          { x: 6000, y: 6000 },
          { x: 7000, y: 6000 },
          { x: 7000, y: 7000 },
          { x: 6000, y: 7000 },
        ],
      },
    });
    const { project, changes } = run(before.project, {
      type: "wall.modify",
      payload: { wallId: "wall_000002", changes: { thickness: 200 } },
    });
    const rs = expand(changes, project);
    expect([...rs.walls].sort()).toEqual(["wall_000001", "wall_000002", "wall_000003"]);
    expect(rs.rooms.size).toBe(0);
    expect(rs.items.size).toBe(0);
    expect(rs.ground).toBe(false);
    expect(rs.layers.has("structure")).toBe(true);
    expect(rs.layers.has("items")).toBe(false);
    expect(rs.bounds).toBe(true);
  });

  it("O-102 O-107 O-110 S-013 S-014 S-017 moving an opening rebuilds the wall it left and the wall it joined, with their neighbours", () => {
    const p = fixture();
    const { project, changes } = run(p, {
      type: "opening.move",
      payload: { openingId: "opening_000001", wallId: "wall_000005", atMm: 2500 },
    });
    const rs = expand(changes, project);
    expect(rs.walls.has("wall_000001")).toBe(true);
    expect(rs.walls.has("wall_000005")).toBe(true);
    expect(rs.walls.has("wall_000006")).toBe(true); // neighbour of both
    expect(rs.items.size).toBe(0);
  });

  it("S-015 O-104 O-105 O-109 reversed: an opening change rebuilds only the wall it is bound to, never walls it merely overlaps", () => {
    const p = fixture();
    const { project, changes } = run(p, {
      type: "opening.modify",
      payload: { openingId: "opening_000001", changes: { width: 1000 } },
    });
    const rs = expand(changes, project);
    expect(rs.walls.has("wall_000003")).toBe(false);
    expect(rs.walls.has("wall_000004")).toBe(false);
  });

  it("S-025 S-026 S-028 R-134 R-136 a room polygon change rebuilds the room and rooms it overlapped; ground on the lowest level", () => {
    const p = fixture();
    const a = run(p, {
      type: "room.create",
      payload: { levelId: L, rect: { x: 0, y: 0, w: 2000, d: 2000 } },
    });
    const b = run(a.project, {
      type: "room.create",
      payload: { levelId: L, rect: { x: 1000, y: 1000, w: 2000, d: 2000 } },
    });
    const [ra, rb] = b.project.rooms.map((r) => r.id) as [string, string];
    const { project, changes } = run(b.project, {
      type: "room.setPolygon",
      payload: {
        roomId: ra,
        polygon: [
          { x: 5000, y: 5000 },
          { x: 6000, y: 5000 },
          { x: 6000, y: 6000 },
          { x: 5000, y: 6000 },
        ],
      },
    });
    const rs = expand(changes, project);
    expect(rs.rooms.has(ra)).toBe(true);
    expect(rs.rooms.has(rb)).toBe(true);
    expect(rs.ground).toBe(true);
    expect(rs.walls.size).toBe(0);
  });

  it("S-004 S-005 S-016 S-020 S-023 an item change rebuilds the item and its descendants; a deleted item is dropped, not rebuilt", () => {
    const p = fixture();
    const a = run(p, {
      type: "item.place",
      payload: { levelId: L, ref: BOX, position: { x: 1000, y: 1000 } },
    });
    const parent = a.project.items[0]?.id as string;
    const b = run(a.project, {
      type: "item.place",
      payload: { levelId: L, ref: BOX, position: { x: 1000, y: 1000 }, parentId: parent, elevation: 500 },
    });
    const child = b.project.items[1]?.id as string;
    const moved = run(b.project, { type: "item.move", payload: { itemIds: [parent], dx: 10, dy: 0 } });
    const rs = expand(moved.changes, moved.project);
    expect([...rs.items].sort()).toEqual([parent, child].sort());
    expect(rs.layers.has("items")).toBe(true);
    expect(rs.walls.size).toBe(0);
    const del = run(moved.project, { type: "item.delete", payload: { itemIds: [parent] } });
    const rd = expand(del.changes, del.project);
    expect(rd.items.size).toBe(0);
    expect(rd.removed.map((r) => r.id).sort()).toEqual([parent, child].sort());
  });

  it("S-029 S-030 S-031 S-032 O-108 R-137 a level change rebuilds everything on the level, the ground and all layers", () => {
    const p = fixture();
    const { project, changes } = run(p, {
      type: "level.modify",
      payload: { levelId: L, changes: { height: 3000 } },
    });
    const rs = expand(changes, project);
    expect(rs.walls.size).toBe(6);
    expect(rs.ground).toBe(true);
    expect(rs.layers.size).toBe(4);
  });

  it("S-036 S-033 S-035 meta and annotation changes touch the overlay only; expand unions across change sets", () => {
    const p = fixture();
    const { project, changes } = run(p, { type: "project.setMeta", payload: { changes: { name: "x" } } });
    const rs = expand(changes, project);
    expect([...rs.layers]).toEqual(["overlay"]);
    expect(rs.walls.size).toBe(0);
    const second = run(project, { type: "wall.move", payload: { wallIds: ["wall_000004"], dx: 0, dy: 100 } });
    const merged = expand(second.changes, second.project, rs);
    expect(merged.layers.has("overlay")).toBe(true);
    expect(merged.walls.has("wall_000004")).toBe(true);
  });

  it("W-009 W-010 W-011 S-006 S-007 S-009 R-132 R-135 removed walls are reported for dropping and their neighbours rebuilt", () => {
    const p = fixture();
    const { project, changes } = run(p, { type: "wall.delete", payload: { wallIds: ["wall_000001"] } });
    const rs = expand(changes, project);
    expect(rs.removed.map((r) => `${r.type}:${r.id}`).sort()).toEqual([
      "opening:opening_000001",
      "wall:wall_000001",
    ]);
    expect(rs.walls.has("wall_000001")).toBe(false);
    expect(rs.walls.has("wall_000002")).toBe(true);
    expect(rs.walls.has("wall_000006")).toBe(true);
  });

  it("S-018 S-024 appearance changes rebuild only the item or room they touch", () => {
    const p = fixture();
    const a = run(p, {
      type: "item.place",
      payload: { levelId: L, ref: BOX, position: { x: 1000, y: 1000 } },
    });
    const b = run(a.project, {
      type: "item.place",
      payload: { levelId: L, ref: BOX, position: { x: 3000, y: 1000 } },
    });
    const [i1, i2] = b.project.items.map((i) => i.id) as [string, string];
    const fin = run(b.project, {
      type: "item.setFinish",
      payload: {
        itemIds: [i1],
        finish: {
          color: "#FF0000",
          textureId: null,
          placement: null,
          mirrorForLeftSide: false,
          shininess: null,
        },
      },
    });
    const rs = expand(fin.changes, fin.project);
    expect([...rs.items]).toEqual([i1]);
    expect(rs.items.has(i2)).toBe(false);
    expect(rs.walls.size).toBe(0);
    const r1 = run(fin.project, {
      type: "room.create",
      payload: { levelId: L, rect: { x: 0, y: 0, w: 2000, d: 2000 } },
    });
    const r2 = run(r1.project, {
      type: "room.create",
      payload: { levelId: L, rect: { x: 5000, y: 5000, w: 1000, d: 1000 } },
    });
    const [ra, rb] = r2.project.rooms.map((r) => r.id) as [string, string];
    const mod = run(r2.project, {
      type: "room.modify",
      payload: { roomId: ra, changes: { ceilingVisible: false } },
    });
    const rr = expand(mod.changes, mod.project);
    expect([...rr.rooms]).toEqual([ra]);
    expect(rr.rooms.has(rb)).toBe(false);
    expect(rr.items.size).toBe(0);
  });

  it("S-022 reversed, S-010 S-021 adopted: items and walls never touch the ground unless their level is underground", () => {
    const p = fixture();
    const placed = run(p, {
      type: "item.place",
      payload: { levelId: L, ref: BOX, position: { x: 1000, y: 1000 } },
    });
    expect(expand(placed.changes, placed.project).ground).toBe(false);
    const sunk = run(placed.project, {
      type: "level.modify",
      payload: { levelId: L, changes: { elevation: -3000 } },
    });
    const wall = run(sunk.project, {
      type: "wall.move",
      payload: { wallIds: ["wall_000004"], dx: 0, dy: 100 },
    });
    expect(expand(wall.changes, wall.project).ground).toBe(true);
    const item = run(wall.project, {
      type: "item.move",
      payload: { itemIds: [sunk.project.items[0]?.id as string], dx: 10, dy: 0 },
    });
    expect(expand(item.changes, item.project).ground).toBe(true);
  });

  it("S-011 S-019 S-027 O-103 rejected: the model has no wall pattern, light power, opening pitch or pending-update state", () => {
    const p = fixture();
    const wall = p.walls[0] as (typeof p.walls)[number];
    const opening = p.openings[0] as (typeof p.openings)[number];
    expect("pattern" in wall).toBe(false);
    expect("pitch" in opening || "roll" in opening).toBe(false);
    expect(p.items.some((i) => "power" in i)).toBe(false);
    // expand is synchronous and pure: the same change set always yields the same rebuild set
    const { project, changes } = run(p, {
      type: "wall.move",
      payload: { wallIds: ["wall_000004"], dx: 0, dy: 100 },
    });
    const a = expand(changes, project);
    const b = expand(changes, project);
    expect([...a.walls].sort()).toEqual([...b.walls].sort());
    expect(a.rooms.size).toBe(0);
  });
});

import { derive } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { BOX, fail, fixture, LEVEL, ok } from "./helpers.js";

describe("room.create", () => {
  it("R-025 R-131 atPoint detects the fixture room with thresholds; outside every enclosure fails", () => {
    const p = fixture();
    const r = ok(p, {
      type: "room.create",
      payload: {
        levelId: LEVEL,
        atPoint: { x: 2000, y: 2000 },
        name: "Board",
        purpose: "boardroom",
        capacity: 10,
      },
    });
    const room = r.project.rooms[0] as (typeof p.rooms)[number];
    expect(room.source).toBe("detected");
    expect(room.boundingWallIds).toHaveLength(6);
    expect(derive.roomArea(room)).toBe(32_755_000);
    expect(room.name).toBe("Board");
    const bad = fail(p, { type: "room.create", payload: { levelId: LEVEL, atPoint: { x: 9000, y: 9000 } } });
    expect(bad.error.code).toBe("room.not-enclosed");
  });

  it("rect and polygon forms; exactly one form required; items inside get the roomId", () => {
    const p = fixture();
    const placed = ok(p, {
      type: "item.place",
      payload: { levelId: LEVEL, ref: BOX, position: { x: 1000, y: 1000 } },
    });
    const r = ok(placed.project, {
      type: "room.create",
      payload: { levelId: LEVEL, rect: { x: 100, y: 100, w: 3000, d: 2000 } },
    });
    expect(r.project.rooms[0]?.polygon).toHaveLength(4);
    expect(r.project.items[0]?.roomId).toBe(r.project.rooms[0]?.id);
    expect(r.changes.updated.map((x) => x.id)).toContain(r.project.items[0]?.id);
    expect(
      fail(p, {
        type: "room.create",
        payload: { levelId: LEVEL, rect: { x: 0, y: 0, w: 1, d: 1 }, atPoint: { x: 1, y: 1 } },
      }).error.code,
    ).toBe("command.payload");
  });

  it("R-150 R-001 a bow-tie or two-point polygon is refused", () => {
    const p = fixture();
    const r = fail(p, {
      type: "room.create",
      payload: {
        levelId: LEVEL,
        polygon: [
          { x: 0, y: 0 },
          { x: 1000, y: 1000 },
          { x: 1000, y: 0 },
          { x: 0, y: 1000 },
        ],
      },
    });
    expect(r.error.code).toBe("room.not-simple");
  });
});

describe("room editing", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 2000, y: 0 },
    { x: 2000, y: 2000 },
    { x: 0, y: 2000 },
  ];

  it("R-056 R-014 addPoint inserts on the nearest edge, projected; R-057 removePoint refuses below three", () => {
    const p = fixture();
    const created = ok(p, { type: "room.create", payload: { levelId: LEVEL, polygon: square } });
    const id = created.project.rooms[0]?.id as string;
    const added = ok(created.project, {
      type: "room.addPoint",
      payload: { roomId: id, point: { x: 1000, y: -50 } },
    });
    expect(added.project.rooms[0]?.polygon[1]).toEqual({ x: 1000, y: 0 });
    expect(added.project.rooms[0]?.source).toBe("manual");
    const tri = ok(created.project, {
      type: "room.setPolygon",
      payload: { roomId: id, polygon: square.slice(0, 3) },
    });
    expect(
      fail(tri.project, { type: "room.removePoint", payload: { roomId: id, index: 0 } }).error.code,
    ).toBe("room.too-few-points");
    expect(
      fail(tri.project, { type: "room.movePoint", payload: { roomId: id, index: 9, point: { x: 0, y: 0 } } })
        .error.code,
    ).toBe("room.point-index");
  });

  it("R-058 movePoint is a plain point set; a self-intersecting result is refused by validation", () => {
    const p = fixture();
    const created = ok(p, { type: "room.create", payload: { levelId: LEVEL, polygon: square } });
    const id = created.project.rooms[0]?.id as string;
    const moved = ok(created.project, {
      type: "room.movePoint",
      payload: { roomId: id, index: 2, point: { x: 2500, y: 2500 } },
    });
    expect(moved.project.rooms[0]?.polygon[2]).toEqual({ x: 2500, y: 2500 });
    expect(
      fail(created.project, {
        type: "room.movePoint",
        payload: { roomId: id, index: 1, point: { x: 2000, y: 3000 } },
      }).error.code,
    ).toBe("room.not-simple");
  });

  it("S-026 setPolygon reports rooms intersecting the old or new polygon; delete re-homes items", () => {
    const p = fixture();
    const a = ok(p, { type: "room.create", payload: { levelId: LEVEL, polygon: square } });
    const b = ok(a.project, {
      type: "room.create",
      payload: { levelId: LEVEL, rect: { x: 5000, y: 5000, w: 1000, d: 1000 } },
    });
    const [ra, rb] = b.project.rooms.map((r) => r.id) as [string, string];
    const moved = ok(b.project, {
      type: "room.setPolygon",
      payload: { roomId: ra, polygon: square.map((q) => ({ x: q.x + 4500, y: q.y + 4500 })) },
    });
    expect(moved.changes.updated.map((x) => x.id)).toContain(rb);
    const placed = ok(moved.project, {
      type: "item.place",
      payload: { levelId: LEVEL, ref: BOX, position: { x: 5500, y: 5500 } },
    });
    expect(placed.project.items[0]?.roomId).toBe(rb); // smallest containing room
    const del = ok(placed.project, { type: "room.delete", payload: { roomIds: [rb] } });
    expect(del.project.items[0]?.roomId).toBe(ra);
  });

  it("R-040 detectAll creates rooms for uncovered enclosures and refreshes stale ones", () => {
    const p = fixture();
    const first = ok(p, { type: "room.detectAll", payload: { levelId: LEVEL } });
    expect(first.project.rooms).toHaveLength(1);
    const again = ok(first.project, { type: "room.detectAll", payload: { levelId: LEVEL } });
    expect(again.project.rooms).toHaveLength(1);
    const moved = ok(again.project, {
      type: "wall.move",
      payload: { wallIds: ["wall_000003", "wall_000004"], dx: 0, dy: 500 },
    });
    expect(moved.project.rooms[0]?.properties.__stale).toBe("true");
    const fixed = ok(moved.project, {
      type: "room.detectAll",
      payload: { levelId: LEVEL, replaceStale: true },
    });
    expect(fixed.project.rooms[0]?.properties.__stale).toBeUndefined();
    expect(fixed.project.rooms).toHaveLength(1);
  });
});

describe("levels", () => {
  it("R-103 R-104 R-105 R-106 R-122 level.add stacks on the top level and indexes siblings at one elevation", () => {
    const p = fixture();
    const a = ok(p, { type: "level.add", payload: {} });
    const l1 = a.project.levels[1] as (typeof p.levels)[number];
    expect(l1.elevation).toBe(2700 + 300);
    expect(l1.index).toBe(0);
    const b = ok(a.project, { type: "level.add", payload: { sameAs: l1.id } });
    const l2 = b.project.levels.find((l) => l.id !== LEVEL && l.id !== l1.id) as (typeof p.levels)[number];
    expect(l2.elevation).toBe(l1.elevation);
    expect(l2.index).toBe(1);
    expect(b.project.levels.map((l) => l.id)).toEqual([LEVEL, l1.id, l2.id]);
  });

  it("R-119 R-120 R-121 elevation and index changes re-index siblings and re-sort", () => {
    const p = fixture();
    const a = ok(p, { type: "level.add", payload: { sameAs: LEVEL } });
    const b = ok(a.project, { type: "level.add", payload: { sameAs: LEVEL } });
    const ids = b.project.levels.map((l) => l.id) as [string, string, string];
    expect(b.project.levels.map((l) => l.index)).toEqual([0, 1, 2]);
    const moved = ok(b.project, {
      type: "level.modify",
      payload: { levelId: ids[1], changes: { elevation: 3000 } },
    });
    expect(moved.project.levels.map((l) => [l.id, l.elevation, l.index])).toEqual([
      [ids[0], 0, 0],
      [ids[2], 0, 1],
      [ids[1], 3000, 0],
    ]);
    const reindexed = ok(b.project, {
      type: "level.modify",
      payload: { levelId: ids[2], changes: { index: 0 } },
    });
    expect(reindexed.project.levels.map((l) => l.id)).toEqual([ids[2], ids[0], ids[1]]);
  });

  it("R-108 R-109 R-110 R-111 R-112 F-175 level.delete cascades everything on the level; the last level cannot be deleted", () => {
    const p = fixture();
    const a = ok(p, { type: "level.add", payload: {} });
    const l1 = a.project.levels[1]?.id as string;
    const w = ok(a.project, {
      type: "wall.create",
      payload: { levelId: l1, start: { x: 0, y: 0 }, end: { x: 1000, y: 0 } },
    });
    const d = ok(w.project, { type: "level.delete", payload: { levelId: l1 } });
    expect(d.project.levels).toHaveLength(1);
    expect(d.project.walls).toHaveLength(6);
    expect(d.changes.removed.map((x) => x.type)).toEqual(expect.arrayContaining(["level", "wall"]));
    expect(fail(d.project, { type: "level.delete", payload: { levelId: LEVEL } }).error.code).toBe(
      "level.last",
    );
  });
});

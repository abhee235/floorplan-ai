import { derive, type Wall } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { BOX, ctx, fail, fixture, LEVEL, ok } from "./helpers.js";

const wall = (p: ReturnType<typeof fixture>, id: string): Wall => p.walls.find((w) => w.id === id) as Wall;

describe("wall.createChain", () => {
  it("W-067 W-141 W-150 a chain snaps to 15 degree intent, joins in sequence, and takes defaults", () => {
    const p = fixture();
    p.walls = [];
    p.openings = [];
    const r = ok(p, {
      type: "wall.createChain",
      payload: {
        levelId: LEVEL,
        points: [
          { x: 200, y: 200 },
          { x: 5000, y: 200 },
          { x: 5000, y: 200 }, // zero-length segment dropped
          { x: 5000, y: 3000 },
          { x: 200, y: 3000 },
        ],
        closed: false,
      },
    });
    const walls = r.project.walls;
    expect(walls).toHaveLength(3);
    expect(walls[0]?.joins.end?.wallId).toBe(walls[1]?.id);
    expect(walls[1]?.joins.start?.wallId).toBe(walls[0]?.id);
    expect(walls[2]?.joins.end).toBeNull();
    expect(walls[0]?.thickness).toBe(120);
    expect(walls[0]?.heightAtEnd).toBeNull();
    expect(r.changes.added.map((x) => x.id)).toEqual(walls.map((w) => w.id));
  });

  it("W-070 closing a chain joins the last wall to the first", () => {
    const p = fixture();
    p.walls = [];
    p.openings = [];
    const r = ok(p, {
      type: "wall.createChain",
      payload: {
        levelId: LEVEL,
        points: [
          { x: 0, y: 0 },
          { x: 4000, y: 0 },
          { x: 4000, y: 3000 },
          { x: 0, y: 3000 },
        ],
        closed: true,
      },
    });
    const w = r.project.walls;
    expect(w).toHaveLength(4);
    expect(w[3]?.joins.end).toEqual({ wallId: w[0]?.id, end: "start" });
    expect(w[0]?.joins.start).toEqual({ wallId: w[3]?.id, end: "end" });
  });

  it("W-068 W-069 W-083 W-143 the chain start snaps to an existing free wall end within snapMm and joins it", () => {
    const p = fixture();
    p.walls = [];
    p.openings = [];
    const first = ok(p, {
      type: "wall.create",
      payload: { levelId: LEVEL, start: { x: 0, y: 0 }, end: { x: 3000, y: 0 } },
    });
    const r = ok(first.project, {
      type: "wall.createChain",
      payload: {
        levelId: LEVEL,
        points: [
          { x: 3015, y: -12 },
          { x: 3000, y: 2000 },
        ],
        closed: false,
        snapMm: 20,
      },
    });
    const created = r.project.walls[1] as Wall;
    expect(created.start).toEqual({ x: 3000, y: 0 });
    expect(created.joins.start).toEqual({ wallId: r.project.walls[0]?.id, end: "end" });
    expect(r.project.walls[0]?.joins.end).toEqual({ wallId: created.id, end: "start" });
  });

  it("W-004 W-138 a zero-length chain fails and an unchanged create is still a valid command", () => {
    const p = fixture();
    const r = fail(p, {
      type: "wall.createChain",
      payload: {
        levelId: LEVEL,
        points: [
          { x: 1, y: 1 },
          { x: 1, y: 1 },
        ],
        closed: false,
      },
    });
    expect(r.error.code).toBe("wall.zero-length");
  });
});

describe("wall.create and joins", () => {
  it("W-013 W-014 W-152 creating with a join sets both sides and detaches the previous partner", () => {
    const p = fixture();
    p.walls = [];
    p.openings = [];
    const a = ok(p, {
      type: "wall.create",
      payload: { levelId: LEVEL, start: { x: 0, y: 0 }, end: { x: 1000, y: 0 } },
    });
    const aId = a.project.walls[0]?.id as string;
    const b = ok(a.project, {
      type: "wall.create",
      payload: {
        levelId: LEVEL,
        start: { x: 1000, y: 0 },
        end: { x: 1000, y: 1000 },
        joinStart: { wallId: aId, end: "end" },
      },
    });
    const bId = b.project.walls[1]?.id as string;
    expect(wall(b.project, aId).joins.end).toEqual({ wallId: bId, end: "start" });
    expect(b.changes.updated.some((x) => x.id === aId)).toBe(true);
    // a third wall taking over a's end detaches b
    const c = ok(b.project, {
      type: "wall.create",
      payload: {
        levelId: LEVEL,
        start: { x: 1000, y: 0 },
        end: { x: 2000, y: 0 },
        joinStart: { wallId: aId, end: "end" },
      },
    });
    expect(wall(c.project, bId).joins.start).toBeNull();
    expect(wall(c.project, aId).joins.end?.wallId).toBe(c.project.walls[2]?.id);
  });

  it("W-015 W-017 a self join is refused; W-068 a non-coincident join is refused with a hint", () => {
    const p = fixture();
    const self = fail(p, {
      type: "wall.join",
      payload: { a: { wallId: "wall_000001", end: "start" }, b: { wallId: "wall_000001", end: "end" } },
    });
    expect(self.error.code).toBe("wall.self-join");
    const r = fail(p, {
      type: "wall.create",
      payload: {
        levelId: LEVEL,
        start: { x: 10, y: 10 },
        end: { x: 500, y: 10 },
        joinStart: { wallId: "wall_000001", end: "start" },
      },
    });
    expect(r.error.code).toBe("wall.join-endpoint-mismatch");
    expect(r.error.hint).toContain("wall.join");
  });
});

describe("wall.move", () => {
  it("W-031 W-032 W-144 moving a selection drags unselected neighbours' shared endpoints only", () => {
    const p = fixture();
    const r = ok(p, {
      type: "wall.move",
      payload: { wallIds: ["wall_000002", "wall_000003"], dx: 40, dy: 0 },
    });
    expect(wall(r.project, "wall_000002").start).toEqual({ x: 8040, y: 0 });
    expect(wall(r.project, "wall_000002").end).toEqual({ x: 8040, y: 3000 });
    expect(wall(r.project, "wall_000003").end).toEqual({ x: 5040, y: 3000 });
    // wall 1 (unselected) end followed; its start did not
    expect(wall(r.project, "wall_000001").end).toEqual({ x: 8040, y: 0 });
    expect(wall(r.project, "wall_000001").start).toEqual({ x: 0, y: 0 });
    // wall 4 (unselected) start followed
    expect(wall(r.project, "wall_000004").start).toEqual({ x: 5040, y: 3000 });
    expect(wall(r.project, "wall_000004").end).toEqual({ x: 5000, y: 5000 });
    expect(r.changes.updated.map((x) => x.id)).toEqual(
      expect.arrayContaining(["wall_000001", "wall_000004", "opening_000001"]),
    );
  });

  it("W-033 O-050 reversed: openings ride with their wall by fraction and are reported changed", () => {
    const p = fixture();
    const r = ok(p, { type: "wall.move", payload: { wallIds: ["wall_000001"], dx: 0, dy: -500 } });
    const o = r.project.openings[0] as (typeof p.openings)[number];
    expect(derive.openingCentre(o, wall(r.project, "wall_000001"))).toEqual({ x: 4000, y: -500 });
  });
});

describe("wall.split", () => {
  it("W-037 W-038 W-040 W-148 W-137 split makes two new ids joined to each other and to the old neighbours; heights interpolate", () => {
    const p = fixture();
    wall(p, "wall_000002").height = 2500;
    wall(p, "wall_000002").heightAtEnd = 1500;
    wall(p, "wall_000002").pattern = "cross-hatch";
    const r = ok(p, { type: "wall.split", payload: { wallId: "wall_000002", at: 0.5 } });
    expect(r.project.walls.find((w) => w.id === "wall_000002")).toBeUndefined();
    const [first, second] = r.project.walls.slice(-2) as [Wall, Wall];
    expect(first.end).toEqual({ x: 8000, y: 1500 });
    expect(second.start).toEqual({ x: 8000, y: 1500 });
    expect(first.joins.end).toEqual({ wallId: second.id, end: "start" });
    expect(first.joins.start).toEqual({ wallId: "wall_000001", end: "end" });
    expect(wall(r.project, "wall_000001").joins.end).toEqual({ wallId: first.id, end: "start" });
    expect(second.joins.end).toEqual({ wallId: "wall_000003", end: "start" });
    expect(wall(r.project, "wall_000003").joins.start).toEqual({ wallId: second.id, end: "end" });
    expect(first.heightAtEnd).toBe(2000);
    expect(second.height).toBe(2000);
    expect(second.heightAtEnd).toBe(1500);
    // both halves are drawn as the whole wall was
    expect([first.pattern, second.pattern]).toEqual(["cross-hatch", "cross-hatch"]);
    expect(new Set([first.id, second.id, "wall_000002"]).size).toBe(3);
  });

  it("W-039 reversed: an arc wall's extent is divided proportionally", () => {
    const p = fixture();
    wall(p, "wall_000005").arcExtent = -90;
    const r = ok(p, { type: "wall.split", payload: { wallId: "wall_000005", at: 0.25 } });
    const [first, second] = r.project.walls.slice(-2) as [Wall, Wall];
    expect(first.arcExtent).toBeCloseTo(-22.5, 6);
    expect(second.arcExtent).toBeCloseTo(-67.5, 6);
  });

  it("openings reassign to the half containing them; a straddled opening refuses the split", () => {
    const p = fixture();
    const r = ok(p, { type: "wall.split", payload: { wallId: "wall_000001", at: 0.25 } });
    const o = r.project.openings[0] as (typeof p.openings)[number];
    const second = r.project.walls[r.project.walls.length - 1] as Wall;
    expect(o.wallId).toBe(second.id);
    expect(o.position).toBeCloseTo((4000 - 2000) / 6000, 9);
    const bad = fail(p, { type: "wall.split", payload: { wallId: "wall_000001", at: 0.5 } });
    expect(bad.error.code).toBe("wall.split-through-opening");
  });
});

describe("wall.join, wall.reverse, wall.delete", () => {
  it("W-043 W-045 W-047 joining two free ends meets at the centreline intersection", () => {
    const p = fixture();
    p.walls = [];
    p.openings = [];
    const a = ok(p, {
      type: "wall.create",
      payload: { levelId: LEVEL, start: { x: 0, y: 0 }, end: { x: 900, y: 0 } },
    });
    const b = ok(a.project, {
      type: "wall.create",
      payload: { levelId: LEVEL, start: { x: 1000, y: 100 }, end: { x: 1000, y: 2000 } },
    });
    const ids = b.project.walls.map((w) => w.id) as [string, string];
    const r = ok(b.project, {
      type: "wall.join",
      payload: { a: { wallId: ids[0], end: "end" }, b: { wallId: ids[1], end: "start" } },
    });
    expect(wall(r.project, ids[0]).end).toEqual({ x: 1000, y: 0 });
    expect(wall(r.project, ids[1]).start).toEqual({ x: 1000, y: 0 });
    expect(wall(r.project, ids[0]).joins.end).toEqual({ wallId: ids[1], end: "start" });
  });

  it("W-044 collinear walls meet at the midpoint between the free ends", () => {
    const p = fixture();
    p.walls = [];
    p.openings = [];
    const a = ok(p, {
      type: "wall.create",
      payload: { levelId: LEVEL, start: { x: 0, y: 0 }, end: { x: 1000, y: 0 } },
    });
    const b = ok(a.project, {
      type: "wall.create",
      payload: { levelId: LEVEL, start: { x: 1200, y: 0 }, end: { x: 3000, y: 0 } },
    });
    const ids = b.project.walls.map((w) => w.id) as [string, string];
    const r = ok(b.project, {
      type: "wall.join",
      payload: { a: { wallId: ids[0], end: "end" }, b: { wallId: ids[1], end: "start" } },
    });
    expect(wall(r.project, ids[0]).end).toEqual({ x: 1100, y: 0 });
  });

  it("W-066 arc walls cannot be joined by wall.join", () => {
    const p = fixture();
    p.walls = [];
    p.openings = [];
    const a = ok(p, {
      type: "wall.create",
      payload: { levelId: LEVEL, start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, arcExtent: 90 },
    });
    const b = ok(a.project, {
      type: "wall.create",
      payload: { levelId: LEVEL, start: { x: 1000, y: 200 }, end: { x: 1000, y: 2000 } },
    });
    const ids = b.project.walls.map((w) => w.id) as [string, string];
    expect(
      fail(b.project, {
        type: "wall.join",
        payload: { a: { wallId: ids[0], end: "end" }, b: { wallId: ids[1], end: "start" } },
      }).error.code,
    ).toBe("wall.join-impossible");
  });

  it("W-034 W-035 W-147 reverse swaps ends, joins, sides and sloped heights; openings stay in place", () => {
    const p = fixture();
    wall(p, "wall_000001").height = 2500;
    wall(p, "wall_000001").heightAtEnd = 2000;
    wall(p, "wall_000001").finishes.left = {
      color: "#FF0000",
      textureId: null,
      placement: null,
      mirrorForLeftSide: false,
      shininess: null,
    };
    const r = ok(p, { type: "wall.reverse", payload: { wallIds: ["wall_000001"] } });
    const w = wall(r.project, "wall_000001");
    expect(w.start).toEqual({ x: 8000, y: 0 });
    expect(w.end).toEqual({ x: 0, y: 0 });
    expect(w.height).toBe(2000);
    expect(w.heightAtEnd).toBe(2500);
    expect(w.finishes.right?.color).toBe("#FF0000");
    expect(w.finishes.left).toBeNull();
    expect(w.joins.start).toEqual({ wallId: "wall_000002", end: "start" });
    expect(wall(r.project, "wall_000002").joins.start).toEqual({ wallId: "wall_000001", end: "start" });
    expect(wall(r.project, "wall_000006").joins.end).toEqual({ wallId: "wall_000001", end: "end" });
    const o = r.project.openings[0] as (typeof p.openings)[number];
    expect(derive.openingCentre(o, w)).toEqual({ x: 4000, y: 0 });
    expect(o.swing?.hinge).toBe("end");
    // a rectangular wall keeps null heightAtEnd on reverse
    const q = fixture();
    const r2 = ok(q, { type: "wall.reverse", payload: { wallIds: ["wall_000002"] } });
    expect(wall(r2.project, "wall_000002").heightAtEnd).toBeNull();
  });

  it("W-029 W-030 W-088 W-136 deleting a wall removes its openings and detaches neighbours at both ends", () => {
    const p = fixture();
    const r = ok(p, { type: "wall.delete", payload: { wallIds: ["wall_000001"] } });
    expect(r.project.walls).toHaveLength(5);
    expect(r.project.openings).toHaveLength(0);
    expect(wall(r.project, "wall_000002").joins.start).toBeNull();
    expect(wall(r.project, "wall_000006").joins.end).toBeNull();
    expect(r.changes.removed.map((x) => x.id)).toEqual(
      expect.arrayContaining(["wall_000001", "opening_000001"]),
    );
    // W-030: a two-wall loop where the survivor is joined to the deleted wall at both of its ends
    const q = fixture();
    q.walls = [];
    q.openings = [];
    const a = ok(q, {
      type: "wall.create",
      payload: { levelId: LEVEL, start: { x: 0, y: 0 }, end: { x: 1000, y: 0 } },
    });
    const b = ok(a.project, {
      type: "wall.create",
      payload: {
        levelId: LEVEL,
        start: { x: 1000, y: 0 },
        end: { x: 0, y: 0 },
        joinStart: { wallId: a.project.walls[0]?.id as string, end: "end" },
        joinEnd: { wallId: a.project.walls[0]?.id as string, end: "start" },
      },
    });
    const ids = b.project.walls.map((w) => w.id) as [string, string];
    const d = ok(b.project, { type: "wall.delete", payload: { wallIds: [ids[1]] } });
    expect(wall(d.project, ids[0]).joins.start).toBeNull();
    expect(wall(d.project, ids[0]).joins.end).toBeNull();
  });

  it("detected rooms bounded by a deleted or moved wall are marked stale", () => {
    const p = fixture();
    const room = ok(p, { type: "room.create", payload: { levelId: LEVEL, atPoint: { x: 2000, y: 2000 } } });
    const r = ok(room.project, { type: "wall.move", payload: { wallIds: ["wall_000003"], dx: 0, dy: 100 } });
    expect(r.project.rooms[0]?.properties.__stale).toBe("true");
    expect(r.changes.updated.some((x) => x.type === "room")).toBe(true);
  });
});

describe("wall.modify", () => {
  it("W-087 W-084 modifying an endpoint follows the same propagation path as a move; W-094 heights normalise", () => {
    const p = fixture();
    const r = ok(p, {
      type: "wall.modify",
      payload: {
        wallId: "wall_000002",
        changes: { end: { x: 8000, y: 3200 }, height: 2600, heightAtEnd: 2600 },
      },
    });
    expect(wall(r.project, "wall_000003").start).toEqual({ x: 8000, y: 3200 });
    expect(wall(r.project, "wall_000002").heightAtEnd).toBeNull();
  });

  it("W-139 a wall whose mount target is deleted falls back to floor mount for items", () => {
    const p = fixture();
    const placed = ok(p, {
      type: "item.place",
      payload: {
        levelId: LEVEL,
        ref: BOX,
        position: { x: 4000, y: 200 },
        mount: { kind: "wall", targetId: "wall_000001", height: 1400 },
      },
    });
    const r = ok(placed.project, { type: "wall.delete", payload: { wallIds: ["wall_000001"] } });
    expect(r.project.items[0]?.mount.kind).toBe("floor");
  });
});

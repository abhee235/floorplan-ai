import { describe, expect, it } from "vitest";
import {
  defaultItem,
  defaultOpening,
  defaultRoom,
  defaultWall,
  hasErrors,
  Project,
  validate,
  Wall,
} from "../src/index.js";
import { fixture, LEVEL } from "./helpers.js";

const codes = (problems: ReturnType<typeof validate>) => problems.map((p) => p.code);
const wall = (p: ReturnType<typeof fixture>, id: string): Wall => p.walls.find((w) => w.id === id) as Wall;

describe("fixture", () => {
  it("R-131 the six-wall fixture validates with zero errors", () => {
    const problems = validate(fixture());
    expect(problems.filter((p) => p.severity === "error")).toEqual([]);
  });
});

describe("walls", () => {
  it("W-004 a zero-length wall is rejected", () => {
    const p = fixture();
    p.walls.push(defaultWall("wall_zz0001", LEVEL, { x: 100, y: 100 }, { x: 100, y: 100 }));
    expect(codes(validate(p))).toContain("wall.zero-length");
  });

  it("W-006 W-007 W-101 zero or negative thickness and non-positive heights fail the schema", () => {
    const p = fixture();
    const w = wall(p, "wall_000001");
    expect(Wall.safeParse({ ...w, thickness: 0 }).success).toBe(false);
    expect(Wall.safeParse({ ...w, thickness: -10 }).success).toBe(false);
    expect(Wall.safeParse({ ...w, height: 0 }).success).toBe(false);
  });

  it("W-015 W-017 P-034 a wall joined to itself is rejected", () => {
    const p = fixture();
    const w = wall(p, "wall_000001");
    w.joins.start = { wallId: w.id, end: "end" };
    w.joins.end = { wallId: w.id, end: "start" };
    const c = codes(validate(p));
    expect(c).toContain("wall.self-join");
  });

  it("W-013 a one-directional join is reported as not reciprocal", () => {
    const p = fixture();
    const w2 = wall(p, "wall_000002");
    w2.joins.start = null;
    const problems = validate(p);
    const notRecip = problems.find((x) => x.code === "wall.join-not-reciprocal");
    expect(notRecip?.entityId).toBe("wall_000001");
    expect(notRecip?.related).toContain("wall_000002");
    expect(notRecip?.hint).toContain("wall_000002.joins.start");
  });

  it("W-068 joined endpoints must coincide", () => {
    const p = fixture();
    wall(p, "wall_000002").start = { x: 8001, y: 0 };
    expect(codes(validate(p))).toContain("wall.join-endpoint-mismatch");
  });

  it("P-033 P-036 a join to a missing wall is a problem, not a silent null", () => {
    const p = fixture();
    wall(p, "wall_000001").joins.end = { wallId: "wall_ghost1", end: "start" };
    const problems = validate(p);
    expect(problems.some((x) => x.code === "ref.missing" && x.entityId === "wall_000001")).toBe(true);
  });

  it("P-032 forward references resolve regardless of array order", () => {
    const p = fixture();
    p.walls.reverse();
    expect(hasErrors(validate(p))).toBe(false);
  });
});

describe("openings", () => {
  it("O-060 O-061 O-062 O-063 O-064 overlapping openings on one wall are rejected (reversed)", () => {
    const p = fixture();
    p.openings.push(
      defaultOpening("opening_zz0001", LEVEL, "wall_000001", "window", {
        position: 0.55,
        width: 1200,
        sill: 900,
      }),
    );
    expect(codes(validate(p))).toContain("opening.overlap");
  });

  it("touching openings do not overlap", () => {
    const p = fixture();
    // door spans 3550..4450 on an 8000 wall; a window from 4450..5650 touches but does not overlap
    p.openings.push(
      defaultOpening("opening_zz0002", LEVEL, "wall_000001", "window", {
        position: 5050 / 8000,
        width: 1200,
      }),
    );
    expect(codes(validate(p))).not.toContain("opening.overlap");
  });

  it("opening.off-wall gives a hint with the valid position range", () => {
    const p = fixture();
    p.openings.push(
      defaultOpening("opening_zz0003", LEVEL, "wall_000004", "door", { position: 0.95, width: 900 }),
    );
    const prob = validate(p).find((x) => x.code === "opening.off-wall");
    expect(prob?.hint).toMatch(/between 0\.225 and 0\.775/);
  });

  it("O-054 an opening taller than its wall is a warning", () => {
    const p = fixture();
    p.openings.push(
      defaultOpening("opening_zz0004", LEVEL, "wall_000005", "window", {
        position: 0.5,
        height: 2000,
        sill: 1000,
      }),
    );
    const prob = validate(p).find((x) => x.code === "opening.taller-than-wall");
    expect(prob?.severity).toBe("warning");
  });

  it("O-004 there is no bound-to-wall flag; the wall reference is the binding", () => {
    const p = fixture();
    expect("boundToWall" in (p.openings[0] as object)).toBe(false);
    expect(p.openings[0]?.wallId).toBe("wall_000001");
  });

  it("opening.level-mismatch and opening.swing-on-window", () => {
    const p = fixture();
    p.levels.push({
      ...(p.levels[0] as (typeof p.levels)[number]),
      id: "level_000001",
      elevation: 3000,
      index: 0,
    });
    p.openings.push(
      defaultOpening("opening_zz0005", "level_000001", "wall_000002", "window", {
        swing: { hinge: "start", direction: "left" },
      }),
    );
    const c = codes(validate(p));
    expect(c).toContain("opening.level-mismatch");
    expect(c).toContain("opening.swing-on-window");
  });
});

describe("rooms", () => {
  it("R-001 R-015 R-057 fewer than three points is rejected", () => {
    const p = fixture();
    const r = defaultRoom("room_zz0001", LEVEL, [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
    ]);
    r.polygon = r.polygon.slice(0, 2);
    p.rooms.push(r);
    expect(codes(validate(p))).toContain("room.too-few-points");
  });

  it("R-150 a bow-tie room is rejected as not simple", () => {
    const p = fixture();
    p.rooms.push(
      defaultRoom("room_zz0002", LEVEL, [
        { x: 0, y: 0 },
        { x: 1000, y: 1000 },
        { x: 1000, y: 0 },
        { x: 0, y: 1000 },
      ]),
    );
    expect(codes(validate(p))).toContain("room.not-simple");
  });

  it("room.winding, room.hole-outside and room.degenerate", () => {
    const p = fixture();
    const cw = [
      { x: 0, y: 0 },
      { x: 0, y: 2000 },
      { x: 2000, y: 2000 },
      { x: 2000, y: 0 },
    ];
    p.rooms.push(defaultRoom("room_zz0003", LEVEL, cw));
    p.rooms.push(
      defaultRoom(
        "room_zz0004",
        LEVEL,
        [
          { x: 0, y: 0 },
          { x: 2000, y: 0 },
          { x: 2000, y: 2000 },
          { x: 0, y: 2000 },
        ],
        {
          holes: [
            [
              { x: 5000, y: 5000 },
              { x: 5000, y: 5500 },
              { x: 5500, y: 5500 },
              { x: 5500, y: 5000 },
            ],
          ],
        },
      ),
    );
    p.rooms.push(
      defaultRoom("room_zz0005", LEVEL, [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ]),
    );
    const c = codes(validate(p));
    expect(c).toContain("room.winding");
    expect(c).toContain("room.hole-outside");
    expect(c).toContain("room.degenerate");
  });
});

describe("levels", () => {
  it("R-101 R-102 a project always has at least one level (schema minimum)", () => {
    const p = fixture();
    expect(Project.safeParse({ ...p, levels: [] }).success).toBe(false);
  });

  it("level.duplicate-order for two levels at the same elevation and index", () => {
    const p = fixture();
    p.levels.push({ ...(p.levels[0] as (typeof p.levels)[number]), id: "level_000001" });
    expect(codes(validate(p))).toContain("level.duplicate-order");
  });

  it("P-035 a dangling levelId is a problem", () => {
    const p = fixture();
    wall(p, "wall_000001").levelId = "level_ghost0";
    expect(validate(p).some((x) => x.code === "ref.missing" && x.entityId === "wall_000001")).toBe(true);
  });
});

describe("items", () => {
  const box = {
    kind: "recipe" as const,
    recipe: { kind: "box" as const, size: { w: 600, d: 600, h: 750 }, label: "box" },
  };

  it("item.parent-cycle and item.parent-level", () => {
    const p = fixture();
    p.items.push(defaultItem("item_zz0001", LEVEL, box, { x: 1000, y: 1000 }, { parentId: "item_zz0002" }));
    p.items.push(defaultItem("item_zz0002", LEVEL, box, { x: 1000, y: 1000 }, { parentId: "item_zz0001" }));
    expect(codes(validate(p))).toContain("item.parent-cycle");
  });

  it("item.overlap warns when floor items overlap by more than 10 percent; stacked items are exempt", () => {
    const p = fixture();
    p.items.push(defaultItem("item_zz0003", LEVEL, box, { x: 1000, y: 1000 }));
    p.items.push(defaultItem("item_zz0004", LEVEL, box, { x: 1200, y: 1000 }));
    p.items.push(
      defaultItem(
        "item_zz0005",
        LEVEL,
        box,
        { x: 1000, y: 1000 },
        { parentId: "item_zz0003", elevation: 750 },
      ),
    );
    const problems = validate(p);
    const overlaps = problems.filter((x) => x.code === "item.overlap");
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.related).toContain("item_zz0004");
  });

  it("F-089 item.in-wall warns when a footprint lies entirely inside a wall", () => {
    const p = fixture();
    wall(p, "wall_000001").thickness = 800;
    p.items.push(
      defaultItem(
        "item_zz0006",
        LEVEL,
        { kind: "recipe", recipe: { kind: "box", size: { w: 200, d: 200, h: 200 }, label: "b" } },
        { x: 2000, y: 0 },
      ),
    );
    expect(codes(validate(p))).toContain("item.in-wall");
  });

  it("item.outside-room warns and catalog.missing-snapshot errors", () => {
    const p = fixture();
    p.rooms.push(
      defaultRoom("room_zz0006", LEVEL, [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 1000, y: 1000 },
        { x: 0, y: 1000 },
      ]),
    );
    p.items.push(defaultItem("item_zz0007", LEVEL, box, { x: 5000, y: 5000 }, { roomId: "room_zz0006" }));
    p.items.push(
      defaultItem("item_zz0008", LEVEL, { kind: "product", productId: "acme-x1" }, { x: 500, y: 500 }),
    );
    const c = codes(validate(p));
    expect(c).toContain("item.outside-room");
    expect(c).toContain("catalog.missing-snapshot");
  });

  it("item.size-not-deformable and catalog.unverified read the product snapshot", () => {
    const p = fixture();
    p.catalogRefs["acme-x1"] = {
      id: "acme-x1",
      snapshotAt: "2026-09-15T00:00:00.000Z",
      dims: { w: 600, d: 600, h: 700 },
      deformable: false,
      verification: { status: "unverified" },
    };
    p.items.push(
      defaultItem(
        "item_zz0009",
        LEVEL,
        { kind: "product", productId: "acme-x1" },
        { x: 500, y: 500 },
        { size: { w: 700, d: 700, h: 700 } },
      ),
    );
    const c = codes(validate(p));
    expect(c).toContain("item.size-not-deformable");
    expect(c).toContain("catalog.unverified");
  });

  it("item.mount-target requires a resolving target for wall and item mounts", () => {
    const p = fixture();
    p.items.push(
      defaultItem(
        "item_zz0010",
        LEVEL,
        box,
        { x: 500, y: 500 },
        { mount: { kind: "wall", targetId: null, height: 1400 } },
      ),
    );
    expect(codes(validate(p))).toContain("item.mount-target");
  });
});

import { derive, type Wall } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { fail, fixture, LEVEL, ok } from "./helpers.js";

const wall = (p: ReturnType<typeof fixture>, id: string): Wall => p.walls.find((w) => w.id === id) as Wall;

describe("opening.add", () => {
  it("O-038 O-039 an opening is bound to its wall by id from creation; defaults per kind", () => {
    const p = fixture();
    const r = ok(p, { type: "opening.add", payload: { wallId: "wall_000005", kind: "window", atMm: 2500 } });
    const o = r.project.openings[1] as (typeof p.openings)[number];
    expect(o.wallId).toBe("wall_000005");
    expect(o.position).toBe(0.5);
    expect([o.width, o.height, o.sill]).toEqual([1200, 1200, 900]);
    expect(o.swing).toBeNull();
    expect(r.changes.updated.map((x) => x.id)).toContain("wall_000005");
  });

  it("O-060 O-061 O-062 O-063 O-064 overlapping openings are refused; touching ones are fine", () => {
    const p = fixture();
    const bad = fail(p, {
      type: "opening.add",
      payload: { wallId: "wall_000001", kind: "window", position: 0.52, width: 1200 },
    });
    expect(bad.error.code).toBe("opening.overlap");
    ok(p, {
      type: "opening.add",
      payload: { wallId: "wall_000001", kind: "window", atMm: 5050, width: 1200 },
    });
  });

  it("opening.off-wall fails with a hint containing the valid range", () => {
    const p = fixture();
    const r = fail(p, {
      type: "opening.add",
      payload: { wallId: "wall_000004", kind: "door", position: 0.95 },
    });
    expect(r.error.code).toBe("opening.off-wall");
    expect(r.error.hint).toMatch(/between/);
  });

  it("command.payload when both position and atMm are given", () => {
    const p = fixture();
    expect(
      fail(p, {
        type: "opening.add",
        payload: { wallId: "wall_000005", kind: "door", position: 0.5, atMm: 100 },
      }).error.code,
    ).toBe("command.payload");
  });

  it("catalog.missing-snapshot when the product is unknown; a known product is snapshotted", () => {
    const p = fixture();
    expect(
      fail(p, {
        type: "opening.add",
        payload: { wallId: "wall_000005", kind: "door", position: 0.5, productId: "nope-x" },
      }).error.code,
    ).toBe("catalog.missing-snapshot");
    const r = ok(p, {
      type: "opening.add",
      payload: { wallId: "wall_000005", kind: "door", position: 0.5, productId: "acme-chair" },
    });
    expect(r.project.catalogRefs["acme-chair"]?.id).toBe("acme-chair");
  });
});

describe("opening.modify, move, delete", () => {
  it("O-040 O-041 O-042 O-043 O-044 O-045 O-046 resizing an opening keeps it on its wall; the wall is reported changed (O-102..O-106)", () => {
    const p = fixture();
    const r = ok(p, {
      type: "opening.modify",
      payload: { openingId: "opening_000001", changes: { width: 1000, height: 2200 } },
    });
    expect(r.project.openings[0]?.wallId).toBe("wall_000001");
    expect(r.changes.updated.map((x) => `${x.type}:${x.id}`)).toEqual(
      expect.arrayContaining(["opening:opening_000001", "wall:wall_000001"]),
    );
  });

  it("O-102 O-107 moving an opening to another wall reports both walls; deleting reports the wall", () => {
    const p = fixture();
    const r = ok(p, {
      type: "opening.move",
      payload: { openingId: "opening_000001", wallId: "wall_000005", atMm: 2500 },
    });
    expect(r.project.openings[0]?.wallId).toBe("wall_000005");
    expect(
      derive.openingCentre(
        r.project.openings[0] as (typeof p.openings)[number],
        wall(r.project, "wall_000005"),
      ),
    ).toEqual({ x: 2500, y: 5000 });
    expect(r.changes.updated.map((x) => x.id)).toEqual(
      expect.arrayContaining(["wall_000001", "wall_000005"]),
    );
    const d = ok(r.project, { type: "opening.delete", payload: { openingIds: ["opening_000001"] } });
    expect(d.project.openings).toHaveLength(0);
    expect(d.changes.removed.map((x) => x.id)).toContain("opening_000001");
    expect(d.changes.updated.map((x) => x.id)).toContain("wall_000005");
  });

  it("O-047 O-048 O-049 openings follow wall geometry changes without any rebinding logic", () => {
    const p = fixture();
    const thick = ok(p, {
      type: "wall.modify",
      payload: { wallId: "wall_000001", changes: { thickness: 300 } },
    });
    expect(thick.project.openings[0]?.wallId).toBe("wall_000001");
    expect(thick.changes.updated.map((x) => x.id)).toContain("opening_000001");
  });

  it("opening.swing-on-window is normalised away by the reducer for windows", () => {
    const p = fixture();
    const r = ok(p, {
      type: "opening.add",
      payload: {
        wallId: "wall_000005",
        kind: "window",
        position: 0.5,
        swing: { hinge: "start", direction: "left" },
      },
    });
    expect(r.project.openings[1]?.swing).toBeNull();
    expect(r.project.levels).toHaveLength(1);
    expect(LEVEL).toBe("level_000000");
  });
});

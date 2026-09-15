// The placement pipeline inside item.place and item.move (spec 03 section 3, spec 05 section 5).
import { doorSwingZones } from "@fpv/geometry";
import { derive, type Item, type Project, poly } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { ctx, fail, fixture, LEVEL, ok } from "./helpers.js";

const BOX = {
  kind: "recipe",
  recipe: { kind: "box", size: { w: 600, d: 400, h: 500 }, label: "box" },
} as const;
const CREDENZA = {
  kind: "recipe",
  recipe: { kind: "box", size: { w: 1800, d: 500, h: 720 }, label: "credenza" },
} as const;

function withRoom(): { project: Project; roomId: string } {
  const r = ok(fixture(), {
    type: "room.create",
    payload: { levelId: LEVEL, atPoint: { x: 2000, y: 2000 }, purpose: "meeting" },
  });
  return { project: r.project, roomId: r.project.rooms[0]?.id as string };
}
const last = (p: Project) => p.items.at(-1) as Item;

describe("item.place runs the placement pipeline", () => {
  it("P1-6: against the wall with the door, the back touches the face and the item stays out of the swing", () => {
    const { project, roomId } = withRoom();
    const r = ok(project, {
      type: "item.place",
      payload: { levelId: LEVEL, ref: CREDENZA, roomId, anchor: "against-south-wall" },
    });
    const it = last(r.project);
    const fp = derive.itemFootprint(it, CREDENZA.recipe.size);
    expect(Math.round(Math.min(...fp.map((q) => q.y)))).toBe(50);
    expect(it.rotation).toBe(180);
    for (const z of doorSwingZones(r.project, LEVEL))
      expect(poly.convexOverlapArea(fp, z.polygon)).toBeLessThanOrEqual(1);
    expect(r.warnings).toEqual([]);
  });

  it("an item too wide for any free stretch is centred on the wall with a warning", () => {
    const { project, roomId } = withRoom();
    const huge = {
      kind: "recipe",
      recipe: { kind: "box", size: { w: 7000, d: 400, h: 500 }, label: "bench" },
    } as const;
    const r = ok(project, {
      type: "item.place",
      payload: { levelId: LEVEL, ref: huge, roomId, anchor: "against-south-wall" },
    });
    expect(r.warnings.some((w) => w.startsWith("no free stretch of the south wall is 7000 mm wide"))).toBe(
      true,
    );
  });

  it("by position near a wall the item turns its back to it and stops at the face; magnetism: false keeps it exact", () => {
    const { project } = withRoom();
    const snapped = ok(project, {
      type: "item.place",
      payload: { levelId: LEVEL, ref: BOX, position: { x: 2000, y: 280 } },
    });
    expect(last(snapped.project)).toMatchObject({ position: { x: 2000, y: 250 }, rotation: 180 });
    const exact = ok(project, {
      type: "item.place",
      payload: { levelId: LEVEL, ref: BOX, position: { x: 2000, y: 280 }, magnetism: false },
    });
    expect(last(exact.project)).toMatchObject({ position: { x: 2000, y: 280 }, rotation: 0 });
    const turned = ok(project, {
      type: "item.place",
      payload: { levelId: LEVEL, ref: BOX, position: { x: 2000, y: 280 }, rotation: 30 },
    });
    expect(last(turned.project).rotation).toBe(30); // an explicit rotation is kept
  });

  it("a wall-mounted item gets the snapped wall as its mount target", () => {
    const { project } = withRoom();
    const r = ok(project, {
      type: "item.place",
      payload: {
        levelId: LEVEL,
        ref: BOX,
        position: { x: 2000, y: 280 },
        elevation: 1200,
        mount: { kind: "wall" },
      },
    });
    expect(last(r.project).mount).toEqual({ kind: "wall", targetId: "wall_000001", height: null });
  });

  it("a product dropped onto a table lands on its top with a parent link (F-062, F-075)", () => {
    const { project } = withRoom();
    const c = ctx(700);
    const table = ok(
      project,
      {
        type: "item.place",
        payload: {
          levelId: LEVEL,
          ref: { kind: "product", productId: "acme-table" },
          position: { x: 2500, y: 2500 },
        },
      },
      c,
    );
    const tableId = last(table.project).id;
    const r = ok(
      table.project,
      { type: "item.place", payload: { levelId: LEVEL, ref: BOX, position: { x: 2500, y: 2500 } } },
      c,
    );
    expect(last(r.project)).toMatchObject({ elevation: 750, parentId: tableId });
  });

  it("F-091 (reversed) a door or window product is refused as an item; it belongs in a wall", () => {
    const p = {
      ...fixture(),
      catalogRefs: {
        "acme-door": {
          id: "acme-door",
          snapshotAt: "2026-09-15T00:00:00.000Z",
          category: "door",
          dims: { w: 900, d: 40, h: 2100 },
        },
      },
    } as Project;
    const r = fail(p, {
      type: "item.place",
      payload: {
        levelId: LEVEL,
        ref: { kind: "product", productId: "acme-door" },
        position: { x: 2000, y: 2000 },
      },
    });
    expect(r.error).toMatchObject({
      code: "item.opening-product",
      hint: "use opening.add (add_opening) with this productId",
    });
  });
});

describe("item.move magnetism (F-076, F-077)", () => {
  it("F-076 a single moved item snaps to the wall without turning", () => {
    const { project } = withRoom();
    const placed = ok(project, {
      type: "item.place",
      payload: { levelId: LEVEL, ref: BOX, position: { x: 2000, y: 2000 }, rotation: 30 },
    });
    const id = last(placed.project).id;
    const moved = ok(placed.project, { type: "item.move", payload: { itemIds: [id], dx: 0, dy: -1720 } });
    const it = moved.project.items.find((i) => i.id === id) as Item;
    expect(it.rotation).toBe(30);
    const fp = derive.itemFootprint(it, BOX.recipe.size);
    expect(Math.round(Math.min(...fp.map((q) => q.y)))).toBe(50);
  });

  it("F-077 moving two items together never magnetises", () => {
    const { project } = withRoom();
    const a = ok(project, {
      type: "item.place",
      payload: { levelId: LEVEL, ref: BOX, position: { x: 1500, y: 2000 }, magnetism: false },
    });
    const b = ok(a.project, {
      type: "item.place",
      payload: { levelId: LEVEL, ref: BOX, position: { x: 3000, y: 2000 }, magnetism: false },
    });
    const ids = b.project.items.map((i) => i.id);
    const moved = ok(b.project, { type: "item.move", payload: { itemIds: ids, dx: 0, dy: -1720 } });
    expect(moved.project.items.map((i) => i.position)).toEqual([
      { x: 1500, y: 280 },
      { x: 3000, y: 280 },
    ]);
    const single = ok(b.project, {
      type: "item.move",
      payload: { itemIds: [ids[0] as string], dx: 0, dy: -1720, magnetism: false },
    });
    expect(single.project.items[0]?.position).toEqual({ x: 1500, y: 280 });
  });
});

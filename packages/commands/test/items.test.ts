import { derive, type Item } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { BOX, ctx, fail, fixture, LEVEL, ok } from "./helpers.js";

const item = (p: ReturnType<typeof fixture>, id: string): Item => p.items.find((i) => i.id === id) as Item;

function withRoom() {
  const p = fixture();
  const r = ok(p, {
    type: "room.create",
    payload: { levelId: LEVEL, atPoint: { x: 2000, y: 2000 }, purpose: "meeting" },
  });
  return { project: r.project, roomId: r.project.rooms[0]?.id as string };
}

describe("item.place", () => {
  it("F-008 F-172 placing by position sets defaults and the containing room", () => {
    const { project, roomId } = withRoom();
    const r = ok(project, {
      type: "item.place",
      payload: { levelId: LEVEL, ref: BOX, position: { x: 1000, y: 1000 } },
    });
    const it = r.project.items[0] as Item;
    expect(it.visible).toBe(true);
    expect(it.rotation).toBe(0);
    expect(it.roomId).toBe(roomId);
    expect(r.changes.added).toEqual([{ type: "item", id: it.id }]);
  });

  it("anchors: against-north-wall touches the north face with its back to the wall", () => {
    const { project, roomId } = withRoom();
    const r = ok(project, {
      type: "item.place",
      payload: { levelId: LEVEL, ref: BOX, roomId, anchor: "against-north-wall" },
    });
    const it = r.project.items[0] as Item;
    // north wall of the fixture room: the long edge at y=4950 (x 50..4950) beats the short one at y=2950
    expect(it.position.y).toBe(4950 - 200);
    expect(it.rotation).toBe(0); // back faces +y
    const fp = derive.itemFootprint(it, { w: 600, d: 400, h: 500 });
    expect(Math.max(...fp.map((q) => q.y))).toBe(4950);
  });

  it("anchors: corners and center", () => {
    const { project, roomId } = withRoom();
    const c = ok(project, {
      type: "item.place",
      payload: { levelId: LEVEL, ref: BOX, roomId, anchor: "south-west-corner" },
    });
    const it = c.project.items[0] as Item;
    expect(it.position).toEqual({ x: 50 + 300, y: 50 + 200 });
    expect(it.rotation).toBe(180); // back to the south wall
    const m = ok(project, {
      type: "item.place",
      payload: { levelId: LEVEL, ref: BOX, roomId, anchor: "center" },
    });
    expect(
      derive.roomContains(
        m.project.rooms[0] as (typeof project.rooms)[number],
        m.project.items[0]?.position as { x: number; y: number },
      ),
    ).toBe(true);
  });

  it("anchors: on:<item> stacks with a parent link and the drop ratio elevation (F-062, F-070 reversed)", () => {
    const { project, roomId } = withRoom();
    const table = ok(project, {
      type: "item.place",
      payload: {
        levelId: LEVEL,
        ref: { kind: "product", productId: "acme-table" },
        roomId,
        anchor: "center",
      },
    });
    const tableId = table.project.items[0]?.id as string;
    const lamp = ok(table.project, {
      type: "item.place",
      payload: { levelId: LEVEL, ref: BOX, roomId, anchor: { on: tableId } },
    });
    const it = lamp.project.items[1] as Item;
    expect(it.parentId).toBe(tableId);
    expect(it.elevation).toBe(750);
    expect(it.position).toEqual(table.project.items[0]?.position);
  });

  it("item.anchor-unresolvable when the room has no wall in that direction; catalog snapshot copied on first use", () => {
    const { project, roomId } = withRoom();
    const tri = ok(project, {
      type: "room.create",
      payload: {
        levelId: LEVEL,
        polygon: [
          { x: 6000, y: 4000 },
          { x: 7000, y: 4000 },
          { x: 6500, y: 4900 },
        ],
      },
    });
    const triId = tri.project.rooms[1]?.id as string;
    expect(
      fail(tri.project, {
        type: "item.place",
        payload: { levelId: LEVEL, ref: BOX, roomId: triId, anchor: "against-north-wall" },
      }).error.code,
    ).toBe("item.anchor-unresolvable");
    const r = ok(project, {
      type: "item.place",
      payload: {
        levelId: LEVEL,
        ref: { kind: "product", productId: "acme-chair" },
        roomId,
        anchor: "center",
      },
    });
    expect(r.project.catalogRefs["acme-chair"]?.snapshotAt).toBe("2026-09-15T00:00:00.000Z");
    expect(
      fail(project, {
        type: "item.place",
        payload: { levelId: LEVEL, ref: { kind: "product", productId: "ghost-1" }, position: { x: 1, y: 1 } },
      }).error.code,
    ).toBe("catalog.missing-snapshot");
  });
});

describe("move, rotate, resize, elevation, parent", () => {
  function stacked() {
    const { project } = withRoom();
    const a = ok(project, {
      type: "item.place",
      payload: {
        levelId: LEVEL,
        ref: { kind: "product", productId: "acme-table" },
        position: { x: 2000, y: 2000 },
      },
    });
    const tableId = a.project.items[0]?.id as string;
    const b = ok(a.project, {
      type: "item.place",
      payload: {
        levelId: LEVEL,
        ref: BOX,
        position: { x: 2300, y: 2000 },
        parentId: tableId,
        elevation: 750,
      },
    });
    return { project: b.project, tableId, boxId: b.project.items[1]?.id as string };
  }

  it("F-042 F-070 moving a parent moves its descendants; F-041 rotating a parent orbits them", () => {
    const { project, tableId, boxId } = stacked();
    const moved = ok(project, { type: "item.move", payload: { itemIds: [tableId], dx: 100, dy: -50 } });
    expect(item(moved.project, boxId).position).toEqual({ x: 2400, y: 1950 });
    expect(moved.changes.updated.map((x) => x.id)).toEqual(expect.arrayContaining([tableId, boxId]));
    const rotated = ok(project, { type: "item.rotate", payload: { itemIds: [tableId], delta: 90 } });
    expect(item(rotated.project, boxId).position).toEqual({ x: 2000, y: 2300 });
    expect(item(rotated.project, boxId).rotation).toBe(90);
  });

  it("F-113 F-114 F-001 rotation is absolute or delta and normalised; rotate about a point orbits the item", () => {
    const { project, tableId } = stacked();
    const abs = ok(project, { type: "item.rotate", payload: { itemIds: [tableId], angle: 350 } });
    expect(item(abs.project, tableId).rotation).toBe(350);
    const wrapped = ok(abs.project, { type: "item.rotate", payload: { itemIds: [tableId], delta: 20 } });
    expect(item(wrapped.project, tableId).rotation).toBe(10);
    const orbit = ok(project, {
      type: "item.rotate",
      payload: { itemIds: [tableId], delta: 180, about: { x: 0, y: 0 } },
    });
    expect(item(orbit.project, tableId).position).toEqual({ x: -2000, y: -2000 });
    expect(
      fail(project, { type: "item.rotate", payload: { itemIds: [tableId], angle: 10, delta: 10 } }).error
        .code,
    ).toBe("command.payload");
  });

  it("F-100 F-101 F-102 F-013 resize keeps the back-left corner fixed; non-deformable products refuse a size", () => {
    const { project } = withRoom();
    const placed = ok(project, {
      type: "item.place",
      payload: { levelId: LEVEL, ref: BOX, position: { x: 1000, y: 1000 }, rotation: 0 },
    });
    const id = placed.project.items[0]?.id as string;
    const before = derive.itemFootprint(item(placed.project, id), { w: 600, d: 400, h: 500 })[0];
    const resized = ok(placed.project, {
      type: "item.resize",
      payload: { itemId: id, size: { w: 1200, d: 400, h: 500 } },
    });
    const after = derive.itemFootprint(item(resized.project, id), { w: 1200, d: 400, h: 500 })[0];
    expect(after).toEqual(before);
    expect(item(resized.project, id).position.x).toBe(1300);
    const chair = ok(project, {
      type: "item.place",
      payload: {
        levelId: LEVEL,
        ref: { kind: "product", productId: "acme-chair" },
        position: { x: 500, y: 500 },
      },
    });
    expect(
      fail(chair.project, {
        type: "item.resize",
        payload: { itemId: chair.project.items[0]?.id as string, size: { w: 1, d: 1, h: 1 } },
      }).error.code,
    ).toBe("item.size-not-deformable");
    expect(
      fail(placed.project, { type: "item.resize", payload: { itemId: id, size: { w: 0, d: 1, h: 1 } } }).error
        .code,
    ).toBe("command.payload");
  });

  it("F-071 F-072 F-012 setElevation shifts descendants by the same delta and allows negatives", () => {
    const { project, tableId, boxId } = stacked();
    const r = ok(project, { type: "item.setElevation", payload: { itemIds: [tableId], elevation: -100 } });
    expect(item(r.project, tableId).elevation).toBe(-100);
    expect(item(r.project, boxId).elevation).toBe(650);
  });

  it("F-035 F-040 setParent refuses cycles; a drop ratio lands the item on the parent's top", () => {
    const { project, tableId, boxId } = stacked();
    expect(
      fail(project, { type: "item.setParent", payload: { itemId: tableId, parentId: boxId } }).error.code,
    ).toBe("item.parent-cycle");
    const r = ok(project, {
      type: "item.setParent",
      payload: { itemId: boxId, parentId: tableId, dropRatio: 0.5 },
    });
    expect(item(r.project, boxId).elevation).toBe(375);
    const detached = ok(r.project, { type: "item.setParent", payload: { itemId: boxId, parentId: null } });
    expect(item(detached.project, boxId).parentId).toBeNull();
  });

  it("F-014 F-015 setProduct clears a size override when the new product is not deformable; setFinish checks slots", () => {
    const { project } = withRoom();
    const placed = ok(project, {
      type: "item.place",
      payload: { levelId: LEVEL, ref: BOX, position: { x: 1000, y: 1000 } },
    });
    const id = placed.project.items[0]?.id as string;
    const sized = ok(placed.project, {
      type: "item.resize",
      payload: { itemId: id, size: { w: 700, d: 400, h: 500 } },
    });
    const swapped = ok(sized.project, {
      type: "item.setProduct",
      payload: { itemId: id, ref: { kind: "product", productId: "acme-chair" } },
    });
    expect(item(swapped.project, id).size).toBeNull();
    const fin = ok(swapped.project, {
      type: "item.setFinish",
      payload: {
        itemIds: [id],
        materials: {
          fabric: {
            color: "#112233",
            textureId: null,
            placement: null,
            mirrorForLeftSide: false,
            shininess: null,
          },
        },
      },
    });
    expect(item(fin.project, id).materials.fabric?.color).toBe("#112233");
    expect(
      fail(swapped.project, { type: "item.setFinish", payload: { itemIds: [id], materials: { seat: null } } })
        .error.code,
    ).toBe("item.material-slot");
  });
});

describe("duplicate, delete, align, distribute, arrange", () => {
  it("F-145 F-147 F-148 F-021 R-019 duplicate gives new ids, remaps parents, offsets 200 mm, keeps the level", () => {
    const { project } = withRoom();
    const a = ok(project, {
      type: "item.place",
      payload: {
        levelId: LEVEL,
        ref: { kind: "product", productId: "acme-table" },
        position: { x: 2000, y: 2000 },
      },
    });
    const tableId = a.project.items[0]?.id as string;
    const b = ok(a.project, {
      type: "item.place",
      payload: {
        levelId: LEVEL,
        ref: BOX,
        position: { x: 2000, y: 2000 },
        parentId: tableId,
        elevation: 750,
      },
    });
    const r = ok(b.project, { type: "item.duplicate", payload: { itemIds: [tableId] } });
    expect(r.project.items).toHaveLength(4);
    const [ct, cb] = r.project.items.slice(2) as [Item, Item];
    expect(ct.id).not.toBe(tableId);
    expect(cb.parentId).toBe(ct.id);
    expect(ct.position).toEqual({ x: 2200, y: 2200 });
    expect(ct.levelId).toBe(LEVEL);
  });

  it("F-059 F-174 deleting a parent deletes descendants by default, or re-parents them", () => {
    const { project } = withRoom();
    const a = ok(project, {
      type: "item.place",
      payload: {
        levelId: LEVEL,
        ref: { kind: "product", productId: "acme-table" },
        position: { x: 2000, y: 2000 },
      },
    });
    const tableId = a.project.items[0]?.id as string;
    const b = ok(a.project, {
      type: "item.place",
      payload: {
        levelId: LEVEL,
        ref: BOX,
        position: { x: 2000, y: 2000 },
        parentId: tableId,
        elevation: 750,
      },
    });
    const gone = ok(b.project, { type: "item.delete", payload: { itemIds: [tableId] } });
    expect(gone.project.items).toHaveLength(0);
    const kept = ok(b.project, {
      type: "item.delete",
      payload: { itemIds: [tableId], withDescendants: false },
    });
    expect(kept.project.items).toHaveLength(1);
    expect(kept.project.items[0]?.parentId).toBeNull();
  });

  it("F-164 F-165 F-169 align by compass edge moves only positions; distribute spaces inner items evenly (F-168)", () => {
    const { project } = withRoom();
    let p = project;
    const ids: string[] = [];
    for (const x of [500, 1300, 3000]) {
      const r = ok(p, {
        type: "item.place",
        payload: { levelId: LEVEL, ref: BOX, position: { x, y: 500 + x / 10 }, rotation: 30 },
      });
      p = r.project;
      ids.push(p.items[p.items.length - 1]?.id as string);
    }
    const aligned = ok(p, {
      type: "item.align",
      payload: { itemIds: ids, leadId: ids[0] as string, edge: "north" },
    });
    const north = (it: Item) =>
      Math.max(...derive.itemFootprint(it, { w: 600, d: 400, h: 500 }).map((q) => q.y));
    const lead = item(aligned.project, ids[0] as string);
    for (const id of ids) {
      expect(north(item(aligned.project, id))).toBeCloseTo(north(lead), 0);
      expect(item(aligned.project, id).rotation).toBe(30);
    }
    const spread = ok(p, { type: "item.distribute", payload: { itemIds: ids, axis: "x" } });
    const xs = ids.map((id) => item(spread.project, id).position.x);
    expect(xs[0]).toBe(500);
    expect(xs[2]).toBe(3000);
    expect(xs[1]).toBe(1750);
    expect(
      fail(p, { type: "item.distribute", payload: { itemIds: ids.slice(0, 2), axis: "x" } }).error.code,
    ).toBe("command.payload");
  });

  it("item.arrange grid fills a room with a zone that regenerates; unsupported patterns say so", () => {
    const { project, roomId } = withRoom();
    const rule = {
      pattern: "grid" as const,
      productId: null,
      recipe: BOX.recipe,
      count: 12,
      spacing: { x: 400, y: 400 },
      facing: 0,
      margin: 500,
    };
    const r = ok(project, { type: "item.arrange", payload: { target: { roomId }, rule } });
    expect(r.project.zones).toHaveLength(1);
    expect(r.project.items.length).toBe(12);
    expect(r.project.zones[0]?.generatedItemIds).toHaveLength(12);
    for (const it of r.project.items)
      expect(derive.roomContains(r.project.rooms[0] as (typeof project.rooms)[number], it.position)).toBe(
        true,
      );
    const zoneId = r.project.zones[0]?.id as string;
    const regen = ok(r.project, { type: "zone.regenerate", payload: { zoneId } });
    expect(regen.project.items.length).toBe(12);
    expect(regen.changes.removed).toHaveLength(12);
    expect(regen.changes.added).toHaveLength(12);
    const tooMany = ok(project, {
      type: "item.arrange",
      payload: { target: { roomId }, rule: { ...rule, count: 500 } },
    });
    expect(tooMany.warnings[0]).toMatch(/placed \d+ of 500/);
    expect(
      fail(project, {
        type: "item.arrange",
        payload: { target: { roomId }, rule: { ...rule, pattern: "boardroom" } },
      }).error.code,
    ).toBe("command.precondition");
    expect(ctx().now()).toBe("2026-09-15T00:00:00.000Z");
  });

  it("F-166 F-167 F-170 lead-frame alignment: front edge and side-by-side in the lead frame", () => {
    const { project } = withRoom();
    let p = project;
    const ids: string[] = [];
    for (const [x, y] of [
      [1000, 1000],
      [1800, 1500],
      [2600, 900],
    ] as [number, number][]) {
      const r = ok(p, {
        type: "item.place",
        payload: { levelId: LEVEL, ref: BOX, position: { x, y }, rotation: 0 },
      });
      p = r.project;
      ids.push(p.items[p.items.length - 1]?.id as string);
    }
    const front = ok(p, {
      type: "item.align",
      payload: { itemIds: ids, leadId: ids[0] as string, edge: "front" },
    });
    for (const id of ids) expect(item(front.project, id).position.y).toBe(1000);
    const side = ok(p, {
      type: "item.align",
      payload: { itemIds: ids, leadId: ids[0] as string, edge: "side-by-side" },
    });
    const xs = ids.map((id) => item(side.project, id).position.x);
    expect(xs).toEqual([1000, 1600, 2200]);
    for (const id of ids) expect(item(side.project, id).position.y).toBe(1000);
  });
});

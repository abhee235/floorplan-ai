// PRD P1-6 acceptance through the tools: an item placed against a wall touches the face with its back and
// stays out of the door swing; placing by position snaps; snap: false keeps the exact position.
import { doorSwingZones } from "@fpv/geometry";
import { derive, type Item, poly } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { buildFixtureRoom, harness } from "./helpers.js";

const CREDENZA = { kind: "box", size: { w: 1800, d: 500, h: 720 }, label: "Credenza" } as const;
const BOX = { kind: "box", size: { w: 600, d: 400, h: 500 }, label: "Box" } as const;
const L = "level_000000";

const itemOf = (h: ReturnType<typeof harness>, id: string) =>
  h.ctx.store.project.items.find((i) => i.id === id) as Item;

describe("placement pipeline through place_item (PRD P1-6, spec 05 section 5)", () => {
  it("against the wall with the door: back on the wall face, clear of the door swing, no warning", async () => {
    const h = harness();
    const { roomId } = await buildFixtureRoom(h); // door in the middle of the south wall
    const r = await h.ok<{ item: { id: string } }>("place_item", {
      recipe: CREDENZA,
      roomId,
      anchor: "against-south-wall",
    });
    const it = itemOf(h, r.result.item.id);
    const fp = derive.itemFootprint(it, CREDENZA.size);
    expect(Math.round(Math.min(...fp.map((q) => q.y)))).toBe(50); // the south wall's inner face
    expect(it.rotation).toBe(180); // back to the wall
    for (const z of doorSwingZones(h.ctx.store.project, L))
      expect(poly.convexOverlapArea(fp, z.polygon)).toBeLessThanOrEqual(1);
    expect(r.warnings.filter((w) => /swing|door/.test(w))).toEqual([]);
  });

  it("against the north wall: the back touches the face", async () => {
    const h = harness();
    const { roomId } = await buildFixtureRoom(h);
    const r = await h.ok<{ item: { id: string } }>("place_item", {
      recipe: CREDENZA,
      roomId,
      anchor: "against-north-wall",
    });
    const it = itemOf(h, r.result.item.id);
    const fp = derive.itemFootprint(it, CREDENZA.size);
    expect(Math.round(Math.max(...fp.map((q) => q.y)))).toBe(4950);
    expect(it.rotation).toBe(0);
  });

  it("placing near a wall by position snaps and turns it; snap: false keeps the exact position", async () => {
    const h = harness();
    await buildFixtureRoom(h);
    const snapped = await h.ok<{ item: { id: string }; adjusted: boolean }>("place_item", {
      recipe: BOX,
      levelId: L,
      x: 2000,
      y: 280,
    });
    expect(snapped.result.adjusted).toBe(true);
    expect(itemOf(h, snapped.result.item.id)).toMatchObject({ position: { x: 2000, y: 250 }, rotation: 180 });
    const exact = await h.ok<{ item: { id: string }; adjusted: boolean }>("place_item", {
      recipe: BOX,
      levelId: L,
      x: 6000,
      y: 280,
      snap: false,
    });
    expect(exact.result.adjusted).toBe(false);
    expect(itemOf(h, exact.result.item.id)).toMatchObject({ position: { x: 6000, y: 280 }, rotation: 0 });
  });

  it("a wall-mounted item placed against a wall gets that wall as its mount target", async () => {
    const h = harness();
    await buildFixtureRoom(h);
    const r = await h.ok<{ item: { id: string } }>("place_item", {
      recipe: { kind: "display", diagonalIn: 55, bezelMm: 10 },
      levelId: L,
      x: 2000,
      y: 4900,
      elevation: 900,
      mount: { kind: "wall" },
    });
    const it = itemOf(h, r.result.item.id);
    expect(it.mount.targetId).toBe("wall_000005"); // the long north wall of the fixture room
    expect(Math.max(...derive.itemFootprint(it, { w: 1, d: 60, h: 1 }).map((q) => q.y))).toBe(4950);
    expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
  });

  it("moving one item pushes it out of the wall to the face without turning it", async () => {
    const h = harness();
    await buildFixtureRoom(h);
    const a = await h.ok<{ item: { id: string } }>("place_item", {
      recipe: BOX,
      levelId: L,
      x: 2000,
      y: 2000,
      rotation: 30,
    });
    await h.ok("modify_item", { itemId: a.result.item.id, y: 280 });
    expect(itemOf(h, a.result.item.id).rotation).toBe(30);
    const moved = itemOf(h, a.result.item.id);
    // turned 30 degrees, the box would reach into the wall at y 280; it is pushed out until its nearest corner is on the face
    expect(Math.round(Math.min(...derive.itemFootprint(moved, BOX.size).map((q) => q.y)))).toBe(50);
    expect(moved.position.y).toBe(373);
  });
});

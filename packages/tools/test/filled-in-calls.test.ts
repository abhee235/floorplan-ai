// place_item and create_room read a filled-in call the plain way instead of refusing it. Live runs on
// pictures sent "" for unused fields, a floor mount with a target, and all three ways to make a room.
import { describe, expect, it } from "vitest";
import { harness } from "./helpers.js";

const sofa = { kind: "sofa", size: { w: 2000, d: 900, h: 800 } };

describe("place_item", () => {
  it("takes empty strings as fields left out", async () => {
    const h = harness();
    const r = await h.ok<{ item: { position: { x: number; y: number } } }>("place_item", {
      productId: "",
      recipe: sofa,
      x: 3200,
      y: 2500,
      roomId: "",
      anchor: "",
      levelId: "level_000000",
      mount: { kind: "floor", targetId: "", height: 0 },
      snap: false,
    });
    expect(r.result.item.position).toEqual({ x: 3200, y: 2500 });
  });

  it("ignores a floor mount's target and a recipe's made-up productId, and says so", async () => {
    const h = harness();
    const r = await h.ok("place_item", {
      productId: "recipe:sofa:2000x900x800",
      recipe: sofa,
      x: 1000,
      y: 1000,
      mount: { kind: "floor", targetId: "level_000000" },
      snap: false,
    });
    expect(r.warnings.join(" ")).toMatch(/targetId level_000000 was ignored/);
    expect(r.warnings.join(" ")).toMatch(/recipe was used/);
  });

  it("reads a recipe's name given as the productId as that recipe", async () => {
    const h = harness();
    const r = await h.ok<{ item: { ref: string } }>("place_item", {
      productId: "recipe:table:boat:3600x1400x750",
      x: 3000,
      y: 2000,
      snap: false,
    });
    expect(r.warnings.join(" ")).toMatch(/read as the recipe it names/);
    const item = h.ctx.store.project.items[0];
    expect(item?.ref).toEqual({
      kind: "recipe",
      recipe: { kind: "table", size: { w: 3600, d: 1400, h: 750 }, shape: "boat" },
    });
  });

  it("still refuses a recipe name that names no recipe", async () => {
    const h = harness();
    const r = await h.call("place_item", { productId: "recipe:spaceship:1x2x3", x: 0, y: 0 });
    expect(r.ok).toBe(false);
  });

  it("uses x and y when an anchor comes too", async () => {
    const h = harness();
    const r = await h.ok<{ item: { position: { x: number; y: number } } }>("place_item", {
      recipe: sofa,
      x: 1500,
      y: 800,
      anchor: "center",
      snap: false,
    });
    expect(r.result.item.position).toEqual({ x: 1500, y: 800 });
    expect(r.warnings.join(" ")).toMatch(/anchor center was ignored/);
  });
});

describe("any tool", () => {
  it("takes an empty list or a null where the call fails as the field left out, and says so", async () => {
    const h = harness();
    const r = await h.ok<{ room: { areaM2: number } }>("create_room", {
      levelId: "level_000000",
      polygon: [],
      rect: { x: 0, y: 0, w: 3000, d: 2000 },
      atPoint: null,
      name: "Store",
    });
    expect(r.result.room.areaM2).toBeCloseTo(6, 1);
    expect(r.warnings.join(" ")).toMatch(/Empty values taken as left out: .*polygon/);
  });

  it("still refuses a call whose empty value is the only one it gave", async () => {
    const h = harness();
    const r = await h.call("create_room", { levelId: "level_000000", polygon: [] });
    expect(r.ok).toBe(false);
  });
});

describe("create_room", () => {
  it("uses the polygon when a rect and a point come too", async () => {
    const h = harness();
    const polygon = [
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
      { x: 4000, y: 3000 },
      { x: 0, y: 3000 },
    ];
    const r = await h.ok<{ room: { areaM2: number } }>("create_room", {
      levelId: "level_000000",
      polygon,
      rect: { x: 0, y: 0, w: 1, d: 1 },
      atPoint: { x: 2000, y: 1500 },
      name: "Meeting room",
    });
    expect(r.result.room.areaM2).toBeCloseTo(12, 1);
    expect(r.warnings.join(" ")).toMatch(/polygon was used/);
  });
});

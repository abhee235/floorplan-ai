import { defaultItem, defaultLevel, derive } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import {
  type AssetRegistry,
  buildItems,
  buildRecipe,
  itemMatrix,
  multiply,
  partArea,
  partBounds,
  recipeAssetKey,
  rotationY,
  transformPoint,
  translation,
} from "../src/index.js";

const level = defaultLevel("level_000000", { elevation: 0, height: 2700, floorThickness: 300 });
const L = level.id;
const box = {
  kind: "recipe" as const,
  recipe: { kind: "box" as const, size: { w: 600, d: 400, h: 500 }, label: "b" },
};
const size = { w: 600, d: 400, h: 500 };
const noSizes: derive.SizeSource = { product: () => null };

describe("item matrices", () => {
  it("F-129 translation puts the item at (x, ground elevation, -y) in metres", () => {
    const it = defaultItem("item_zz0001", L, box, { x: 1000, y: 2000 }, { elevation: 100 });
    const m = itemMatrix(it, size, { ...level, elevation: 250 }, null);
    expect(transformPoint(m, [0, 0, 0]).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 0.35, -2]);
  });

  it("a counter-clockwise plan rotation maps to the three.js y rotation", () => {
    const it = defaultItem("item_zz0002", L, box, { x: 0, y: 0 }, { rotation: 90 });
    const m = itemMatrix(it, size, level, null);
    // local +x (item right) rotated 90 degrees counter-clockwise in plan points to plan +y, which is three.js -z
    const p = transformPoint(m, [1, 0, 0]).map((v) => Math.round(v * 1e6) / 1e6);
    expect(p).toEqual([0, 0, -1]);
    expect(multiply(translation(1, 2, 3), rotationY(0))[12]).toBe(1);
  });

  it("F-119 F-120 F-121 F-125 mirroring negates the x scale; product assets scale from their bbox", () => {
    const it = defaultItem("item_zz0003", L, box, { x: 0, y: 0 }, { mirrored: true });
    const m = itemMatrix(it, size, level, null);
    expect(m[0]).toBe(-1);
    const chair = defaultItem("item_zz0004", L, { kind: "product", productId: "acme-chair" }, { x: 0, y: 0 });
    const scaled = itemMatrix(chair, { w: 600, d: 600, h: 900 }, level, { w: 1, d: 1, h: 1 });
    expect(scaled[0]).toBeCloseTo(0.6, 9);
    expect(scaled[5]).toBeCloseTo(0.9, 9);
    expect(scaled[10]).toBeCloseTo(0.6, 9);
  });

  it("F-123 F-127 F-128 O-083 buildItems resolves sizes, asset keys and visibility; unknown products are skipped", () => {
    const registry: AssetRegistry = {
      keyFor: (id) => (id === "acme-chair" ? "chair/task/std" : null),
      bbox: (key) => (key === "chair/task/std" ? { w: 0.5, d: 0.5, h: 0.9 } : null),
    };
    const sizes: derive.SizeSource = {
      product: (id) => (id === "acme-chair" ? { dims: { w: 600, d: 600, h: 900 }, deformable: false } : null),
    };
    const items = [
      defaultItem("item_zz0005", L, box, { x: 0, y: 0 }),
      defaultItem("item_zz0006", L, { kind: "product", productId: "acme-chair" }, { x: 0, y: 0 }),
      defaultItem("item_zz0007", L, { kind: "product", productId: "ghost-1" }, { x: 0, y: 0 }),
      defaultItem("item_zz0008", "level_zzzzzz", box, { x: 0, y: 0 }),
    ];
    const out = buildItems(items, { level, sizes, assets: registry });
    expect(out.map((i) => i.entityId)).toEqual(["item_zz0005", "item_zz0006"]);
    expect(out[0]?.assetKey).toBe("recipe:box:600x400x500");
    expect(out[1]?.assetKey).toBe("chair/task/std");
    expect(out[1]?.matrix[0]).toBeCloseTo(1.2, 9);
    expect(out.every((i) => i.visible)).toBe(true);
    const hidden = buildItems([{ ...(items[0] as (typeof items)[number]), visible: false }], {
      level,
      sizes,
      assets: registry,
    });
    expect(hidden[0]?.visible).toBe(false);
    // recipes size themselves; a product with no catalog size cannot be placed and is skipped (F-128)
    expect(buildItems(items, { level, sizes: noSizes }).map((i) => i.entityId)).toEqual(["item_zz0005"]);
  });
});

describe("recipes", () => {
  it("F-122 F-124 F-126 a box recipe is centred on the footprint with its base at y = 0", () => {
    const part = buildRecipe(box.recipe);
    const b = partBounds(part);
    const close = (got: number[], want: number[]) =>
      got.forEach((v, i) => expect(v).toBeCloseTo(want[i] as number, 6));
    close(b.min, [-0.3, 0, -0.2]);
    close(b.max, [0.3, 0.5, 0.2]);
    expect(partArea(part)).toBeCloseTo(2 * (0.6 * 0.4 + 0.6 * 0.5 + 0.4 * 0.5), 6);
    expect(recipeAssetKey(box.recipe)).toBe("recipe:box:600x400x500");
  });

  it("table, chair, cylinder, display and ceiling speaker recipes build within their size", () => {
    const table = buildRecipe({ kind: "table", size: { w: 2400, d: 1200, h: 750 }, shape: "rect" });
    partBounds(table).max.forEach((v, i) => expect(v).toBeCloseTo([1.2, 0.75, 0.6][i] as number, 6));
    const chair = buildRecipe({ kind: "chair", size: { w: 600, d: 600, h: 900 } });
    expect(partBounds(chair).max[1]).toBeCloseTo(0.9, 6);
    const cyl = buildRecipe({ kind: "cylinder", diameter: 300, height: 400, label: "c" });
    expect(partBounds(cyl).max[0]).toBeCloseTo(0.15, 6);
    const display = buildRecipe({ kind: "display", diagonalIn: 75, bezelMm: 0 });
    expect(partBounds(display).max[0]).toBeCloseTo(0.83, 6);
    const spk = buildRecipe({ kind: "ceiling-speaker", diameter: 200 });
    expect(partBounds(spk).max[1]).toBeCloseTo(0.1, 6);
    const round = buildRecipe({ kind: "table", size: { w: 1200, d: 1200, h: 750 }, shape: "round" });
    expect(partBounds(round).max[1]).toBeCloseTo(0.75, 6);
  });
});

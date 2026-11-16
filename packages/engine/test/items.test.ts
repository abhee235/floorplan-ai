import { defaultItem, defaultLevel, derive } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import {
  type AssetRegistry,
  buildItems,
  buildRecipe,
  buildRecipeParts,
  fallbackRecipe,
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

  it("a recipe item given a size of its own is scaled to it, keeping the recipe's mesh", () => {
    const own = buildItems([defaultItem("item_zz0009", L, box, { x: 0, y: 0 })], { level, sizes: noSizes });
    expect([own[0]?.matrix[0], own[0]?.matrix[5], own[0]?.matrix[10]]).toEqual([1, 1, 1]);
    const resized = defaultItem("item_zz0010", L, box, { x: 0, y: 0 }, { size: { w: 1200, d: 400, h: 250 } });
    const [inst] = buildItems([resized], { level, sizes: noSizes });
    expect(inst?.assetKey).toBe("recipe:box:600x400x500");
    expect(inst?.matrix[0]).toBeCloseTo(2, 9);
    expect(inst?.matrix[5]).toBeCloseTo(0.5, 9);
    expect(inst?.matrix[10]).toBeCloseTo(1, 9);
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

describe("item parts and their materials (P3-5)", () => {
  const finish = (color: string | null, shininess: number | null = null) => ({
    color,
    textureId: null,
    placement: null,
    mirrorForLeftSide: false,
    shininess,
  });
  const chair = {
    kind: "recipe" as const,
    recipe: { kind: "chair" as const, size: { w: 600, d: 600, h: 900 } },
  };

  it("builds a recipe part by part, in its slot order, covering what the one-part mesh covers", () => {
    for (const recipe of [
      chair.recipe,
      { kind: "table" as const, size: { w: 2400, d: 1200, h: 750 }, shape: "round" as const },
      { kind: "display" as const, diagonalIn: 65, bezelMm: 10 },
      box.recipe,
    ]) {
      const parts = buildRecipeParts(recipe);
      expect(parts.map((p) => p.slot)).toEqual([...derive.recipeSlots(recipe.kind)]);
      expect(parts.map((p) => p.materialKey)).toEqual(parts.map((p) => `${recipe.kind}/${p.slot}`));
      const whole = partBounds(buildRecipe(recipe));
      const bounds = parts.map(partBounds);
      for (const axis of [0, 1, 2]) {
        const low = Math.min(...bounds.map((b) => b.min[axis] as number));
        const high = Math.max(...bounds.map((b) => b.max[axis] as number));
        expect(low).toBeCloseTo(whole.min[axis] as number, 6);
        expect(high).toBeCloseTo(whole.max[axis] as number, 6);
      }
      expect(parts.reduce((n, p) => n + partArea(p), 0)).toBeCloseTo(partArea(buildRecipe(recipe)), 6);
    }
  });

  it("gives each part its own finish, else the item's, else its plain material", () => {
    const plain = defaultItem("item_zz0011", L, chair, { x: 0, y: 0 });
    const [inst] = buildItems([plain], { level, sizes: noSizes });
    expect(inst?.materials).toEqual([
      { slot: "fabric", materialKey: "chair/fabric" },
      { slot: "frame", materialKey: "chair/frame" },
    ]);
    const dressed = {
      ...plain,
      finish: finish("#222222"),
      materials: { fabric: finish("#AA3333", 0.25) },
    };
    expect(buildItems([dressed], { level, sizes: noSizes })[0]?.materials).toEqual([
      { slot: "fabric", materialKey: "chair/fabric|#AA3333|0.25" },
      { slot: "frame", materialKey: "chair/frame|#222222|" },
    ]);
  });

  it("draws a product without a model as its category's recipe, scaled onto the product's size", () => {
    const sizes: derive.SizeSource = {
      product: (id) =>
        id === "acme-screen"
          ? { dims: { w: 1450, d: 70, h: 830 }, deformable: false, category: "display", assetKey: null }
          : id === "acme-lamp"
            ? { dims: { w: 300, d: 300, h: 1600 }, deformable: false, category: "lighting", assetKey: null }
            : null,
    };
    const screen = defaultItem(
      "item_zz0012",
      L,
      { kind: "product", productId: "acme-screen" },
      { x: 0, y: 0 },
    );
    const lamp = defaultItem("item_zz0013", L, { kind: "product", productId: "acme-lamp" }, { x: 0, y: 0 });
    const [s, l] = buildItems([screen, lamp], { level, sizes });
    expect(s?.recipe?.kind).toBe("display");
    expect(s?.materials.map((m) => m.slot)).toEqual(["screen", "frame"]);
    // the display recipe comes out a little off the product's size; the matrix makes it exact
    if (!s?.recipe) throw new Error("the screen should be drawn as a recipe");
    const drawn = derive.recipeSize(s.recipe);
    expect((s?.matrix[0] as number) * drawn.w).toBeCloseTo(1450, 6);
    expect((s?.matrix[5] as number) * drawn.h).toBeCloseTo(830, 6);
    expect((s?.matrix[10] as number) * drawn.d).toBeCloseTo(70, 6);
    expect(l?.recipe).toEqual({ kind: "box", size: { w: 300, d: 300, h: 1600 }, label: "acme-lamp" });
    expect(fallbackRecipe("ceiling-speaker", { w: 200, d: 200, h: 90 }, "x")).toEqual({
      kind: "ceiling-speaker",
      diameter: 200,
    });
  });
});

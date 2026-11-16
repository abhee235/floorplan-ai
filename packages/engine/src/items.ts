// Item instances (ADR-003 D3 two-stage transform; ledger F-119..F-129). Assets are normalised offline to
// metres with origin at the footprint centre and base at y = 0 (ADR-010 D3), so the per-item matrix is
// scale (size / asset bbox, x negated when mirrored) then rotation about y then translation.
import { entryFor, resolveAssetKey } from "@fpv/assets";
import type { Item, Level, PrimitiveRecipe, Size3 } from "@fpv/ir";
import { derive } from "@fpv/ir";
import { finishedMaterialKey, type TextureSource } from "./palette.js";
import { fallbackRecipe, recipeAssetKey, recipeSlotKey } from "./recipes.js";
import { type ItemInstance, MM_PER_M } from "./types.js";

export interface AssetRegistry {
  /** The loaded model asset for a product; null draws the product as its category's recipe. */
  keyFor(productId: string): string | null;
  /** Normalised bounding box of an asset in metres, or null when unknown (scale 1 is assumed). */
  bbox(assetKey: string): { w: number; d: number; h: number } | null;
}

export const noAssets: AssetRegistry = { keyFor: () => null, bbox: () => null };

// ---- column-major 4x4 helpers (three.js layout) ---------------------------

export type Mat4 = number[];

export function identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let s = 0;
      for (let k = 0; k < 4; k += 1) s += (a[k * 4 + row] as number) * (b[col * 4 + k] as number);
      out[col * 4 + row] = s;
    }
  }
  return out;
}

export function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function scaling(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

/** Rotation about +y by `deg`; a counter-clockwise plan rotation maps to this in the three.js frame. */
export function rotationY(deg: number): Mat4 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const m = identity();
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

export function transformPoint(m: Mat4, p: [number, number, number]): [number, number, number] {
  return [
    (m[0] as number) * p[0] + (m[4] as number) * p[1] + (m[8] as number) * p[2] + (m[12] as number),
    (m[1] as number) * p[0] + (m[5] as number) * p[1] + (m[9] as number) * p[2] + (m[13] as number),
    (m[2] as number) * p[0] + (m[6] as number) * p[1] + (m[10] as number) * p[2] + (m[14] as number),
  ];
}

// ---- instances ------------------------------------------------------------

/**
 * What an item is drawn as: a model asset the registry holds for its product (`recipe` null), or a recipe,
 * which is the item's own or, for a product without a model, its category's at the product's size
 * (spec 02 section 3.1).
 */
export function drawnAs(
  item: Item,
  size: Size3,
  sizes: derive.SizeSource,
  assets: AssetRegistry,
): { assetKey: string; recipe: PrimitiveRecipe | null } {
  if (item.ref.kind === "recipe")
    return { assetKey: recipeAssetKey(item.ref.recipe), recipe: item.ref.recipe };
  const model = assets.keyFor(item.ref.productId);
  if (model) return { assetKey: model, recipe: null };
  const info = sizes.product(item.ref.productId);
  const entry = entryFor(
    resolveAssetKey({ category: info?.category ?? "other", dims: size, assetKey: info?.assetKey ?? null }),
  );
  const recipe = fallbackRecipe(entry.recipe ?? "box", size, item.ref.productId);
  return { assetKey: recipeAssetKey(recipe), recipe };
}

export function assetKeyFor(
  item: Item,
  size: Size3,
  assets: AssetRegistry,
  sizes?: derive.SizeSource,
): string {
  return drawnAs(item, size, sizes ?? { product: () => null }, assets).assetKey;
}

/** Stage two of the transform for one item (F-129): scale, mirror, rotate, translate. */
export function itemMatrix(
  item: Item,
  size: Size3,
  level: Level,
  assetBbox: { w: number; d: number; h: number } | null,
): Mat4 {
  const sx = assetBbox ? size.w / MM_PER_M / assetBbox.w : 1;
  const sy = assetBbox ? size.h / MM_PER_M / assetBbox.h : 1;
  const sz = assetBbox ? size.d / MM_PER_M / assetBbox.d : 1;
  const scale = scaling(item.mirrored ? -sx : sx, sy, sz);
  const rot = rotationY(item.rotation);
  const t = translation(
    item.position.x / MM_PER_M,
    derive.itemGroundElevation(item, level) / MM_PER_M,
    -item.position.y / MM_PER_M,
  );
  return multiply(t, multiply(rot, scale));
}

export interface ItemBuildContext {
  level: Level;
  sizes: derive.SizeSource;
  assets?: AssetRegistry;
  /** Texture sizes, for parts that wear a texture; without it a texture is left off. */
  textures?: TextureSource;
}

/**
 * The material of each of a recipe's parts, in slot order: the part's own finish on the item, else the
 * item's finish, else the part's plain material.
 */
function slotMaterials(
  item: Item,
  recipe: PrimitiveRecipe,
  textures?: TextureSource,
): ItemInstance["materials"] {
  return derive.recipeSlots(recipe.kind).map((slot) => ({
    slot,
    materialKey: finishedMaterialKey(
      recipeSlotKey(recipe.kind, slot),
      item.materials[slot] ?? item.finish,
      textures,
    ),
  }));
}

/** A recipe's own size in metres: the box its mesh is built to fill. */
function recipeBox(recipe: PrimitiveRecipe): { w: number; d: number; h: number } {
  const s = derive.recipeSize(recipe);
  return { w: s.w / MM_PER_M, d: s.d / MM_PER_M, h: s.h / MM_PER_M };
}

/** Instances for the items of one level; items without a resolvable size are skipped. */
export function buildItems(items: readonly Item[], ctx: ItemBuildContext): ItemInstance[] {
  const assets = ctx.assets ?? noAssets;
  const out: ItemInstance[] = [];
  for (const it of items) {
    if (it.levelId !== ctx.level.id) continue;
    const size = derive.itemSize(it, ctx.sizes);
    if (!size) continue;
    const { assetKey, recipe } = drawnAs(it, size, ctx.sizes, assets);
    // A recipe mesh is built at the recipe's own size, so the matrix scales it onto the item's; left at
    // scale 1, a resized box grew on the plan and stayed the same in the view.
    const bbox = recipe ? recipeBox(recipe) : assets.bbox(assetKey);
    out.push({
      entityId: it.id,
      assetKey,
      recipe,
      matrix: itemMatrix(it, size, ctx.level, bbox),
      materials: recipe ? slotMaterials(it, recipe, ctx.textures) : [],
      visible: it.visible,
    });
  }
  return out;
}

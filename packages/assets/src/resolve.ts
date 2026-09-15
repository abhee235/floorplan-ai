// Asset key resolution (spec 02 section 3.1, ADR-010 D1): explicit key, else the nearest default size
// class for the category, else the category's recipe, else the labelled box.
import type { Size3 } from "@fpv/ir";
import { RECIPE_MANIFEST } from "./recipes.js";
import type { AssetEntry } from "./schema.js";

export interface AssetKeyInput {
  category: string;
  /** Millimetres. */
  dims: Size3;
  assetKey: string | null;
}

/** Sum of absolute log ratios of w, d, h between a product (mm) and an entry (metres). */
export function sizeDistance(dims: Size3, bbox: { w: number; d: number; h: number }): number {
  const ratio = (a: number, b: number) => Math.abs(Math.log(Math.max(a, 1) / 1000 / Math.max(b, 1e-3)));
  return ratio(dims.w, bbox.w) + ratio(dims.d, bbox.d) + ratio(dims.h, bbox.h);
}

/**
 * The manifest entries in play: the given ones plus the built-in recipes. A given entry with the same
 * key as a built-in one replaces it, so a pack can supply `chair/default/std` as a real mesh.
 */
export function withBuiltIns(entries: readonly AssetEntry[]): AssetEntry[] {
  const byKey = new Map<string, AssetEntry>();
  for (const e of RECIPE_MANIFEST.entries) byKey.set(e.key, e);
  for (const e of entries) byKey.set(e.key, e);
  return [...byKey.values()];
}

export function resolveAssetKey(product: AssetKeyInput, entries: readonly AssetEntry[] = []): string {
  const all = withBuiltIns(entries);
  const byKey = new Map(all.map((e) => [e.key, e]));
  if (product.assetKey && byKey.has(product.assetKey)) return product.assetKey;
  const prefix = `${product.category}/default/`;
  let best: { key: string; d: number } | null = null;
  for (const e of all) {
    if (!e.key.startsWith(prefix)) continue;
    const d = sizeDistance(product.dims, e.bbox);
    if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && e.key.endsWith("/std")))
      best = { key: e.key, d };
  }
  if (best) return best.key;
  return "other/default/std";
}

/** The entry a key resolves to, or the labelled box when the key is unknown. */
export function entryFor(key: string, entries: readonly AssetEntry[] = []): AssetEntry {
  const all = withBuiltIns(entries);
  return all.find((e) => e.key === key) ?? (all.find((e) => e.key === "other/default/std") as AssetEntry);
}

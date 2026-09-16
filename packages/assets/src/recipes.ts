// The built-in manifest: one recipe entry per category fallback (spec 02 section 3.1). Always present,
// never on disk, so every product resolves to something drawable (ADR-010 D2 tier 1).
import { derive } from "@fpv/ir";
import type { AssetEntry, AssetManifest, RecipeKind } from "./schema.js";

const GENERATED = { id: "generated", author: null, sourceUrl: null, attribution: null } as const;

function recipeEntry(key: string, recipe: RecipeKind, bbox: { w: number; d: number; h: number }): AssetEntry {
  return {
    key,
    kind: "recipe",
    file: null,
    recipe,
    bbox,
    triangles: 0,
    bytes: 0,
    sha256: null,
    materialSlots: [...derive.recipeSlots(recipe)],
    articulations: [],
    presets: {},
    planIcon: null,
    licence: { ...GENERATED },
    tags: ["recipe"],
  };
}

/** Category to fallback recipe (spec 02 section 3.1 table). Categories not listed use the box. */
export const CATEGORY_RECIPE: Readonly<Record<string, RecipeKind>> = {
  table: "table",
  desk: "table",
  chair: "chair",
  sofa: "chair",
  display: "display",
  "video-bar": "video-bar",
  soundbar: "video-bar",
  "ceiling-speaker": "ceiling-speaker",
  "ceiling-mic": "ceiling-mic",
};

/** Typical sizes in metres so the nearest-size-class rule has something to compare against. */
const RECIPE_BBOX: Readonly<Record<RecipeKind, { w: number; d: number; h: number }>> = {
  box: { w: 0.6, d: 0.4, h: 0.5 },
  cylinder: { w: 0.3, d: 0.3, h: 0.4 },
  table: { w: 2.4, d: 1.2, h: 0.75 },
  chair: { w: 0.6, d: 0.6, h: 0.9 },
  display: { w: 1.68, d: 0.06, h: 0.96 },
  "video-bar": { w: 1.2, d: 0.1, h: 0.1 },
  "ceiling-speaker": { w: 0.2, d: 0.2, h: 0.1 },
  "ceiling-mic": { w: 0.6, d: 0.6, h: 0.05 },
};

export const RECIPE_MANIFEST: AssetManifest = {
  version: 1,
  entries: [
    ...Object.entries(CATEGORY_RECIPE).map(([category, recipe]) =>
      recipeEntry(`${category}/default/std`, recipe, RECIPE_BBOX[recipe]),
    ),
    recipeEntry("other/default/std", "box", RECIPE_BBOX.box),
    recipeEntry("other/default/cylinder", "cylinder", RECIPE_BBOX.cylinder),
  ],
};

/** The recipe a category falls back to when no manifest entry fits (spec 02 section 3.1). */
export function recipeForCategory(category: string): RecipeKind {
  return CATEGORY_RECIPE[category] ?? "box";
}

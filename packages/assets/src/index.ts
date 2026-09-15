// @fpv/assets: Primitive recipes, glTF manifest, licence manifest (spec 02 section 3, ADR-010)
export const PACKAGE = "assets" as const;
export { CATEGORY_RECIPE, RECIPE_MANIFEST, recipeForCategory } from "./recipes.js";
export { type AssetKeyInput, entryFor, resolveAssetKey, sizeDistance, withBuiltIns } from "./resolve.js";
export {
  Articulation,
  AssetEntry,
  AssetManifest,
  Licence,
  LicenceId,
  licenceProblems,
  MAX_BYTES,
  MAX_TRIANGLES,
  type ManifestProblem,
  RecipeKind,
  validateManifest,
} from "./schema.js";

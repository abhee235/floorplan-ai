// @fpv/engine: IR to geometry buffers and item instances, plus the invalidation table (docs/spec/05, ADR-003, ADR-014, ADR-015).
export const PACKAGE = "engine" as const;
export { type CutOutSource, type CutOutSpec, cutOutSource, snapshotCutOuts } from "./cutouts.js";
export { emptyRebuildSet, expand, type Layer, type RebuildSet } from "./expand.js";
export {
  buildGround,
  GROUND_DEPTH_MM,
  GROUND_ID,
  GROUND_MARGIN_MM,
  type Ground,
  type GroundBuildContext,
} from "./ground.js";
export {
  type AssetRegistry,
  assetKeyFor,
  buildItems,
  drawnAs,
  type ItemBuildContext,
  identity,
  itemMatrix,
  type Mat4,
  multiply,
  noAssets,
  rotationY,
  scaling,
  transformPoint,
  translation,
} from "./items.js";
export { MeshBuilder, partArea, partBounds } from "./mesh.js";
export {
  type FinishLike,
  finishedMaterialKey,
  MATERIAL_COLOURS,
  type MaterialLook,
  type MaterialTexture,
  materialColour,
  materialKeyOf,
  materialLook,
  materialRoughness,
  roughnessForShininess,
  type TextureSize,
  type TextureSource,
  textureSourceOf,
} from "./palette.js";
export { buildRecipe, buildRecipeParts, fallbackRecipe, recipeAssetKey, recipeSlotKey } from "./recipes.js";
export { buildRooms, ceilingElevation, type RoomBuildContext } from "./rooms.js";
export * from "./types.js";
export {
  buildWalls,
  type SkirtingOutline,
  skirtingOutlines,
  type WallBuildContext,
  type WallElevations,
  wallElevations,
} from "./walls.js";

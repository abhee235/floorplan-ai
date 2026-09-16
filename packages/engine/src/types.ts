// Engine output types (ADR-003 D2). Positions are float32 metres in the three.js frame:
// plan (x, y) with elevation z maps to (x, z, -y) so the frame is right-handed with y up.
import type { PrimitiveRecipe } from "@fpv/ir";

export type PartKind =
  | "wall-left"
  | "wall-right"
  | "wall-top"
  | "wall-end-start"
  | "wall-end-end"
  | "skirting-left"
  | "skirting-right"
  | "opening-sill"
  | "opening-head"
  | "opening-jamb"
  | "opening-reveal"
  | "floor"
  | "floor-side"
  | "floor-bottom"
  | "ceiling"
  | "ground"
  | "item"
  | "recipe";

export interface GeometryPart {
  entityId: string;
  part: PartKind;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  materialKey: string;
}

export interface ItemInstance {
  entityId: string;
  /** Asset key from the registry, or "recipe:<kind>…" for generated meshes. */
  assetKey: string;
  /**
   * The recipe to build the mesh from (buildRecipeParts): the item's own, or its product's category
   * fallback. Null for a model asset from the registry, which the renderer loads by `assetKey`.
   */
  recipe: PrimitiveRecipe | null;
  /** Column-major 4x4 matrix, three.js order, metres. */
  matrix: number[];
  /** The material key for each of the recipe's parts, in its slot order, with the item's finishes applied. */
  materials: { slot: string; materialKey: string }[];
  visible: boolean;
}

/** A point in plan millimetres with elevation. */
export interface P3 {
  x: number;
  y: number;
  z: number;
}

export const MM_PER_M = 1000;

export function toThree(p: P3): [number, number, number] {
  return [p.x / MM_PER_M, p.z / MM_PER_M, -p.y / MM_PER_M];
}

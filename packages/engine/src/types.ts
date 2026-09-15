// Engine output types (ADR-003 D2). Positions are float32 metres in the three.js frame:
// plan (x, y) with elevation z maps to (x, z, -y) so the frame is right-handed with y up.

export type PartKind =
  | "wall-left"
  | "wall-right"
  | "wall-top"
  | "wall-end-start"
  | "wall-end-end"
  | "opening-sill"
  | "opening-head"
  | "opening-jamb"
  | "floor"
  | "floor-side"
  | "floor-bottom"
  | "ceiling"
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
  /** Asset key from the registry, or "recipe:<kind>" for generated meshes. */
  assetKey: string;
  /** Column-major 4x4 matrix, three.js order, metres. */
  matrix: number[];
  materialOverrides: Record<string, { color: string | null; textureId: string | null }>;
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

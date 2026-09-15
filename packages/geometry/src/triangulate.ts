// Triangulation with holes via earcut (ISC). Returns indices into the concatenated point list
// [outer..., hole0..., hole1..., ...].
import type { Point } from "@fpv/ir";
import earcut from "earcut";

export interface Triangulation {
  points: Point[];
  indices: Uint32Array;
}

export function triangulate(
  outer: readonly Point[],
  holes: readonly (readonly Point[])[] = [],
): Triangulation {
  const points: Point[] = [...outer];
  const holeIndices: number[] = [];
  for (const h of holes) {
    holeIndices.push(points.length);
    points.push(...h);
  }
  const flat = new Array<number>(points.length * 2);
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i] as Point;
    flat[2 * i] = p.x;
    flat[2 * i + 1] = p.y;
  }
  const idx = earcut(flat, holeIndices.length ? holeIndices : undefined, 2);
  return { points, indices: Uint32Array.from(idx) };
}

/** Total triangle area, useful to check a triangulation covers the polygon. */
export function triangulatedArea(t: Triangulation): number {
  let a = 0;
  for (let i = 0; i + 2 < t.indices.length; i += 3) {
    const p = t.points[t.indices[i] as number] as Point;
    const q = t.points[t.indices[i + 1] as number] as Point;
    const r = t.points[t.indices[i + 2] as number] as Point;
    a += Math.abs((q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y)) / 2;
  }
  return a;
}

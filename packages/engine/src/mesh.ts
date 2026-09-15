// MeshBuilder: accumulates flat-shaded faces given in plan millimetres and emits a GeometryPart.

import { triangulate } from "@fpv/geometry";
import type { Point } from "@fpv/ir";
import { type GeometryPart, MM_PER_M, type P3, type PartKind, toThree } from "./types.js";

type V3 = [number, number, number];

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function norm(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export class MeshBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private uvs: number[] = [];
  private indices: number[] = [];

  get triangleCount(): number {
    return this.indices.length / 3;
  }
  get isEmpty(): boolean {
    return this.indices.length === 0;
  }

  /**
   * Add a planar polygon (3+ points in plan mm with elevation) as a flat-shaded face.
   * `outward` is a plan-space hint (x, y, z) for the normal; the winding is flipped to match it.
   */
  addFace(points: readonly P3[], outward: P3, uv: (p: P3) => [number, number]): void {
    if (points.length < 3) return;
    const three = points.map(toThree);
    const a = three[0] as V3;
    const b = three[1] as V3;
    const c = three[2] as V3;
    let n = norm(cross(sub(b, a), sub(c, a)));
    const hint = norm(toThree({ x: outward.x, y: outward.y, z: outward.z }) as V3);
    let pts = three;
    let src = points;
    if (dot(n, hint) < 0) {
      pts = [...three].reverse();
      src = [...points].reverse();
      n = [-n[0], -n[1], -n[2]];
    }
    const base = this.positions.length / 3;
    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i] as V3;
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(n[0], n[1], n[2]);
      const [u, v] = uv(src[i] as P3);
      this.uvs.push(u, v);
    }
    if (pts.length === 3) {
      this.indices.push(base, base + 1, base + 2);
    } else if (pts.length === 4) {
      this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    } else {
      // general polygon: triangulate in its own plane by projecting to the dominant axes
      const ax = Math.abs(n[0]);
      const ay = Math.abs(n[1]);
      const az = Math.abs(n[2]);
      const proj: Point[] = pts.map((p) =>
        ay >= ax && ay >= az ? { x: p[0], y: -p[2] } : ax >= az ? { x: p[2], y: p[1] } : { x: p[0], y: p[1] },
      );
      const t = triangulate(proj);
      for (let i = 0; i + 2 < t.indices.length; i += 3) {
        const i0 = base + (t.indices[i] as number);
        const i1 = base + (t.indices[i + 1] as number);
        const i2 = base + (t.indices[i + 2] as number);
        // keep the orientation consistent with the face normal
        const p0 = pts[t.indices[i] as number] as V3;
        const p1 = pts[t.indices[i + 1] as number] as V3;
        const p2 = pts[t.indices[i + 2] as number] as V3;
        const tn = cross(sub(p1, p0), sub(p2, p0));
        if (dot(tn, n) >= 0) this.indices.push(i0, i1, i2);
        else this.indices.push(i0, i2, i1);
      }
    }
  }

  /** Horizontal polygon with holes at elevation z, facing up or down; UVs are plan metres. */
  addHorizontal(outer: readonly Point[], holes: readonly (readonly Point[])[], z: number, up: boolean): void {
    const t = triangulate(outer, holes);
    const base = this.positions.length / 3;
    const n: V3 = up ? [0, 1, 0] : [0, -1, 0];
    for (const p of t.points) {
      const q = toThree({ x: p.x, y: p.y, z });
      this.positions.push(q[0], q[1], q[2]);
      this.normals.push(n[0], n[1], n[2]);
      this.uvs.push(p.x / MM_PER_M, p.y / MM_PER_M);
    }
    for (let i = 0; i + 2 < t.indices.length; i += 3) {
      const i0 = base + (t.indices[i] as number);
      const i1 = base + (t.indices[i + 1] as number);
      const i2 = base + (t.indices[i + 2] as number);
      // earcut emits counter-clockwise triangles in plan (y up); in the three.js frame that faces +y
      if (up) this.indices.push(i0, i1, i2);
      else this.indices.push(i0, i2, i1);
    }
  }

  /**
   * Planar polygon with holes given in its own 2D coordinates and mapped into plan mm with elevation.
   * Used for wall sides around shaped openings; `outward` is the face normal and must be perpendicular to it.
   */
  addMapped(
    outer: readonly Point[],
    holes: readonly (readonly Point[])[],
    to3: (p: Point) => P3,
    outward: P3,
    uv: (p: Point) => [number, number],
  ): void {
    const t = triangulate(outer, holes);
    if (t.indices.length === 0) return;
    const n = norm(toThree(outward) as V3);
    const pts = t.points.map((p) => toThree(to3(p)) as V3);
    const base = this.positions.length / 3;
    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i] as V3;
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(n[0], n[1], n[2]);
      const [u, v] = uv(t.points[i] as Point);
      this.uvs.push(u, v);
    }
    for (let i = 0; i + 2 < t.indices.length; i += 3) {
      const a = t.indices[i] as number;
      const b = t.indices[i + 1] as number;
      const c = t.indices[i + 2] as number;
      const p0 = pts[a] as V3;
      const tn = cross(sub(pts[b] as V3, p0), sub(pts[c] as V3, p0));
      if (dot(tn, n) >= 0) this.indices.push(base + a, base + b, base + c);
      else this.indices.push(base + a, base + c, base + b);
    }
  }

  toPart(entityId: string, part: PartKind, materialKey: string): GeometryPart {
    return {
      entityId,
      part,
      positions: Float32Array.from(this.positions),
      normals: Float32Array.from(this.normals),
      uvs: Float32Array.from(this.uvs),
      indices: Uint32Array.from(this.indices),
      materialKey,
    };
  }
}

/** Sum of triangle areas in m², handy for tests. */
export function partArea(part: GeometryPart): number {
  let area = 0;
  const p = part.positions;
  for (let i = 0; i + 2 < part.indices.length; i += 3) {
    const a = part.indices[i] as number;
    const b = part.indices[i + 1] as number;
    const c = part.indices[i + 2] as number;
    const ax = p[a * 3] as number;
    const ay = p[a * 3 + 1] as number;
    const az = p[a * 3 + 2] as number;
    const u: V3 = [(p[b * 3] as number) - ax, (p[b * 3 + 1] as number) - ay, (p[b * 3 + 2] as number) - az];
    const v: V3 = [(p[c * 3] as number) - ax, (p[c * 3 + 1] as number) - ay, (p[c * 3 + 2] as number) - az];
    const cr = cross(u, v);
    area += Math.hypot(cr[0], cr[1], cr[2]) / 2;
  }
  return area;
}

/** Axis-aligned bounds of a part in the three.js frame (metres). */
export function partBounds(part: GeometryPart): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < part.positions.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      const v = part.positions[i + k] as number;
      if (v < (min[k] as number)) min[k] = v;
      if (v > (max[k] as number)) max[k] = v;
    }
  }
  return { min, max };
}

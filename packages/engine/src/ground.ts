// Ground slab (spec 05 section 8; R-089..R-100 simplified): one slab under the lowest level, from the project
// bounds plus a margin, minus the floors of the visible rooms on that level, with its outer edge down to a
// depth. Underground terraces, digging furniture and background images are not modelled.
import { difference, type MultiPoly, ringToMulti, union } from "@fpv/geometry";
import { derive, type Point, type Project, type poly } from "@fpv/ir";
import { MeshBuilder } from "./mesh.js";
import { type GeometryPart, MM_PER_M } from "./types.js";

export const GROUND_ID = "ground";
export const GROUND_MARGIN_MM = 10_000;
export const GROUND_DEPTH_MM = 300;
/** Half size of the ground when the project has nothing to bound it (R-090). */
export const GROUND_EMPTY_HALF_MM = 5_000;

export interface GroundBuildContext {
  sizes?: derive.SizeSource;
  marginMm?: number;
  depthMm?: number;
}

export interface Ground {
  /** Top and outer edge as one part, entity id "ground"; null when nothing is left to draw. */
  part: GeometryPart | null;
  /** Elevation of the top face in mm: the lowest level's elevation (R-097). */
  elevation: number;
  rect: poly.Rect;
}

export function buildGround(project: Project, ctx: GroundBuildContext = {}): Ground {
  const level = derive.lowestLevel(project);
  const margin = ctx.marginMm ?? GROUND_MARGIN_MM;
  const depth = ctx.depthMm ?? GROUND_DEPTH_MM;
  const b = derive.projectBounds(project, ctx.sizes ?? derive.snapshotSizeSource(project));
  const h = GROUND_EMPTY_HALF_MM;
  const rect: poly.Rect = b
    ? { minX: b.minX - margin, minY: b.minY - margin, maxX: b.maxX + margin, maxY: b.maxY + margin }
    : { minX: -h, minY: -h, maxX: h, maxY: h };
  const outline: Point[] = [
    { x: rect.minX, y: rect.minY },
    { x: rect.maxX, y: rect.minY },
    { x: rect.maxX, y: rect.maxY },
    { x: rect.minX, y: rect.maxY },
  ];
  // R-091: visible floors on the lowest level are holes in the ground, so floor and ground never overlap
  const floors: MultiPoly[] = level.viewable
    ? project.rooms
        .filter((r) => r.levelId === level.id && r.floorVisible && r.polygon.length >= 3)
        .map((r) => difference(ringToMulti(r.polygon), ...r.holes.map((x) => ringToMulti(x))))
    : [];
  const area = floors.length > 0 ? difference(ringToMulti(outline), union(...floors)) : ringToMulti(outline);
  const z = level.elevation;
  const mb = new MeshBuilder();
  // R-098 adapted: top UVs are plan metres, like floors
  for (const p of area) mb.addHorizontal(p.outer, p.holes, z, true);
  if (depth > 0)
    for (let i = 0; i < outline.length; i += 1) {
      const a = outline[i] as Point;
      const c = outline[(i + 1) % outline.length] as Point;
      mb.addFace(
        [
          { x: a.x, y: a.y, z: z - depth },
          { x: c.x, y: c.y, z: z - depth },
          { x: c.x, y: c.y, z },
          { x: a.x, y: a.y, z },
        ],
        // counter-clockwise outline: outward is to the right of each edge
        { x: c.y - a.y, y: a.x - c.x, z: 0 },
        (p) => [Math.hypot(p.x - a.x, p.y - a.y) / MM_PER_M, p.z / MM_PER_M],
      );
    }
  return { part: mb.isEmpty ? null : mb.toPart(GROUND_ID, "ground", "ground"), elevation: z, rect };
}

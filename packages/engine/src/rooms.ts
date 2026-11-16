// Room geometry (spec 05 section 3; ledger R-061..R-067, R-075..R-080, R-082..R-088).

import { difference, type MultiPoly, ringToMulti } from "@fpv/geometry";
import type { Level, Point, Room } from "@fpv/ir";
import { poly } from "@fpv/ir";
import { MeshBuilder } from "./mesh.js";
import { finishedMaterialKey, type TextureSource } from "./palette.js";
import { type GeometryPart, MM_PER_M } from "./types.js";

export interface RoomBuildContext {
  level: Level;
  isLowest: boolean;
  /** Texture sizes, for floors and ceilings that wear a texture; without it a texture is left off. */
  textures?: TextureSource;
}

/** Ceiling elevation: the room override or the level height (ADR-001; R-068..R-071 reversed). */
export function ceilingElevation(r: Room, level: Level): number {
  return level.elevation + (r.ceilingHeight ?? level.height);
}

function roomMulti(r: Room): MultiPoly {
  return difference(ringToMulti(r.polygon), ...r.holes.map((h) => ringToMulti(h)));
}

/**
 * Later rooms on the same level subtract earlier overlapping rooms from their floor and ceiling
 * (spec 05 section 3; R-065 adapted), so coplanar floors never fight.
 */
function visibleArea(r: Room, earlier: readonly Room[]): MultiPoly {
  let area = roomMulti(r);
  const rb = poly.bounds(r.polygon);
  for (const e of earlier) {
    if (!poly.rectsIntersect(rb, poly.bounds(e.polygon))) continue;
    area = difference(area, roomMulti(e));
  }
  return area;
}

function addSideStrip(
  mb: MeshBuilder,
  ring: readonly Point[],
  zTop: number,
  zBottom: number,
  outwardIsRight: boolean,
): void {
  const n = ring.length;
  for (let i = 0; i < n; i += 1) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % n] as Point;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    // counter-clockwise outer ring: outward is to the right of the edge direction
    const outward = outwardIsRight ? { x: dy, y: -dx, z: 0 } : { x: -dy, y: dx, z: 0 };
    mb.addFace(
      [
        { x: a.x, y: a.y, z: zBottom },
        { x: b.x, y: b.y, z: zBottom },
        { x: b.x, y: b.y, z: zTop },
        { x: a.x, y: a.y, z: zTop },
      ],
      outward,
      (p) => [Math.hypot(p.x - a.x, p.y - a.y) / MM_PER_M, p.z / MM_PER_M],
    );
  }
}

/** Build floor, ceiling, and on upper levels the slab side and underside, for the rooms of one level. */
export function buildRooms(rooms: readonly Room[], ctx: RoomBuildContext): GeometryPart[] {
  const onLevel = rooms.filter((r) => r.levelId === ctx.level.id);
  const out: GeometryPart[] = [];
  const floorZ = ctx.level.elevation;
  const slabBottomZ = ctx.level.elevation - ctx.level.floorThickness;
  onLevel.forEach((r, index) => {
    if (r.polygon.length < 3) return; // R-061
    const area = visibleArea(r, onLevel.slice(0, index));
    if (r.floorVisible) {
      const floor = new MeshBuilder();
      for (const p of area) floor.addHorizontal(p.outer, p.holes, floorZ, true);
      // the floor and the ceiling wear the room's own finishes, as a wall side wears its own
      if (!floor.isEmpty)
        out.push(floor.toPart(r.id, "floor", finishedMaterialKey("floor", r.finishes.floor, ctx.textures)));
      if (!ctx.isLowest) {
        // R-063, R-064: underside and slab sides only above the lowest level
        const bottom = new MeshBuilder();
        for (const p of area) bottom.addHorizontal(p.outer, p.holes, slabBottomZ, false);
        if (!bottom.isEmpty) out.push(bottom.toPart(r.id, "floor-bottom", "floor-side"));
        const side = new MeshBuilder();
        for (const p of area) {
          addSideStrip(side, p.outer, floorZ, slabBottomZ, true);
          for (const h of p.holes) addSideStrip(side, poly.reversed(h), floorZ, slabBottomZ, false);
        }
        if (!side.isEmpty) out.push(side.toPart(r.id, "floor-side", "floor-side"));
      }
    }
    if (r.ceilingVisible) {
      const ceiling = new MeshBuilder();
      const z = ceilingElevation(r, ctx.level);
      for (const p of area) ceiling.addHorizontal(p.outer, p.holes, z, false);
      if (!ceiling.isEmpty)
        out.push(
          ceiling.toPart(r.id, "ceiling", finishedMaterialKey("ceiling", r.finishes.ceiling, ctx.textures)),
        );
    }
  });
  return out;
}

// Wall geometry (ADR-014 D5..D9, spec 05 section 3). Each side is built in wall-local (u, v) space:
// u is the distance along the wall direction in mm (so opening intervals map exactly, even on mitred
// sides), v is elevation. Rectangular openings decompose a side face into rectangles below sills,
// above heads, and between openings. A shaped opening (its product's cut-out path) cuts its shape out
// of the opening's column with 2D booleans in the same space and gets a reveal instead of sill, head
// and jambs (ADR-014 D7 step 3).

import {
  difference,
  intersection,
  intersectLines,
  type MultiPoly,
  multiArea,
  ringToMulti,
  TOL,
  unionRings,
  wallFootprints,
} from "@fpv/geometry";
import type { Level, Opening, Point, Wall } from "@fpv/ir";
import { derive } from "@fpv/ir";
import type { CutOutSource } from "./cutouts.js";
import { MeshBuilder } from "./mesh.js";
import { finishedMaterialKey, type TextureSource } from "./palette.js";
import { type GeometryPart, MM_PER_M, type P3 } from "./types.js";

export interface WallBuildContext {
  level: Level;
  isLowest: boolean;
  isHighest: boolean;
  footprints?: Map<string, Point[]>;
  /** Cut-out shapes by opening (ADR-014 D7 step 3); without it every opening is a rectangle. */
  cutOuts?: CutOutSource;
  /** Texture sizes, for sides that wear a texture; without it a texture is left off. */
  textures?: TextureSource;
}

/** Length of the wall centreline path: the chord for straight walls, the arc length for arcs (W-111). */
export function pathLength(w: Wall): number {
  const arc = derive.arcParams(w);
  if (!arc) return derive.wallLength(w);
  return (arc.radius * Math.abs(w.arcExtent as number) * Math.PI) / 180;
}

/** A side polyline with a monotonic parameter u (mm along the wall centreline path) at each vertex. */
interface Side {
  points: Point[];
  u: number[];
  start: number;
  end: number;
}

function makeSide(points: Point[], w: Wall): Side {
  const chord = derive.wallLength(w);
  const len = pathLength(w);
  const dx = (w.end.x - w.start.x) / chord;
  const dy = (w.end.y - w.start.y) / chord;
  let u: number[];
  if (derive.isArc(w)) {
    // arcs: u by angle fraction (a side's own arc length is proportional to it), scaled to the centreline arc length
    const cum = [0];
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1] as Point;
      const b = points[i] as Point;
      cum.push((cum[i - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y));
    }
    const total = cum[cum.length - 1] as number;
    u = cum.map((c) => (total === 0 ? 0 : (c / total) * len));
  } else {
    u = points.map((p) => (p.x - w.start.x) * dx + (p.y - w.start.y) * dy);
  }
  return { points, u, start: u[0] as number, end: u[u.length - 1] as number };
}

/** Point on the side at parameter u, clamped to the side's range. */
function at(side: Side, u: number): Point {
  const target = Math.min(Math.max(side.start, u), side.end);
  for (let i = 1; i < side.points.length; i += 1) {
    const u0 = side.u[i - 1] as number;
    const u1 = side.u[i] as number;
    if (target <= u1 || i === side.points.length - 1) {
      const a = side.points[i - 1] as Point;
      const b = side.points[i] as Point;
      const s = u1 === u0 ? 0 : (target - u0) / (u1 - u0);
      return { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s };
    }
  }
  return side.points[0] as Point;
}

/** Vertices strictly inside (u0, u1) with the exact endpoints. */
function strip(side: Side, u0: number, u1: number): { p: Point; u: number }[] {
  const out: { p: Point; u: number }[] = [{ p: at(side, u0), u: Math.max(u0, side.start) }];
  for (let i = 0; i < side.points.length; i += 1) {
    const u = side.u[i] as number;
    if (u > u0 + 1e-9 && u < u1 - 1e-9) out.push({ p: side.points[i] as Point, u });
  }
  out.push({ p: at(side, u1), u: Math.min(u1, side.end) });
  return out;
}

export interface WallElevations {
  bottom: number;
  /** Top elevation as a function of the fraction along the wall (0 at start, 1 at end). */
  top: (t: number) => number;
}

/** W-097, W-098: bottom drops through the floor slab on upper levels plus 1 mm; top gets 1 mm except on the highest level. */
export function wallElevations(w: Wall, ctx: WallBuildContext): WallElevations {
  const bottom = ctx.isLowest
    ? ctx.level.elevation
    : ctx.level.elevation - ctx.level.floorThickness + TOL.LEVEL_SHIFT;
  const h0 = derive.wallHeight(w, ctx.level);
  const h1 = derive.wallHeightAtEnd(w, ctx.level);
  const shift = ctx.isHighest ? 0 : TOL.LEVEL_SHIFT;
  return { bottom, top: (t) => ctx.level.elevation + h0 + (h1 - h0) * Math.min(1, Math.max(0, t)) + shift };
}

interface Cut {
  from: number; // mm along the wall
  to: number;
  sillZ: number;
  headZ: number;
  opening: Opening;
  /** Hole in (u, z) mm for a shaped opening; null cuts the rectangle. */
  shape: MultiPoly | null;
}

function cuts(w: Wall, openings: readonly Opening[], level: Level, cutOuts?: CutOutSource): Cut[] {
  const straight = !derive.isArc(w);
  return openings
    .filter((o) => o.wallId === w.id)
    .map((o) => {
      // position is a fraction of the centreline path; width is a physical width along that path (W-111)
      const c = o.position * pathLength(w);
      const from = c - o.width / 2;
      const sillZ = level.elevation + o.sill;
      const headZ = sillZ + o.height;
      // O-082: arc walls cut rectangles. O-070: the shape follows its wall, so it is never at an angle to it.
      const rings = straight && cutOuts ? cutOuts(o) : null;
      return {
        from,
        to: c + o.width / 2,
        sillZ,
        headZ,
        opening: o,
        shape: rings ? shapeIn(rings, o, from, headZ) : null,
      };
    })
    .sort((a, b) => a.from - b.from);
}

/** Unit-square rings (y down) into (u, z) mm; null when the shape fills the rectangle (O-069) or has no area. */
function shapeIn(rings: Point[][], o: Opening, from: number, headZ: number): MultiPoly | null {
  // O-072: a mirrored opening mirrors its shape
  const mapped = rings.map((r) =>
    r.map((p) => ({ x: from + (o.mirrored ? 1 - p.x : p.x) * o.width, y: headZ - p.y * o.height })),
  );
  const shape = unionRings(mapped);
  const a = multiArea(shape);
  if (a <= 0 || a >= o.width * o.height * (1 - 1e-6)) return null;
  return shape;
}

/** The opening's column of the wall in (u, z) mm, bottom to the (possibly sloped) top. */
function columnRegion(c: Cut, len: number, el: WallElevations): MultiPoly {
  return ringToMulti([
    { x: c.from, y: el.bottom },
    { x: c.to, y: el.bottom },
    { x: c.to, y: el.top(c.to / len) },
    { x: c.from, y: el.top(c.from / len) },
  ]);
}

function outwardNormal(side: Side, other: Side, u: number): P3 {
  const a = at(side, u);
  const b = at(other, u);
  return { x: a.x - b.x, y: a.y - b.y, z: 0 };
}

/** Vertical band of a side between u0..u1 and elevations vb..vt(u). */
function band(
  mb: MeshBuilder,
  side: Side,
  other: Side,
  len: number,
  u0: number,
  u1: number,
  vb: number,
  vt: (t: number) => number,
): void {
  if (u1 <= u0) return;
  const pts = strip(side, u0, u1);
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const a = pts[i] as { p: Point; u: number };
    const b = pts[i + 1] as { p: Point; u: number };
    if (a.u >= b.u) continue;
    const topA = vt(a.u / len);
    const topB = vt(b.u / len);
    if (topA <= vb && topB <= vb) continue;
    const quad: P3[] = [
      { x: a.p.x, y: a.p.y, z: vb },
      { x: b.p.x, y: b.p.y, z: vb },
      { x: b.p.x, y: b.p.y, z: Math.max(vb, topB) },
      { x: a.p.x, y: a.p.y, z: Math.max(vb, topA) },
    ];
    const n = outwardNormal(side, other, (a.u + b.u) / 2);
    mb.addFace(quad, n, (p) => [(p.x === a.p.x && p.y === a.p.y ? a.u : b.u) / MM_PER_M, p.z / MM_PER_M]);
  }
}

function buildSide(side: Side, other: Side, len: number, cutList: Cut[], el: WallElevations): MeshBuilder {
  const mb = new MeshBuilder();
  let cursor = side.start;
  for (const c of cutList) {
    if (c.from > cursor) band(mb, side, other, len, cursor, c.from, el.bottom, el.top);
    if (c.shape) {
      shapedColumn(mb, side, other, len, c, el);
      cursor = Math.max(cursor, c.to);
      continue;
    }
    if (c.sillZ > el.bottom) band(mb, side, other, len, c.from, c.to, el.bottom, () => c.sillZ); // O-052
    band(mb, side, other, len, c.from, c.to, c.headZ, el.top); // O-054: empty when the head reaches the top
    cursor = Math.max(cursor, c.to);
  }
  if (cursor < side.end) band(mb, side, other, len, cursor, side.end, el.bottom, el.top);
  return mb;
}

/** The part of a side inside a shaped opening's column: the column minus the shape. */
function shapedColumn(
  mb: MeshBuilder,
  side: Side,
  other: Side,
  len: number,
  c: Cut,
  el: WallElevations,
): void {
  const solid = difference(columnRegion(c, len, el), c.shape as MultiPoly);
  const n = outwardNormal(side, other, (c.from + c.to) / 2);
  for (const p of solid)
    mb.addMapped(
      p.outer,
      p.holes,
      (q) => ({ ...at(side, q.x), z: q.y }),
      n,
      (q) => [q.x / MM_PER_M, q.y / MM_PER_M],
    );
}

/** O-073: every edge of the hole extruded through the thickness, except edges on the wall's bottom or top line. */
function buildReveal(
  left: Side,
  right: Side,
  len: number,
  c: Cut,
  el: WallElevations,
  out: GeometryPart[],
  revealKey: string,
): void {
  const hole = intersection(columnRegion(c, len, el), c.shape as MultiPoly);
  const a = at(left, c.from);
  const b = at(left, c.to);
  const al = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const dir = { x: (b.x - a.x) / al, y: (b.y - a.y) / al };
  const eps = 0.5;
  const mb = new MeshBuilder();
  let s = 0;
  for (const p of hole)
    for (const ring of [p.outer, ...p.holes])
      for (let i = 0; i < ring.length; i += 1) {
        const p0 = ring[i] as Point;
        const p1 = ring[(i + 1) % ring.length] as Point;
        const du = p1.x - p0.x;
        const dz = p1.y - p0.y;
        const edge = Math.hypot(du, dz);
        if (edge < TOL.DEGENERATE) continue;
        const onBottom = p0.y <= el.bottom + eps && p1.y <= el.bottom + eps;
        const onTop = p0.y >= el.top(p0.x / len) - eps && p1.y >= el.top(p1.x / len) - eps;
        if (onBottom || onTop) {
          s += edge;
          continue;
        }
        const l0 = at(left, p0.x);
        const l1 = at(left, p1.x);
        const r0 = at(right, p0.x);
        const r1 = at(right, p1.x);
        const verts: P3[] = [
          { ...l0, z: p0.y },
          { ...l1, z: p1.y },
          { ...r1, z: p1.y },
          { ...r0, z: p0.y },
        ];
        const depth = Math.hypot(r0.x - l0.x, r0.y - l0.y);
        const uvs: [number, number][] = [
          [s, 0],
          [s + edge, 0],
          [s + edge, depth],
          [s, depth],
        ];
        // the void is left of each edge (outer rings counter-clockwise, holes clockwise): the face looks into it
        const nu = -dz / edge;
        const nz = du / edge;
        mb.addFace(verts, { x: dir.x * nu, y: dir.y * nu, z: nz }, (q) => {
          const uv = uvs[verts.indexOf(q)] ?? [0, 0];
          return [uv[0] / MM_PER_M, uv[1] / MM_PER_M];
        });
        s += edge;
      }
  if (!mb.isEmpty) out.push(mb.toPart(c.opening.id, "opening-reveal", revealKey));
}

/**
 * What stands in the hole: a pane in a window, a leaf in a door, nothing in a passage.
 *
 * Until now an opening was only the surfaces AROUND the hole — sill, head, jambs — so a window was a
 * gap you could see the garden through and a closed door was a doorway. The schema has carried
 * `finishes.frame` and `finishes.leaf` and a recipe style of "glazed" all along, with nothing to put
 * them on.
 *
 * One quad at the middle of the wall's thickness, faced both ways. A pane is thin enough that its
 * thickness is not worth the triangles, and a leaf drawn as a box would be wrong as often as right —
 * a door is only in its frame when it is closed, and the model does not say whether it is.
 */
function buildOpeningFill(
  left: Side,
  right: Side,
  c: Cut,
  el: WallElevations,
  out: GeometryPart[],
  fillKey: string | null,
): void {
  if (!fillKey) return;
  const lf = at(left, c.from);
  const lt = at(left, c.to);
  const rf = at(right, c.from);
  const rt = at(right, c.to);
  // The centre plane of the wall, so the pane sits in the reveal rather than on one face of it.
  const mf = { x: (lf.x + rf.x) / 2, y: (lf.y + rf.y) / 2 };
  const mt = { x: (lt.x + rt.x) / 2, y: (lt.y + rt.y) / 2 };
  const bottom = Math.max(c.sillZ, el.bottom);
  const head = c.headZ;
  if (head <= bottom) return;
  const along = { x: mt.x - mf.x, y: mt.y - mf.y, z: 0 };
  const width = Math.hypot(along.x, along.y);
  if (width <= 0) return;
  // The face normal is across the wall, which is `along` turned a quarter turn in the plan.
  const nx = -along.y / width;
  const ny = along.x / width;
  const uv = (q: P3): [number, number] => [Math.hypot(q.x - mf.x, q.y - mf.y) / MM_PER_M, q.z / MM_PER_M];
  const face = [
    { x: mf.x, y: mf.y, z: bottom },
    { x: mt.x, y: mt.y, z: bottom },
    { x: mt.x, y: mt.y, z: head },
    { x: mf.x, y: mf.y, z: head },
  ];
  const mb = new MeshBuilder();
  mb.addFace(face, { x: nx, y: ny, z: 0 }, uv);
  // Seen from the other side too: one quad with one normal would be invisible from half the room.
  mb.addFace([...face].reverse(), { x: -nx, y: -ny, z: 0 }, uv);
  if (!mb.isEmpty)
    out.push(
      mb.toPart(c.opening.id, c.opening.kind === "window" ? "opening-glass" : "opening-leaf", fillKey),
    );
}

function buildOpeningFaces(
  left: Side,
  right: Side,
  len: number,
  c: Cut,
  el: WallElevations,
  out: GeometryPart[],
  revealKey: string,
  fillKey: string | null,
): void {
  buildOpeningFill(left, right, c, el, out, fillKey);
  if (c.shape) {
    buildReveal(left, right, len, c, el, out, revealKey);
    return;
  }
  const oid = c.opening.id;
  const top = Math.min(el.top(c.from / len), el.top(c.to / len));
  const headZ = Math.min(c.headZ, top);
  const lf = at(left, c.from);
  const lt = at(left, c.to);
  const rf = at(right, c.from);
  const rt = at(right, c.to);
  const along = { x: lt.x - lf.x, y: lt.y - lf.y, z: 0 };
  const planUv = (p: P3): [number, number] => [p.x / MM_PER_M, p.y / MM_PER_M];
  if (c.sillZ > el.bottom) {
    const sill = new MeshBuilder();
    sill.addFace(
      [
        { x: lf.x, y: lf.y, z: c.sillZ },
        { x: lt.x, y: lt.y, z: c.sillZ },
        { x: rt.x, y: rt.y, z: c.sillZ },
        { x: rf.x, y: rf.y, z: c.sillZ },
      ],
      { x: 0, y: 0, z: 1 },
      planUv,
    );
    out.push(sill.toPart(oid, "opening-sill", revealKey));
  }
  if (c.headZ < top) {
    const head = new MeshBuilder();
    head.addFace(
      [
        { x: lf.x, y: lf.y, z: c.headZ },
        { x: lt.x, y: lt.y, z: c.headZ },
        { x: rt.x, y: rt.y, z: c.headZ },
        { x: rf.x, y: rf.y, z: c.headZ },
      ],
      { x: 0, y: 0, z: -1 },
      planUv,
    );
    out.push(head.toPart(oid, "opening-head", revealKey));
  }
  const jambs = new MeshBuilder();
  const vb = Math.max(c.sillZ, el.bottom);
  if (headZ > vb) {
    jambs.addFace(
      [
        { x: lf.x, y: lf.y, z: vb },
        { x: rf.x, y: rf.y, z: vb },
        { x: rf.x, y: rf.y, z: headZ },
        { x: lf.x, y: lf.y, z: headZ },
      ],
      along,
      (p) => [Math.hypot(p.x - lf.x, p.y - lf.y) / MM_PER_M, p.z / MM_PER_M],
    );
    jambs.addFace(
      [
        { x: lt.x, y: lt.y, z: vb },
        { x: rt.x, y: rt.y, z: vb },
        { x: rt.x, y: rt.y, z: headZ },
        { x: lt.x, y: lt.y, z: headZ },
      ],
      { x: -along.x, y: -along.y, z: 0 },
      (p) => [Math.hypot(p.x - lt.x, p.y - lt.y) / MM_PER_M, p.z / MM_PER_M],
    );
  }
  if (!jambs.isEmpty) out.push(jambs.toPart(oid, "opening-jamb", revealKey));
}

/** A wall's two sides, path length, elevations and opening cuts: what every builder here starts from. */
interface WallFrame {
  left: Side;
  right: Side;
  len: number;
  el: WallElevations;
  cutList: Cut[];
}

function frameOf(
  w: Wall,
  fps: Map<string, Point[]>,
  openings: readonly Opening[],
  ctx: WallBuildContext,
): WallFrame | null {
  const fp = fps.get(w.id);
  const len = pathLength(w);
  if (!fp || fp.length < 4 || len === 0) return null;
  const n = fp.length / 2;
  return {
    left: makeSide(fp.slice(0, n), w),
    right: makeSide([...fp.slice(n)].reverse(), w),
    len,
    el: wallElevations(w, ctx),
    cutList: cuts(w, openings, ctx.level, ctx.cutOuts),
  };
}

/** Build every part for the walls of one level. */
export function buildWalls(
  walls: readonly Wall[],
  openings: readonly Opening[],
  ctx: WallBuildContext,
): GeometryPart[] {
  const onLevel = walls.filter((w) => w.levelId === ctx.level.id);
  const fps = ctx.footprints ?? wallFootprints(onLevel);
  const out: GeometryPart[] = [];
  const planUv = (p: P3): [number, number] => [p.x / MM_PER_M, p.y / MM_PER_M];
  for (const w of onLevel) {
    const frame = frameOf(w, fps, openings, ctx);
    if (!frame) continue;
    const { left, right, len, el, cutList } = frame;
    // Each side wears its own finish (W-106); the end caps and reveals keep the plain wall material. A glass
    // wall is glass on both faces and aluminium everywhere it has an edge: its top, its ends and the reveals
    // of anything set into it, which is how a glazed partition is actually built.
    const glass = w.kind === "glass";
    const sideBase = glass ? "wall-glass" : "wall-side";
    const edgeKey = glass ? "wall-glass-frame" : "wall-side";
    const revealKey = glass ? "wall-glass-frame" : "opening-reveal";
    const leftKey = finishedMaterialKey(sideBase, w.finishes.left, ctx.textures);
    const rightKey = finishedMaterialKey(sideBase, w.finishes.right, ctx.textures);
    out.push(buildSide(left, right, len, cutList, el).toPart(w.id, "wall-left", leftKey));
    out.push(buildSide(right, left, len, cutList, el).toPart(w.id, "wall-right", rightKey));
    // top: full footprint ring with per-vertex top elevation (W-093 sloped tops)
    const top = new MeshBuilder();
    const ring: P3[] = [
      ...left.points.map((p, i) => ({ x: p.x, y: p.y, z: el.top((left.u[i] as number) / len) })),
      ...[...right.points].reverse().map((p, i) => {
        const idx = right.points.length - 1 - i;
        return { x: p.x, y: p.y, z: el.top((right.u[idx] as number) / len) };
      }),
    ];
    top.addFace(ring, { x: 0, y: 0, z: 1 }, planUv);
    out.push(
      top.toPart(
        w.id,
        "wall-top",
        finishedMaterialKey(glass ? "wall-glass-frame" : "wall-top", w.finishes.top),
      ),
    );
    // end caps (W-003 corners)
    const dir = { x: w.end.x - w.start.x, y: w.end.y - w.start.y, z: 0 };
    const ls = left.points[0] as Point;
    const rs = right.points[0] as Point;
    const le = left.points[left.points.length - 1] as Point;
    const re = right.points[right.points.length - 1] as Point;
    const capStart = new MeshBuilder();
    capStart.addFace(
      [
        { x: ls.x, y: ls.y, z: el.bottom },
        { x: rs.x, y: rs.y, z: el.bottom },
        { x: rs.x, y: rs.y, z: el.top(0) },
        { x: ls.x, y: ls.y, z: el.top(0) },
      ],
      { x: -dir.x, y: -dir.y, z: 0 },
      (p) => [Math.hypot(p.x - ls.x, p.y - ls.y) / MM_PER_M, p.z / MM_PER_M],
    );
    out.push(capStart.toPart(w.id, "wall-end-start", edgeKey));
    const capEnd = new MeshBuilder();
    capEnd.addFace(
      [
        { x: le.x, y: le.y, z: el.bottom },
        { x: re.x, y: re.y, z: el.bottom },
        { x: re.x, y: re.y, z: el.top(1) },
        { x: le.x, y: le.y, z: el.top(1) },
      ],
      dir,
      (p) => [Math.hypot(p.x - le.x, p.y - le.y) / MM_PER_M, p.z / MM_PER_M],
    );
    out.push(capEnd.toPart(w.id, "wall-end-end", edgeKey));
    for (const c of cutList) {
      const o = c.opening;
      // The frame finish dresses what surrounds the hole; the leaf finish dresses what fills it.
      const frameKey = finishedMaterialKey(revealKey, o.finishes.frame, ctx.textures);
      // A window is glazed by default, because a window without glass is a hole and nobody means that.
      // A door is NOT: a doorway with a flat panel across it reads as a flaw rather than as a door, and
      // the model does not know whether the door is shut. A leaf appears when one is asked for, by
      // giving it a colour or a material. A passage never has one.
      const fillBase =
        o.kind === "window" ? "opening-glass" : o.kind === "door" && o.finishes.leaf ? "opening-leaf" : null;
      const fillKey = fillBase ? finishedMaterialKey(fillBase, o.finishes.leaf, ctx.textures) : null;
      buildOpeningFaces(left, right, len, c, el, out, frameKey, fillKey);
    }
    // A baseboard wears its own colour when it has one and its side's otherwise, with the side's shininess
    // either way, and a quiet off-white of its own on an unpainted side (W-112). On glass it is frame.
    for (const [name, side] of [
      ["left", left],
      ["right", right],
    ] as const) {
      const finish = w.finishes[name];
      const own = w.skirting[name]?.color ?? null;
      const key = glass
        ? "wall-glass-frame"
        : finishedMaterialKey("wall-skirting", {
            color: own ?? finish?.color ?? null,
            shininess: finish?.shininess ?? null,
          });
      buildSkirting(w, name, side, len, cutList, el, ctx.level, key, out);
    }
  }
  return out;
}

type Stop = { p: Point; u: number };

/** One unbroken stretch of a baseboard: the side's face and the offset line, each start to end. */
interface SkirtingRun {
  inner: Stop[];
  skin: Stop[];
}

interface SkirtingPlan {
  runs: SkirtingRun[];
  bottom: number;
  topAt: (u: number) => number;
  side: Side;
  outer: Side;
}

/** Where a baseboard lies on the plan: one ring per unbroken stretch, the face out to the offset line. */
export interface SkirtingOutline {
  wallId: string;
  side: "left" | "right";
  rings: Point[][];
}

/**
 * The plan outline of every baseboard on a level, from the same runs the 3D faces are built from, so the
 * plan and the model cannot disagree about where a baseboard stops.
 */
export function skirtingOutlines(
  walls: readonly Wall[],
  openings: readonly Opening[],
  ctx: WallBuildContext,
): SkirtingOutline[] {
  const onLevel = walls.filter((w) => w.levelId === ctx.level.id);
  if (!onLevel.some((w) => w.skirting.left || w.skirting.right)) return [];
  const fps = ctx.footprints ?? wallFootprints(onLevel);
  const out: SkirtingOutline[] = [];
  for (const w of onLevel) {
    if (!w.skirting.left && !w.skirting.right) continue;
    const frame = frameOf(w, fps, openings, ctx);
    if (!frame) continue;
    for (const [name, side] of [
      ["left", frame.left],
      ["right", frame.right],
    ] as const) {
      const plan = planSkirting(w, name, side, frame.len, frame.cutList, frame.el, ctx.level);
      if (!plan || plan.runs.length === 0) continue;
      out.push({
        wallId: w.id,
        side: name,
        rings: plan.runs.map((r) => [...r.inner.map((s) => s.p), ...[...r.skin].reverse().map((s) => s.p)]),
      });
    }
  }
  return out;
}

/**
 * A baseboard along one side (ADR-014 D8): a strip standing out from the side's face by its thickness, from
 * the floor up to its height.
 *
 * - It stands on the level's floor, not on the wall's bottom, which drops through the slab on upper levels,
 *   and its top is flat even on a sloping wall (W-099) — except that it never rises above the wall where
 *   the wall is lower (W-100).
 * - The strip lies between the side's own outline and that outline offset outward (W-107). At a joined end
 *   the offset stops on the line through the join and the side's corner, which is the line the neighbour's
 *   baseboard stops on too, so a corner closes without either one knowing about the other.
 * - Any opening that starts below the baseboard's top breaks it (W-113), leaving an end face each side.
 * - On the inside of a curve the offset never passes the arc's centre (W-057 reversed).
 */
function planSkirting(
  w: Wall,
  name: "left" | "right",
  side: Side,
  len: number,
  cutList: readonly Cut[],
  el: WallElevations,
  level: Level,
): SkirtingPlan | null {
  const sk = w.skirting[name];
  const pts = side.points;
  if (!sk || pts.length < 2) return null;

  // outward normal of each segment: left of the start-to-end direction for the left side, right for the right
  const segNormals: Point[] = [];
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const a = pts[i] as Point;
    const b = pts[i + 1] as Point;
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dx = (b.x - a.x) / l;
    const dy = (b.y - a.y) / l;
    segNormals.push(name === "left" ? { x: -dy, y: dx } : { x: dy, y: -dx });
  }
  const arc = derive.arcParams(w);
  const offsetAt = (i: number): Point => {
    const p = pts[i] as Point;
    const nPrev = segNormals[Math.max(0, i - 1)] as Point;
    const nNext = segNormals[Math.min(segNormals.length - 1, i)] as Point;
    // mitre between the neighbouring segments, so the offset stays parallel to both
    let mx = nPrev.x + nNext.x;
    let my = nPrev.y + nNext.y;
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml;
    my /= ml;
    const cos = mx * nNext.x + my * nNext.y;
    let d = sk.thickness / (Math.abs(cos) < 1e-6 ? 1 : cos);
    if (arc) {
      // W-057 reversed: toward the centre, the offset stops at the centre instead of passing through it
      const toCentre = Math.hypot(arc.centre.x - p.x, arc.centre.y - p.y);
      const inward = (arc.centre.x - p.x) * mx + (arc.centre.y - p.y) * my > 0;
      if (inward) d = Math.min(d, toCentre);
    }
    return { x: p.x + mx * d, y: p.y + my * d };
  };
  const offset = pts.map((_, i) => offsetAt(i));
  // Joined ends: slide the offset end along the offset line onto the corner line through the join.
  const endOnCornerLine = (i: number, next: number, joint: Point): void => {
    const p = pts[i] as Point;
    const q = offset[i] as Point;
    const n = pts[next] as Point;
    if (Math.hypot(p.x - joint.x, p.y - joint.y) < 1e-6) return;
    // the offset line runs through q parallel to the side's end segment; the corner line through the join
    const hit = intersectLines(q, { x: q.x + (n.x - p.x), y: q.y + (n.y - p.y) }, joint, p);
    if (hit) offset[i] = hit;
  };
  if (w.joins.start) endOnCornerLine(0, 1, w.start);
  if (w.joins.end) endOnCornerLine(pts.length - 1, pts.length - 2, w.end);
  // Positions along the wall for the offset line. A straight wall measures them by projection, as its face
  // does, so a door break is square across the baseboard; reusing the face's positions would skew it by the
  // corner offset. On a curve a radial offset keeps each point at the face point's angle, so the face's
  // positions are the right ones, and the two strips below stay vertex for vertex.
  const outer: Side = derive.isArc(w)
    ? { points: offset, u: side.u, start: side.start, end: side.end }
    : makeSide(offset, w);

  const bottom = level.elevation;
  const topAt = (u: number): number => Math.min(bottom + sk.height, el.top(len === 0 ? 0 : u / len));
  if (topAt(side.start) <= bottom && topAt(side.end) <= bottom) return null;

  // runs of the side not broken by an opening that starts below the baseboard's top
  const breaks = cutList
    .filter((c) => c.sillZ < bottom + sk.height)
    .map((c) => [Math.max(side.start, c.from), Math.min(side.end, c.to)] as const)
    .filter(([a, b]) => b > a);
  const runs: [number, number][] = [];
  let from = side.start;
  for (const [a, b] of breaks) {
    if (a > from) runs.push([from, a]);
    from = Math.max(from, b);
  }
  if (side.end > from) runs.push([from, side.end]);

  // A clamped end can repeat a vertex; a zero-length edge would only make degenerate triangles.
  const distinct = (stops: Stop[]): Stop[] =>
    stops.filter(
      (s, k) =>
        k === 0 || Math.hypot(s.p.x - (stops[k - 1] as Stop).p.x, s.p.y - (stops[k - 1] as Stop).p.y) > 1e-6,
    );

  const pieces: SkirtingRun[] = [];
  for (const [ua, ub] of runs) {
    if (ub - ua < 0.5) continue;
    // The face and the offset line are walked separately: on a straight wall the offset line starts and ends
    // a little further along than the face (it stops on the corner lines), so their vertices do not pair up.
    const inner = distinct(strip(side, ua, ub));
    const skin = distinct(strip(outer, ua, ub));
    if (inner.length >= 2 && skin.length >= 2) pieces.push({ inner, skin });
  }
  return { runs: pieces, bottom, topAt, side, outer };
}

/** The faces of one side's baseboard: front, top and an end wherever a run stops. */
function buildSkirting(
  w: Wall,
  name: "left" | "right",
  side: Side,
  len: number,
  cutList: readonly Cut[],
  el: WallElevations,
  level: Level,
  key: string,
  out: GeometryPart[],
): void {
  const plan = planSkirting(w, name, side, len, cutList, el, level);
  if (!plan) return;
  const { bottom, topAt, outer } = plan;
  const mb = new MeshBuilder();
  for (const { inner, skin } of plan.runs) {
    // front: the offset line, bottom to top, facing away from the wall
    for (let k = 0; k + 1 < skin.length; k += 1) {
      const a = skin[k] as Stop;
      const b = skin[k + 1] as Stop;
      const mid = (a.u + b.u) / 2;
      const face = at(side, mid);
      const off = at(outer, mid);
      mb.addFace(
        [
          { ...a.p, z: bottom },
          { ...b.p, z: bottom },
          { ...b.p, z: topAt(b.u) },
          { ...a.p, z: topAt(a.u) },
        ],
        { x: off.x - face.x, y: off.y - face.y, z: 0 },
        (q) => [(a.u + Math.hypot(q.x - a.p.x, q.y - a.p.y)) / MM_PER_M, q.z / MM_PER_M],
      );
    }
    // top: one band from the face out to the offset line
    mb.addFace(
      [...inner, ...[...skin].reverse()].map((s) => ({ ...s.p, z: topAt(s.u) })),
      { x: 0, y: 0, z: 1 },
      (q) => [q.x / MM_PER_M, q.y / MM_PER_M],
    );
    // An end face wherever the run stops: at the wall's ends and either side of a break. Each faces along the
    // run's own direction there, not the chord's, which on a curve can point well away from it.
    for (const [i, within, o] of [
      [inner[0], inner[1], skin[0]],
      [inner[inner.length - 1], inner[inner.length - 2], skin[skin.length - 1]],
    ] as [Stop, Stop, Stop][]) {
      const t = topAt(o.u);
      mb.addFace(
        [
          { ...i.p, z: bottom },
          { ...o.p, z: bottom },
          { ...o.p, z: t },
          { ...i.p, z: t },
        ],
        { x: i.p.x - within.p.x, y: i.p.y - within.p.y, z: 0 },
        (q) => [Math.hypot(q.x - i.p.x, q.y - i.p.y) / MM_PER_M, q.z / MM_PER_M],
      );
    }
  }
  if (!mb.isEmpty) out.push(mb.toPart(w.id, name === "left" ? "skirting-left" : "skirting-right", key));
}

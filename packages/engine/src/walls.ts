// Wall geometry (ADR-014 D5..D9, spec 05 section 3). Each side is built in wall-local (u, v) space:
// u is the distance along the wall direction in mm (so opening intervals map exactly, even on mitred
// sides), v is elevation. Openings are rectangles in that space, so a side face decomposes into
// rectangles below sills, above heads, and between openings, with no booleans.

import { TOL, wallFootprints } from "@fpv/geometry";
import type { Level, Opening, Point, Wall } from "@fpv/ir";
import { derive } from "@fpv/ir";
import { MeshBuilder } from "./mesh.js";
import { type GeometryPart, MM_PER_M, type P3 } from "./types.js";

export interface WallBuildContext {
  level: Level;
  isLowest: boolean;
  isHighest: boolean;
  footprints?: Map<string, Point[]>;
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
}

function cuts(w: Wall, openings: readonly Opening[], level: Level): Cut[] {
  return openings
    .filter((o) => o.wallId === w.id)
    .map((o) => {
      // position is a fraction of the centreline path; width is a physical width along that path (W-111)
      const c = o.position * pathLength(w);
      return {
        from: c - o.width / 2,
        to: c + o.width / 2,
        sillZ: level.elevation + o.sill,
        headZ: level.elevation + o.sill + o.height,
        opening: o,
      };
    })
    .sort((a, b) => a.from - b.from);
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
    if (c.sillZ > el.bottom) band(mb, side, other, len, c.from, c.to, el.bottom, () => c.sillZ); // O-052
    band(mb, side, other, len, c.from, c.to, c.headZ, el.top); // O-054: empty when the head reaches the top
    cursor = Math.max(cursor, c.to);
  }
  if (cursor < side.end) band(mb, side, other, len, cursor, side.end, el.bottom, el.top);
  return mb;
}

function buildOpeningFaces(
  left: Side,
  right: Side,
  len: number,
  c: Cut,
  el: WallElevations,
  out: GeometryPart[],
): void {
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
    out.push(sill.toPart(oid, "opening-sill", "opening-reveal"));
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
    out.push(head.toPart(oid, "opening-head", "opening-reveal"));
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
  if (!jambs.isEmpty) out.push(jambs.toPart(oid, "opening-jamb", "opening-reveal"));
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
    const fp = fps.get(w.id);
    const len = pathLength(w);
    if (!fp || fp.length < 4 || len === 0) continue;
    const n = fp.length / 2;
    const left = makeSide(fp.slice(0, n), w);
    const right = makeSide([...fp.slice(n)].reverse(), w);
    const el = wallElevations(w, ctx);
    const cutList = cuts(w, openings, ctx.level);
    out.push(buildSide(left, right, len, cutList, el).toPart(w.id, "wall-left", "wall-side"));
    out.push(buildSide(right, left, len, cutList, el).toPart(w.id, "wall-right", "wall-side"));
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
    out.push(top.toPart(w.id, "wall-top", "wall-top"));
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
    out.push(capStart.toPart(w.id, "wall-end-start", "wall-side"));
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
    out.push(capEnd.toPart(w.id, "wall-end-end", "wall-side"));
    for (const c of cutList) buildOpeningFaces(left, right, len, c, el, out);
  }
  return out;
}

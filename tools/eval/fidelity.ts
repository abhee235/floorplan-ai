// How closely a model built from a picture matches a reference built from the same picture.
//
// A picture with no dimensions can be drawn at any scale and from any origin, and a run that guessed
// 20 mm a pixel where the reference used 22 has not drawn a different building. So both projects are
// first mapped onto the unit square of their own walls' bounding box, and everything is compared
// there: walls by how much of each lies along the other's, openings and furniture by their centres,
// rooms by name. The tolerance is a share of the box's diagonal, so it means the same on any scale.

import type { Item, Project, Wall } from "@fpv/ir";

export interface FidelityScore {
  /** How much bigger the built project is than the reference: the scale the run guessed, relatively. */
  scaleRatio: number;
  walls: { reference: number; built: number; recall: number; precision: number };
  openings: { reference: number; built: number; recall: number; kindAgreement: number };
  rooms: { reference: number; built: number; named: number; missing: string[] };
  items: { reference: number; built: number; recall: number; precision: number };
}

type P = { x: number; y: number };

function box(p: Project) {
  const xs = p.walls.flatMap((w) => [w.start.x, w.end.x]);
  const ys = p.walls.flatMap((w) => [w.start.y, w.end.y]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(1, Math.max(...xs) - x0);
  const h = Math.max(1, Math.max(...ys) - y0);
  return { x0, y0, w, h, norm: (q: P): P => ({ x: (q.x - x0) / w, y: (q.y - y0) / h }) };
}

function segDist(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** The share of wall `w` that lies within `tol` of some wall in `others`. */
function covered(w: [P, P], others: [P, P][], tol: number): number {
  const n = 40;
  let hit = 0;
  for (let i = 0; i <= n; i += 1) {
    const p = { x: w[0].x + ((w[1].x - w[0].x) * i) / n, y: w[0].y + ((w[1].y - w[0].y) * i) / n };
    if (others.some(([a, b]) => segDist(p, a, b) <= tol)) hit += 1;
  }
  return hit / (n + 1);
}

function openingCentre(wallOf: Map<string, Wall>, o: Project["openings"][number]): P | null {
  const w = wallOf.get(o.wallId);
  if (!w) return null;
  return {
    x: w.start.x + (w.end.x - w.start.x) * o.position,
    y: w.start.y + (w.end.y - w.start.y) * o.position,
  };
}

/** Items in broad families, so a chair drawn as a recipe matches a chair from the catalog. */
function family(i: Item): string {
  const kind = i.ref.kind === "recipe" ? i.ref.recipe.kind : "product";
  if (kind === "chair" || kind === "sofa") return "seat";
  if (kind === "table") return "table";
  if (kind === "cylinder") return "round";
  return "other";
}

/** Greedy one-to-one matching by distance, within the tolerance. */
function matchPoints(
  a: { p: P; f: string }[],
  b: { p: P; f: string }[],
  tol: number,
  sameFamily: boolean,
): number {
  const pairs: [number, number, number][] = [];
  for (const [i, x] of a.entries())
    for (const [j, y] of b.entries()) {
      if (sameFamily && x.f !== y.f) continue;
      const d = Math.hypot(x.p.x - y.p.x, x.p.y - y.p.y);
      if (d <= tol) pairs.push([d, i, j]);
    }
  pairs.sort((u, v) => u[0] - v[0]);
  const ua = new Set<number>();
  const ub = new Set<number>();
  for (const [, i, j] of pairs) {
    if (ua.has(i) || ub.has(j)) continue;
    ua.add(i);
    ub.add(j);
  }
  return ua.size;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

export function scoreFidelity(built: Project, reference: Project, tolShare = 0.025): FidelityScore {
  const rb = box(reference);
  const bb = box(built);
  // The unit square is not square; the tolerance is a share of its diagonal in normalised units.
  const tol = tolShare * Math.SQRT2;
  const seg = (p: Project, b: typeof rb) => p.walls.map((w) => [b.norm(w.start), b.norm(w.end)] as [P, P]);
  const rs = seg(reference, rb);
  const bs = seg(built, bb);
  const wallRecall = rs.length ? rs.filter((w) => covered(w, bs, tol) >= 0.7).length / rs.length : 0;
  const wallPrecision = bs.length ? bs.filter((w) => covered(w, rs, tol) >= 0.7).length / bs.length : 0;

  const centres = (p: Project, b: typeof rb) => {
    const wallOf = new Map(p.walls.map((w) => [w.id, w]));
    return p.openings.flatMap((o) => {
      const c = openingCentre(wallOf, o);
      return c ? [{ p: b.norm(c), f: o.kind === "window" ? "window" : "way" }] : [];
    });
  };
  const ro = centres(reference, rb);
  const bo = centres(built, bb);
  const openingsAnywhere = matchPoints(ro, bo, tol * 1.5, false);
  const openingsSameKind = matchPoints(ro, bo, tol * 1.5, true);

  const names = built.rooms.map((r) => words(r.name ?? ""));
  const missing = reference.rooms
    .map((r) => r.name ?? "")
    .filter((n) => {
      const w = words(n);
      return !names.some((b) => w.some((x) => b.includes(x)));
    });

  const items = (p: Project, b: typeof rb) => p.items.map((i) => ({ p: b.norm(i.position), f: family(i) }));
  const ri = items(reference, rb);
  const bi = items(built, bb);
  const itemMatches = matchPoints(ri, bi, tol, true);

  const diag = (b: typeof rb) => Math.hypot(b.w, b.h);
  return {
    scaleRatio: Math.round((diag(bb) / diag(rb)) * 1000) / 1000,
    walls: {
      reference: rs.length,
      built: bs.length,
      recall: Math.round(wallRecall * 100) / 100,
      precision: Math.round(wallPrecision * 100) / 100,
    },
    openings: {
      reference: ro.length,
      built: bo.length,
      recall: ro.length ? Math.round((openingsAnywhere / ro.length) * 100) / 100 : 0,
      kindAgreement: openingsAnywhere ? Math.round((openingsSameKind / openingsAnywhere) * 100) / 100 : 0,
    },
    rooms: {
      reference: reference.rooms.length,
      built: built.rooms.length,
      named: reference.rooms.length - missing.length,
      missing,
    },
    items: {
      reference: ri.length,
      built: bi.length,
      recall: ri.length ? Math.round((itemMatches / ri.length) * 100) / 100 : 0,
      precision: bi.length ? Math.round((itemMatches / bi.length) * 100) / 100 : 0,
    },
  };
}

/** An overall share, the mean of walls, openings, rooms and furniture recall. */
export function fidelityOverall(s: FidelityScore): number {
  const rooms = s.rooms.reference ? s.rooms.named / s.rooms.reference : 0;
  return Math.round(((s.walls.recall + s.openings.recall + rooms + s.items.recall) / 4) * 100) / 100;
}

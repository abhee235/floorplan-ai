// Draft quality against a hand-labelled or generated expectation (spec 06 A4): wall recall and precision by
// centreline overlap within 150 mm, opening recall within 300 mm, room recall by label and area within 10
// percent, and the scale error in percent. All comparisons happen in millimetres.
import type { PlanDraft } from "./draft.js";
import { flatten, parseDxf } from "./dxf.js";

export interface ExpectedPlan {
  name: string;
  /** The true millimetres per drawing unit. */
  mmPerUnit: number;
  /** Centrelines in millimetres. */
  walls: { points: { x: number; y: number }[]; thickness: number }[];
  openings: { at: { x: number; y: number }; kind: "door" | "window" | "passage"; width: number }[];
  rooms: { name: string; areaM2: number | null }[];
}

export interface DraftScore {
  wallRecall: number;
  wallPrecision: number;
  openingRecall: number;
  openingPrecision: number;
  roomRecall: number;
  scaleErrorPct: number | null;
  missedOpenings: { at: { x: number; y: number }; kind: string }[];
  missedRooms: string[];
}

type P = { x: number; y: number };

const WALL_TOL_MM = 150;
const OPENING_TOL_MM = 300;
const SAMPLE_MM = 50;
const ANGLE_TOL = Math.sin((15 * Math.PI) / 180);

function segments(lines: readonly P[][]): [P, P][] {
  return lines.flatMap((pts) => pts.slice(1).map((q, i): [P, P] => [pts[i] as P, q]));
}

function distanceToSegment(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Share of `from`'s length lying within tolerance of some roughly parallel segment of `to`. */
function coverage(from: readonly [P, P][], to: readonly [P, P][]): number {
  let total = 0;
  let covered = 0;
  for (const [a, b] of from) {
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l === 0) continue;
    const u = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
    const n = Math.max(1, Math.round(l / SAMPLE_MM));
    for (let i = 0; i < n; i += 1) {
      const t = ((i + 0.5) / n) * l;
      const p = { x: a.x + u.x * t, y: a.y + u.y * t };
      total += l / n;
      const hit = to.some(([c, d]) => {
        const m = Math.hypot(d.x - c.x, d.y - c.y);
        if (m === 0) return false;
        const cross = Math.abs(u.x * (d.y - c.y) - u.y * (d.x - c.x)) / m;
        return cross <= ANGLE_TOL && distanceToSegment(p, c, d) <= WALL_TOL_MM;
      });
      if (hit) covered += l / n;
    }
  }
  return total === 0 ? 1 : covered / total;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function polygonAreaM2(poly: readonly P[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i] as P;
    const b = poly[(i + 1) % poly.length] as P;
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2 / 1e6;
}

export function scoreDraft(draft: PlanDraft, expected: ExpectedPlan): DraftScore {
  const f = draft.units.mmPerUnit ?? expected.mmPerUnit;
  const mm = (p: P): P => ({ x: p.x * f, y: p.y * f });
  const draftWalls = segments(draft.walls.map((w) => w.points.map(mm)));
  const expectedWalls = segments(expected.walls.map((w) => w.points));
  const openings = draft.openings.map((o) => ({ at: mm(o.at), kind: o.kind }));
  const used = new Set<number>();
  const missedOpenings: DraftScore["missedOpenings"] = [];
  for (const e of expected.openings) {
    let best = -1;
    let bestD = OPENING_TOL_MM;
    openings.forEach((o, i) => {
      if (used.has(i)) return;
      if (e.kind !== "passage" && o.kind !== e.kind) return;
      const d = Math.hypot(o.at.x - e.at.x, o.at.y - e.at.y);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) used.add(best);
    else missedOpenings.push({ at: e.at, kind: e.kind });
  }
  const roomsUsed = new Set<number>();
  const missedRooms: string[] = [];
  for (const e of expected.rooms) {
    const i = draft.rooms.findIndex((r, k) => {
      if (roomsUsed.has(k) || !r.name || norm(r.name) !== norm(e.name)) return false;
      if (e.areaM2 === null || !r.polygon) return true;
      const a = polygonAreaM2(r.polygon.map(mm));
      return Math.abs(a - e.areaM2) / e.areaM2 <= 0.1;
    });
    if (i >= 0) roomsUsed.add(i);
    else missedRooms.push(e.name);
  }
  const ratio = (hit: number, of: number) => (of === 0 ? 1 : hit / of);
  return {
    wallRecall: coverage(expectedWalls, draftWalls),
    wallPrecision: coverage(draftWalls, expectedWalls),
    openingRecall: ratio(expected.openings.length - missedOpenings.length, expected.openings.length),
    openingPrecision: ratio(used.size, openings.length),
    roomRecall: ratio(expected.rooms.length - missedRooms.length, expected.rooms.length),
    scaleErrorPct:
      draft.units.mmPerUnit === null
        ? null
        : (Math.abs(draft.units.mmPerUnit - expected.mmPerUnit) / expected.mmPerUnit) * 100,
    missedOpenings,
    missedRooms,
  };
}

// ---- real drawings --------------------------------------------------------------------------------------------
// Real plans are not hand-labelled wall by wall. Walls are scored against the drawing itself: the share of
// wall-layer line work lying along a face of some draft wall. Openings are scored by count against the
// drawing's hand count, and rooms by name.

export interface RealPlanExpectation {
  name: string;
  /** Where the drawing comes from and under which licence. */
  source: string;
  licence: string;
  /** The true millimetres per drawing unit, read from the drawing's dimensions. */
  mmPerUnit: number;
  /** Layers that really hold the walls (the source line work walls are scored against). */
  wallLayers: string[];
  /** Hand counts from the drawing; null when the drawing does not allow an honest count. */
  doors: number | null;
  windows: number | null;
  /** Room names as written on the drawing. */
  rooms: string[];
}

export interface RealPlanScore {
  /** Share of wall-layer line length lying along a draft wall face. */
  wallFaceCoverage: number;
  scaleErrorPct: number | null;
  /** Null when the expectation has no count. */
  doorRecall: number | null;
  windowRecall: number | null;
  /** What the draft found, to read beside the capped recall. */
  doorsFound: number;
  windowsFound: number;
  roomRecall: number;
  missedRooms: string[];
  extraRooms: string[];
}

type Segment = [number, number, number, number];

/** Face coverage: each sample on a source wall line counts when it lies within half a wall's thickness (plus
 * 30 mm) of that wall's centreline and runs within 10 degrees of it. Lines shorter than 400 mm are wall end
 * caps and jambs, which run across the wall, and are left out. */
export function wallFaceCoverage(draft: PlanDraft, faces: readonly Segment[], mmPerUnit: number): number {
  const tol = 30 / mmPerUnit;
  const cosTol = Math.cos((10 * Math.PI) / 180);
  const walls = draft.walls.flatMap((w) =>
    w.points.slice(1).map((q, i) => ({ a: w.points[i] as P, b: q, half: (w.thickness ?? 0) / 2 })),
  );
  const step = 50 / mmPerUnit;
  let total = 0;
  let covered = 0;
  for (const [x1, y1, x2, y2] of faces) {
    const l = Math.hypot(x2 - x1, y2 - y1);
    if (l === 0 || l * mmPerUnit < 400) continue;
    const ux = (x2 - x1) / l;
    const uy = (y2 - y1) / l;
    const n = Math.max(1, Math.round(l / step));
    for (let i = 0; i < n; i += 1) {
      const t = ((i + 0.5) / n) * l;
      const p = { x: x1 + ux * t, y: y1 + uy * t };
      total += l / n;
      const hit = walls.some(({ a, b, half }) => {
        const m = Math.hypot(b.x - a.x, b.y - a.y);
        if (m === 0) return false;
        if (Math.abs((ux * (b.x - a.x) + uy * (b.y - a.y)) / m) < cosTol) return false;
        return distanceToSegment(p, a, b) <= half + tol;
      });
      if (hit) covered += l / n;
    }
  }
  return total === 0 ? 1 : covered / total;
}

export function scoreRealPlan(
  draft: PlanDraft,
  faces: readonly Segment[],
  expected: RealPlanExpectation,
): RealPlanScore {
  const count = (kind: string) => draft.openings.filter((o) => o.kind === kind).length;
  const recallOf = (found: number, of: number | null) =>
    of === null ? null : of === 0 ? 1 : Math.min(found, of) / of;
  const names = draft.rooms.map((r) => (r.name ? norm(r.name) : "")).filter(Boolean);
  const wanted = expected.rooms.map(norm);
  const pool = [...names];
  const missedRooms: string[] = [];
  expected.rooms.forEach((room, i) => {
    const at = pool.indexOf(wanted[i] as string);
    if (at >= 0) pool.splice(at, 1);
    else missedRooms.push(room);
  });
  const extraRooms = draft.rooms.map((r) => r.name ?? "").filter((n) => n && !wanted.includes(norm(n)));
  return {
    wallFaceCoverage: wallFaceCoverage(draft, faces, expected.mmPerUnit),
    scaleErrorPct:
      draft.units.mmPerUnit === null
        ? null
        : (Math.abs(draft.units.mmPerUnit - expected.mmPerUnit) / expected.mmPerUnit) * 100,
    doorRecall: recallOf(count("door"), expected.doors),
    doorsFound: count("door"),
    windowsFound: count("window"),
    windowRecall: recallOf(count("window"), expected.windows),
    roomRecall: recallOf(expected.rooms.length - missedRooms.length, expected.rooms.length) ?? 1,
    missedRooms,
    extraRooms,
  };
}

/**
 * The drawing's own wall line work, in drawing units: lines and polyline edges on the given layers, with
 * blocks flattened and frozen or off layers left out. Face coverage is scored against these.
 */
export function sourceWallFaces(text: string, wallLayers: readonly string[]): Segment[] {
  const doc = parseDxf(text);
  const hidden = new Set([...doc.layers.values()].filter((l) => l.frozen || l.off).map((l) => l.name));
  const wanted = new Set(wallLayers);
  const out: Segment[] = [];
  for (const { entity: e } of flatten(doc).placed) {
    if (!wanted.has(e.layer) || hidden.has(e.layer)) continue;
    if (e.type === "LINE") out.push([e.a.x, e.a.y, e.b.x, e.b.y]);
    else if (e.type === "POLYLINE") {
      const v = e.vertices;
      const edges = e.closed ? v.length : v.length - 1;
      for (let i = 0; i < edges; i += 1) {
        const a = v[i] as { x: number; y: number };
        const b = v[(i + 1) % v.length] as { x: number; y: number };
        out.push([a.x, a.y, b.x, b.y]);
      }
    }
  }
  return out;
}

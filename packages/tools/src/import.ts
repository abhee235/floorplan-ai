// Committing a reviewed PlanDraft (spec 06 A2, ADR-011 D1, D3): one transaction of wall chains, joins,
// openings, rooms, labels and provenance. Nothing writes IR directly; every change is a command.
import type { HistoryEntry, Store } from "@fpv/commands";
import { type PlanDraft, scaleStatus } from "@fpv/importers";
import { derive, type Point, type Wall } from "@fpv/ir";

export class CommitError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string | null = null,
  ) {
    super(message);
    this.name = "CommitError";
  }
}

export interface CommitOptions {
  levelId: string;
  label: string;
  now: string;
  /** Added to every converted coordinate, in millimetres. */
  offsetMm?: { x: number; y: number };
}

export interface CommitSkip {
  what: "wall" | "opening" | "room";
  idx: number;
  reason: string;
}

export interface CommitReport {
  wallIds: string[];
  openingIds: string[];
  roomIds: string[];
  /** Labels whose room could not be found, kept as label annotations. */
  annotationIds: string[];
  skipped: CommitSkip[];
  /** Unanswered questions and skipped entities, as recorded in the project provenance. */
  questions: string[];
  entry: HistoryEntry | null;
}

/** Endpoints closer than this join (spec 06 A2 rule 4). */
const JOIN_MM = 20;
/** Openings must lie this close to an imported wall centreline (spec 06 A2 rule 5). */
const OPENING_MM = 100;

interface DraftWallMm {
  idx: number;
  points: Point[];
  thickness: number | null;
  kind: PlanDraft["walls"][number]["kind"];
}

interface Chain {
  points: Point[];
  closed: boolean;
  /** Draft wall index of each segment, in order. */
  segmentWall: number[];
  thickness: number | null;
  kind: DraftWallMm["kind"];
}

/**
 * Walls meeting end to end at a point where exactly two ends meet, with the same thickness and kind, become
 * one chain, so corners are joined by the chain itself. Endpoints within 20 mm are first moved to one point.
 */
export function buildChains(walls: readonly DraftWallMm[]): Chain[] {
  // cluster endpoints within JOIN_MM
  const ends: { wall: number; end: 0 | 1; p: Point }[] = [];
  walls.forEach((w, i) => {
    ends.push({ wall: i, end: 0, p: w.points[0] as Point });
    ends.push({ wall: i, end: 1, p: w.points[w.points.length - 1] as Point });
  });
  const parent = ends.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    let c = i;
    while (parent[c] !== r) {
      const next = parent[c] as number;
      parent[c] = r;
      c = next;
    }
    return r;
  };
  for (let i = 0; i < ends.length; i += 1)
    for (let j = i + 1; j < ends.length; j += 1) {
      const a = ends[i] as (typeof ends)[number];
      const b = ends[j] as (typeof ends)[number];
      if (
        Math.abs(a.p.x - b.p.x) <= JOIN_MM &&
        Math.abs(a.p.y - b.p.y) <= JOIN_MM &&
        Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y) <= JOIN_MM
      )
        parent[find(i)] = find(j);
    }
  const clusters = new Map<number, number[]>();
  ends.forEach((_, i) => {
    const r = find(i);
    clusters.set(r, [...(clusters.get(r) ?? []), i]);
  });
  const snapped = walls.map((w) => ({ ...w, points: w.points.map((p) => ({ ...p })) }));
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const x = Math.round(
      members.reduce((s, i) => s + (ends[i] as (typeof ends)[number]).p.x, 0) / members.length,
    );
    const y = Math.round(
      members.reduce((s, i) => s + (ends[i] as (typeof ends)[number]).p.y, 0) / members.length,
    );
    for (const i of members) {
      const e = ends[i] as (typeof ends)[number];
      const pts = (snapped[e.wall] as DraftWallMm).points;
      pts[e.end === 0 ? 0 : pts.length - 1] = { x, y };
    }
  }
  // partner of an end: the other end in a two-member cluster with a compatible wall
  const compatible = (a: DraftWallMm, b: DraftWallMm) =>
    a.kind === b.kind &&
    (a.thickness === null || b.thickness === null
      ? a.thickness === b.thickness
      : Math.abs(a.thickness - b.thickness) <= 1);
  const partner = new Map<number, number>();
  for (const members of clusters.values()) {
    if (members.length !== 2) continue;
    const [i, j] = members as [number, number];
    const a = ends[i] as (typeof ends)[number];
    const b = ends[j] as (typeof ends)[number];
    if (a.wall === b.wall) continue;
    if (!compatible(snapped[a.wall] as DraftWallMm, snapped[b.wall] as DraftWallMm)) continue;
    partner.set(i, j);
    partner.set(j, i);
  }
  const endIndex = (wall: number, end: 0 | 1) => wall * 2 + end;
  const used = new Set<number>();
  const chains: Chain[] = [];
  const walk = (startWall: number, startReversed: boolean): Chain => {
    const order: { wall: number; reversed: boolean }[] = [];
    let wall = startWall;
    let reversed = startReversed;
    let closed = false;
    for (;;) {
      used.add(wall);
      order.push({ wall, reversed });
      const exitEnd = endIndex(wall, reversed ? 0 : 1);
      const next = partner.get(exitEnd);
      if (next === undefined) break;
      const nw = Math.floor(next / 2);
      if (nw === startWall) {
        closed = true;
        break;
      }
      if (used.has(nw)) break;
      wall = nw;
      reversed = next % 2 === 1; // entering at its end means walking it backwards
    }
    const points: Point[] = [];
    const segmentWall: number[] = [];
    for (const { wall: w, reversed: r } of order) {
      const pts = (snapped[w] as DraftWallMm).points;
      const seq = r ? [...pts].reverse() : pts;
      const run = points.length ? seq.slice(1) : seq;
      for (let k = 0; k < seq.length - 1; k += 1) segmentWall.push((snapped[w] as DraftWallMm).idx);
      points.push(...run);
    }
    if (closed) points.pop();
    const first = snapped[startWall] as DraftWallMm;
    return { points, closed, segmentWall, thickness: first.thickness, kind: first.kind };
  };
  // open chains start at an end with no partner
  snapped.forEach((_, w) => {
    if (used.has(w)) return;
    if (!partner.has(endIndex(w, 0))) chains.push(walk(w, false));
    else if (!partner.has(endIndex(w, 1))) chains.push(walk(w, true));
  });
  // what is left is loops
  snapped.forEach((_, w) => {
    if (!used.has(w)) chains.push(walk(w, false));
  });
  return chains;
}

function dedupe(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
  }
  return out;
}

function project(p: Point, w: Wall): { t: number; distance: number; length: number } {
  const length = derive.wallLength(w);
  if (length === 0) return { t: 0, distance: Math.hypot(p.x - w.start.x, p.y - w.start.y), length };
  const ux = (w.end.x - w.start.x) / length;
  const uy = (w.end.y - w.start.y) / length;
  const t = (p.x - w.start.x) * ux + (p.y - w.start.y) * uy;
  const distance = Math.abs(-(p.x - w.start.x) * uy + (p.y - w.start.y) * ux);
  return { t, distance, length };
}

/** Direction of the draft wall segment nearest a point, in millimetres. */
function draftDirection(points: readonly Point[], p: Point): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < bestD) {
      bestD = d;
      best = { x: dx, y: dy };
    }
  }
  return best;
}

export function commitDraft(store: Store, draft: PlanDraft, options: CommitOptions): CommitReport {
  const status = scaleStatus(draft);
  if (!status.confirmed)
    throw new CommitError(
      "import.scale-unconfirmed",
      `the scale is not confirmed: ${status.reason}`,
      "answer the scale question (units such as mm, or yes to keep it) or pass scale with a known length",
    );
  const f = draft.units.mmPerUnit as number;
  const off = options.offsetMm ?? { x: 0, y: 0 };
  const toMm = (p: { x: number; y: number }): Point => ({
    x: Math.round(p.x * f + off.x),
    y: Math.round(p.y * f + off.y),
  });
  const levelId = options.levelId;
  const skipped: CommitSkip[] = [];

  const wallsMm: DraftWallMm[] = [];
  for (const w of draft.walls) {
    const points = dedupe(w.points.map(toMm));
    if (points.length < 2) {
      skipped.push({ what: "wall", idx: w.idx, reason: `wall ${w.idx} is shorter than 1 mm at this scale` });
      continue;
    }
    wallsMm.push({
      idx: w.idx,
      points,
      thickness: w.thickness === null ? null : Math.max(1, Math.round(w.thickness * f)),
      kind: w.kind,
    });
  }
  const draftWallById = new Map(wallsMm.map((w) => [w.idx, w]));

  store.begin(options.label);
  const fail = (code: string, message: string, hint: string | null = null): never => {
    store.rollback();
    throw new CommitError(code, message, hint);
  };
  const wallIds: string[] = [];
  const wallDraftIdx = new Map<string, number>();
  for (const chain of buildChains(wallsMm)) {
    const pts =
      chain.closed && chain.points.length < 3 ? [...chain.points, chain.points[0] as Point] : chain.points;
    const closed = chain.closed && chain.points.length >= 3;
    const r = store.apply(
      {
        type: "wall.createChain",
        payload: {
          levelId,
          points: pts,
          closed,
          snapMm: JOIN_MM,
          ...(chain.thickness !== null ? { thickness: chain.thickness } : {}),
          ...(chain.kind !== null ? { kind: chain.kind } : {}),
        },
      },
      "import",
    );
    if (!r.ok)
      fail(r.error.code, `walls from draft wall ${chain.segmentWall[0]}: ${r.error.message}`, r.error.hint);
    const created = (r as Extract<typeof r, { ok: true }>).result as Wall[];
    created.forEach((w, i) => {
      wallIds.push(w.id);
      wallDraftIdx.set(w.id, chain.segmentWall[Math.min(i, chain.segmentWall.length - 1)] as number);
    });
  }

  // rule 4: free ends of imported walls within 20 mm that the chains did not join
  const importedWalls = () => store.project.walls.filter((w) => wallDraftIdx.has(w.id));
  const freeEnds = () =>
    importedWalls().flatMap((w) =>
      (["start", "end"] as const)
        .filter((end) => w.joins[end] === null)
        .map((end) => ({ wallId: w.id, end, p: w[end] })),
    );
  for (const a of freeEnds()) {
    const current = freeEnds();
    if (!current.some((e) => e.wallId === a.wallId && e.end === a.end)) continue;
    // prefer a wall of the same thickness (the continuing wall at a corner), then the nearest; a join that
    // is impossible (parallel, not collinear) is simply not made
    const thickness = (id: string) => store.project.walls.find((w) => w.id === id)?.thickness ?? 0;
    const candidates = current
      .filter((e) => e.wallId !== a.wallId && Math.hypot(e.p.x - a.p.x, e.p.y - a.p.y) <= JOIN_MM)
      .sort(
        (x, y) =>
          Number(thickness(x.wallId) !== thickness(a.wallId)) -
            Number(thickness(y.wallId) !== thickness(a.wallId)) ||
          Math.hypot(x.p.x - a.p.x, x.p.y - a.p.y) - Math.hypot(y.p.x - a.p.x, y.p.y - a.p.y),
      );
    for (const b of candidates) {
      const r = store.apply(
        {
          type: "wall.join",
          payload: { a: { wallId: a.wallId, end: a.end }, b: { wallId: b.wallId, end: b.end } },
        },
        "import",
      );
      if (r.ok) break;
    }
  }

  // rule 5: openings on the nearest imported wall
  const openingIds: string[] = [];
  for (const o of draft.openings) {
    const at = toMm(o.at);
    let best: { wall: Wall; t: number; distance: number; length: number } | null = null;
    for (const w of importedWalls()) {
      if (w.arcExtent !== null) continue;
      const pr = project(at, w);
      if (pr.distance > OPENING_MM || pr.t < -OPENING_MM || pr.t > pr.length + OPENING_MM) continue;
      const own = o.wallIdx !== null && wallDraftIdx.get(w.id) === o.wallIdx;
      const bestOwn = best !== null && o.wallIdx !== null && wallDraftIdx.get(best.wall.id) === o.wallIdx;
      if (!best || (own && !bestOwn) || (own === bestOwn && pr.distance < best.distance))
        best = { wall: w, ...pr };
    }
    if (!best) {
      skipped.push({
        what: "opening",
        idx: o.idx,
        reason: `${o.kind} ${o.idx} at (${at.x}, ${at.y}) is not within ${OPENING_MM} mm of an imported wall`,
      });
      continue;
    }
    const width = o.width === null ? null : Math.max(1, Math.round(o.width * f));
    const payload: Record<string, unknown> = {
      wallId: best.wall.id,
      kind: o.kind,
      atMm: Math.round(Math.max(0, Math.min(best.length, best.t))),
      ...(width !== null ? { width } : {}),
      ...(o.height !== null ? { height: Math.max(1, Math.round(o.height * f)) } : {}),
    };
    if (o.kind === "door" && o.hinge !== null) {
      const source = o.wallIdx !== null ? draftWallById.get(o.wallIdx) : undefined;
      const dir = source ? draftDirection(source.points, at) : null;
      const wx = best.wall.end.x - best.wall.start.x;
      const wy = best.wall.end.y - best.wall.start.y;
      const same = dir === null || dir.x * wx + dir.y * wy >= 0;
      const flip = <T extends string>(v: T, a: T, b: T): T => (same ? v : v === a ? b : a);
      payload.swing = {
        hinge: flip(o.hinge, "start", "end"),
        direction: flip(o.swing ?? "left", "left", "right"),
      };
    }
    const r = store.apply({ type: "opening.add", payload }, "import");
    if (r.ok) openingIds.push((r.result as { id: string }).id);
    else skipped.push({ what: "opening", idx: o.idx, reason: `${o.kind} ${o.idx}: ${r.error.message}` });
  }

  // rule 6: rooms by polygon, or detected around the label; labels without a room stay as labels
  const roomIds: string[] = [];
  const annotationIds: string[] = [];
  const label = (at: Point, text: string) => {
    const r = store.apply(
      {
        type: "annotation.add",
        payload: { annotation: { levelId, kind: "label", position: at, text, angle: 0, elevation: null } },
      },
      "import",
    );
    if (r.ok) annotationIds.push((r.result as { id: string }).id);
  };
  for (const room of draft.rooms) {
    const common = {
      levelId,
      ...(room.name !== null ? { name: room.name } : {}),
      ...(room.purpose !== null ? { purpose: room.purpose } : {}),
      ...(room.capacity !== null ? { capacity: room.capacity } : {}),
    };
    let polygon: Point[] | null = null;
    if (room.polygon) {
      polygon = dedupe(room.polygon.map(toMm));
      const first = polygon[0] as Point;
      const last = polygon[polygon.length - 1] as Point;
      if (polygon.length > 1 && first.x === last.x && first.y === last.y) polygon.pop();
    }
    const attempt =
      polygon && polygon.length >= 3
        ? store.apply({ type: "room.create", payload: { ...common, polygon } }, "import")
        : room.labelAt
          ? store.apply(
              { type: "room.create", payload: { ...common, atPoint: toMm(room.labelAt) } },
              "import",
            )
          : null;
    if (attempt?.ok) {
      roomIds.push((attempt.result as { id: string }).id);
      continue;
    }
    const why = attempt ? attempt.error.message : "it has neither an outline nor a label point";
    skipped.push({ what: "room", idx: room.idx, reason: `room ${room.name ?? room.idx}: ${why}` });
    const at = room.labelAt ? toMm(room.labelAt) : polygon?.[0];
    if (room.name && at) label(at, room.name);
  }

  // rule 7: provenance with what is still open
  const questions = [
    ...draft.questions.filter((q) => q.answer === null).map((q) => q.text),
    ...skipped.map((s) => s.reason),
  ];
  const reader = draft.reader
    ? `${draft.reader.providerId}:${draft.reader.model}:${draft.reader.promptVersion}`
    : `${draft.source.kind}:deterministic`;
  const prov = store.apply(
    {
      type: "project.setProvenance",
      payload: {
        provenance: {
          sourceFile: draft.source.file,
          reader,
          confidence: draft.confidence,
          questions,
          importedAt: options.now,
        },
      },
    },
    "import",
  );
  if (!prov.ok) fail(prov.error.code, prov.error.message, prov.error.hint);
  const entry = store.commit("import");
  return { wallIds, openingIds, roomIds, annotationIds, skipped, questions, entry };
}

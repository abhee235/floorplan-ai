// Refining a vision model's walls against the image itself (ADR-011 D2, classical clean-up). The model says which
// walls exist and roughly where; the pixels say exactly where. For every axis-aligned wall the model reported, a band
// of 4 percent of the image (plus one wall thickness) around it is searched for dark evidence: a solid band of pixels,
// or a pair of thin parallel face lines. The wall's centreline and thickness snap to that evidence, its ends follow
// the drawn lines, ends join the perpendicular wall they meet, and short walls with no evidence are dropped. Then the
// ordinary clean-up runs again. Pure.
import type { DraftOpening, DraftWall, PlanDraft } from "./draft.js";
import type { GrayBitmap } from "./png.js";
import { cleanupRasterDraft } from "./raster.js";

/** Pixels darker than this count as ink. */
export const INK_THRESHOLD = 160;
/** A row or column is part of a line when this share of the wall's length is ink. */
const COVERAGE = 0.35;
/** ...and one unbroken run of ink covers at least this share of it, so text and hatching do not count as walls. */
const MIN_RUN_SHARE = 0.2;

interface AxisWall {
  horizontal: boolean;
  /** Pixel row of a horizontal wall, pixel column of a vertical one (y downward). */
  cross: number;
  /** Pixel extent along the wall. */
  lo: number;
  hi: number;
  thickness: number | null;
  src: DraftWall;
  evidence: boolean;
  /** Pixel rows (or columns) of the face lines or band the wall snapped to. */
  faces?: [number, number][];
}

interface Band {
  a: number;
  b: number;
  s: number;
}

interface Candidate {
  centre: number;
  thickness: number;
  /** Share of the wall's length inked. */
  s: number;
  /** 0 a single thin line, 1 a solid band, 2 a pair of face lines. */
  kind: 0 | 1 | 2;
  faces: [number, number][];
}

export interface RefineReport {
  /** Walls whose position was confirmed and snapped by the image. */
  snapped: number;
  /** Short walls dropped because the image shows no line there. */
  dropped: number;
  /** Wall pieces merged across a door-sized gap. */
  bridged: number;
  /** Passages recorded in gaps where the model put no opening. */
  passages: number;
}

export function refineRasterDraft(
  draft: PlanDraft,
  bitmap: GrayBitmap,
): { draft: PlanDraft; report: RefineReport } {
  const size = draft.source.pixelSize;
  if (!size || size.w !== bitmap.width || size.h !== bitmap.height)
    return { draft, report: { snapped: 0, dropped: 0, bridged: 0, passages: 0 } };
  const { width: W, height: H, gray } = bitmap;
  const u = 1000 / Math.max(W, H);
  const maxDim = Math.max(W, H);
  const reach = Math.max(6, Math.round(0.04 * maxDim));
  const maxThickness = Math.max(4, Math.round(0.03 * maxDim));
  const ink = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < W && y < H && (gray[y * W + x] ?? 255) < INK_THRESHOLD;

  const axis: AxisWall[] = [];
  const others: DraftWall[] = [];
  for (const w of draft.walls) {
    const a = w.points[0];
    const b = w.points[1];
    if (!a || !b || w.points.length !== 2) {
      others.push(w);
      continue;
    }
    const thickness = w.thickness === null ? null : w.thickness / u;
    if (Math.abs(a.y - b.y) < 1e-6)
      axis.push({
        horizontal: true,
        cross: H - a.y / u,
        lo: Math.min(a.x, b.x) / u,
        hi: Math.max(a.x, b.x) / u,
        thickness,
        src: w,
        evidence: false,
      });
    else if (Math.abs(a.x - b.x) < 1e-6)
      axis.push({
        horizontal: false,
        cross: a.x / u,
        lo: Math.min(H - a.y / u, H - b.y / u),
        hi: Math.max(H - a.y / u, H - b.y / u),
        thickness,
        src: w,
        evidence: false,
      });
    else others.push(w);
  }

  // 1. snap each wall's cross position and thickness to the ink near where the model put it. The search reaches one
  // wall thickness past the band so a face line just outside it still pairs; pairs of face lines and solid bands rank
  // above single thin lines, and among them the better inked and nearer wins.
  let snapped = 0;
  const window = reach + maxThickness;
  for (const wall of axis) {
    const length = wall.hi - wall.lo;
    const from = Math.round(wall.lo + 0.1 * length);
    const to = Math.round(wall.hi - 0.1 * length);
    if (to <= from) continue;
    const crossLimit = wall.horizontal ? H : W;
    const c0 = Math.round(wall.cross);
    const bands: Band[] = [];
    let open: Band | null = null;
    for (let c = Math.max(0, c0 - window); c <= Math.min(crossLimit - 1, c0 + window); c += 1) {
      let hits = 0;
      let runLength = 0;
      let longest = 0;
      for (let t = from; t <= to; t += 1) {
        if (wall.horizontal ? ink(t, c) : ink(c, t)) {
          hits += 1;
          runLength += 1;
          if (runLength > longest) longest = runLength;
        } else runLength = 0;
      }
      const s = hits / (to - from + 1);
      if (s >= COVERAGE && longest >= MIN_RUN_SHARE * (to - from + 1)) {
        if (open && c === open.b + 1) {
          open.b = c;
          open.s = Math.max(open.s, s);
        } else {
          open = { a: c, b: c, s };
          bands.push(open);
        }
      } else open = null;
    }
    const candidates: Candidate[] = [];
    for (const band of bands) {
      const t = band.b - band.a + 1;
      if (t > 3 && t <= maxThickness)
        candidates.push({
          centre: (band.a + band.b) / 2,
          thickness: t,
          s: band.s,
          kind: 1,
          faces: [[band.a, band.b]],
        });
      else if (t <= 3)
        candidates.push({
          centre: (band.a + band.b) / 2,
          thickness: t,
          s: band.s / 2,
          kind: 0,
          faces: [[band.a, band.b]],
        });
    }
    for (let i = 0; i < bands.length; i += 1)
      for (let j = i + 1; j < bands.length; j += 1) {
        const p = bands[i] as Band;
        const q = bands[j] as Band;
        const gap = q.a - p.b - 1;
        const outer = q.b - p.a + 1;
        if (p.b - p.a <= 3 && q.b - q.a <= 3 && gap >= 2 && outer <= maxThickness)
          candidates.push({
            centre: (p.a + q.b) / 2,
            thickness: outer,
            s: Math.min(p.s, q.s),
            kind: 2,
            faces: [
              [p.a, p.b],
              [q.a, q.b],
            ],
          });
      }
    // real wall faces meet the walls at their ends, so ink crosses from one face line to the other there; a dimension
    // or text line drawn beside a wall is not connected that way
    const bridgedEnds = (c: Candidate) => {
      if (c.kind === 0) return 0;
      const first = (c.faces[0] as [number, number])[0];
      const last = (c.faces[c.faces.length - 1] as [number, number])[1];
      const alongLimit = wall.horizontal ? W : H;
      let ends = 0;
      for (const endAt of [wall.lo, wall.hi]) {
        const lo = Math.max(0, Math.round(endAt - reach));
        const hi = Math.min(alongLimit - 1, Math.round(endAt + reach));
        for (let t = lo; t <= hi; t += 1) {
          let crossed = true;
          for (let r = first; r <= last && crossed; r += 1)
            if (!(wall.horizontal ? ink(t, r) : ink(r, t))) crossed = false;
          if (crossed) {
            ends += 1;
            break;
          }
        }
      }
      return ends;
    };
    const value = (c: Candidate) =>
      c.kind * 0.25 + c.s + 0.2 * bridgedEnds(c) - (0.5 * Math.abs(c.centre - wall.cross)) / window;
    const usable = candidates.filter((c) => Math.abs(c.centre - wall.cross) <= reach + maxThickness / 2);
    if (usable.length === 0) continue;
    usable.sort((x, y) => value(y) - value(x));
    const best = usable[0] as Candidate;
    wall.cross = best.centre;
    wall.thickness = best.thickness;
    wall.faces = best.faces;
    wall.evidence = true;
    snapped += 1;
  }

  // 1b. ends follow the ink: pull back where the wall's face lines do not continue, then extend while they do,
  // bridging gaps no wider than a wall (the faces of a wall it meets)
  for (const wall of axis) {
    const faces = wall.faces;
    if (!faces) continue;
    const onWall = (t: number) => {
      let rows = 0;
      let hits = 0;
      for (const [a, b] of faces)
        for (let c = a; c <= b; c += 1) {
          rows += 1;
          if (wall.horizontal ? ink(t, c) : ink(c, t)) hits += 1;
        }
      return rows > 0 && hits / rows >= 0.5;
    };
    const alongLimit = wall.horizontal ? W : H;
    const maxPull = Math.max(reach, Math.round(0.3 * (wall.hi - wall.lo)));
    for (const end of ["lo", "hi"] as const) {
      const inward = end === "lo" ? 1 : -1;
      let t = Math.round(wall[end]);
      let moved = 0;
      while (moved < maxPull && !onWall(t)) {
        t += inward;
        moved += 1;
      }
      if (moved >= maxPull) continue;
      let last = t;
      let gap = 0;
      moved = 0;
      for (let s = t - inward; s >= 0 && s < alongLimit && moved < 2 * reach; s -= inward, moved += 1) {
        if (onWall(s)) {
          last = s;
          gap = 0;
        } else if (++gap > maxThickness) break;
      }
      wall[end] = last;
      // beyond a doorway the same wall carries on: when its face lines resume within a door-sized gap and the
      // model reported no wall there, add that piece; step 4 joins the pieces and records the passage
      const outward = -inward;
      const doorway = Math.round(0.12 * maxDim);
      const settle = Math.max(3, Math.round(maxThickness / 2));
      let resume = -1;
      let steady = 0;
      for (
        let p = last + outward, k = 0;
        p >= 0 && p < alongLimit && k < doorway + settle;
        p += outward, k += 1
      ) {
        if (onWall(p)) {
          steady += 1;
          if (steady >= settle) {
            resume = p - outward * (steady - 1);
            break;
          }
        } else steady = 0;
      }
      if (resume < 0) continue;
      let stop = resume;
      let miss = 0;
      for (let p = resume; p >= 0 && p < alongLimit; p += outward) {
        if (onWall(p)) {
          stop = p;
          miss = 0;
        } else if (++miss > maxThickness) break;
      }
      const collinear = axis.filter(
        (o) =>
          o !== wall && o.horizontal === wall.horizontal && Math.abs(o.cross - wall.cross) <= maxThickness,
      );
      // the model already reported this stretch
      if (collinear.some((o) => resume >= o.lo - settle && resume <= o.hi + settle)) continue;
      // stop where the next wall reported on this line begins; step 4 joins the two
      for (const o of collinear) {
        if (outward > 0 && o.lo > resume && o.lo - 1 < stop) stop = o.lo - 1;
        if (outward < 0 && o.hi < resume && o.hi + 1 > stop) stop = o.hi + 1;
      }
      const pieceLo = Math.min(resume, stop);
      const pieceHi = Math.max(resume, stop);
      if (pieceHi - pieceLo >= 2 * Math.max(4, wall.thickness ?? 4))
        axis.push({
          horizontal: wall.horizontal,
          cross: wall.cross,
          lo: pieceLo,
          hi: pieceHi,
          thickness: wall.thickness,
          src: wall.src,
          evidence: true,
          faces,
        });
    }
  }

  // 2. wall ends join the perpendicular wall they meet
  for (const wall of axis)
    for (const end of ["lo", "hi"] as const) {
      let best: number | null = null;
      let bestD = Number.POSITIVE_INFINITY;
      for (const o of axis) {
        if (o === wall || o.horizontal === wall.horizontal) continue;
        const d = Math.abs(o.cross - wall[end]);
        if (d > reach || wall.cross < o.lo - reach || wall.cross > o.hi + reach) continue;
        if (d < bestD) {
          bestD = d;
          best = o.cross;
        }
      }
      if (best !== null) wall[end] = best;
    }

  // 3. drop short walls the image does not show
  let dropped = 0;
  // when most walls are confirmed, the image draws walls in a style we detect, so an unconfirmed wall is not drawn;
  // otherwise (hatched or grey walls) keep what the model reported
  const confirmedShare = axis.length ? axis.filter((w) => w.evidence).length / axis.length : 0;
  const strict = confirmedShare >= 0.7;
  const kept = axis.filter((w) => {
    if (w.hi < w.lo) [w.lo, w.hi] = [w.hi, w.lo];
    if (w.hi - w.lo < 3) {
      dropped += 1;
      return false;
    }
    if (!w.evidence && (strict || w.hi - w.lo < 0.05 * maxDim)) {
      dropped += 1;
      return false;
    }
    return true;
  });

  // 4. a gap between two pieces of one wall is an opening in that wall, not two walls: merge the pieces, and where the
  // model put no opening in the gap, record a passage there so the rooms on both sides close when committed
  const bridgeMax = Math.round(0.12 * maxDim);
  const addedOpenings: DraftOpening[] = [];
  const merged = new Set<AxisWall>();
  for (const horizontal of [true, false]) {
    const line = kept
      .filter((w) => w.horizontal === horizontal)
      .sort((a, b) => a.cross - b.cross || a.lo - b.lo);
    for (let i = 0; i < line.length; i += 1) {
      const a = line[i] as AxisWall;
      if (merged.has(a)) continue;
      for (let j = i + 1; j < line.length; j += 1) {
        const b = line[j] as AxisWall;
        if (merged.has(b)) continue;
        if (Math.abs(b.cross - a.cross) > 3) break;
        const gap = b.lo - a.hi;
        if (gap <= 0 || gap > bridgeMax) continue;
        const ta = a.thickness ?? 0;
        const tb = b.thickness ?? 0;
        if (Math.max(ta, tb) > 0 && Math.min(ta, tb) / Math.max(ta, tb) < 0.5) continue;
        const centreAlong = (a.hi + b.lo) / 2;
        const box = (along: number, cross: number) =>
          horizontal ? { x: along * u, y: (H - cross) * u } : { x: cross * u, y: (H - along) * u };
        const gapStart = box(a.hi, a.cross);
        const gapEnd = box(b.lo, a.cross);
        const near = draft.openings.some((o) => {
          const along = horizontal ? o.at.x : o.at.y;
          const across = horizontal ? o.at.y : o.at.x;
          const lo = horizontal ? Math.min(gapStart.x, gapEnd.x) : Math.min(gapStart.y, gapEnd.y);
          const hi = horizontal ? Math.max(gapStart.x, gapEnd.x) : Math.max(gapStart.y, gapEnd.y);
          const crossBox = horizontal ? gapStart.y : gapStart.x;
          return (
            along >= lo - reach * u &&
            along <= hi + reach * u &&
            Math.abs(across - crossBox) <= (reach + maxThickness) * u
          );
        });
        if (!near && gap >= maxThickness)
          addedOpenings.push({
            idx: -1,
            wallIdx: null,
            at: box(centreAlong, a.cross),
            kind: "passage",
            width: gap * u,
            height: null,
            hinge: null,
            swing: null,
            confidence: 0.4,
          });
        a.hi = b.hi;
        a.cross = (a.cross + b.cross) / 2;
        a.evidence = a.evidence || b.evidence;
        merged.add(b);
        j = i;
      }
    }
  }
  const bridged = kept.filter((w) => !merged.has(w));
  const openings: DraftOpening[] = [...draft.openings, ...addedOpenings].map((o, idx) => ({ ...o, idx }));

  const walls: DraftWall[] = [
    ...bridged.map((w, idx) => ({
      ...w.src,
      idx,
      points: w.horizontal
        ? [
            { x: w.lo * u, y: (H - w.cross) * u },
            { x: w.hi * u, y: (H - w.cross) * u },
          ]
        : [
            { x: w.cross * u, y: (H - w.lo) * u },
            { x: w.cross * u, y: (H - w.hi) * u },
          ],
      thickness: w.thickness === null ? null : w.thickness * u,
      confidence: w.evidence ? Math.max(w.src.confidence, 0.75) : w.src.confidence,
    })),
    ...others.map((w, i) => ({ ...w, idx: bridged.length + i })),
  ];
  return {
    draft: cleanupRasterDraft({ ...draft, walls, openings }),
    report: { snapped, dropped, bridged: merged.size, passages: addedOpenings.length },
  };
}

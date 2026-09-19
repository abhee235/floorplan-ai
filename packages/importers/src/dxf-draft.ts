// DXF to PlanDraft (ADR-011 D2, the deterministic pass). Layers get roles from their names; parallel line
// pairs on wall layers become wall centrelines with a thickness; collinear pieces merge and the gaps between
// them become opening candidates; door arcs, door and window blocks, and window lines become openings;
// closed polylines and label texts become rooms; the scale comes from dimension text that agrees with the
// measured lengths, else the header, else a guess, and anything not confirmed is asked.
import type { Room } from "@fpv/ir";
import type {
  DraftOpening,
  DraftQuestion,
  DraftRoom,
  DraftText,
  DraftUnits,
  DraftWall,
  PlanDraft,
  ScaleSource,
} from "./draft.js";
import {
  type DxfArc,
  type DxfDimension,
  type DxfDocument,
  type DxfLine,
  type DxfPoint,
  type DxfPolyline,
  type DxfText,
  flatten,
  insUnitsToMm,
  type Placed,
  parseDxf,
} from "./dxf.js";

export type LayerRole =
  | "wall"
  | "door"
  | "window"
  | "room"
  | "text"
  | "dimension"
  | "furniture"
  | "ignore"
  | "unknown";

const ROLE_WORDS: readonly [LayerRole, readonly string[]][] = [
  [
    "ignore",
    ["defpoints", "grid", "hatch", "title", "border", "xref", "viewport", "vport", "frame", "sheet", "north"],
  ],
  ["dimension", ["dim", "dims", "dimension", "dimensions", "cote", "cotes", "bemassung"]],
  [
    "door",
    [
      "door",
      "doors",
      "opening",
      "openings",
      "porte",
      "portes",
      "tur",
      "tuer",
      "tür",
      "türen",
      "puerta",
      "puertas",
      "dr",
    ],
  ],
  [
    "window",
    [
      "win",
      "window",
      "windows",
      "glaz",
      "glazing",
      "glass",
      "fenetre",
      "fenêtre",
      "fenetres",
      "fenster",
      "ventana",
    ],
  ],
  [
    "wall",
    [
      "wall",
      "walls",
      "mur",
      "murs",
      "wand",
      "waende",
      "wände",
      "pared",
      "paredes",
      "partition",
      "partitions",
    ],
  ],
  [
    "room",
    [
      "room",
      "rooms",
      "space",
      "spaces",
      "area",
      "areas",
      "zone",
      "zones",
      "piece",
      "pieces",
      "pièce",
      "raum",
      "raeume",
      "local",
      "locaux",
    ],
  ],
  [
    "text",
    [
      "text",
      "texts",
      "texte",
      "anno",
      "annotation",
      "name",
      "names",
      "label",
      "labels",
      "txt",
      "iden",
      "tag",
      "note",
      "notes",
      "keynote",
      "keynotes",
    ],
  ],
  [
    "furniture",
    [
      "furn",
      "furniture",
      "ffe",
      "equip",
      "equipment",
      "mob",
      "mobilier",
      "mobel",
      "möbel",
      "fixt",
      "fixtures",
    ],
  ],
];

/** A layer's role from the words in its name, e.g. "A-WALL-EXTR" is a wall layer and "A-AREA-IDEN" a text layer. */
/**
 * The layer's own name without an external-reference prefix: bound xrefs are named `<xref>$0$<layer>`
 * and attached ones `<xref>|<layer>`.
 */
export function baseLayerName(name: string): string {
  return name.replace(/^.*\$\d+\$/, "").replace(/^.*\|/, "");
}

export function layerRole(name: string): LayerRole {
  const words = baseLayerName(name)
    .toLowerCase()
    .split(/[^a-z0-9àâäéèêëïîôöùûüç]+/)
    .filter(Boolean);
  // a naming standard's final qualifier refines the major group: A-AREA-IDEN holds room names
  const last = words.at(-1);
  if (words.length > 1 && last && (ROLE_WORDS.find(([r]) => r === "text")?.[1] ?? []).includes(last))
    return "text";
  for (const [role, keys] of ROLE_WORDS) if (words.some((w) => keys.includes(w))) return role;
  // words run together ("doorswindows", "wallhigh"): look for the main words inside longer words
  const joined: readonly [LayerRole, RegExp][] = [
    ["door", /door/],
    ["window", /window|glaz/],
    ["wall", /wall/],
    ["dimension", /dimension/],
    ["furniture", /furniture/],
  ];
  for (const [role, re] of joined) if (words.some((w) => w.length > 4 && re.test(w))) return role;
  return "unknown";
}

/** The role a block's name implies for everything it draws, or null. */
export function blockRole(name: string | null): LayerRole | null {
  if (!name) return null;
  const n = name.toLowerCase();
  if (/door|porte|tuer|tür|puerta|^dr[\d_-]/.test(n)) return "door";
  if (/window|win[\d_-]|^win$|glaz|fenetre|fenêtre|fenster|ventana/.test(n)) return "window";
  if (/chair|desk|table|sofa|furn|bed|cabinet/.test(n)) return "furniture";
  return null;
}

// ---- small vector helpers --------------------------------------------------------------------------------

const sub = (a: DxfPoint, b: DxfPoint): DxfPoint => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: DxfPoint, b: DxfPoint): DxfPoint => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: DxfPoint, k: number): DxfPoint => ({ x: a.x * k, y: a.y * k });
const dot = (a: DxfPoint, b: DxfPoint) => a.x * b.x + a.y * b.y;
const cross = (a: DxfPoint, b: DxfPoint) => a.x * b.y - a.y * b.x;
const len = (a: DxfPoint) => Math.hypot(a.x, a.y);

interface Seg {
  p: DxfPoint;
  q: DxfPoint;
  u: DxfPoint;
  n: DxfPoint;
  length: number;
  handle: string | null;
}

function seg(p: DxfPoint, q: DxfPoint, handle: string | null): Seg | null {
  const d = sub(q, p);
  const l = len(d);
  if (l === 0) return null;
  const u = mul(d, 1 / l);
  return { p, q, u, n: { x: -u.y, y: u.x }, length: l, handle };
}

/** Points along a bulged polyline edge, `stepDeg` apart. */
function bulgePoints(a: DxfPoint, b: DxfPoint, bulge: number, stepDeg = 10): DxfPoint[] {
  const theta = 4 * Math.atan(bulge);
  const chord = len(sub(b, a));
  if (chord === 0 || Math.abs(theta) < 1e-9) return [a, b];
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const mid = mul(add(a, b), 0.5);
  const u = mul(sub(b, a), 1 / chord);
  const nrm = { x: -u.y, y: u.x };
  const h =
    Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2)) *
    Math.sign(bulge) *
    (Math.abs(theta) > Math.PI ? -1 : 1);
  const c = add(mid, mul(nrm, h));
  const a0 = Math.atan2(a.y - c.y, a.x - c.x);
  const steps = Math.max(2, Math.ceil((Math.abs(theta) * 180) / Math.PI / stepDeg));
  const out: DxfPoint[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = a0 + (theta * i) / steps;
    out.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
  }
  out[out.length - 1] = b;
  return out;
}

function polylinePoints(e: DxfPolyline): DxfPoint[] {
  const pts: DxfPoint[] = [];
  const n = e.vertices.length;
  const edges = e.closed ? n : n - 1;
  for (let i = 0; i < edges; i += 1) {
    const a = e.vertices[i] as DxfPolyline["vertices"][number];
    const b = e.vertices[(i + 1) % n] as DxfPolyline["vertices"][number];
    const run = bulgePoints(a, b, a.bulge);
    if (pts.length) run.shift();
    pts.push(...run);
  }
  if (!e.closed && n === 1) pts.push(e.vertices[0] as DxfPoint);
  // a closed ring ends where it started: drop the repeat; keep only coordinates
  if (e.closed && pts.length > 1) pts.pop();
  return pts.map((p) => ({ x: p.x, y: p.y }));
}

// ---- intervals ---------------------------------------------------------------------------------------------

type Interval = [number, number];

function subtract(from: Interval, cuts: readonly Interval[]): Interval[] {
  let pieces: Interval[] = [from];
  for (const [c0, c1] of cuts) {
    const next: Interval[] = [];
    for (const [a, b] of pieces) {
      if (c1 <= a || c0 >= b) next.push([a, b]);
      else {
        if (c0 > a) next.push([a, c0]);
        if (c1 < b) next.push([c1, b]);
      }
    }
    pieces = next;
  }
  return pieces;
}

function union(intervals: readonly Interval[], join: number): Interval[] {
  const sorted = [...intervals].sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a <= last[1] + join) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// ---- scale ---------------------------------------------------------------------------------------------------

/** A length written on a drawing, in millimetres: 3600, 3.60, 3.6 m, 360 cm, 12'-6", 150". Null when not a length. */
export function parseLengthMm(raw: string): number | null {
  let t = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  else t = t.replace(/,/g, ".");
  const imperial = /^(\d+(?:\.\d+)?)\s*'\s*-?\s*(?:(\d+(?:\.\d+)?)\s*(?:"|'')?)?$/.exec(t);
  if (imperial) return Number(imperial[1]) * 304.8 + Number(imperial[2] ?? 0) * 25.4;
  const inches = /^(\d+(?:\.\d+)?)\s*(?:"|''|in|inch|inches)$/.exec(t);
  if (inches) return Number(inches[1]) * 25.4;
  const metric = /^(\d+(?:\.\d+)?)\s*(mm|cm|m)$/.exec(t);
  if (metric) return Number(metric[1]) * { mm: 1, cm: 10, m: 1000 }[metric[2] as "mm" | "cm" | "m"];
  const bare = /^\d+(?:\.\d+)?$/.exec(t);
  if (bare) {
    const n = Number(t);
    return t.includes(".") && n < 100 ? n * 1000 : n;
  }
  return null;
}

function unitsFor(mmPerUnit: number): DraftUnits {
  for (const [u, f] of [
    ["mm", 1],
    ["cm", 10],
    ["m", 1000],
    ["in", 25.4],
    ["ft", 304.8],
  ] as const)
    if (Math.abs(mmPerUnit - f) / f < 0.02) return u;
  return "unknown";
}

interface ScaleDecision {
  detected: DraftUnits;
  mmPerUnit: number;
  source: ScaleSource;
  checks: PlanDraft["units"]["checks"];
  questions: Omit<DraftQuestion, "id">[];
}

/**
 * The most common distance between a wall-layer line and its nearest overlapping parallel line, in drawing
 * units: usually the wall thickness. Null when there are too few pairs to say.
 */
export function typicalSpacing(segs: readonly Seg[]): number | null {
  const sample = [...segs].sort((a, b) => b.length - a.length).slice(0, 4000);
  const sinTol = Math.sin((1.5 * Math.PI) / 180);
  const nearest: number[] = [];
  for (const a of sample) {
    let best = Number.POSITIVE_INFINITY;
    for (const b of sample) {
      if (a === b || Math.abs(cross(a.u, b.u)) > sinTol) continue;
      const d = Math.abs(dot(sub(b.p, a.p), a.n));
      if (d <= 1e-9 || d >= best) continue;
      const t1 = dot(sub(b.p, a.p), a.u);
      const t2 = dot(sub(b.q, a.p), a.u);
      if (Math.min(a.length, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2)) <= 0) continue;
      best = d;
    }
    if (Number.isFinite(best)) nearest.push(best);
  }
  if (nearest.length < 4) return null;
  // histogram in 5 percent log bins; the fullest bin wins, the thinner on a tie
  const bins = new Map<number, number[]>();
  for (const d of nearest) {
    const key = Math.round(Math.log(d) / Math.log(1.05));
    bins.set(key, [...(bins.get(key) ?? []), d]);
  }
  const [, values] = [...bins.entries()].sort((x, y) => y[1].length - x[1].length || x[0] - y[0])[0] as [
    number,
    number[],
  ];
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

export interface TextDimension {
  text: string;
  measuredUnits: number;
}

function decideScale(
  header: StatedUnits | null,
  dims: readonly DxfDimension[],
  extent: number,
  textDims: readonly TextDimension[] = [],
  spacing: number | null = null,
  candidates: readonly number[] = [1, 10, 1000, 25.4, 304.8],
): ScaleDecision {
  const checks: PlanDraft["units"]["checks"] = [];
  for (const t of textDims) {
    const mm = parseLengthMm(t.text);
    if (mm !== null && mm > 0 && t.measuredUnits > 0)
      checks.push({ text: t.text, measuredUnits: t.measuredUnits, impliedMmPerUnit: mm / t.measuredUnits });
  }
  for (const d of dims) {
    const text = d.text.trim();
    if (!text || text.includes("<>")) continue; // shows the measured value: says nothing about the scale
    const mm = parseLengthMm(text);
    if (mm === null || mm <= 0) continue;
    const delta = sub(d.p2, d.p1);
    const a = (d.angle * Math.PI) / 180;
    const measured =
      d.kind === "linear" ? Math.abs(dot(delta, { x: Math.cos(a), y: Math.sin(a) })) : len(delta);
    if (measured <= 0) continue;
    checks.push({ text, measuredUnits: measured, impliedMmPerUnit: mm / measured });
  }
  const says = header ? (header.label ?? `the drawing header says ${header.units}`) : "";
  const Says = says.charAt(0).toUpperCase() + says.slice(1);
  const questions: Omit<DraftQuestion, "id">[] = [];
  // the largest group of checks within 2 percent of each other
  let best: number[] = [];
  for (const c of checks) {
    const group = checks
      .map((x) => x.impliedMmPerUnit)
      .filter((v) => Math.abs(v - c.impliedMmPerUnit) / c.impliedMmPerUnit <= 0.02);
    if (group.length > best.length) best = group;
  }
  if (best.length >= 2) {
    const sorted = [...best].sort((x, y) => x - y);
    const mmPerUnit = sorted[Math.floor(sorted.length / 2)] as number;
    if (header && Math.abs(header.mmPerUnit - mmPerUnit) / mmPerUnit > 0.02)
      questions.push({
        kind: "scale",
        text: `Dimension text implies ${round(mmPerUnit)} mm per drawing unit, but ${says}. The dimensions were used; confirm.`,
        answer: null,
      });
    return { detected: unitsFor(mmPerUnit), mmPerUnit, source: "dimension-text", checks, questions };
  }
  // a unit is plausible when the drawing is 3 m to 500 m across and its walls 60 mm to 500 mm thick
  const plausible = (f: number) =>
    extent * f >= 3000 &&
    extent * f <= 500000 &&
    (spacing === null || (spacing * f >= 60 && spacing * f <= 500));
  if (header && plausible(header.mmPerUnit)) {
    questions.push({
      kind: "scale",
      text: `${Says} and no two dimension texts confirm it. Answer yes to keep it, or name the units (mm, cm, m, in, ft), or set the scale from one known length.`,
      answer: null,
    });
    return { detected: header.units, mmPerUnit: header.mmPerUnit, source: "header", checks, questions };
  }
  // otherwise the plausible unit whose walls come closest to 150 mm, or failing that the one that makes the
  // drawing 5 m to 200 m across

  // typical office walls are about 150 mm and floors about 30 m across; the unit nearest both wins
  const closeness = (f: number) =>
    Math.abs(Math.log((extent * f) / 30000)) +
    (spacing === null ? 0 : Math.abs(Math.log((spacing * f) / 150)));
  const guess =
    candidates.filter(plausible).sort((a, b) => closeness(a) - closeness(b))[0] ??
    candidates.find((f) => extent * f >= 5000 && extent * f <= 200000) ??
    header?.mmPerUnit ??
    1;
  const readAs = (f: number) => (unitsFor(f) === "unknown" ? `${round(f, 0.001)} mm per unit` : unitsFor(f));
  const described = (f: number) =>
    `${round((extent * f) / 1000, 0.1)} m across${spacing === null ? "" : ` with walls ${round(spacing * f, 1)} mm thick`}`;
  questions.push({
    kind: "scale",
    text: header
      ? `${Says}, but that makes the drawing ${described(header.mmPerUnit)}; it was read as ${readAs(guess)} (${described(guess)}). Answer with the units (mm, cm, m, in, ft), or set the scale from one known length.`
      : `The drawing has no units; it was read as ${readAs(guess)} (${described(guess)}). Answer with the units (mm, cm, m, in, ft), or set the scale from one known length.`,
    answer: null,
  });
  return { detected: "unknown", mmPerUnit: guess, source: "guess", checks, questions };
}

const round = (n: number, step = 0.001) => Math.round(n / step) * step;

// ---- walls ---------------------------------------------------------------------------------------------------

interface Piece {
  p: DxfPoint;
  q: DxfPoint;
  thickness: number;
  handles: string[];
  confidence: number;
}

interface Wall {
  points: DxfPoint[];
  thickness: number;
  handles: string[];
  confidence: number;
  /** For straight walls: the gaps along it, as intervals from points[0]. */
  gaps: Interval[];
  straight: boolean;
}

interface Limits {
  minT: number;
  maxT: number;
  minOverlap: number;
  bridge: number;
  maxGap: number;
}

/** Parallel line pairs to centreline pieces; each stretch of a line is used by its nearest partner only. */
function pairLines(segs: readonly Seg[], lim: Limits): Piece[] {
  const sinTol = Math.sin((1.5 * Math.PI) / 180);
  const cand: { i: number; j: number; d: number; overlap: number }[] = [];
  const bucket = new Map<number, number[]>();
  const keyOf = (s: Seg) => Math.round((((Math.atan2(s.u.y, s.u.x) * 180) / Math.PI + 360) % 180) / 2);
  segs.forEach((s, i) => {
    const k = keyOf(s);
    bucket.set(k, [...(bucket.get(k) ?? []), i]);
  });
  segs.forEach((a, i) => {
    const k = keyOf(a);
    for (const kk of [k - 1, k, k + 1, (k + 90) % 90, k === 0 ? 89 : -1, k === 89 ? 0 : -1])
      for (const j of bucket.get(kk) ?? []) {
        if (j <= i) continue;
        const b = segs[j] as Seg;
        if (Math.abs(cross(a.u, b.u)) > sinTol) continue;
        const d = Math.abs(dot(sub(b.p, a.p), a.n));
        if (d < lim.minT || d > lim.maxT) continue;
        const t1 = dot(sub(b.p, a.p), a.u);
        const t2 = dot(sub(b.q, a.p), a.u);
        const overlap = Math.min(a.length, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2));
        if (overlap < lim.minOverlap) continue;
        if (!cand.some((c) => c.i === i && c.j === j)) cand.push({ i, j, d, overlap });
      }
  });
  cand.sort((x, y) => x.d - y.d || y.overlap - x.overlap);
  const cover: Interval[][] = segs.map(() => []);
  const pieces: Piece[] = [];
  for (const { i, j } of cand) {
    const a = segs[i] as Seg;
    const b = segs[j] as Seg;
    const toA = (tb: number) => dot(sub(add(b.p, mul(b.u, tb)), a.p), a.u);
    const toB = (ta: number) => dot(sub(add(a.p, mul(a.u, ta)), b.p), b.u);
    const t1 = toA(0);
    const t2 = toA(b.length);
    const span: Interval = [Math.max(0, Math.min(t1, t2)), Math.min(a.length, Math.max(t1, t2))];
    const bCuts = (cover[j] as Interval[]).map(([x, y]): Interval => {
      const s0 = toA(x);
      const s1 = toA(y);
      return [Math.min(s0, s1), Math.max(s0, s1)];
    });
    const sd = dot(sub(b.p, a.p), a.n);
    for (const [s0, s1] of subtract(span, [...(cover[i] as Interval[]), ...bCuts])) {
      if (s1 - s0 < lim.minOverlap) continue;
      const off = mul(a.n, sd / 2);
      pieces.push({
        p: add(add(a.p, mul(a.u, s0)), off),
        q: add(add(a.p, mul(a.u, s1)), off),
        thickness: Math.abs(sd),
        handles: [a.handle, b.handle].filter((h): h is string => h !== null),
        confidence: 0.9,
      });
      (cover[i] as Interval[]).push([s0, s1]);
      const b0 = toB(s0);
      const b1 = toB(s1);
      (cover[j] as Interval[]).push([Math.min(b0, b1), Math.max(b0, b1)]);
    }
  }
  return pieces;
}

/** Collinear pieces of similar thickness merge; short gaps (junctions) bridge, door-sized gaps are kept as gaps. */
function mergePieces(pieces: readonly Piece[], lim: Limits): Wall[] {
  const used = new Array(pieces.length).fill(false);
  const walls: Wall[] = [];
  const sinTol = Math.sin((2 * Math.PI) / 180);
  for (let i = 0; i < pieces.length; i += 1) {
    if (used[i]) continue;
    const base = pieces[i] as Piece;
    const s = seg(base.p, base.q, null);
    if (!s) continue;
    const group = [i];
    used[i] = true;
    for (let j = i + 1; j < pieces.length; j += 1) {
      if (used[j]) continue;
      const o = pieces[j] as Piece;
      const os = seg(o.p, o.q, null);
      if (!os || Math.abs(cross(s.u, os.u)) > sinTol) continue;
      const offset = Math.abs(dot(sub(o.p, base.p), s.n));
      if (offset > Math.max(0.25 * base.thickness, lim.minT / 2)) continue;
      const ratio = o.thickness / base.thickness;
      if (ratio < 0.7 || ratio > 1.43) continue;
      group.push(j);
      used[j] = true;
    }
    const spans = group
      .map((k) => {
        const g = pieces[k] as Piece;
        const a = dot(sub(g.p, base.p), s.u);
        const b = dot(sub(g.q, base.p), s.u);
        return { iv: [Math.min(a, b), Math.max(a, b)] as Interval, piece: g };
      })
      .sort((x, y) => x.iv[0] - y.iv[0]);
    let run: { from: number; to: number; gaps: Interval[]; members: Piece[] } | null = null;
    const flush = () => {
      if (!run) return;
      const members = run.members;
      const thickness =
        members.reduce((acc, m) => acc + m.thickness * len(sub(m.q, m.p)), 0) /
        members.reduce((acc, m) => acc + len(sub(m.q, m.p)), 0);
      const avgOffset =
        members.reduce((acc, m) => acc + dot(sub(m.p, base.p), s.n) * len(sub(m.q, m.p)), 0) /
        members.reduce((acc, m) => acc + len(sub(m.q, m.p)), 0);
      const origin = add(base.p, mul(s.n, avgOffset));
      walls.push({
        points: [add(origin, mul(s.u, run.from)), add(origin, mul(s.u, run.to))],
        thickness,
        handles: [...new Set(members.flatMap((m) => m.handles))],
        confidence: Math.min(...members.map((m) => m.confidence)),
        gaps: run.gaps.map(([a, b]): Interval => [a - run!.from, b - run!.from]),
        straight: true,
      });
      run = null;
    };
    for (const { iv, piece } of spans) {
      if (!run) {
        run = { from: iv[0], to: iv[1], gaps: [], members: [piece] };
        continue;
      }
      const gap = iv[0] - run.to;
      if (gap <= lim.bridge) {
        run.to = Math.max(run.to, iv[1]);
        run.members.push(piece);
      } else if (gap <= lim.maxGap) {
        run.gaps.push([run.to, iv[0]]);
        run.to = Math.max(run.to, iv[1]);
        run.members.push(piece);
      } else {
        flush();
        run = { from: iv[0], to: iv[1], gaps: [], members: [piece] };
      }
    }
    flush();
  }
  return walls;
}

/** Wall ends stop short of corners and T-junctions by half a thickness; extend them to the other centreline. */
function extendEnds(walls: Wall[]): void {
  const straight = walls.filter((w) => w.straight);
  for (const w of straight) {
    for (const endIndex of [0, 1] as const) {
      const e = w.points[endIndex] as DxfPoint;
      const other = w.points[1 - endIndex] as DxfPoint;
      const s = seg(other, e, null);
      if (!s) continue;
      let bestT = Number.POSITIVE_INFINITY;
      let best: DxfPoint | null = null;
      for (const o of straight) {
        if (o === w) continue;
        const os = seg(o.points[0] as DxfPoint, o.points[1] as DxfPoint, null);
        if (!os) continue;
        const denom = cross(s.u, os.u);
        if (Math.abs(denom) < Math.sin((20 * Math.PI) / 180)) continue;
        const t = cross(sub(os.p, s.p), os.u) / denom; // along s from `other`
        const x = add(s.p, mul(s.u, t));
        const reach = t - s.length;
        const limit = 0.75 * Math.max(w.thickness, o.thickness) + 1;
        if (reach < -limit || reach > limit) continue;
        const along = dot(sub(x, os.p), os.u);
        if (along < -limit || along > os.length + limit) continue;
        if (Math.abs(reach) < bestT) {
          bestT = Math.abs(reach);
          best = x;
        }
      }
      if (!best) continue;
      if (endIndex === 0 && w.gaps.length) {
        // gaps are measured from the start: moving the start shifts them
        const shift = dot(sub(e, best), s.u) * -1;
        w.gaps = w.gaps.map(([a, b]): Interval => [a + shift, b + shift]);
      }
      w.points[endIndex] = best;
    }
  }
}

function concentricArcs(arcs: readonly DxfArc[], lim: Limits): Wall[] {
  const walls: Wall[] = [];
  const used = new Set<number>();
  const norm = (a: number) => ((a % 360) + 360) % 360;
  const sweep = (a: DxfArc) => norm(a.end - a.start) || 360;
  for (let i = 0; i < arcs.length; i += 1) {
    if (used.has(i)) continue;
    const a = arcs[i] as DxfArc;
    for (let j = i + 1; j < arcs.length; j += 1) {
      if (used.has(j)) continue;
      const b = arcs[j] as DxfArc;
      const dr = Math.abs(a.radius - b.radius);
      if (len(sub(a.centre, b.centre)) > lim.minT / 2 || dr < lim.minT || dr > lim.maxT) continue;
      const s0 = norm(a.start);
      const s1 = s0 + sweep(a);
      let t0 = norm(b.start);
      if (t0 < s0 - 1e-9) t0 += 360;
      const t1 = t0 + sweep(b);
      const from = Math.max(s0, t0);
      const to = Math.min(s1, t1);
      if (to - from < 10) continue;
      const r = (a.radius + b.radius) / 2;
      const steps = Math.max(2, Math.ceil((to - from) / 8));
      const points: DxfPoint[] = [];
      for (let k = 0; k <= steps; k += 1) {
        const ang = ((from + ((to - from) * k) / steps) * Math.PI) / 180;
        points.push({ x: a.centre.x + r * Math.cos(ang), y: a.centre.y + r * Math.sin(ang) });
      }
      walls.push({
        points,
        thickness: dr,
        handles: [a.handle, b.handle].filter((h): h is string => h !== null),
        confidence: 0.85,
        gaps: [],
        straight: false,
      });
      used.add(i);
      used.add(j);
      break;
    }
  }
  return walls;
}

// ---- openings -------------------------------------------------------------------------------------------------

interface Candidate {
  wall: number;
  t: number;
  width: number;
  kind: "door" | "window" | "passage";
  hinge: "start" | "end" | null;
  swing: "left" | "right" | null;
  confidence: number;
}

function nearestWall(
  walls: readonly Wall[],
  p: DxfPoint,
  slack: number,
): { index: number; t: number; distance: number } | null {
  let best: { index: number; t: number; distance: number } | null = null;
  walls.forEach((w, index) => {
    if (!w.straight) return;
    const s = seg(w.points[0] as DxfPoint, w.points[1] as DxfPoint, null);
    if (!s) return;
    const t = dot(sub(p, s.p), s.u);
    if (t < -slack || t > s.length + slack) return;
    const distance = Math.abs(dot(sub(p, s.p), s.n));
    if (distance > w.thickness / 2 + slack) return;
    if (!best || distance < best.distance) best = { index, t, distance };
  });
  return best;
}

function wallFrame(w: Wall): Seg {
  return seg(w.points[0] as DxfPoint, w.points[1] as DxfPoint, null) as Seg;
}

// ---- rooms --------------------------------------------------------------------------------------------------

const PURPOSES: readonly [RegExp, Room["purpose"]][] = [
  [/board\s*room/, "boardroom"],
  [/huddle|focus|phone|quiet/, "huddle"],
  [/training|class\s*room|seminar|lecture/, "training"],
  [/meeting|conference|conf\b|mtg/, "meeting"],
  [/open\s*(plan|office)|work\s*space|workstation|desks?\b|office/, "open-office"],
  // a home's rooms, read before the workplace words they share letters with
  [/bed\s*room|master\s*bed|\bbed\b/, "bedroom"],
  [/living|lounge|drawing\s*room|sitting\s*room|family\s*room/, "living"],
  [/dining/, "dining"],
  [/kitchen|kitchenette/, "kitchen"],
  [/bath\s*room|en\s*-?suite|\bbath\b/, "bathroom"],
  [/laundry/, "laundry"],
  [/balcony|terrace|veranda/, "balcony"],
  [/garage|car\s*port/, "garage"],
  [/\bstudy\b/, "study"],
  [/pantry|cafe|café|canteen|break\s*out|breakout|tea/, "cafeteria"],
  [/corridor|hall\s*way|hallway|circulation|passage/, "corridor"],
  [/\bwc\b|toilet|rest\s*room|washroom|lavator|shower/, "restroom"],
  [/stor(e|age)|archive|cupboard|closet/, "storage"],
  [/reception|lobby|entrance|foyer|waiting/, "reception"],
  [/server|comms|\bit\b|plant|electrical|riser|utility|data/, "utility"],
];

export function purposeFromName(name: string): Room["purpose"] | null {
  const n = name.toLowerCase();
  for (const [re, p] of PURPOSES) if (re.test(n)) return p;
  return null;
}

export function capacityFromText(text: string): number | null {
  const m = /(\d+)\s*(?:pax|seats?|seater|people|persons?|p)\b/i.exec(text) ?? /\((\d+)\)/.exec(text);
  return m ? Number(m[1]) : null;
}

function inside(poly: readonly DxfPoint[], p: DxfPoint): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i] as DxfPoint;
    const b = poly[j] as DxfPoint;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

function area(poly: readonly DxfPoint[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i] as DxfPoint;
    const b = poly[(i + 1) % poly.length] as DxfPoint;
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

function classifyText(t: string, role: LayerRole): DraftText["kind"] {
  if (/\b1\s*:\s*\d{2,4}\b|\bscale\b/i.test(t)) return "scale";
  if (/\d/.test(t) && /^[\s\d.,'"x×-]+(mm|cm|m|m²|m2)?$/i.test(t)) return "dimension";
  const trimmed = t.trim();
  // window and door callouts ("5050 XO", "6068 S.G.D.") and sized notes ('18" MIN.') start with a size
  if (/^\d{3,}\b/.test(trimmed) || /^\d+(\.\d+)?\s*["']/.test(trimmed)) return "other";
  // a word of three letters, or a dotted abbreviation of at least three letters ("W.I.C.")
  const hasWord = /[A-Za-zÀ-ÿ]{3,}/.test(trimmed) || /(^|\s)([A-Za-z]\.){2,}[A-Za-z]\.?(\s|$)/.test(trimmed);
  // room names are short labels ("KITCHEN / DINING" included); notes have colons, commas, quotes or "W/"
  if (trimmed.split(/\s+/).length > 4 || /[:,"]/.test(trimmed) || /\b[A-Za-z]\/(?=\s|$)/.test(trimmed))
    return "other";
  if (hasWord && trimmed.length <= 60 && (role === "room" || role === "text" || role === "unknown"))
    return "room-name";
  return "other";
}

// ---- the whole pass -------------------------------------------------------------------------------------------

export interface DxfImportReport {
  layers: { name: string; role: LayerRole; entities: Record<string, number>; frozen: boolean }[];
  skipped: Record<string, number>;
  warnings: string[];
  /** Layers whose lines were read as walls. */
  wallLayers: string[];
}

export interface DxfImport {
  draft: PlanDraft;
  report: DxfImportReport;
}

/** Units a drawing states: a DXF header, or a note such as a PDF sheet's "SCALE 1:100". */
export interface StatedUnits {
  units: DraftUnits;
  mmPerUnit: number;
  /** How a question names the statement; default "the drawing header says <units>". */
  label?: string;
}

export interface DocumentDraftOptions {
  file?: string | null;
  /** The draft's source kind: "dxf" unless a PDF page was converted into the document. */
  sourceKind?: "dxf" | "pdf-vector";
  page?: number | null;
  /** Roles for layers whose names say nothing, such as the stroke groups of a PDF page. */
  layerRoles?: ReadonlyMap<string, LayerRole>;
  /** Units the drawing states when not in a DXF header; null when it states none. */
  header?: StatedUnits | null;
  /** Millimetres per unit to try when nothing states the scale (default mm, cm, m, in, ft). */
  scaleCandidates?: readonly number[];
}

export function dxfToDraft(text: string, options: DocumentDraftOptions = {}): DxfImport {
  return documentToDraft(parseDxf(text), options);
}

/** The DXF interpretation of a parsed document: a DXF file, or a PDF page converted into one (spec 06 A6). */
export function documentToDraft(doc: DxfDocument, options: DocumentDraftOptions = {}): DxfImport {
  const { placed, warnings } = flatten(doc);
  const hidden = new Set([...doc.layers.values()].filter((l) => l.frozen || l.off).map((l) => l.name));
  const visible = placed.filter((p) => !hidden.has(p.entity.layer));
  const roleOfLayer = (name: string): LayerRole => options.layerRoles?.get(name) ?? layerRole(name);
  const roleOf = (p: Placed): LayerRole => blockRole(p.block) ?? roleOfLayer(p.entity.layer);

  // layer report
  const layerStats = new Map<string, Record<string, number>>();
  for (const p of placed) {
    const s = layerStats.get(p.entity.layer) ?? {};
    s[p.entity.type] = (s[p.entity.type] ?? 0) + 1;
    layerStats.set(p.entity.layer, s);
  }

  // extents and scale
  const pts: DxfPoint[] = [];
  for (const { entity: e } of visible) {
    if (e.type === "LINE") pts.push(e.a, e.b);
    else if (e.type === "POLYLINE") pts.push(...e.vertices);
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const extent = pts.length
    ? Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    : 0;
  const dims = visible.map((p) => p.entity).filter((e): e is DxfDimension => e.type === "DIMENSION");

  // wall layers: named ones, architectural over structural; unknown layers only when nothing is named
  let wallSource = visible.filter((p) => roleOf(p) === "wall");
  const discipline = (layer: string) => /^([a-z])-/i.exec(baseLayerName(layer))?.[1]?.toLowerCase() ?? null;
  if (wallSource.some((p) => discipline(p.entity.layer) === "a"))
    wallSource = wallSource.filter((p) => discipline(p.entity.layer) === "a");
  const wallLayers = new Set(wallSource.map((p) => p.entity.layer));
  const layerQuestions: Omit<DraftQuestion, "id">[] = [];
  if (wallSource.length === 0) {
    wallSource = visible.filter((p) => roleOf(p) === "unknown");
    for (const p of wallSource) wallLayers.add(p.entity.layer);
    if (wallSource.length > 0)
      layerQuestions.push({
        kind: "ambiguity",
        text: `No layer is named like walls, so lines on ${[...wallLayers].sort().join(", ")} were read as walls. Which layers hold the walls?`,
        answer: null,
      });
  }
  const rawWallSegs: Seg[] = [];
  for (const { entity: e } of wallSource) {
    if (e.type === "LINE") {
      const sg = seg(e.a, e.b, null);
      if (sg) rawWallSegs.push(sg);
    } else if (e.type === "POLYLINE" && e.width === null) {
      const ring = polylinePoints(e);
      for (let i = 0; i + 1 < ring.length; i += 1) {
        const sg = seg(ring[i] as DxfPoint, ring[i + 1] as DxfPoint, null);
        if (sg) rawWallSegs.push(sg);
      }
    }
  }
  const spacing = typicalSpacing(rawWallSegs);

  // dimension labels drawn as text beside a line on a dimension layer
  const dimLines = visible
    .filter((p) => roleOf(p) === "dimension" && p.entity.type === "LINE")
    .map((p) => p.entity as DxfLine);
  const textDims: TextDimension[] = [];
  for (const p of visible) {
    if (roleOf(p) !== "dimension" || p.entity.type !== "TEXT") continue;
    const e = p.entity as DxfText;
    if (parseLengthMm(e.text) === null) continue;
    const r = (e.rotation * Math.PI) / 180;
    const dir = { x: Math.cos(r), y: Math.sin(r) };
    let best: { length: number; d: number } | null = null;
    for (const l of dimLines) {
      const sg = seg(l.a, l.b, null);
      if (!sg || Math.abs(cross(sg.u, dir)) > Math.sin((10 * Math.PI) / 180)) continue;
      const mid = mul(add(l.a, l.b), 0.5);
      const off = sub(e.at, mid);
      if (Math.abs(dot(off, sg.u)) > 0.25 * sg.length) continue;
      const d = Math.abs(dot(off, sg.n));
      if (d > 3 * Math.max(e.height, 1e-9)) continue;
      if (!best || d < best.d) best = { length: sg.length, d };
    }
    if (best) textDims.push({ text: e.text, measuredUnits: best.length });
  }

  const stated = options.header !== undefined ? options.header : insUnitsToMm(doc.insUnits);
  const scale = decideScale(stated, dims, extent, textDims, spacing, options.scaleCandidates);
  const k = 1 / scale.mmPerUnit; // draft units per millimetre
  const lim: Limits = { minT: 40 * k, maxT: 700 * k, minOverlap: 150 * k, bridge: 450 * k, maxGap: 3600 * k };
  const questions: Omit<DraftQuestion, "id">[] = [...scale.questions, ...layerQuestions];
  const segs: Seg[] = [];
  const widthPieces: Piece[] = [];
  const widthWalls: Wall[] = [];
  const arcs: DxfArc[] = [];
  for (const { entity: e } of wallSource) {
    if (e.type === "LINE") {
      const s = seg(e.a, e.b, e.handle);
      if (s) segs.push(s);
    } else if (e.type === "ARC") arcs.push(e);
    else if (e.type === "POLYLINE") {
      if (e.width !== null && e.width >= lim.minT && e.width <= lim.maxT) {
        // a polyline drawn with the wall's width is its centreline
        const n = e.vertices.length;
        const edges = e.closed ? n : n - 1;
        for (let i = 0; i < edges; i += 1) {
          const a = e.vertices[i] as DxfPolyline["vertices"][number];
          const b = e.vertices[(i + 1) % n] as DxfPolyline["vertices"][number];
          if (Math.abs(a.bulge) > 1e-9)
            widthWalls.push({
              points: bulgePoints(a, b, a.bulge, 8),
              thickness: e.width,
              handles: e.handle ? [e.handle] : [],
              confidence: 0.95,
              gaps: [],
              straight: false,
            });
          else
            widthPieces.push({
              p: a,
              q: b,
              thickness: e.width,
              handles: e.handle ? [e.handle] : [],
              confidence: 0.95,
            });
        }
      } else {
        const ring = polylinePoints(e);
        for (let i = 0; i + 1 < ring.length; i += 1) {
          const s = seg(ring[i] as DxfPoint, ring[i + 1] as DxfPoint, e.handle);
          if (s) segs.push(s);
        }
        if (e.closed && ring.length > 2) {
          const s = seg(ring[ring.length - 1] as DxfPoint, ring[0] as DxfPoint, e.handle);
          if (s) segs.push(s);
        }
      }
    }
  }
  const pieces = [...pairLines(segs, lim), ...widthPieces];
  const walls = [...mergePieces(pieces, lim), ...concentricArcs(arcs, lim), ...widthWalls];
  extendEnds(walls);
  walls.sort((a, b) => {
    const ax = Math.min(...a.points.map((p) => p.x));
    const bx = Math.min(...b.points.map((p) => p.x));
    const ay = Math.min(...a.points.map((p) => p.y));
    const by = Math.min(...b.points.map((p) => p.y));
    return ax - bx || ay - by;
  });

  // openings
  const cands: Candidate[] = [];
  const slack = 150 * k;
  const gapsUsed = new Set<string>();
  const gapKey = (wi: number, g: Interval) => `${wi}:${Math.round(g[0])}`;
  const findGap = (wi: number, lo: number, hi: number): Interval | null => {
    const w = walls[wi] as Wall;
    for (const g of w.gaps) {
      const [a, b] = g;
      if (a <= hi + slack && b >= lo - slack) return [a, b];
    }
    return null;
  };
  // door arcs
  const doorArcs = visible.filter((p) => roleOf(p) === "door" && p.entity.type === "ARC");
  const arcInserts = new Set<number>();
  for (const p of doorArcs) {
    const e = p.entity as DxfArc;
    if (e.radius < 400 * k || e.radius > 2100 * k) continue;
    const hit = nearestWall(walls, e.centre, slack);
    if (!hit) {
      questions.push({
        kind: "missing",
        text: `A door swing at (${round(e.centre.x, 1)}, ${round(e.centre.y, 1)}) is not on any wall.`,
        answer: null,
      });
      continue;
    }
    const f = wallFrame(walls[hit.index] as Wall);
    const ends = [e.start, e.end].map((a) => ({
      x: e.centre.x + e.radius * Math.cos((a * Math.PI) / 180),
      y: e.centre.y + e.radius * Math.sin((a * Math.PI) / 180),
    }));
    const sorted = ends.sort((x, y) => Math.abs(dot(sub(x, f.p), f.n)) - Math.abs(dot(sub(y, f.p), f.n)));
    const latch = sorted[0] as DxfPoint;
    // the other end of the swing is the open leaf's tip: its side of the wall is the swing side
    const leafTip = sorted[1] as DxfPoint;
    const t0 = hit.t;
    const t1 = dot(sub(latch, f.p), f.u);
    const gap = findGap(hit.index, Math.min(t0, t1), Math.max(t0, t1));
    const [lo, hi] = gap ?? [Math.min(t0, t1), Math.max(t0, t1)];
    if (gap) gapsUsed.add(gapKey(hit.index, gap));
    cands.push({
      wall: hit.index,
      t: (lo + hi) / 2,
      width: hi - lo,
      kind: "door",
      hinge: t0 <= t1 ? "start" : "end",
      swing: dot(sub(leafTip, f.p), f.n) >= 0 ? "left" : "right",
      confidence: gap ? 0.9 : 0.75,
    });
    if (p.insert !== null) arcInserts.add(p.insert);
  }
  // door and window blocks without a usable arc: the block's extent along the nearest wall
  const byInsert = new Map<number, Placed[]>();
  for (const p of visible)
    if (p.insert !== null) byInsert.set(p.insert, [...(byInsert.get(p.insert) ?? []), p]);
  for (const [index, members] of byInsert) {
    const role = blockRole(members[0]?.block ?? null);
    if (role !== "door" && role !== "window") continue;
    if (role === "door" && arcInserts.has(index)) continue;
    const bpts: DxfPoint[] = [];
    for (const { entity: e } of members) {
      if (e.type === "LINE") bpts.push(e.a, e.b);
      else if (e.type === "POLYLINE") bpts.push(...e.vertices);
      else if (e.type === "ARC" || e.type === "CIRCLE") bpts.push(e.centre);
    }
    if (bpts.length === 0) continue;
    const centre = {
      x: bpts.reduce((s, p) => s + p.x, 0) / bpts.length,
      y: bpts.reduce((s, p) => s + p.y, 0) / bpts.length,
    };
    const hit = nearestWall(walls, centre, slack * 2);
    if (!hit) continue;
    const f = wallFrame(walls[hit.index] as Wall);
    const ts = bpts.map((q) => dot(sub(q, f.p), f.u));
    const gap = findGap(hit.index, Math.min(...ts), Math.max(...ts));
    const [lo, hi] = gap ?? [Math.min(...ts), Math.max(...ts)];
    if (gap) gapsUsed.add(gapKey(hit.index, gap));
    cands.push({
      wall: hit.index,
      t: (lo + hi) / 2,
      width: hi - lo,
      kind: role,
      hinge: null,
      swing: null,
      confidence: gap ? 0.85 : 0.7,
    });
  }
  // window lines lying inside a wall
  const windowLines: Map<number, Interval[]> = new Map();
  for (const p of visible) {
    if (roleOf(p) !== "window" || p.insert !== null) continue;
    const e = p.entity;
    const edges: [DxfPoint, DxfPoint][] = [];
    if (e.type === "LINE") edges.push([e.a, e.b]);
    else if (e.type === "POLYLINE") {
      const ring = polylinePoints(e);
      for (let i = 0; i + 1 < ring.length; i += 1) edges.push([ring[i] as DxfPoint, ring[i + 1] as DxfPoint]);
    }
    for (const [a, b] of edges) {
      const s = seg(a, b, null);
      if (!s) continue;
      const mid = mul(add(a, b), 0.5);
      const hit = nearestWall(walls, mid, 30 * k);
      if (!hit) continue;
      const f = wallFrame(walls[hit.index] as Wall);
      if (Math.abs(cross(s.u, f.u)) > Math.sin((3 * Math.PI) / 180)) continue;
      const t1 = dot(sub(a, f.p), f.u);
      const t2 = dot(sub(b, f.p), f.u);
      windowLines.set(hit.index, [
        ...(windowLines.get(hit.index) ?? []),
        [Math.min(t1, t2), Math.max(t1, t2)],
      ]);
    }
  }
  for (const [wi, ivs] of windowLines)
    for (const [lo0, hi0] of union(ivs, 50 * k)) {
      if (hi0 - lo0 < 300 * k) continue;
      const gap = findGap(wi, lo0, hi0);
      const [lo, hi] = gap ?? [lo0, hi0];
      if (gap) gapsUsed.add(gapKey(wi, gap));
      cands.push({
        wall: wi,
        t: (lo + hi) / 2,
        width: hi - lo,
        kind: "window",
        hinge: null,
        swing: null,
        confidence: gap ? 0.85 : 0.75,
      });
    }
  // lines on door or window layers lying in a wall gap say what the gap is: two or more lines along most of
  // the gap are glazing (a window); leaves each covering about half of it are a sliding door
  const gapLines = new Map<number, Interval[]>();
  for (const p of visible) {
    const role = roleOf(p);
    if ((role !== "door" && role !== "window") || p.insert !== null || p.entity.type !== "LINE") continue;
    const e = p.entity;
    const s = seg(e.a, e.b, null);
    if (!s) continue;
    const hit = nearestWall(walls, mul(add(e.a, e.b), 0.5), 30 * k);
    if (!hit) continue;
    const f = wallFrame(walls[hit.index] as Wall);
    if (Math.abs(cross(s.u, f.u)) > Math.sin((3 * Math.PI) / 180)) continue;
    const t1 = dot(sub(e.a, f.p), f.u);
    const t2 = dot(sub(e.b, f.p), f.u);
    gapLines.set(hit.index, [...(gapLines.get(hit.index) ?? []), [Math.min(t1, t2), Math.max(t1, t2)]]);
  }
  walls.forEach((w, wi) => {
    for (const g of w.gaps) {
      if (gapsUsed.has(gapKey(wi, g))) continue;
      const width = g[1] - g[0];
      if (width < 300 * k) continue;
      const inGap = (gapLines.get(wi) ?? [])
        .map(([a, b]): Interval => [Math.max(a, g[0]), Math.min(b, g[1])])
        .filter(([a, b]) => b - a > 0.05 * width);
      const full = inGap.filter(([a, b]) => b - a >= 0.8 * width).length;
      const halves = inGap.filter(([a, b]) => b - a >= 0.3 * width && b - a <= 0.7 * width);
      const halfCover = union(halves, 1e-9).reduce((acc, [a, b]) => acc + b - a, 0);
      const kind = halves.length >= 2 && halfCover >= 0.9 * width ? "door" : full >= 2 ? "window" : null;
      if (!kind) continue;
      gapsUsed.add(gapKey(wi, g));
      cands.push({ wall: wi, t: (g[0] + g[1]) / 2, width, kind, hinge: null, swing: null, confidence: 0.8 });
    }
  });
  // remaining gaps are passages
  walls.forEach((w, wi) => {
    for (const g of w.gaps) {
      if (gapsUsed.has(gapKey(wi, g))) continue;
      const width = g[1] - g[0];
      if (width < 600 * k || width > 3600 * k) continue;
      cands.push({
        wall: wi,
        t: (g[0] + g[1]) / 2,
        width,
        kind: "passage",
        hinge: null,
        swing: null,
        confidence: 0.5,
      });
    }
  });
  // one opening per place: keep the most confident within 300 mm on the same wall
  cands.sort((a, b) => b.confidence - a.confidence || a.wall - b.wall || a.t - b.t);
  const kept: Candidate[] = [];
  for (const c of cands)
    if (!kept.some((o) => o.wall === c.wall && Math.abs(o.t - c.t) < 300 * k)) kept.push(c);
  kept.sort((a, b) => a.wall - b.wall || a.t - b.t);
  const openings: DraftOpening[] = kept.map((c, idx) => {
    const f = wallFrame(walls[c.wall] as Wall);
    return {
      idx,
      wallIdx: c.wall,
      at: add(f.p, mul(f.u, c.t)),
      kind: c.kind,
      width: c.width > 0 ? c.width : null,
      height: null,
      hinge: c.hinge,
      swing: c.swing,
      confidence: c.confidence,
    };
  });

  // rooms and texts
  const texts: (DraftText & { role: LayerRole; raw: string; height: number })[] = [];
  for (const p of visible) {
    const role = roleOf(p);
    if (role === "ignore" || role === "furniture" || p.block !== null) continue;
    if (p.entity.type === "TEXT") {
      const e = p.entity as DxfText;
      if (!e.text) continue;
      const kind = role === "dimension" ? "dimension" : classifyText(e.text.split("\n")[0] ?? e.text, role);
      texts.push({ at: e.at, text: e.text, kind, role, raw: e.text, height: e.height });
    }
  }
  for (const d of dims) {
    const shown =
      d.text && !d.text.includes("<>")
        ? d.text
        : d.measurement !== null
          ? String(round(d.measurement, 0.1))
          : "";
    if (shown && d.textAt)
      texts.push({ at: d.textAt, text: shown, kind: "dimension", role: "dimension", raw: shown, height: 0 });
  }
  // a room name written as two stacked texts ("MASTER" over "BEDROOM") is one name
  for (const upper of texts) {
    if (upper.kind !== "room-name" || upper.height <= 0) continue;
    const h = upper.height;
    const below = texts.find(
      (t) =>
        t !== upper &&
        t.kind === "room-name" &&
        Math.abs(t.height - h) <= 0.2 * h &&
        upper.at.y - t.at.y >= 1.1 * h &&
        upper.at.y - t.at.y <= 2.2 * h &&
        Math.abs(upper.at.x - t.at.x) <= h,
    );
    if (!below) continue;
    const merged = [upper.text.split("\n")[0] ?? "", below.text.split("\n")[0] ?? ""].join(" ").trim();
    if (merged.split(/\s+/).length > 4 || merged.length > 60) continue;
    upper.text = merged;
    below.kind = "other";
  }
  const polygons = visible
    .filter((p) => roleOf(p) === "room" && p.entity.type === "POLYLINE" && (p.entity as DxfPolyline).closed)
    .map((p) => polylinePoints(p.entity as DxfPolyline))
    .filter((poly) => poly.length >= 3 && area(poly) > 1e6 * k * k);
  const rooms: DraftRoom[] = [];
  const named = new Set<number>();
  const nameTexts = texts.map((t, i) => ({ t, i })).filter(({ t }) => t.kind === "room-name");
  for (const polygon of polygons) {
    const c = polygon.reduce((acc, p) => add(acc, mul(p, 1 / polygon.length)), { x: 0, y: 0 });
    const hits = nameTexts
      .filter(({ t }) => inside(polygon, t.at))
      .sort((a, b) => len(sub(a.t.at, c)) - len(sub(b.t.at, c)));
    const label = hits[0];
    for (const h of hits) named.add(h.i);
    const name = label ? (label.t.text.split("\n")[0] as string).trim() : null;
    rooms.push({
      idx: rooms.length,
      polygon,
      labelAt: label ? label.t.at : null,
      name,
      purpose: name ? purposeFromName(name) : null,
      capacity: label ? capacityFromText(label.t.text) : null,
      confidence: label ? 0.9 : 0.7,
    });
  }
  for (const { t, i } of nameTexts) {
    if (named.has(i)) continue;
    // a label on a text or room layer names a room the drawing did not outline
    if (t.role !== "room" && t.role !== "text") continue;
    const name = (t.text.split("\n")[0] as string).trim();
    rooms.push({
      idx: rooms.length,
      polygon: null,
      labelAt: t.at,
      name,
      purpose: purposeFromName(name),
      capacity: capacityFromText(t.text),
      confidence: 0.6,
    });
  }

  // assemble
  const draftWalls: DraftWall[] = walls.map((w, idx) => ({
    idx,
    points: w.points,
    thickness: w.thickness,
    kind: w.thickness >= 200 * k ? "exterior" : w.thickness <= 110 * k ? "partition" : "interior",
    confidence: w.confidence,
    sourceRef: w.handles.length ? w.handles.slice(0, 8).join(",") : null,
  }));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
  const confidence = Math.min(
    1,
    0.5 * (draftWalls.length ? mean(draftWalls.map((w) => w.confidence)) : 0) +
      0.3 * (openings.length ? mean(openings.map((o) => o.confidence)) : 0.5) +
      0.2 * (scale.source === "dimension-text" ? 1 : 0.5),
  );
  const draft: PlanDraft = {
    source: {
      kind: options.sourceKind ?? "dxf",
      file: options.file ?? null,
      page: options.page ?? null,
      pixelSize: null,
    },
    units: {
      detected: scale.detected,
      mmPerUnit: scale.mmPerUnit,
      scaleSource: scale.source,
      checks: scale.checks,
    },
    levelName: null,
    walls: draftWalls,
    openings,
    rooms,
    texts: texts.map(({ at, text: t, kind }) => ({ at, text: t, kind })),
    confidence: Math.round(confidence * 100) / 100,
    questions: questions.map((q, i) => ({ ...q, id: `q${i + 1}` })),
    reader: null,
  };
  if (walls.length === 0)
    draft.questions.push({
      id: `q${draft.questions.length + 1}`,
      kind: "missing",
      text: "No walls were found in the drawing.",
      answer: null,
    });
  return {
    draft,
    report: {
      layers: [...new Set([...doc.layers.keys(), ...layerStats.keys()])].sort().map((name) => ({
        name,
        role: roleOfLayer(name),
        entities: layerStats.get(name) ?? {},
        frozen: hidden.has(name),
      })),
      skipped: doc.skipped,
      warnings,
      wallLayers: [...wallLayers].sort(),
    },
  };
}

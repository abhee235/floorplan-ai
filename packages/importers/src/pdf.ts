// Vector PDF plans (ADR-011 D2, spec 06 A6). The host extracts a page's paths and text with a PDF library;
// this module turns them into the document the DXF reader interprets, so walls, openings, rooms and scale
// come from one pass. A PDF has no layers, so line work is grouped by stroke width and colour: the heaviest
// groups made of parallel line pairs are walls, curves that are circular arcs are door swings, a length label
// and the line it sits beside are a dimension, dashed lines are ignored, and the rest is detail that can mark
// windows. Pure: extracted content in, draft out.
import type { DxfArc, DxfDocument, DxfEntity, DxfLayer, DxfLine, DxfPoint } from "./dxf.js";
import {
  type DxfImport,
  documentToDraft,
  type LayerRole,
  parseLengthMm,
  type StatedUnits,
} from "./dxf-draft.js";
import type { PlanPreview } from "./read.js";

export interface PdfPoint {
  x: number;
  y: number;
}
export type PdfCommand = { op: "L"; to: PdfPoint } | { op: "C"; c1: PdfPoint; c2: PdfPoint; to: PdfPoint };
export interface PdfSubpath {
  start: PdfPoint;
  commands: PdfCommand[];
  closed: boolean;
}
/** One painted path in page space (points, y up), after the current transform. */
export interface PdfPath {
  subpaths: PdfSubpath[];
  stroke: boolean;
  fill: boolean;
  /** Stroke width in page points. */
  lineWidth: number;
  strokeColor: string;
  fillColor: string;
  dashed: boolean;
}
/** A text run as the PDF library reports it: baseline start, height and direction in page space. */
export interface PdfText {
  str: string;
  x: number;
  y: number;
  height: number;
  /** Degrees counter-clockwise. */
  rotation: number;
  width: number;
}
export interface PdfPageContent {
  /** 1-based. */
  page: number;
  width: number;
  height: number;
  paths: PdfPath[];
  texts: PdfText[];
  /** Images painted on the page; a page of images and no line work is a scan. */
  images: number;
}

/** Operator numbers by name, as pdfjs-dist exports them in `OPS`. */
export type PdfOps = Readonly<Record<string, number>>;

// pdfjs-dist 6 path data inside constructPath
const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 } as const;

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` applied after `n`: the new current transform when `n` is concatenated onto `m`. */
function compose(m: Matrix, n: Matrix): Matrix {
  return [
    n[0] * m[0] + n[1] * m[2],
    n[0] * m[1] + n[1] * m[3],
    n[2] * m[0] + n[3] * m[2],
    n[2] * m[1] + n[3] * m[3],
    n[4] * m[0] + n[5] * m[2] + m[4],
    n[4] * m[1] + n[5] * m[3] + m[5],
  ];
}
const apply = (m: Matrix, x: number, y: number): PdfPoint => ({
  x: m[0] * x + m[2] * y + m[4],
  y: m[1] * x + m[3] * y + m[5],
});
const isMatrix = (v: unknown): v is Matrix =>
  Array.isArray(v) || ArrayBuffer.isView(v)
    ? (v as ArrayLike<number>).length === 6 && Array.from(v as ArrayLike<number>).every(Number.isFinite)
    : false;

interface GraphicsState {
  ctm: Matrix;
  lineWidth: number;
  stroke: string;
  fill: string;
  dashed: boolean;
}

const dashedOf = (dash: unknown) => Array.isArray(dash) && dash.some((d) => typeof d === "number" && d > 0);

/**
 * Paths and image count of a page from a pdfjs operator list: transforms, save and restore, form XObjects,
 * line width, dash and colour are tracked; only painted paths are kept.
 */
export function interpretPdfOperators(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
  ops: PdfOps,
): { paths: PdfPath[]; images: number } {
  let state: GraphicsState = {
    ctm: IDENTITY,
    lineWidth: 1,
    stroke: "#000000",
    fill: "#000000",
    dashed: false,
  };
  const stack: GraphicsState[] = [];
  const paths: PdfPath[] = [];
  let images = 0;
  const strokes = new Set(
    ["stroke", "closeStroke", "fillStroke", "eoFillStroke", "closeFillStroke", "closeEOFillStroke"].map(
      (n) => ops[n],
    ),
  );
  const fills = new Set(
    ["fill", "eoFill", "fillStroke", "eoFillStroke", "closeFillStroke", "closeEOFillStroke"].map(
      (n) => ops[n],
    ),
  );
  const closes = new Set(["closeStroke", "closeFillStroke", "closeEOFillStroke"].map((n) => ops[n]));
  const imageOps = new Set(
    [
      "paintImageXObject",
      "paintInlineImageXObject",
      "paintImageMaskXObject",
      "paintImageXObjectRepeat",
      "paintInlineImageXObjectGroup",
      "paintImageMaskXObjectGroup",
    ].map((n) => ops[n]),
  );
  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i] as number;
    const args = (argsArray[i] ?? null) as unknown[] | null;
    if (fn === ops.save) stack.push({ ...state });
    else if (fn === ops.restore) state = stack.pop() ?? state;
    else if (fn === ops.transform) {
      if (args && isMatrix(args)) state.ctm = compose(state.ctm, Array.from(args) as Matrix);
    } else if (fn === ops.paintFormXObjectBegin) {
      stack.push({ ...state });
      const m = args?.[0];
      if (isMatrix(m)) state.ctm = compose(state.ctm, Array.from(m as ArrayLike<number>) as Matrix);
    } else if (fn === ops.paintFormXObjectEnd) state = stack.pop() ?? state;
    else if (fn === ops.setLineWidth) {
      if (typeof args?.[0] === "number") state.lineWidth = args[0];
    } else if (fn === ops.setDash) state.dashed = dashedOf(args?.[0]);
    else if (fn === ops.setGState) {
      for (const entry of (args?.[0] as unknown[] | undefined) ?? []) {
        if (!Array.isArray(entry)) continue;
        const [key, value] = entry as [unknown, unknown];
        if (key === "LW" && typeof value === "number") state.lineWidth = value;
        if (key === "D" && Array.isArray(value)) state.dashed = dashedOf(value[0]);
      }
    } else if (fn === ops.setStrokeRGBColor) {
      if (typeof args?.[0] === "string") state.stroke = args[0];
    } else if (fn === ops.setFillRGBColor) {
      if (typeof args?.[0] === "string") state.fill = args[0];
    } else if (imageOps.has(fn)) images += 1;
    else if (fn === ops.constructPath) {
      const paint = args?.[0] as number;
      const data = (args?.[1] as unknown[] | undefined)?.[0] as ArrayLike<number> | null | undefined;
      const stroke = strokes.has(paint);
      const fill = fills.has(paint);
      if (!data || (!stroke && !fill)) continue;
      const subpaths = readPathData(data, state.ctm, closes.has(paint));
      if (subpaths.length === 0) continue;
      const [a, b, c, d] = state.ctm;
      paths.push({
        subpaths,
        stroke,
        fill,
        lineWidth: state.lineWidth * Math.sqrt(Math.abs(a * d - b * c)),
        strokeColor: state.stroke,
        fillColor: state.fill,
        dashed: state.dashed,
      });
    }
  }
  return { paths, images };
}

function readPathData(data: ArrayLike<number>, m: Matrix, closeAll: boolean): PdfSubpath[] {
  const out: PdfSubpath[] = [];
  let current: PdfSubpath | null = null;
  let at: PdfPoint = { x: 0, y: 0 };
  const open = () => {
    if (!current) {
      current = { start: at, commands: [], closed: false };
      out.push(current);
    }
    return current;
  };
  for (let i = 0; i < data.length; ) {
    const op = data[i++];
    const n = () => data[i++] as number;
    if (op === DRAW.moveTo) {
      const x = n();
      const y = n();
      at = apply(m, x, y);
      current = { start: at, commands: [], closed: false };
      out.push(current);
    } else if (op === DRAW.lineTo) {
      const x = n();
      const y = n();
      const to = apply(m, x, y);
      open().commands.push({ op: "L", to });
      at = to;
    } else if (op === DRAW.curveTo) {
      const c1 = apply(m, n(), n());
      const c2 = apply(m, n(), n());
      const to = apply(m, n(), n());
      open().commands.push({ op: "C", c1, c2, to });
      at = to;
    } else if (op === DRAW.quadraticCurveTo) {
      const q = apply(m, n(), n());
      const to = apply(m, n(), n());
      const from = at;
      open().commands.push({
        op: "C",
        c1: { x: from.x + (2 / 3) * (q.x - from.x), y: from.y + (2 / 3) * (q.y - from.y) },
        c2: { x: to.x + (2 / 3) * (q.x - to.x), y: to.y + (2 / 3) * (q.y - to.y) },
        to,
      });
      at = to;
    } else if (op === DRAW.closePath) {
      const s = current as PdfSubpath | null;
      if (s) {
        s.closed = true;
        at = s.start;
      }
      current = null;
    } else break;
  }
  if (closeAll) for (const s of out) s.closed = true;
  return out.filter((s) => s.commands.length > 0);
}

// ---- geometry helpers ---------------------------------------------------------------------------------------

const sub = (a: PdfPoint, b: PdfPoint): PdfPoint => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: PdfPoint, b: PdfPoint): PdfPoint => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: PdfPoint, k: number): PdfPoint => ({ x: a.x * k, y: a.y * k });
const dot = (a: PdfPoint, b: PdfPoint) => a.x * b.x + a.y * b.y;
const cross = (a: PdfPoint, b: PdfPoint) => a.x * b.y - a.y * b.x;
const len = (a: PdfPoint) => Math.hypot(a.x, a.y);

/** A cubic Bézier that is a circular arc: its centre, radius, start angle and signed sweep in radians. */
export interface ArcFit {
  centre: PdfPoint;
  radius: number;
  from: number;
  sweep: number;
}

/**
 * The circular arc a cubic Bézier draws, or null. PDF writers draw arcs as cubics of at most 90 degrees with
 * control points on the end tangents at 4/3 tan(sweep/4) of the radius; anything else is not an arc.
 */
export function cubicArc(p0: PdfPoint, c1: PdfPoint, c2: PdfPoint, p3: PdfPoint): ArcFit | null {
  const t0 = sub(c1, p0);
  const t1 = sub(p3, c2);
  const l0 = len(t0);
  const l1 = len(t1);
  if (l0 < 1e-9 || l1 < 1e-9) return null;
  const n0 = { x: -t0.y / l0, y: t0.x / l0 };
  const n1 = { x: -t1.y / l1, y: t1.x / l1 };
  // p0 + s n0 = p3 + r n1
  const det = n0.x * -n1.y - n0.y * -n1.x;
  if (Math.abs(det) < 1e-9) return null;
  const d = sub(p3, p0);
  const s = (d.x * -n1.y - d.y * -n1.x) / det;
  const centre = add(p0, mul(n0, s));
  const r0 = len(sub(p0, centre));
  const r1 = len(sub(p3, centre));
  const radius = (r0 + r1) / 2;
  if (radius < 1e-9 || Math.abs(r0 - r1) > 0.02 * radius) return null;
  const from = Math.atan2(p0.y - centre.y, p0.x - centre.x);
  const to = Math.atan2(p3.y - centre.y, p3.x - centre.x);
  const ccw = cross(sub(p0, centre), t0) > 0;
  let sweep = ccw ? to - from : from - to;
  while (sweep <= 0) sweep += 2 * Math.PI;
  while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
  if (sweep > (100 * Math.PI) / 180 || sweep < (2 * Math.PI) / 180) return null;
  const k = (4 / 3) * Math.tan(sweep / 4) * radius;
  if (Math.abs(l0 - k) > 0.15 * k || Math.abs(l1 - k) > 0.15 * k) return null;
  // the curve's midpoint lies on the circle too
  const mid = mul(add(add(p0, p3), mul(add(c1, c2), 3)), 1 / 8);
  if (Math.abs(len(sub(mid, centre)) - radius) > 0.02 * radius) return null;
  return { centre, radius, from, sweep: ccw ? sweep : -sweep };
}

function bezierPoint(p0: PdfPoint, c1: PdfPoint, c2: PdfPoint, p3: PdfPoint, t: number): PdfPoint {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
  };
}

/** Consecutive arc pieces of one circle drawn in one direction are one arc; full circles are dropped. */
function mergeArcs(pieces: readonly ArcFit[], layer: string, handle: string): DxfArc[] {
  const merged: ArcFit[] = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    const joins =
      last &&
      Math.sign(last.sweep) === Math.sign(p.sweep) &&
      len(sub(last.centre, p.centre)) <= 0.02 * last.radius &&
      Math.abs(last.radius - p.radius) <= 0.02 * last.radius &&
      Math.abs(
        Math.atan2(Math.sin(last.from + last.sweep - p.from), Math.cos(last.from + last.sweep - p.from)),
      ) < 0.02;
    if (last && joins) last.sweep += p.sweep;
    else merged.push({ ...p });
  }
  const deg = (r: number) => ((((r * 180) / Math.PI) % 360) + 360) % 360;
  return merged
    .filter((a) => Math.abs(a.sweep) < (350 * Math.PI) / 180)
    .map((a) => {
      const start = a.sweep > 0 ? a.from : a.from + a.sweep;
      return {
        type: "ARC",
        layer,
        handle,
        centre: a.centre,
        radius: a.radius,
        start: deg(start),
        end: deg(start + Math.abs(a.sweep)),
      };
    });
}

// ---- text -------------------------------------------------------------------------------------------------

interface Run {
  str: string;
  start: PdfPoint;
  u: PdfPoint;
  width: number;
  height: number;
  rotation: number;
}

export interface PageLabel {
  text: string;
  /** Centre of the label's baseline. */
  at: PdfPoint;
  height: number;
  rotation: number;
}

/**
 * Text runs as labels: pieces of one line are joined, and a short line with digits under a label ("12 PAX"
 * under "BOARDROOM") becomes its second line, as a CAD program's multi-line text would read.
 */
export function pageLabels(items: readonly PdfText[]): PageLabel[] {
  const runs: Run[] = [];
  for (const t of items) {
    if (!t.str.trim() || !(t.height > 0)) continue;
    const r = (t.rotation * Math.PI) / 180;
    const u = { x: Math.cos(r), y: Math.sin(r) };
    const start = { x: t.x, y: t.y };
    const prev = runs.find((l) => {
      if (Math.abs(l.rotation - t.rotation) > 1 || Math.abs(l.height - t.height) > 0.1 * l.height)
        return false;
      const off = sub(start, add(l.start, mul(l.u, l.width)));
      const along = dot(off, l.u);
      return (
        along >= -0.2 * l.height && along <= 0.6 * l.height && Math.abs(cross(l.u, off)) <= 0.2 * l.height
      );
    });
    if (prev) {
      const gap = dot(sub(start, add(prev.start, mul(prev.u, prev.width))), prev.u);
      const space = gap > 0.15 * prev.height && !prev.str.endsWith(" ") && !t.str.startsWith(" ");
      prev.str = `${prev.str}${space ? " " : ""}${t.str}`;
      prev.width = dot(sub(start, prev.start), prev.u) + t.width;
    } else runs.push({ str: t.str, start, u, width: t.width, height: t.height, rotation: t.rotation });
  }
  const centre = (l: Run) => add(l.start, mul(l.u, l.width / 2));
  const used = new Set<Run>();
  const out: PageLabel[] = [];
  for (const l of runs) {
    if (used.has(l)) continue;
    let text = l.str.trim();
    if (/[A-Za-z]{3,}/.test(text) && !/\d/.test(text)) {
      const n = { x: -l.u.y, y: l.u.x };
      const below = runs.find((o) => {
        if (o === l || used.has(o) || Math.abs(o.rotation - l.rotation) > 1) return false;
        const s = o.str.trim();
        if (!/\d/.test(s) || s.split(/\s+/).length > 3) return false;
        const off = sub(centre(o), centre(l));
        const depth = -dot(off, n);
        return depth >= 1.0 * l.height && depth <= 1.8 * l.height && Math.abs(dot(off, l.u)) <= l.height;
      });
      if (below) {
        used.add(below);
        text = `${text}\n${below.str.trim()}`;
      }
    }
    out.push({ text, at: centre(l), height: l.height, rotation: l.rotation });
  }
  return out;
}

// ---- page to document -------------------------------------------------------------------------------------

/** Drawing scales tried when nothing on the sheet states one, as millimetres per point. */
export const PAPER_SCALES: readonly number[] = [
  1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 500, 1000, 1250, 2000, 2500, 5000,
].map((n) => (n * 25.4) / 72);

const DASHED = "pdf-dashed";
/** Text away from the wall line work: a legend, a title block or a note, never a room name. */
const NOTES = "pdf-notes";
const ARCS = "pdf-arcs";
const TEXT = "pdf-text";
const DIMENSIONS = "pdf-dimensions";
/** Parallel line pairs this far apart on the sheet can be wall faces: 60 mm at 1:500 to 500 mm at 1:20. */
const PAIR_MIN_PT = 0.3;
const PAIR_MAX_PT = 72;

interface Group {
  layer: string;
  lines: DxfLine[];
  width: number;
  fill: boolean;
  color: string;
}

const hexOf = (color: string) => color.replace(/^#/, "").toLowerCase();
function luminance(color: string): number {
  const v = Number.parseInt(hexOf(color).padEnd(6, "0").slice(0, 6), 16);
  if (!Number.isFinite(v)) return 0;
  return (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255;
}

/** Share of a group's line length that has a parallel, overlapping partner at a wall-like distance. */
function pairedShare(lines: readonly DxfLine[]): { share: number; length: number; meanPaired: number } {
  const segs = lines
    .map((l) => {
      const d = sub(l.b, l.a);
      const length = len(d);
      return { a: l.a, b: l.b, length, u: length > 0 ? mul(d, 1 / length) : d };
    })
    .filter((s) => s.length > 1e-6)
    .sort((x, y) => y.length - x.length);
  const length = segs.reduce((acc, s) => acc + s.length, 0);
  const sample = segs.slice(0, 1500);
  const sinTol = Math.sin((2 * Math.PI) / 180);
  let paired = 0;
  let pairedCount = 0;
  let sampled = 0;
  for (const s of sample) {
    sampled += s.length;
    const n = { x: -s.u.y, y: s.u.x };
    const hit = sample.some((o) => {
      if (o === s || Math.abs(cross(s.u, o.u)) > sinTol) return false;
      const d = Math.abs(dot(sub(o.a, s.a), n));
      if (d < PAIR_MIN_PT || d > PAIR_MAX_PT) return false;
      const t1 = dot(sub(o.a, s.a), s.u);
      const t2 = dot(sub(o.b, s.a), s.u);
      const overlap = Math.min(s.length, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2));
      return overlap > 0.25 * Math.min(s.length, o.length);
    });
    if (hit) {
      paired += s.length;
      pairedCount += 1;
    }
  }
  return {
    share: sampled > 0 ? paired / sampled : 0,
    length,
    meanPaired: pairedCount > 0 ? paired / pairedCount : 0,
  };
}

export interface PdfDocumentConversion {
  doc: DxfDocument;
  layerRoles: Map<string, LayerRole>;
  /** The drawing scale a note on the sheet states ("SCALE 1:100"), or null. */
  header: StatedUnits | null;
  wallLayers: string[];
}

/** A page's line work and text as a DXF-like document with a role for every synthetic layer. */
export function pdfPageToDocument(content: PdfPageContent): PdfDocumentConversion {
  const pageArea = Math.max(1, content.width * content.height);
  const entities: DxfEntity[] = [];
  const groups = new Map<string, Group>();

  content.paths.forEach((path, pi) => {
    const handle = `p${pi}`;
    let layer: string;
    if (path.stroke && path.dashed) layer = DASHED;
    else if (path.stroke) layer = `pdf-stroke-${path.lineWidth.toFixed(2)}-${hexOf(path.strokeColor)}`;
    else {
      // white masks and sheet-sized backgrounds are not drawing
      if (luminance(path.fillColor) > 0.97) return;
      const pts = path.subpaths.flatMap((s) => [s.start, ...s.commands.map((c) => c.to)]);
      const w = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
      const h = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
      if (w * h >= 0.25 * pageArea) return;
      layer = `pdf-fill-${hexOf(path.fillColor)}`;
    }
    let group: Group | null = null;
    if (layer !== DASHED) {
      group = groups.get(layer) ?? {
        layer,
        lines: [],
        width: path.stroke ? path.lineWidth : 0,
        fill: !path.stroke,
        color: path.stroke ? path.strokeColor : path.fillColor,
      };
      groups.set(layer, group);
    }
    const addLine = (a: DxfPoint, b: DxfPoint) => {
      if (len(sub(a, b)) < 1e-6) return;
      const line: DxfLine = { type: "LINE", layer, handle, a, b };
      entities.push(line);
      group?.lines.push(line);
    };
    for (const sp of path.subpaths) {
      let at = sp.start;
      const pieces: ArcFit[] = [];
      const flushArcs = () => {
        if (pieces.length) entities.push(...mergeArcs(pieces, ARCS, handle));
        pieces.length = 0;
      };
      for (const c of sp.commands) {
        if (c.op === "L") {
          flushArcs();
          addLine(at, c.to);
        } else {
          const arc = layer === DASHED ? null : cubicArc(at, c.c1, c.c2, c.to);
          if (arc) pieces.push(arc);
          else {
            flushArcs();
            let prev = at;
            for (let k = 1; k <= 8; k += 1) {
              const q = bezierPoint(at, c.c1, c.c2, c.to, k / 8);
              addLine(prev, q);
              prev = q;
            }
          }
        }
        at = c.to;
      }
      flushArcs();
      if (sp.closed) addLine(at, sp.start);
    }
  });

  // Walls, before the labels: a plan's overall dimension is stated across its wall line work, so the walls
  // have to be known before the scale can be read off them. Hatching, furniture and symbols pair as readily
  // as wall faces do, but they draw short lines, so the groups of long parallel pairs are the walls whatever
  // stroke weight they are drawn at.
  const diagonal = Math.hypot(content.width, content.height);
  const pickWalls = (): Set<string> => {
    const stats = [...groups.values()]
      .filter((g) => g.lines.length > 0)
      .map((g) => ({ g, ...pairedShare(g.lines) }));
    const maxLength = Math.max(0, ...stats.map((s) => s.length));
    const candidates = stats
      .filter(
        (s) =>
          s.share >= 0.5 &&
          s.length >= 0.05 * maxLength &&
          s.meanPaired >= 0.02 * diagonal &&
          (!s.g.fill || luminance(s.g.color) < 0.6),
      )
      .map((s) => ({ ...s, paired: s.share * s.length }));
    const most = Math.max(0, ...candidates.map((s) => s.paired));
    // a second group joins the walls only when it carries nearly as much paired line work: on a drawing
    // whose walls are unmistakable, the thin detail lines are window and door symbols, not walls
    return new Set(candidates.filter((s) => s.paired >= 0.8 * most).map((s) => s.g.layer));
  };
  const boxOf = (layers: ReadonlySet<string>) => {
    const pts = [...groups.values()]
      .filter((g) => layers.has(g.layer))
      .flatMap((g) => g.lines)
      .flatMap((l) => [l.a, l.b]);
    if (pts.length === 0) return null;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  };
  const roughBox = boxOf(pickWalls());

  // labels, dimension labels and the dimension line beside each
  const labels = pageLabels(content.texts);
  const moved = new Set<DxfLine>();
  let header: StatedUnits | null = null;
  let longestMm = 0;
  const lengths: { at: DxfPoint; height: number; rotation: number; mm: number }[] = [];
  for (const t of labels) {
    const scaleNote = /\b1\s*:\s*(\d{1,5})\b/.exec(t.text);
    if (scaleNote && !header) {
      const n = Number(scaleNote[1]);
      if (n > 0) header = { units: "unknown", mmPerUnit: (n * 25.4) / 72, label: `the sheet says 1:${n}` };
    }
    const mm = /\d/.test(t.text) ? parseLengthMm(t.text) : null;
    entities.push({
      type: "TEXT",
      layer: mm === null ? TEXT : DIMENSIONS,
      handle: null,
      at: t.at,
      height: t.height,
      text: t.text,
      rotation: t.rotation,
    });
    if (mm === null || !(mm > 0)) continue;
    if (mm > longestMm) longestMm = mm;
    lengths.push({ at: t.at, height: t.height, rotation: t.rotation, mm });
  }
  // The longest length the drawing states is its overall dimension, and that is measured across the plan, so
  // the wall line work gives millimetres per point even when the dimension lines are broken around their text
  // and no single line is as long as the length beside it.
  const span = roughBox ? Math.max(roughBox.maxX - roughBox.minX, roughBox.maxY - roughBox.minY) : 0;
  const fromExtent = span > 0 && longestMm > 0 ? longestMm / span : null;
  for (const t of lengths) {
    const r = (t.rotation * Math.PI) / 180;
    const dir = { x: Math.cos(r), y: Math.sin(r) };
    let best: { line: DxfLine; d: number; implied: number } | null = null;
    for (const g of groups.values()) {
      if (g.fill) continue;
      for (const line of g.lines) {
        const v = sub(line.b, line.a);
        const l = len(v);
        if (l < 1e-6 || moved.has(line)) continue;
        const u = mul(v, 1 / l);
        if (Math.abs(cross(u, dir)) > Math.sin((10 * Math.PI) / 180)) continue;
        const off = sub(t.at, mul(add(line.a, line.b), 0.5));
        if (Math.abs(dot(off, u)) > 0.25 * l) continue;
        const d = Math.abs(cross(u, off));
        if (d > 3 * t.height) continue;
        if (!best || d < best.d) best = { line, d, implied: t.mm / l };
      }
    }
    // a label beside a line that is not its dimension implies a scale the plan's own extent disagrees with
    const agrees = fromExtent === null || Math.abs(best ? best.implied - fromExtent : 0) / fromExtent <= 0.1;
    if (best && agrees) moved.add(best.line);
  }
  for (const line of moved) line.layer = DIMENSIONS;
  for (const g of groups.values()) g.lines = g.lines.filter((l) => !moved.has(l));
  // only when no label sits beside a line of its own length: a drawing that dimensions itself properly
  // should be read from its dimension text, which a person can confirm, not from this reading of its extent
  // a lone label beside a line of its own length is not enough for the scale to be read from dimension text
  // (two must agree), so the extent reading stands in for it; two or more accepted lines speak for themselves
  if (!header && moved.size < 2 && fromExtent !== null)
    header = {
      units: "unknown",
      mmPerUnit: fromExtent,
      label: `the plan measures ${Math.round(longestMm / 100) / 10} m across`,
    };

  // the dimension lines are out of the way now, so the wall groups are chosen again without them
  const walls = pickWalls();
  const wallBox = boxOf(walls);
  if (wallBox) {
    const mx = 0.05 * (wallBox.maxX - wallBox.minX);
    const my = 0.05 * (wallBox.maxY - wallBox.minY);
    for (const e of entities)
      if (
        e.type === "TEXT" &&
        e.layer === TEXT &&
        (e.at.x < wallBox.minX - mx ||
          e.at.x > wallBox.maxX + mx ||
          e.at.y < wallBox.minY - my ||
          e.at.y > wallBox.maxY + my)
      )
        e.layer = NOTES;
  }
  const layerRoles = new Map<string, LayerRole>([
    [DASHED, "ignore"],
    [ARCS, "door"],
    [TEXT, "text"],
    [NOTES, "ignore"],
    [DIMENSIONS, "dimension"],
  ]);
  // with no wall-like group every group is unknown, and the reader asks which lines are walls
  for (const g of groups.values())
    layerRoles.set(g.layer, walls.size === 0 ? "unknown" : walls.has(g.layer) ? "wall" : "window");

  const layers = new Map<string, DxfLayer>();
  for (const e of entities)
    if (!layers.has(e.layer)) layers.set(e.layer, { name: e.layer, color: 7, frozen: false, off: false });
  return {
    doc: {
      version: null,
      insUnits: null,
      measurement: null,
      layers,
      blocks: new Map(),
      entities,
      skipped: content.images > 0 ? { IMAGE: content.images } : {},
    },
    layerRoles,
    header,
    wallLayers: [...walls].sort(),
  };
}

const PREVIEW_LIMIT = 20_000;

/** A vector PDF page as a draft in page points (spec 06 A6), with its report and a preview of the line work. */
export function pdfPageToDraft(
  content: PdfPageContent,
  options: { file?: string | null } = {},
): DxfImport & { preview: PlanPreview } {
  const { doc, layerRoles, header } = pdfPageToDocument(content);
  const result = documentToDraft(doc, {
    file: options.file ?? null,
    sourceKind: "pdf-vector",
    page: content.page,
    layerRoles,
    header,
    scaleCandidates: PAPER_SCALES,
  });
  const segments: [number, number, number, number][] = [];
  let truncated = false;
  const push = (x1: number, y1: number, x2: number, y2: number) => {
    if (segments.length >= PREVIEW_LIMIT) truncated = true;
    else segments.push([x1, y1, x2, y2]);
  };
  for (const e of doc.entities) {
    if (e.type === "LINE") push(e.a.x, e.a.y, e.b.x, e.b.y);
    else if (e.type === "ARC") {
      const sweep = (((e.end - e.start) % 360) + 360) % 360 || 360;
      const steps = Math.max(4, Math.ceil(sweep / 15));
      for (let i = 0; i < steps; i += 1) {
        const a0 = ((e.start + (sweep * i) / steps) * Math.PI) / 180;
        const a1 = ((e.start + (sweep * (i + 1)) / steps) * Math.PI) / 180;
        push(
          e.centre.x + e.radius * Math.cos(a0),
          e.centre.y + e.radius * Math.sin(a0),
          e.centre.x + e.radius * Math.cos(a1),
          e.centre.y + e.radius * Math.sin(a1),
        );
      }
    }
  }
  return { ...result, preview: { segments, truncated } };
}

// An ASCII DXF reader for plan import (ADR-011 D2). It reads what floor plans use: header units, layers,
// blocks, LINE, ARC, CIRCLE, LWPOLYLINE, POLYLINE with VERTEX, TEXT, MTEXT, INSERT and DIMENSION, and it
// flattens block references into world coordinates. Everything else is counted and skipped, never guessed.
// Pure: text in, records out.

export interface DxfPoint {
  x: number;
  y: number;
}

interface Base {
  layer: string;
  handle: string | null;
}

export interface DxfLine extends Base {
  type: "LINE";
  a: DxfPoint;
  b: DxfPoint;
}
/** Angles in degrees, counter-clockwise from start to end. */
export interface DxfArc extends Base {
  type: "ARC";
  centre: DxfPoint;
  radius: number;
  start: number;
  end: number;
}
export interface DxfCircle extends Base {
  type: "CIRCLE";
  centre: DxfPoint;
  radius: number;
}
/** LWPOLYLINE and POLYLINE; bulge is the tangent of a quarter of the arc's included angle. */
export interface DxfPolyline extends Base {
  type: "POLYLINE";
  vertices: { x: number; y: number; bulge: number }[];
  closed: boolean;
  /** Constant width when the polyline has one, else null. */
  width: number | null;
}
/** TEXT and MTEXT with formatting codes removed. */
export interface DxfText extends Base {
  type: "TEXT";
  at: DxfPoint;
  height: number;
  text: string;
  rotation: number;
}
export interface DxfInsert extends Base {
  type: "INSERT";
  block: string;
  at: DxfPoint;
  scale: { x: number; y: number };
  rotation: number;
}
export interface DxfDimension extends Base {
  type: "DIMENSION";
  kind: "linear" | "aligned" | "other";
  p1: DxfPoint;
  p2: DxfPoint;
  /** Direction of a linear dimension in degrees. */
  angle: number;
  /** The text override as written; empty or "<>" means the measured value is shown. */
  text: string;
  measurement: number | null;
  textAt: DxfPoint | null;
}

export type DxfEntity = DxfLine | DxfArc | DxfCircle | DxfPolyline | DxfText | DxfInsert | DxfDimension;

export interface DxfLayer {
  name: string;
  color: number;
  frozen: boolean;
  off: boolean;
}

export interface DxfBlock {
  name: string;
  base: DxfPoint;
  entities: DxfEntity[];
}

export interface DxfDocument {
  version: string | null;
  insUnits: number | null;
  measurement: number | null;
  layers: Map<string, DxfLayer>;
  blocks: Map<string, DxfBlock>;
  entities: DxfEntity[];
  /** Entity types that were read past, with counts. */
  skipped: Record<string, number>;
}

export class DxfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DxfError";
  }
}

type Pair = [number, string];

interface RecordData {
  type: string;
  pairs: Pair[];
}

function first(r: RecordData, code: number): string | undefined {
  return r.pairs.find((p) => p[0] === code)?.[1];
}
function num(r: RecordData, code: number, fallback = 0): number {
  const v = first(r, code);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readPairs(text: string): Pair[] {
  if (text.startsWith("AutoCAD Binary DXF"))
    throw new DxfError("binary DXF is not supported; save the drawing as ASCII DXF");
  const lines = text.split(/\r\n|\r|\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number((lines[i] as string).trim());
    if (!Number.isInteger(code))
      throw new DxfError(`line ${i + 1}: expected a group code, got "${(lines[i] as string).trim()}"`);
    out.push([code, (lines[i + 1] as string).trim()]);
  }
  return out;
}

/** Split a run of pairs into records, each starting at a group 0. */
function records(pairs: readonly Pair[]): RecordData[] {
  const out: RecordData[] = [];
  let cur: RecordData | null = null;
  for (const p of pairs) {
    if (p[0] === 0) {
      cur = { type: p[1], pairs: [] };
      out.push(cur);
    } else cur?.pairs.push(p);
  }
  return out;
}

const SPECIAL: Readonly<Record<string, string>> = { "%%d": "°", "%%p": "±", "%%c": "⌀", "%%%": "%" };

/** TEXT control codes and MTEXT formatting removed: \P becomes a line break, font and colour codes vanish. */
export function cleanText(raw: string): string {
  return raw
    .replace(/%%[dpc%]/gi, (m) => SPECIAL[m.toLowerCase()] ?? "")
    .replace(/%%[ou]/gi, "")
    .replace(/\\P/g, "\n")
    .replace(/\\~/g, " ")
    .replace(/\\[ACcFfHhQqTtWw][^;]*;/g, "")
    .replace(/\\[LlOoKk]/g, "")
    .replace(/\\S([^;]*);/g, (_, s: string) => s.replace(/[\^#/]/g, "/"))
    .replace(/[{}]/g, "")
    .replace(/\\\\/g, "\\")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

/** Entities that live in an object coordinate system flip x when their extrusion points down (230 = -1). */
function mirrored(r: RecordData): boolean {
  return num(r, 230, 1) < 0;
}

function toEntity(r: RecordData, vertices: RecordData[] = []): DxfEntity | null {
  const layer = first(r, 8) ?? "0";
  const handle = first(r, 5) ?? null;
  const flip = mirrored(r) ? -1 : 1;
  switch (r.type) {
    case "LINE":
      return {
        type: "LINE",
        layer,
        handle,
        a: { x: num(r, 10), y: num(r, 20) },
        b: { x: num(r, 11), y: num(r, 21) },
      };
    case "ARC": {
      const start = num(r, 50);
      const end = num(r, 51);
      return {
        type: "ARC",
        layer,
        handle,
        centre: { x: flip * num(r, 10), y: num(r, 20) },
        radius: num(r, 40),
        // mirroring reverses the sweep, so start and end swap around 180
        start: flip < 0 ? 180 - end : start,
        end: flip < 0 ? 180 - start : end,
      };
    }
    case "CIRCLE":
      return {
        type: "CIRCLE",
        layer,
        handle,
        centre: { x: flip * num(r, 10), y: num(r, 20) },
        radius: num(r, 40),
      };
    case "LWPOLYLINE": {
      const verts: { x: number; y: number; bulge: number }[] = [];
      let widths = new Set<number>();
      for (const [code, value] of r.pairs) {
        const v = Number(value);
        if (code === 10) verts.push({ x: flip * v, y: 0, bulge: 0 });
        else if (code === 20 && verts.length) (verts[verts.length - 1] as { y: number }).y = v;
        else if (code === 42 && verts.length) (verts[verts.length - 1] as { bulge: number }).bulge = flip * v;
        else if ((code === 40 || code === 41) && verts.length) widths.add(v);
      }
      const constant = first(r, 43);
      if (constant !== undefined) widths = new Set([Number(constant)]);
      const width = widths.size === 1 && ([...widths][0] as number) > 0 ? ([...widths][0] as number) : null;
      return { type: "POLYLINE", layer, handle, vertices: verts, closed: (num(r, 70) & 1) === 1, width };
    }
    case "POLYLINE": {
      const verts = vertices
        .filter((v) => (num(v, 70) & 16) === 0) // skip spline frame control points
        .map((v) => ({ x: flip * num(v, 10), y: num(v, 20), bulge: flip * num(v, 42) }));
      const w0 = num(r, 40);
      const w1 = num(r, 41, w0);
      const vw = vertices.flatMap((v) => [num(v, 40, w0), num(v, 41, w1)]);
      const all = new Set([w0, w1, ...vw]);
      const width = all.size === 1 && w0 > 0 ? w0 : null;
      return { type: "POLYLINE", layer, handle, vertices: verts, closed: (num(r, 70) & 1) === 1, width };
    }
    case "TEXT": {
      const aligned = num(r, 72) !== 0 || num(r, 73) !== 0;
      const at =
        aligned && first(r, 11) !== undefined
          ? { x: num(r, 11), y: num(r, 21) }
          : { x: num(r, 10), y: num(r, 20) };
      return {
        type: "TEXT",
        layer,
        handle,
        at: { x: flip * at.x, y: at.y },
        height: num(r, 40),
        text: cleanText(first(r, 1) ?? ""),
        rotation: num(r, 50),
      };
    }
    case "MTEXT": {
      const parts = r.pairs.filter((p) => p[0] === 3).map((p) => p[1]);
      const text = cleanText([...parts, first(r, 1) ?? ""].join(""));
      return {
        type: "TEXT",
        layer,
        handle,
        at: { x: num(r, 10), y: num(r, 20) },
        height: num(r, 40),
        text,
        rotation: num(r, 50),
      };
    }
    case "INSERT":
      return {
        type: "INSERT",
        layer,
        handle,
        block: first(r, 2) ?? "",
        at: { x: flip * num(r, 10), y: num(r, 20) },
        scale: { x: flip * num(r, 41, 1), y: num(r, 42, 1) },
        rotation: flip < 0 ? -num(r, 50) : num(r, 50),
      };
    case "DIMENSION": {
      const t = num(r, 70) & 7;
      const textAt = first(r, 11) !== undefined ? { x: num(r, 11), y: num(r, 21) } : null;
      const m = first(r, 42);
      return {
        type: "DIMENSION",
        layer,
        handle,
        kind: t === 0 ? "linear" : t === 1 ? "aligned" : "other",
        p1: { x: num(r, 13), y: num(r, 23) },
        p2: { x: num(r, 14), y: num(r, 24) },
        angle: num(r, 50),
        text: cleanText(first(r, 1) ?? ""),
        measurement: m === undefined ? null : Number(m),
        textAt,
      };
    }
    default:
      return null;
  }
}

/** Turn a section's records into entities, pulling VERTEX records into their POLYLINE. */
function entitiesOf(recs: readonly RecordData[], skipped: Record<string, number>): DxfEntity[] {
  const out: DxfEntity[] = [];
  for (let i = 0; i < recs.length; i += 1) {
    const r = recs[i] as RecordData;
    if (r.type === "POLYLINE") {
      const verts: RecordData[] = [];
      while (i + 1 < recs.length && (recs[i + 1] as RecordData).type === "VERTEX")
        verts.push(recs[++i] as RecordData);
      if (i + 1 < recs.length && (recs[i + 1] as RecordData).type === "SEQEND") i += 1;
      const e = toEntity(r, verts);
      if (e) out.push(e);
      continue;
    }
    if (r.type === "SEQEND" || r.type === "VERTEX" || r.type === "ATTRIB" || r.type === "ATTDEF") continue;
    const e = toEntity(r);
    if (e) out.push(e);
    else skipped[r.type] = (skipped[r.type] ?? 0) + 1;
  }
  return out;
}

export function parseDxf(text: string): DxfDocument {
  const pairs = readPairs(text.replace(/^﻿/, ""));
  const doc: DxfDocument = {
    version: null,
    insUnits: null,
    measurement: null,
    layers: new Map(),
    blocks: new Map(),
    entities: [],
    skipped: {},
  };
  let i = 0;
  let sections = 0;
  while (i < pairs.length) {
    const [code, value] = pairs[i] as Pair;
    if (code === 0 && value === "EOF") break;
    if (!(code === 0 && value === "SECTION")) {
      i += 1;
      continue;
    }
    const name = pairs[i + 1]?.[0] === 2 ? (pairs[i + 1] as Pair)[1] : "";
    let j = i + 2;
    while (j < pairs.length && !((pairs[j] as Pair)[0] === 0 && (pairs[j] as Pair)[1] === "ENDSEC")) j += 1;
    const body = pairs.slice(i + 2, j);
    sections += 1;
    if (name === "HEADER") {
      for (let k = 0; k < body.length; k += 1) {
        const [c, v] = body[k] as Pair;
        if (c !== 9) continue;
        const next = body[k + 1];
        if (!next) continue;
        if (v === "$ACADVER") doc.version = next[1];
        if (v === "$INSUNITS") doc.insUnits = Number(next[1]);
        if (v === "$MEASUREMENT") doc.measurement = Number(next[1]);
      }
    } else if (name === "TABLES") {
      for (const r of records(body)) {
        if (r.type !== "LAYER") continue;
        const layerName = first(r, 2);
        if (!layerName) continue;
        const color = num(r, 62, 7);
        doc.layers.set(layerName, { name: layerName, color, frozen: (num(r, 70) & 1) === 1, off: color < 0 });
      }
    } else if (name === "BLOCKS") {
      const recs = records(body);
      for (let k = 0; k < recs.length; k += 1) {
        const r = recs[k] as RecordData;
        if (r.type !== "BLOCK") continue;
        let end = k + 1;
        while (end < recs.length && (recs[end] as RecordData).type !== "ENDBLK") end += 1;
        const blockName = first(r, 2) ?? "";
        doc.blocks.set(blockName, {
          name: blockName,
          base: { x: num(r, 10), y: num(r, 20) },
          entities: entitiesOf(recs.slice(k + 1, end), doc.skipped),
        });
        k = end;
      }
    } else if (name === "ENTITIES") {
      doc.entities = entitiesOf(records(body), doc.skipped);
    }
    i = j + 1;
  }
  if (sections === 0) throw new DxfError("no SECTION found; this is not a DXF file");
  return doc;
}

// ---- flattening block references ------------------------------------------------------------------------

interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

function apply(m: Affine, p: DxfPoint): DxfPoint {
  return { x: m.a * p.x + m.c * p.y + m.tx, y: m.b * p.x + m.d * p.y + m.ty };
}

function compose(outer: Affine, inner: Affine): Affine {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    tx: outer.a * inner.tx + outer.c * inner.ty + outer.tx,
    ty: outer.b * inner.tx + outer.d * inner.ty + outer.ty,
  };
}

/** translate(at) · rotate(rotation) · scale(sx, sy) · translate(-base) */
function insertMatrix(ins: DxfInsert, base: DxfPoint): Affine {
  const r = (ins.rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const a = cos * ins.scale.x;
  const b = sin * ins.scale.x;
  const c = -sin * ins.scale.y;
  const d = cos * ins.scale.y;
  return { a, b, c, d, tx: ins.at.x - (a * base.x + c * base.y), ty: ins.at.y - (b * base.x + d * base.y) };
}

const det = (m: Affine) => m.a * m.d - m.b * m.c;
const angleOf = (c: DxfPoint, p: DxfPoint) => (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;

function transform(e: DxfEntity, m: Affine, warnings: string[]): DxfEntity {
  if (m === IDENTITY) return e;
  const flip = det(m) < 0;
  const sx = Math.hypot(m.a, m.b);
  const sy = Math.hypot(m.c, m.d);
  const mean = Math.sqrt(Math.abs(det(m)));
  const rot = (Math.atan2(m.b, m.a) * 180) / Math.PI;
  switch (e.type) {
    case "LINE":
      return { ...e, a: apply(m, e.a), b: apply(m, e.b) };
    case "ARC": {
      if (Math.abs(sx - sy) > 1e-6 * Math.max(sx, sy))
        warnings.push(`arc ${e.handle ?? ""} in a non-uniformly scaled block was read as circular`);
      const s = (e.start * Math.PI) / 180;
      const t = (e.end * Math.PI) / 180;
      const centre = apply(m, e.centre);
      const ps = apply(m, { x: e.centre.x + e.radius * Math.cos(s), y: e.centre.y + e.radius * Math.sin(s) });
      const pe = apply(m, { x: e.centre.x + e.radius * Math.cos(t), y: e.centre.y + e.radius * Math.sin(t) });
      const start = angleOf(centre, ps);
      const end = angleOf(centre, pe);
      return { ...e, centre, radius: e.radius * mean, start: flip ? end : start, end: flip ? start : end };
    }
    case "CIRCLE":
      return { ...e, centre: apply(m, e.centre), radius: e.radius * mean };
    case "POLYLINE":
      return {
        ...e,
        vertices: e.vertices.map((v) => ({ ...apply(m, v), bulge: flip ? -v.bulge : v.bulge })),
        width: e.width === null ? null : e.width * mean,
      };
    case "TEXT":
      return { ...e, at: apply(m, e.at), height: e.height * mean, rotation: e.rotation + rot };
    case "DIMENSION":
      return {
        ...e,
        p1: apply(m, e.p1),
        p2: apply(m, e.p2),
        angle: e.angle + rot,
        textAt: e.textAt ? apply(m, e.textAt) : null,
      };
    case "INSERT":
      return e;
  }
}

export interface Placed {
  entity: Exclude<DxfEntity, DxfInsert>;
  /** Index of the top-level INSERT this came from, or null for a model-space entity. */
  insert: number | null;
  /** Name of that top-level block, or null. */
  block: string | null;
}

/**
 * Model space with every INSERT replaced by its block's entities in world coordinates. Entities on layer 0
 * inside a block take the layer of the insert that places them, as CAD programs draw them.
 */
export function flatten(doc: DxfDocument, maxDepth = 8): { placed: Placed[]; warnings: string[] } {
  const placed: Placed[] = [];
  const warnings: string[] = [];
  let inserts = 0;
  const walk = (
    entities: readonly DxfEntity[],
    m: Affine,
    layer0: string | null,
    depth: number,
    top: { index: number; block: string } | null,
    trail: string[],
  ) => {
    for (const e of entities) {
      const layer = e.layer === "0" && layer0 !== null ? layer0 : e.layer;
      if (e.type === "INSERT") {
        const block = doc.blocks.get(e.block);
        if (!block) {
          warnings.push(`block "${e.block}" is referenced but not defined`);
          continue;
        }
        if (depth >= maxDepth || trail.includes(e.block)) {
          warnings.push(`block "${e.block}" nests too deeply or refers to itself; skipped`);
          continue;
        }
        const here = top ?? { index: inserts++, block: e.block };
        walk(block.entities, compose(m, insertMatrix(e, block.base)), layer, depth + 1, here, [
          ...trail,
          e.block,
        ]);
        continue;
      }
      placed.push({
        entity: { ...transform(e, m, warnings), layer } as Placed["entity"],
        insert: top?.index ?? null,
        block: top?.block ?? null,
      });
    }
  };
  walk(doc.entities, IDENTITY, null, 0, null, []);
  return { placed, warnings };
}

/** Millimetres per unit for $INSUNITS, or null when unitless or unusual. */
export function insUnitsToMm(
  code: number | null,
): { units: "mm" | "cm" | "m" | "in" | "ft"; mmPerUnit: number } | null {
  switch (code) {
    case 1:
      return { units: "in", mmPerUnit: 25.4 };
    case 2:
      return { units: "ft", mmPerUnit: 304.8 };
    case 4:
      return { units: "mm", mmPerUnit: 1 };
    case 5:
      return { units: "cm", mmPerUnit: 10 };
    case 6:
      return { units: "m", mmPerUnit: 1000 };
    default:
      return null;
  }
}

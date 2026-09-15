// Raster plans (ADR-011 D2, spec 06 A1, A3): image sizes from file headers, the reader prompt contract, the
// model's reply schema, conversion to a PlanDraft in the normalised box, and the classical clean-up that
// squares up what a vision model draws. Pure: bytes and JSON in, drafts out. The model call lives in agents.
import { z } from "zod";
import type { DraftOpening, DraftQuestion, DraftRoom, DraftText, DraftWall, PlanDraft } from "./draft.js";
import { capacityFromText, parseLengthMm, purposeFromName } from "./dxf-draft.js";

// ---- image headers ---------------------------------------------------------------------------------------

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "bmp";

export interface ImageInfo {
  format: ImageFormat;
  width: number;
  height: number;
  mime: string;
}

const be16 = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const le16 = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const be32 = (b: Uint8Array, i: number) => (be16(b, i) * 65536 + be16(b, i + 2)) >>> 0;
const le32 = (b: Uint8Array, i: number) => (le16(b, i) + le16(b, i + 2) * 65536) >>> 0;
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.slice(i, i + n));

/** Format and pixel size read from the file header, or null when the bytes are not a supported image. */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const b = bytes;
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG")
    return { format: "png", width: be32(b, 16), height: be32(b, 20), mime: "image/png" };
  if (b.length >= 10 && ascii(b, 0, 4) === "GIF8")
    return { format: "gif", width: le16(b, 6), height: le16(b, 8), mime: "image/gif" };
  if (b.length >= 26 && ascii(b, 0, 2) === "BM") {
    const h = le32(b, 22);
    return {
      format: "bmp",
      width: le32(b, 18),
      height: h > 0x7fffffff ? 0x100000000 - h : h,
      mime: "image/bmp",
    };
  }
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8 ")
      return {
        format: "webp",
        width: le16(b, 26) & 0x3fff,
        height: le16(b, 28) & 0x3fff,
        mime: "image/webp",
      };
    if (chunk === "VP8L") {
      const b1 = b[21] ?? 0;
      const b2 = b[22] ?? 0;
      const b3 = b[23] ?? 0;
      const b4 = b[24] ?? 0;
      return {
        format: "webp",
        width: 1 + ((b1 | (b2 << 8)) & 0x3fff),
        height: 1 + (((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)) & 0x3fff),
        mime: "image/webp",
      };
    }
    if (chunk === "VP8X")
      return {
        format: "webp",
        width: 1 + ((b[24] ?? 0) | ((b[25] ?? 0) << 8) | ((b[26] ?? 0) << 16)),
        height: 1 + ((b[27] ?? 0) | ((b[28] ?? 0) << 8) | ((b[29] ?? 0) << 16)),
        mime: "image/webp",
      };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = b[i + 1] ?? 0;
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker === 0xd9) break;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { format: "jpeg", width: be16(b, i + 7), height: be16(b, i + 5), mime: "image/jpeg" };
      i += 2 + be16(b, i + 2);
    }
    return null;
  }
  return null;
}

// ---- the normalised box ------------------------------------------------------------------------------------

export interface ImageBox {
  /** Box units per pixel: the longer side of the image spans 1000 units. */
  unitsPerPixel: number;
  width: number;
  height: number;
}

export function imageBox(width: number, height: number): ImageBox {
  const unitsPerPixel = 1000 / Math.max(1, width, height);
  return { unitsPerPixel, width: width * unitsPerPixel, height: height * unitsPerPixel };
}

// ---- reader contract (spec 06 A3) -------------------------------------------------------------------------

export const READER_PROMPT_VERSION = "reader-v1";

const Num = z.coerce.number().finite();
const Pt = z.tuple([Num, Num]);

/** What the reader model returns: image coordinates in the box, y downward, walls as centreline segments. */
export const RasterReply = z.object({
  walls: z
    .array(
      z.object({
        from: Pt,
        to: Pt,
        thickness: Num.positive().nullable().optional(),
        exterior: z.boolean().nullable().optional(),
      }),
    )
    .default([]),
  openings: z
    .array(
      z.object({
        kind: z.enum(["door", "window", "passage"]),
        at: Pt,
        width: Num.positive().nullable().optional(),
      }),
    )
    .default([]),
  rooms: z
    .array(
      z.object({
        name: z.string().nullable().optional(),
        at: Pt,
        polygon: z.array(Pt).min(3).nullable().optional(),
      }),
    )
    .default([]),
  dimensions: z.array(z.object({ text: z.string(), from: Pt, to: Pt })).default([]),
  scaleBar: z.object({ text: z.string(), from: Pt, to: Pt }).nullable().optional(),
  notes: z.array(z.string()).default([]),
});
export type RasterReply = z.infer<typeof RasterReply>;

export const RASTER_REPLY_JSON_SCHEMA = {
  type: "object",
  properties: {
    walls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          to: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          thickness: { type: ["number", "null"] },
          exterior: { type: ["boolean", "null"] },
        },
        required: ["from", "to"],
      },
    },
    openings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { enum: ["door", "window", "passage"] },
          at: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          width: { type: ["number", "null"] },
        },
        required: ["kind", "at"],
      },
    },
    rooms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: ["string", "null"] },
          at: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          polygon: { type: ["array", "null"], items: { type: "array", items: { type: "number" } } },
        },
        required: ["at"],
      },
    },
    dimensions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          from: { type: "array", items: { type: "number" } },
          to: { type: "array", items: { type: "number" } },
        },
        required: ["text", "from", "to"],
      },
    },
    scaleBar: { type: ["object", "null"] },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["walls", "openings", "rooms", "dimensions"],
} as const;

export const READER_SYSTEM = [
  "You read architectural floor plan images and return what is drawn as one JSON object.",
  "Coordinates: x and y both run from 0 to 1000 across the image, whatever its proportions: x from the left edge (0) to the right edge (1000), y from the top edge (0) down to the bottom edge (1000).",
  "Walls: every wall as a straight segment along its centreline, from one end to the other, split at corners and junctions; thickness in the same 0 to 1000 units; exterior true for outside walls.",
  "Openings: every door, window and open passage at the centre of the gap it makes in a wall, with its width in the same 0 to 1000 units.",
  "Rooms: every room label as written, at the point where it is written; a polygon only when the room is clearly bounded.",
  "Dimensions: every dimension string you can read, with the two points it measures; a scale bar the same way if there is one.",
  "Do not invent anything that is not drawn. Put anything you are unsure about in notes. Reply with the JSON object only.",
  "Example for a single 10 by 6 metre room with a door in the bottom wall:",
  JSON.stringify({
    walls: [
      { from: [100, 100], to: [900, 100], thickness: 12, exterior: true },
      { from: [900, 100], to: [900, 580], thickness: 12, exterior: true },
      { from: [900, 580], to: [100, 580], thickness: 12, exterior: true },
      { from: [100, 580], to: [100, 100], thickness: 12, exterior: true },
    ],
    openings: [{ kind: "door", at: [500, 580], width: 72 }],
    rooms: [{ name: "MEETING ROOM", at: [500, 340], polygon: null }],
    dimensions: [{ text: "10000", from: [100, 640], to: [900, 640] }],
    scaleBar: null,
    notes: [],
  }),
].join("\n");

export function readerSystemPrompt(): string {
  return `${READER_SYSTEM}\nThe reply must match this JSON schema:\n${JSON.stringify(RASTER_REPLY_JSON_SCHEMA)}`;
}

export function readerUserPrompt(info: Pick<ImageInfo, "width" | "height">): string {
  const b = imageBox(info.width, info.height);
  const shape = b.width >= b.height ? "wider than it is tall" : "taller than it is wide";
  return `The plan image is ${info.width} by ${info.height} pixels (${shape}). Give every coordinate as 0 to 1000 on each axis: x across the width from the left edge, y down the height from the top edge. Return the JSON object.`;
}

// ---- reply to draft ---------------------------------------------------------------------------------------

type P = { x: number; y: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dist = (a: P, b: P) => Math.hypot(b.x - a.x, b.y - a.y);

export interface RasterDraftOptions {
  file?: string | null;
  reader?: PlanDraft["reader"];
  kind?: "image" | "pdf-raster" | "sketch";
}

/** The model's reply as a PlanDraft in the box, y up, then cleaned up (spec 06 A2 rule 3, applied on reading). */
export function rasterReplyToDraft(
  reply: RasterReply,
  info: Pick<ImageInfo, "width" | "height">,
  options: RasterDraftOptions = {},
): PlanDraft {
  const box = imageBox(info.width, info.height);
  // the reply is 0 to 1000 on each axis with y downward; the draft is the long-side box with y upward
  const sx = box.width / 1000;
  const sy = box.height / 1000;
  const flip = ([x, y]: readonly [number, number]): P => ({
    x: clamp(x, 0, 1000) * sx,
    y: box.height - clamp(y, 0, 1000) * sy,
  });
  const length = (v: number | null | undefined) =>
    v === null || v === undefined ? null : (v * (sx + sy)) / 2;
  const walls: DraftWall[] = [];
  reply.walls.forEach((w) => {
    const a = flip(w.from);
    const b = flip(w.to);
    if (dist(a, b) === 0) return;
    walls.push({
      idx: walls.length,
      points: [a, b],
      thickness: length(w.thickness),
      kind: w.exterior === true ? "exterior" : null,
      confidence: 0.6,
      sourceRef: null,
    });
  });
  const openings: DraftOpening[] = reply.openings.map((o, idx) => ({
    idx,
    wallIdx: null,
    at: flip(o.at),
    kind: o.kind,
    width: length(o.width),
    height: null,
    hinge: null,
    swing: null,
    confidence: 0.5,
  }));
  const rooms: DraftRoom[] = reply.rooms.map((r, idx) => {
    // a label written over two lines ("BOARDROOM" / "12 PAX") names the room by its first line
    const full = r.name?.trim() ? r.name.trim() : null;
    const name = full ? (full.split("\n")[0] ?? "").trim() || null : null;
    return {
      idx,
      // a model's room outline is too rough to use; committing detects the room from the refined walls instead
      polygon: null,
      labelAt: flip(r.at),
      name,
      purpose: name ? purposeFromName(name) : null,
      capacity: full ? capacityFromText(full) : null,
      confidence: 0.5,
    };
  });
  const texts: DraftText[] = [
    ...rooms
      .filter((r) => r.name && r.labelAt)
      .map((r) => ({ at: r.labelAt as P, text: r.name as string, kind: "room-name" as const })),
    ...reply.dimensions.map((d) => {
      const a = flip(d.from);
      const b = flip(d.to);
      return { at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, text: d.text, kind: "dimension" as const };
    }),
    ...(reply.scaleBar
      ? [{ at: flip(reply.scaleBar.from), text: reply.scaleBar.text, kind: "scale" as const }]
      : []),
  ];

  // scale: dimension strings that agree, else a scale bar, else nothing; a person confirms unless two agree
  const measure = (d: { text: string; from: readonly [number, number]; to: readonly [number, number] }) => {
    const mm = parseLengthMm(d.text);
    const units = dist(flip(d.from), flip(d.to));
    return mm !== null && mm > 0 && units > 0
      ? { text: d.text, measuredUnits: units, impliedMmPerUnit: mm / units }
      : null;
  };
  const checks = reply.dimensions.map(measure).filter((c): c is NonNullable<typeof c> => c !== null);
  let best: number[] = [];
  for (const c of checks) {
    const group = checks
      .map((x) => x.impliedMmPerUnit)
      .filter((v) => Math.abs(v - c.impliedMmPerUnit) / c.impliedMmPerUnit <= 0.02);
    if (group.length > best.length) best = group;
  }
  const bar = reply.scaleBar ? measure(reply.scaleBar) : null;
  const questions: Omit<DraftQuestion, "id">[] = [];
  let units: PlanDraft["units"];
  if (best.length >= 2) {
    const sorted = [...best].sort((x, y) => x - y);
    units = {
      detected: "unknown",
      mmPerUnit: sorted[Math.floor(sorted.length / 2)] as number,
      scaleSource: "dimension-text",
      checks,
    };
    questions.push({
      kind: "scale",
      text: `Dimension strings read from the image suggest ${Math.round((units.mmPerUnit ?? 0) * 100) / 100} mm per unit. Readings from images are a few percent off; confirm the scale, or set it from one known length.`,
      answer: null,
    });
  } else {
    const from = bar ?? checks[0] ?? null;
    units = {
      detected: "unknown",
      mmPerUnit: from ? from.impliedMmPerUnit : null,
      scaleSource: bar ? "scale-bar" : "guess",
      checks: bar ? [...checks, bar] : checks,
    };
    questions.push({
      kind: "scale",
      text: from
        ? `The scale was read from "${from.text}" only and is not confirmed. Check it against a known length, such as a door width, and confirm or correct it.`
        : "No readable dimension or scale bar was found. Give one known length, such as a door width or a wall, to set the scale.",
      answer: null,
    });
  }
  for (const note of reply.notes.slice(0, 5)) questions.push({ kind: "ambiguity", text: note, answer: null });
  if (walls.length === 0)
    questions.push({ kind: "missing", text: "The reader found no walls in the image.", answer: null });

  const draft: PlanDraft = {
    source: {
      kind: options.kind ?? "image",
      file: options.file ?? null,
      page: null,
      pixelSize: { w: info.width, h: info.height },
    },
    units,
    levelName: null,
    walls,
    openings,
    rooms,
    texts,
    confidence: options.kind === "sketch" ? 0.4 : 0.55,
    questions: questions.map((q, i) => ({ ...q, id: `q${i + 1}` })),
    reader: options.reader ?? null,
  };
  return cleanupRasterDraft(draft);
}

// ---- clean-up (spec 06 A2 rule 3) -------------------------------------------------------------------------

interface Seg {
  a: P;
  b: P;
  thickness: number | null;
  kind: DraftWall["kind"];
  confidence: number;
  axis: "h" | "v" | null;
}

const AXIS_SIN = Math.sin((5 * Math.PI) / 180);

function orthogonalise(s: Seg): void {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const l = Math.hypot(dx, dy);
  if (l === 0) return;
  if (Math.abs(dy) / l <= AXIS_SIN) {
    const y = (s.a.y + s.b.y) / 2;
    s.a.y = y;
    s.b.y = y;
    s.axis = "h";
  } else if (Math.abs(dx) / l <= AXIS_SIN) {
    const x = (s.a.x + s.b.x) / 2;
    s.a.x = x;
    s.b.x = x;
    s.axis = "v";
  } else s.axis = null;
}

/** Collinear axis segments on one line merge when they touch within `snap` or an opening sits in the gap. */
function mergeCollinear(segs: Seg[], snap: number, openings: readonly P[]): Seg[] {
  const out: Seg[] = segs.filter((s) => s.axis === null);
  for (const axis of ["h", "v"] as const) {
    const along = (p: P) => (axis === "h" ? p.x : p.y);
    const across = (p: P) => (axis === "h" ? p.y : p.x);
    const items = segs
      .filter((s) => s.axis === axis)
      .map((s) => ({
        s,
        lo: Math.min(along(s.a), along(s.b)),
        hi: Math.max(along(s.a), along(s.b)),
        c: across(s.a),
      }))
      .sort((x, y) => x.c - y.c || x.lo - y.lo);
    const used = new Set<number>();
    for (let i = 0; i < items.length; i += 1) {
      if (used.has(i)) continue;
      const base = items[i] as (typeof items)[number];
      const group = [base];
      used.add(i);
      for (let j = i + 1; j < items.length; j += 1) {
        const o = items[j] as (typeof items)[number];
        if (o.c - base.c > snap / 2) break;
        if (used.has(j)) continue;
        group.push(o);
        used.add(j);
      }
      group.sort((x, y) => x.lo - y.lo);
      let run: (typeof items)[number][] = [];
      let hi = Number.NEGATIVE_INFINITY;
      const flush = () => {
        if (run.length === 0) return;
        const total = run.reduce((acc, r) => acc + (r.hi - r.lo), 0) || 1;
        const c = run.reduce((acc, r) => acc + r.c * (r.hi - r.lo), 0) / total;
        const lo = Math.min(...run.map((r) => r.lo));
        const top = Math.max(...run.map((r) => r.hi));
        const thicknesses = run.map((r) => r.s.thickness).filter((t): t is number => t !== null);
        const first = run[0] as (typeof items)[number];
        out.push({
          a: axis === "h" ? { x: lo, y: c } : { x: c, y: lo },
          b: axis === "h" ? { x: top, y: c } : { x: c, y: top },
          thickness: thicknesses.length ? Math.max(...thicknesses) : null,
          kind: run.some((r) => r.s.kind === "exterior") ? "exterior" : first.s.kind,
          confidence: Math.min(...run.map((r) => r.s.confidence)),
          axis,
        });
        run = [];
        hi = Number.NEGATIVE_INFINITY;
      };
      for (const g of group) {
        const gapFrom = hi;
        const gapTo = g.lo;
        const bridged =
          run.length > 0 &&
          (gapTo <= gapFrom + snap ||
            openings.some(
              (o) =>
                along(o) >= gapFrom - snap &&
                along(o) <= gapTo + snap &&
                Math.abs(across(o) - g.c) <= Math.max(snap, (g.s.thickness ?? 0) / 2 + snap),
            ));
        if (run.length > 0 && !bridged) flush();
        run.push(g);
        hi = Math.max(hi, g.hi);
      }
      flush();
    }
  }
  return out;
}

/** Endpoints within `snap` meet at one point; axis segments keep their line. Free ends reach a wall within `snap`. */
function snapEnds(segs: Seg[], snap: number): void {
  const ends: { s: Seg; key: "a" | "b" }[] = segs.flatMap((s) => [
    { s, key: "a" as const },
    { s, key: "b" as const },
  ]);
  const parent = ends.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    return r;
  };
  for (let i = 0; i < ends.length; i += 1)
    for (let j = i + 1; j < ends.length; j += 1) {
      const p = (ends[i] as (typeof ends)[number]).s[(ends[i] as (typeof ends)[number]).key];
      const q = (ends[j] as (typeof ends)[number]).s[(ends[j] as (typeof ends)[number]).key];
      if (dist(p, q) <= snap) parent[find(i)] = find(j);
    }
  const clusters = new Map<number, number[]>();
  ends.forEach((_, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), i]));
  const clustered = new Set<number>();
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const pts = members.map((i) => ends[i] as (typeof ends)[number]);
    const vx = pts.filter((e) => e.s.axis === "v").map((e) => e.s[e.key].x);
    const hy = pts.filter((e) => e.s.axis === "h").map((e) => e.s[e.key].y);
    const mean = (xs: number[]) => xs.reduce((acc, v) => acc + v, 0) / xs.length;
    const x = vx.length ? mean(vx) : mean(pts.map((e) => e.s[e.key].x));
    const y = hy.length ? mean(hy) : mean(pts.map((e) => e.s[e.key].y));
    for (const i of members) {
      const e = ends[i] as (typeof ends)[number];
      e.s[e.key] = { x, y };
      clustered.add(i);
    }
  }
  // free ends: reach the nearest other segment's line when the foot lies on it (T-junctions, short walls)
  ends.forEach((e, i) => {
    if (clustered.has(i)) return;
    const p = e.s[e.key];
    let best: { foot: P; d: number } | null = null;
    for (const o of segs) {
      if (o === e.s) continue;
      const dx = o.b.x - o.a.x;
      const dy = o.b.y - o.a.y;
      const l2 = dx * dx + dy * dy;
      if (l2 === 0) continue;
      const t = ((p.x - o.a.x) * dx + (p.y - o.a.y) * dy) / l2;
      const l = Math.sqrt(l2);
      if (t < -snap / l || t > 1 + snap / l) continue;
      const foot = { x: o.a.x + clamp(t, 0, 1) * dx, y: o.a.y + clamp(t, 0, 1) * dy };
      const d = dist(p, foot);
      if (d <= snap && (!best || d < best.d)) best = { foot, d };
    }
    if (best) {
      const f = best.foot;
      e.s[e.key] = e.s.axis === "h" ? { x: f.x, y: p.y } : e.s.axis === "v" ? { x: p.x, y: f.y } : f;
    }
  });
}

/**
 * Square up a raster draft in its own units: segments within 5 degrees of an axis become axis-aligned,
 * collinear pieces merge (also across an opening's gap), endpoints within 1 percent of the image diagonal
 * meet, walls shorter than half a percent of it are dropped, and openings attach to their nearest wall.
 */
export function cleanupRasterDraft(draft: PlanDraft): PlanDraft {
  const px = draft.source.pixelSize;
  const box = px ? imageBox(px.w, px.h) : { width: 1000, height: 1000, unitsPerPixel: 1 };
  const diagonal = Math.hypot(box.width, box.height);
  const snap = 0.01 * diagonal;
  let segs: Seg[] = draft.walls.flatMap((w) =>
    w.points.slice(1).map((q, i) => ({
      a: { ...(w.points[i] as P) },
      b: { ...q },
      thickness: w.thickness,
      kind: w.kind,
      confidence: w.confidence,
      axis: null,
    })),
  );
  for (const s of segs) orthogonalise(s);
  segs = mergeCollinear(
    segs,
    snap,
    draft.openings.map((o) => o.at),
  );
  for (let pass = 0; pass < 2; pass += 1) {
    snapEnds(segs, snap);
    for (const s of segs) if (s.axis) orthogonalise(s);
  }
  segs = segs.filter((s) => dist(s.a, s.b) >= 0.005 * diagonal);
  const walls: DraftWall[] = segs.map((s, idx) => ({
    idx,
    points: [s.a, s.b],
    thickness: s.thickness,
    kind: s.kind,
    confidence: s.confidence,
    sourceRef: null,
  }));
  const openings: DraftOpening[] = draft.openings.map((o) => {
    let best: { idx: number; foot: P; d: number } | null = null;
    segs.forEach((s, idx) => {
      const dx = s.b.x - s.a.x;
      const dy = s.b.y - s.a.y;
      const l2 = dx * dx + dy * dy;
      if (l2 === 0) return;
      const t = clamp(((o.at.x - s.a.x) * dx + (o.at.y - s.a.y) * dy) / l2, 0, 1);
      const foot = { x: s.a.x + t * dx, y: s.a.y + t * dy };
      const d = dist(o.at, foot);
      const reach = (s.thickness ?? 0) / 2 + 1.5 * snap;
      if (d <= reach && (!best || d < best.d)) best = { idx, foot, d };
    });
    const hit = best as { idx: number; foot: P; d: number } | null;
    return hit ? { ...o, wallIdx: hit.idx, at: hit.foot } : { ...o, wallIdx: null };
  });
  return { ...draft, walls, openings };
}

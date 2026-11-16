// The layout drawing as a DXF (ADR-013 D5): one level in model space, millimetres, y up, from the same
// shapes the plan and the PDF draw. A layer per kind of thing. What paper paints over, a DXF has to cut:
// a wall's outline is broken at its doors and windows, and its hatching is cut to the wall, because R12
// can neither paint white nor clip.
import { clipToShape, hatchLines, shapeTriangles, withoutGaps } from "@fpv/engine";
import { type derive, type Project, poly } from "@fpv/ir";
import {
  chooseScale,
  type DrawingProvenance,
  levelDrawing,
  mm,
  mountNote,
  mountWords,
  PAPER_MM,
  titleLines,
} from "./drawing.js";
import { type DxfLayer, DxfWriter } from "./dxf.js";

/**
 * The layers, by ADR-013's names, refined where a reader needs it: a reader (ours among them) tells what a
 * layer holds from its name. Openings are split into doors and windows, which "OPENING" alone does not
 * say. TEXT holds the room names and nothing else, so a room is never named after a mount height; an item's
 * tag and height go with the item on ITEM, and switch off with it. A cluster's outline has a layer of its
 * own rather than being taken for a room, and the title and schedule go on TITLE, outside the plan.
 */
export const DXF_LAYERS: readonly DxfLayer[] = [
  { name: "WALL", colour: 7 },
  { name: "OPENING-DOOR", colour: 3 },
  { name: "OPENING-WINDOW", colour: 5 },
  { name: "ROOM", colour: 8 },
  { name: "ITEM", colour: 34 },
  { name: "CLUSTER", colour: 200, lineType: "DASHED" },
  { name: "TEXT", colour: 7 },
  { name: "DIM", colour: 2 },
  { name: "TITLE", colour: 7 },
];

export interface DxfDrawingOptions {
  levelId: string;
  sizes: derive.SizeSource;
  provenance: DrawingProvenance;
  /** The n of 1:n the drawing is meant to print at, which sizes its text; absent, what fits an A3 sheet. */
  scale?: number | null;
}

export interface DxfDrawing {
  bytes: Uint8Array;
  /** The scale its text is sized for. */
  scale: number;
  /** Entities written, by layer. */
  counts: Record<string, number>;
  drawn: {
    rooms: number;
    wallCuts: number;
    openings: number;
    items: number;
    zones: number;
    scheduleRows: number;
  };
}

export function projectToDxf(project: Project, options: DxfDrawingOptions): DxfDrawing {
  const d = levelDrawing(project, options.levelId, options.sizes);
  const frame = d.frame ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  // the scale it would print at on A3 with the PDF's panel, which is what sizes the text
  const { scale } = chooseScale(
    { w: frame.maxX - frame.minX, h: frame.maxY - frame.minY },
    { w: PAPER_MM.A3.h - 2 * 10 - 88 - 8 - 28, h: PAPER_MM.A3.w - 2 * 10 - 8 - 28 },
    options.scale ?? null,
  );
  /** Paper millimetres as model millimetres at that scale. */
  const S = (paperMm: number) => paperMm * scale;
  const dxf = new DxfWriter(DXF_LAYERS);
  const drawn = { rooms: 0, wallCuts: 0, openings: 0, items: 0, zones: 0, scheduleRows: 0 };

  for (const r of d.structure.rooms) {
    for (const ring of r.rings) dxf.polyline("ROOM", ring);
    dxf.text("TEXT", r.name, { x: r.labelAt.x, y: r.labelAt.y + S(1.8) }, S(2.2), "center");
    dxf.text(
      "TEXT",
      `${r.areaM2.toFixed(1)} m²`,
      { x: r.labelAt.x, y: r.labelAt.y - S(1.8) },
      S(1.8),
      "center",
    );
    drawn.rooms += 1;
  }
  // walls, broken where their doors and windows are
  const gaps = d.structure.openings.map((o) => o.gap);
  for (const cut of d.structure.walls) {
    const shape = withoutGaps(cut.shape, gaps);
    for (const part of shape) for (const ring of [part.outer, ...part.holes]) dxf.polyline("WALL", ring);
    if (cut.pattern === "hatch" || cut.pattern === "cross-hatch") {
      if (shape.length) {
        const box = poly.bounds(shape.flatMap((p) => p.outer));
        for (const slope of cut.pattern === "cross-hatch" ? ([1, -1] as const) : ([1] as const))
          for (const [a, b] of hatchLines(box, S(1.0), slope))
            for (const [p, q] of clipToShape(a, b, shape)) dxf.line("WALL", p, q);
      }
    } else if (cut.pattern !== "outline") {
      for (const [a, b, c] of shapeTriangles(shape)) dxf.solid("WALL", a, b, c);
    }
    drawn.wallCuts += 1;
  }
  for (const o of d.structure.openings) {
    if (o.glazing) dxf.line("OPENING-WINDOW", o.glazing.a, o.glazing.b);
    else if (o.swing) {
      const { hinge, radius, start, sweep } = o.swing;
      const at = (a: number) => ({ x: hinge.x + radius * Math.cos(a), y: hinge.y + radius * Math.sin(a) });
      dxf.line("OPENING-DOOR", hinge, at(start));
      dxf.arc("OPENING-DOOR", hinge, radius, start, sweep);
      dxf.line("OPENING-DOOR", at(start + sweep), hinge);
    }
    drawn.openings += 1;
  }
  for (const it of d.items) {
    dxf.polyline("ITEM", it.footprint);
    dxf.line("ITEM", it.front[0], it.front[1]);
    const tag = d.tags.get(it.id);
    const c = it.footprint.reduce((s, p) => ({ x: s.x + p.x / 4, y: s.y + p.y / 4 }), { x: 0, y: 0 });
    if (tag) dxf.text("ITEM", tag, c, Math.min(S(1.6), Math.min(it.size.w, it.size.d) * 0.5), "center");
    const note = mountNote(it);
    if (note) {
      const f = { x: (it.front[0].x + it.front[1].x) / 2, y: (it.front[0].y + it.front[1].y) / 2 };
      const len = Math.hypot(f.x - c.x, f.y - c.y) || 1;
      const at = { x: f.x + ((f.x - c.x) / len) * S(2.2), y: f.y + ((f.y - c.y) / len) * S(2.2) };
      dxf.text("ITEM", note, at, S(1.6), "center");
    }
    drawn.items += 1;
  }
  for (const z of d.zones) {
    dxf.polyline("CLUSTER", z.ring);
    dxf.text("CLUSTER", z.label, { x: z.labelAt.x, y: z.labelAt.y + S(1.2) }, S(1.9));
    drawn.zones += 1;
  }

  // overall dimensions, below and to the left of the walls
  const box = d.structure.walls.length
    ? poly.bounds(d.structure.walls.flatMap((c) => c.shape.flatMap((p) => p.outer)))
    : null;
  if (box) {
    const off = S(7);
    const tick = S(1.2);
    const yb = box.minY - off;
    const xl = box.minX - off;
    dxf.line("DIM", { x: box.minX, y: box.minY - tick }, { x: box.minX, y: yb - tick });
    dxf.line("DIM", { x: box.maxX, y: box.minY - tick }, { x: box.maxX, y: yb - tick });
    dxf.line("DIM", { x: box.minX - tick, y: yb }, { x: box.maxX + tick, y: yb });
    dxf.line("DIM", { x: box.minX - tick, y: box.minY }, { x: xl - tick, y: box.minY });
    dxf.line("DIM", { x: box.minX - tick, y: box.maxY }, { x: xl - tick, y: box.maxY });
    dxf.line("DIM", { x: xl, y: box.minY - tick }, { x: xl, y: box.maxY + tick });
    for (const x of [box.minX, box.maxX])
      dxf.line("DIM", { x: x - tick, y: yb - tick }, { x: x + tick, y: yb + tick });
    for (const y of [box.minY, box.maxY])
      dxf.line("DIM", { x: xl - tick, y: y - tick }, { x: xl + tick, y: y + tick });
    dxf.text(
      "DIM",
      mm(box.maxX - box.minX),
      { x: (box.minX + box.maxX) / 2, y: yb + S(1.8) },
      S(1.9),
      "center",
    );
    dxf.text(
      "DIM",
      mm(box.maxY - box.minY),
      { x: xl - S(1.8), y: (box.minY + box.maxY) / 2 },
      S(1.9),
      "center",
      90,
    );
  }

  // the title and the schedule, written below the plan
  const title = titleLines(options.provenance, d.level, `Drawn for 1:${scale}`);
  let y = frame.minY - S(20);
  dxf.text("TITLE", title.heading, { x: frame.minX, y }, S(3.5));
  for (const line of title.lines) {
    y -= S(4.4);
    dxf.text("TITLE", line, { x: frame.minX, y }, S(2.2));
  }
  y -= S(8);
  dxf.text("TITLE", "Schedule", { x: frame.minX, y }, S(2.8));
  for (const row of d.schedule) {
    y -= S(4.2);
    dxf.text(
      "TITLE",
      `${row.tag}  ${row.title}, ${mm(row.size.w)} x ${mm(row.size.d)}  x${row.count}  ${mountWords(row)}`,
      { x: frame.minX, y },
      S(2.2),
    );
    drawn.scheduleRows += 1;
  }

  const text = dxf.toString();
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0x7f;
  return { bytes, scale, counts: dxf.counts, drawn };
}

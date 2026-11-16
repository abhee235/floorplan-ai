// The layout drawing as a PDF (ADR-013 D5): one landscape sheet per level, the plan at a standard scale on
// the left, and down the right a schedule of what is in it, the north arrow, a scale bar and the title
// block. The plan is the editor's plan, drawn from the same shapes (@fpv/engine planStructure, planItems,
// planZones); what a sheet adds is the tags that lead from each item to its line in the schedule, the
// heights a fitter mounts things at, and the overall dimensions.
import { hatchLines, type ItemShape, PLAN_INK } from "@fpv/engine";
import { derive, type Point, type Project, poly } from "@fpv/ir";
import {
  chooseScale,
  type DrawingProvenance,
  type LevelDrawing,
  levelDrawing,
  mm,
  mountNote,
  mountWords,
  PAPER_MM,
  type PaperSize,
  titleLines,
} from "./drawing.js";
import { PdfPage, PT_PER_MM, textWidth, writePdf } from "./pdf.js";

export interface PdfDrawingOptions {
  /** The levels to draw, one sheet each, in this order. */
  levelIds: readonly string[];
  /** Frame one room instead of the whole level; its level must be the one level given. */
  roomId?: string | null;
  paper?: PaperSize;
  /** The n of 1:n; absent, the largest standard scale that fits. */
  scale?: number | null;
  sizes: derive.SizeSource;
  provenance: DrawingProvenance;
}

export interface PdfSheetReport {
  levelId: string;
  levelName: string;
  scale: number;
  /** Whether the plan fits the sheet at that scale; a scale asked for may not. */
  fits: boolean;
  /** Kinds of item in the schedule, whether or not the sheet had room for every line. */
  kinds: number;
  drawn: {
    rooms: number;
    wallCuts: number;
    openings: number;
    items: number;
    zones: number;
    tags: number;
    mountNotes: number;
    scheduleRows: number;
  };
}

export interface PdfDrawing {
  bytes: Uint8Array;
  paper: PaperSize;
  sheets: PdfSheetReport[];
  warnings: string[];
}

const MARGIN = 10;
/** Room around the plan for its labels and dimensions, in paper millimetres. */
const PLAN_PAD = 14;
const PANEL_MM: Record<PaperSize, number> = { A4: 66, A3: 88, A2: 110, A1: 110, A0: 120 };

/** Paper millimetres to points. */
const pt = (v: number) => v * PT_PER_MM;

const INK = { ...PLAN_INK, frame: "#222222", dim: "#555555", draft: "rgba(214, 60, 60, 0.18)" };

/** The project as a layout drawing, one sheet per level asked for. */
export function projectToPdf(project: Project, options: PdfDrawingOptions): PdfDrawing {
  const paper = options.paper ?? "A3";
  const warnings: string[] = [];
  const pages: PdfPage[] = [];
  const sheets: PdfSheetReport[] = [];
  for (const levelId of options.levelIds) {
    const drawing = levelDrawing(project, levelId, options.sizes, options.roomId ?? null);
    const { page, report } = sheet(project, drawing, paper, options);
    if (!report.fits)
      warnings.push(
        `${drawing.level.name} runs off an ${paper} sheet at 1:${report.scale}; the parts outside the frame are cut off. Leave out the scale, or choose a larger sheet.`,
      );
    if (drawing.schedule.length > report.drawn.scheduleRows)
      warnings.push(
        `${drawing.level.name}: the schedule has ${drawing.schedule.length} kinds of item and the sheet shows ${report.drawn.scheduleRows}; a larger sheet shows more.`,
      );
    pages.push(page);
    sheets.push(report);
  }
  const bytes = writePdf(pages, {
    title: `${options.provenance.projectName} - layout`,
    producer: `floorplan-ai ${options.provenance.appVersion}`,
    createdAt: options.provenance.exportedAt,
  });
  return { bytes, paper, sheets, warnings };
}

function sheet(
  project: Project,
  d: LevelDrawing,
  paper: PaperSize,
  options: PdfDrawingOptions,
): { page: PdfPage; report: PdfSheetReport } {
  // landscape
  const W = PAPER_MM[paper].h;
  const H = PAPER_MM[paper].w;
  const page = new PdfPage(pt(W), pt(H));
  const panelW = PANEL_MM[paper];
  const panelX = W - MARGIN - panelW;
  const area = { x0: MARGIN + 4, y0: MARGIN + 4, x1: panelX - 4, y1: H - MARGIN - 4 };
  const frame = d.frame ?? { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
  const { scale, fits } = chooseScale(
    { w: frame.maxX - frame.minX, h: frame.maxY - frame.minY },
    { w: area.x1 - area.x0 - 2 * PLAN_PAD, h: area.y1 - area.y0 - 2 * PLAN_PAD },
    options.scale ?? null,
  );
  const cx = (frame.minX + frame.maxX) / 2;
  const cy = (frame.minY + frame.maxY) / 2;
  const ax = (area.x0 + area.x1) / 2;
  const ay = (area.y0 + area.y1) / 2;
  /** A plan point on the page, in points. */
  const P = (p: Point): Point => ({ x: pt(ax + (p.x - cx) / scale), y: pt(ay + (p.y - cy) / scale) });
  /** A plan length on the page, in points. */
  const L = (v: number) => pt(v / scale);

  // the sheet's frame
  page
    .round()
    .stroke(INK.frame)
    .lineWidth(0.8)
    .rect(pt(MARGIN), pt(MARGIN), pt(W - 2 * MARGIN), pt(H - 2 * MARGIN));
  page.strokePath();
  page
    .lineWidth(0.5)
    .moveTo(pt(panelX), pt(MARGIN))
    .lineTo(pt(panelX), pt(H - MARGIN))
    .strokePath();

  const drawn = {
    rooms: 0,
    wallCuts: 0,
    openings: 0,
    items: 0,
    zones: 0,
    tags: 0,
    mountNotes: 0,
    scheduleRows: 0,
  };
  page
    .save()
    .rect(pt(area.x0), pt(area.y0), pt(area.x1 - area.x0), pt(area.y1 - area.y0))
    .clip();

  // Colours and widths are set before each path begins: PDF allows no state change inside a path.
  // rooms under walls
  page.fill(INK.room).stroke(INK.roomEdge).lineWidth(0.25);
  for (const r of d.structure.rooms) {
    for (const ring of r.rings) page.ring(ring.map(P));
    page.fillAndStroke(true);
    drawn.rooms += 1;
  }
  // walls, in their patterns: hatching a millimetre apart on paper, as it is five pixels apart on screen
  for (const cut of d.structure.walls) {
    const ink = cut.glass ? INK.wallGlass : INK.wall;
    const outline = () => {
      for (const part of cut.shape) for (const ring of [part.outer, ...part.holes]) page.ring(ring.map(P));
    };
    drawn.wallCuts += 1;
    if (cut.pattern !== "hatch" && cut.pattern !== "cross-hatch" && cut.pattern !== "outline") {
      page.fill(ink);
      outline();
      page.fillPath(true);
      continue;
    }
    page.fill(INK.paper);
    outline();
    page.fillPath(true);
    if (cut.pattern !== "outline") {
      const box = poly.bounds(cut.shape.flatMap((p) => p.outer));
      page.save();
      outline();
      page.clip(true);
      page.stroke(ink).lineWidth(0.2);
      for (const slope of cut.pattern === "cross-hatch" ? ([1, -1] as const) : ([1] as const))
        for (const [a, b] of hatchLines(box, 1.0 * scale, slope)) {
          const [pa, pb] = [P(a), P(b)];
          page.moveTo(pa.x, pa.y).lineTo(pb.x, pb.y);
        }
      page.strokePath().restore();
    }
    page.stroke(ink).lineWidth(0.5);
    outline();
    page.strokePath();
  }
  if (d.structure.skirting.length) {
    page.fill(INK.skirting).stroke(INK.skirting).lineWidth(0.15);
    for (const ring of d.structure.skirting) page.ring(ring.map(P));
    page.fillAndStroke();
  }
  // openings: the gap, then the glass or the door's swing
  for (const o of d.structure.openings) {
    page.fill(INK.opening).ring(o.gap.map(P)).fillPath();
    if (o.glazing) {
      const [a, b] = [P(o.glazing.a), P(o.glazing.b)];
      page.stroke(INK.wallGlass).lineWidth(Math.max(L(o.glazing.widthMm), 0.6));
      page.moveTo(a.x, a.y).lineTo(b.x, b.y).strokePath();
    } else if (o.swing) {
      const h = P(o.swing.hinge);
      const r = L(o.swing.radius);
      page.stroke(INK.swing).lineWidth(0.25).moveTo(h.x, h.y);
      page.lineTo(h.x + r * Math.cos(o.swing.start), h.y + r * Math.sin(o.swing.start));
      page.arc(h.x, h.y, r, o.swing.start, o.swing.sweep).close().strokePath();
    }
    drawn.openings += 1;
  }
  // items, with the front edge marked
  for (const it of d.items) {
    page.fill(INK.item).stroke(INK.itemEdge).lineWidth(0.25).ring(it.footprint.map(P)).fillAndStroke();
    const [a, b] = [P(it.front[0]), P(it.front[1])];
    page.lineWidth(0.7).moveTo(a.x, a.y).lineTo(b.x, b.y).strokePath();
    drawn.items += 1;
  }
  // zones: a dashed ring and the name above its top-left corner
  for (const z of d.zones) {
    page
      .stroke(INK.zone)
      .lineWidth(0.4)
      .dash([pt(2), pt(1.2)])
      .ring(z.ring.map(P))
      .strokePath()
      .dash([]);
    const at = P(z.labelAt);
    page.fill(INK.zone).text(z.label, at.x, at.y + pt(1.2), { size: 5.5 });
    drawn.zones += 1;
  }
  // tags and mount heights
  for (const it of d.items) {
    const tag = d.tags.get(it.id);
    if (tag && tagFits(it, tag, scale)) {
      const c = P(centre(it.footprint));
      page.fill(INK.text).text(tag, c.x, c.y - 1.6, { size: 4.5, font: "bold", align: "center" });
      drawn.tags += 1;
    }
    const note = mountNote(it);
    if (note) {
      const at = P(notePoint(it, 2.2 * scale));
      page.fill(INK.text).text(note, at.x, at.y - 1.6, { size: 4.5, align: "center" });
      drawn.mountNotes += 1;
    }
  }
  // room names and areas, last, so nothing covers them; a name wider than its room is set smaller, down to
  // the 4 points that still read on paper, rather than run across its neighbours
  for (const r of d.structure.rooms) {
    const at = P(r.labelAt);
    const b = poly.bounds(r.rings[0] ?? []);
    const room = L(b.maxX - b.minX) * 0.92;
    const size = Math.max(4, Math.min(6.5, (6.5 * room) / textWidth(r.name, 6.5, "bold")));
    page.fill(INK.text).text(r.name, at.x, at.y + 1, { size, font: "bold", align: "center" });
    page.text(`${r.areaM2.toFixed(1)} m²`, at.x, at.y - size, { size: Math.min(5.5, size), align: "center" });
  }
  dimensions(page, d, options.roomId ? frame : null, P, scale);
  page.restore();

  // the panel: schedule from the top, then the north arrow and scale bar, then the title block
  const titleH = paper === "A4" ? 40 : 46;
  const keyH = 26;
  const scheduleTop = H - MARGIN - 6;
  const scheduleBottom = MARGIN + titleH + keyH + 4;
  drawn.scheduleRows = schedule(page, d, panelX + 3, panelW - 6, scheduleTop, scheduleBottom);
  const keyY = MARGIN + titleH + 4;
  page
    .stroke(INK.frame)
    .lineWidth(0.35)
    .moveTo(pt(panelX), pt(keyY + keyH))
    .lineTo(pt(W - MARGIN), pt(keyY + keyH));
  page.strokePath();
  northArrow(page, panelX + 14, keyY + keyH / 2, project.meta.north);
  scaleBar(page, panelX + 28, keyY + keyH / 2 - 3, scale, panelW - 34);
  const title = titleLines(options.provenance, d.level, `Scale 1:${scale} at ${paper}`);
  page
    .stroke(INK.frame)
    .lineWidth(0.5)
    .moveTo(pt(panelX), pt(MARGIN + titleH))
    .lineTo(pt(W - MARGIN), pt(MARGIN + titleH));
  page.strokePath();
  let y = MARGIN + titleH - 8;
  page
    .fill(INK.frame)
    .text(fit(title.heading, panelW - 8, 10, "bold"), pt(panelX + 4), pt(y), { size: 10, font: "bold" });
  for (const line of title.lines) {
    y -= 4.4;
    page
      .fill(line.startsWith("DRAFT") ? "#c03030" : INK.frame)
      .text(fit(line, panelW - 8, 7), pt(panelX + 4), pt(y), {
        size: 7,
        font: line.startsWith("DRAFT") ? "bold" : "regular",
      });
  }
  if (options.provenance.draft)
    page.fill(INK.draft).text("DRAFT", pt(ax), pt(ay) - 30, {
      size: paper === "A4" ? 90 : 140,
      font: "bold",
      align: "center",
      angleDeg: 25,
    });

  return {
    page,
    report: { levelId: d.level.id, levelName: d.level.name, scale, fits, kinds: d.schedule.length, drawn },
  };
}

function centre(ring: readonly Point[]): Point {
  return ring.reduce((s, p) => ({ x: s.x + p.x / ring.length, y: s.y + p.y / ring.length }), { x: 0, y: 0 });
}

/** A tag is printed inside its item when it fits there; a chair at 1:200 is two millimetres across. */
function tagFits(it: ItemShape, tag: string, scale: number): boolean {
  const inner = Math.min(it.size.w, it.size.d) / scale; // paper mm
  const wide = textWidth(tag, 4.5, "bold") / PT_PER_MM;
  return inner >= 2.2 && wide <= inner * 0.9;
}

/** Where an item's mount height is written: in front of it, into the room, `gap` plan millimetres out. */
function notePoint(it: ItemShape, gap: number): Point {
  const c = centre(it.footprint);
  const f = { x: (it.front[0].x + it.front[1].x) / 2, y: (it.front[0].y + it.front[1].y) / 2 };
  const dx = f.x - c.x;
  const dy = f.y - c.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: f.x + (dx / len) * gap, y: f.y + (dy / len) * gap };
}

/** Text cut to a width in paper millimetres, with an ellipsis when it had to be. */
function fit(text: string, widthMm: number, size: number, font: "regular" | "bold" = "regular"): string {
  if (textWidth(text, size, font) / PT_PER_MM <= widthMm) return text;
  let s = text;
  while (s.length > 1 && textWidth(`${s}…`, size, font) / PT_PER_MM > widthMm) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

/** The schedule, top down; returns how many rows it had room for. */
function schedule(page: PdfPage, d: LevelDrawing, x: number, w: number, top: number, bottom: number): number {
  const rowH = 4.2;
  const cols = { tag: x, item: x + 7, qty: x + w - 28, mount: x + w - 26 };
  page.fill(INK.frame).text("Schedule", pt(x), pt(top - 3), { size: 8, font: "bold" });
  let y = top - 9;
  page.text("Tag", pt(cols.tag), pt(y), { size: 6, font: "bold" });
  page.text("Item", pt(cols.item), pt(y), { size: 6, font: "bold" });
  page.text("Qty", pt(cols.qty), pt(y), { size: 6, font: "bold", align: "right" });
  page.text("Mount", pt(cols.mount), pt(y), { size: 6, font: "bold" });
  page
    .stroke(INK.frame)
    .lineWidth(0.3)
    .moveTo(pt(x), pt(y - 1.4))
    .lineTo(pt(x + w), pt(y - 1.4))
    .strokePath();
  const room = Math.max(0, Math.floor((y - 1.4 - bottom) / rowH));
  if (d.schedule.length === 0) {
    page.fill(INK.dim).text("Nothing is furnished on this level.", pt(x), pt(y - rowH - 0.5), { size: 6 });
    return 0;
  }
  const shown = d.schedule.length > room ? Math.max(0, room - 1) : d.schedule.length;
  for (const row of d.schedule.slice(0, shown)) {
    y -= rowH;
    const size = `${mm(row.size.w)} x ${mm(row.size.d)}`;
    page.fill(INK.frame).text(row.tag, pt(cols.tag), pt(y), { size: 6.5, font: "bold" });
    page.text(fit(`${row.title}, ${size}`, cols.qty - cols.item - 8, 6.5), pt(cols.item), pt(y), {
      size: 6.5,
    });
    page.text(String(row.count), pt(cols.qty), pt(y), { size: 6.5, align: "right" });
    page.text(fit(mountWords(row), x + w - cols.mount, 6), pt(cols.mount), pt(y), { size: 6 });
  }
  if (shown < d.schedule.length) {
    y -= rowH;
    page
      .fill(INK.dim)
      .text(`and ${d.schedule.length - shown} more kinds of item`, pt(cols.item), pt(y), { size: 6 });
  }
  return shown;
}

/** A north arrow in a circle, pointing where the project says north is (meta.north, from +x, counter-clockwise). */
function northArrow(page: PdfPage, x: number, y: number, northDeg: number): void {
  const r = 6;
  const a = (northDeg * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  const at = (u: number, v: number) => ({ x: pt(x + u * c - v * s), y: pt(y + u * s + v * c) });
  page
    .stroke(INK.frame)
    .lineWidth(0.35)
    .moveTo(pt(x + r), pt(y))
    .arc(pt(x), pt(y), pt(r), 0, 2 * Math.PI)
    .close();
  page.strokePath();
  const tip = at(r * 0.85, 0);
  const left = at(-r * 0.6, r * 0.42);
  const right = at(-r * 0.6, -r * 0.42);
  const notch = at(-r * 0.25, 0);
  page
    .fill(INK.frame)
    .moveTo(tip.x, tip.y)
    .lineTo(left.x, left.y)
    .lineTo(notch.x, notch.y)
    .close()
    .fillPath();
  page.moveTo(tip.x, tip.y).lineTo(right.x, right.y).lineTo(notch.x, notch.y).close().strokePath();
  const n = at(r + 3.2, 0);
  page.fill(INK.frame).text("N", n.x, n.y - 2.6, { size: 7.5, font: "bold", align: "center" });
}

/** A scale bar of four equal parts, as long as a round number of metres that fits in `room` millimetres. */
function scaleBar(page: PdfPage, x: number, y: number, scale: number, room: number): void {
  const lengths = [1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000];
  const total = [...lengths].reverse().find((m) => m / scale <= room - 8) ?? (lengths[0] as number);
  const w = total / scale;
  const h = 1.6;
  page.stroke(INK.frame).lineWidth(0.3);
  for (let i = 0; i < 4; i += 1)
    page
      .fill(i % 2 === 0 ? INK.frame : "#ffffff")
      .rect(pt(x + (i * w) / 4), pt(y), pt(w / 4), pt(h))
      .fillAndStroke();
  const metres = (v: number) => (v >= 1000 ? `${v / 1000} m` : `${v} mm`);
  page.fill(INK.frame).text("0", pt(x), pt(y - 3.2), { size: 6, align: "center" });
  page.text(metres(total), pt(x + w), pt(y - 3.2), { size: 6, align: "center" });
  page.text(`1:${scale}`, pt(x), pt(y + h + 2.2), { size: 6.5, font: "bold" });
}

/**
 * Overall dimensions of the building, or of the room a sheet is framed on: a line under it and one to its
 * left, each with its length in millimetres, ticked at the ends.
 */
function dimensions(
  page: PdfPage,
  d: LevelDrawing,
  roomFrame: poly.Rect | null,
  P: (p: Point) => Point,
  scale: number,
): void {
  const box =
    roomFrame ??
    (d.structure.walls.length
      ? poly.bounds(d.structure.walls.flatMap((c) => c.shape.flatMap((p) => p.outer)))
      : null);
  if (!box) return;
  const off = 7 * scale; // seven paper millimetres out
  const tick = 1.2 * scale;
  page.stroke(INK.dim).lineWidth(0.25).fill(INK.dim);
  const seg = (a: Point, b: Point) => {
    const [pa, pb] = [P(a), P(b)];
    page.moveTo(pa.x, pa.y).lineTo(pb.x, pb.y);
  };
  // width, below
  const yb = box.minY - off;
  seg({ x: box.minX, y: box.minY - tick }, { x: box.minX, y: yb - tick });
  seg({ x: box.maxX, y: box.minY - tick }, { x: box.maxX, y: yb - tick });
  seg({ x: box.minX - tick, y: yb }, { x: box.maxX + tick, y: yb });
  for (const x of [box.minX, box.maxX]) seg({ x: x - tick, y: yb - tick }, { x: x + tick, y: yb + tick });
  // depth, to the left
  const xl = box.minX - off;
  seg({ x: box.minX - tick, y: box.minY }, { x: xl - tick, y: box.minY });
  seg({ x: box.minX - tick, y: box.maxY }, { x: xl - tick, y: box.maxY });
  seg({ x: xl, y: box.minY - tick }, { x: xl, y: box.maxY + tick });
  for (const y of [box.minY, box.maxY]) seg({ x: xl - tick, y: y - tick }, { x: xl + tick, y: y + tick });
  page.strokePath();
  const below = P({ x: (box.minX + box.maxX) / 2, y: yb });
  page.text(mm(box.maxX - box.minX), below.x, below.y + 1.2, { size: 5.5, align: "center" });
  const left = P({ x: xl, y: (box.minY + box.maxY) / 2 });
  page.text(mm(box.maxY - box.minY), left.x - 1.2, left.y, { size: 5.5, align: "center", angleDeg: 90 });
}

// Builds tools/fixtures/plans: three DXF floor plans drawn the way CAD exports them, each with the expected
// draft it should produce (ADR-011 D6, spec 06 A4). Each plan is described once in millimetres as wall
// centrelines, openings and rooms; wall faces come from the union of the wall outlines with the openings cut
// out, so corners and T-junctions look like a real drawing. The expected file is written from the same model.
//
//   office-mm        millimetres in the header, AIA-style layers, door blocks (some mirrored), window lines,
//                    room outlines with MTEXT names, a frozen demolition layer, furniture and grid noise
//   lshape-metres    metres with no units in the header, French layer names, loose door arcs, a passage,
//                    window rectangles, text labels without outlines, scale from dimension text
//   rotated-inches   inches, the whole plan turned 30 degrees, faces as closed polylines, door and window
//                    blocks, feet-and-inches dimension text
//   office-mm.pdf    the office drawn as a vector PDF sheet at 1:100 (spec 06 A6): heavy wall faces, light
//                    door arcs as Bezier curves, window lines, dimension lines with labels, two-line room
//                    names, furniture, a dashed grid line, a sheet border and a scale note
//
// Usage: corepack pnpm exec tsx tools/build-plan-fixtures.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { difference, type MultiPoly, ringToMulti, union } from "@fpv/geometry";
import type { Point } from "@fpv/ir";

const OUT = fileURLToPath(new URL("./fixtures/plans/", import.meta.url));

type P = { x: number; y: number };

interface WallSpec {
  a: P;
  b: P;
  t: number;
}
interface OpeningSpec {
  wall: number;
  /** Centre distance from the wall start along the centreline. */
  offset: number;
  width: number;
  kind: "door" | "window" | "passage";
  /** Door hinge jamb and swing side (+1 to the left of the wall direction). */
  hinge?: "start" | "end";
  side?: 1 | -1;
}
interface RoomSpec {
  name: string;
  /** Extra label lines, such as a capacity. */
  note?: string;
  /** Inner outline in millimetres; drawn only when the plan draws room outlines. */
  outline: P[];
}

interface Plan {
  name: string;
  /** Millimetres per drawing unit. */
  mmPerUnit: number;
  insUnits: number | null;
  rotationDeg: number;
  layers: {
    wall: string;
    door: string;
    window: string;
    room: string | null;
    text: string;
    dims: string;
    extra: { name: string; frozen?: boolean; color?: number }[];
  };
  walls: WallSpec[];
  openings: OpeningSpec[];
  rooms: RoomSpec[];
  style: {
    faces: "lines" | "polylines";
    doors: "blocks" | "arcs";
    windows: "lines" | "rectangles" | "blocks";
    names: "mtext" | "text";
  };
  dims: { a: P; b: P; angle: number; text: string; at: P }[];
  noise: (d: Dxf, tx: (p: P) => P) => void;
}

// ---- a small deterministic DXF writer -------------------------------------------------------------------

const fmt = (n: number) => {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? "0" : String(r);
};

class Dxf {
  private body: string[] = [];
  private blocks: string[] = [];
  private handle = 0x100;
  private readonly layers = new Map<string, { color: number; frozen: boolean }>();

  constructor(private readonly insUnits: number | null) {}

  layer(name: string, color = 7, frozen = false) {
    if (!this.layers.has(name)) this.layers.set(name, { color, frozen });
  }

  private pairs(target: string[], pairs: [number, string | number][]) {
    for (const [c, v] of pairs) target.push(String(c), typeof v === "number" ? fmt(v) : v);
  }

  private entity(target: string[], type: string, layer: string, rest: [number, string | number][]) {
    if (layer !== "0") this.layer(layer);
    this.pairs(target, [[0, type], [5, (this.handle++).toString(16).toUpperCase()], [8, layer], ...rest]);
  }

  line(layer: string, a: P, b: P, into = this.body) {
    this.entity(into, "LINE", layer, [
      [10, a.x],
      [20, a.y],
      [30, 0],
      [11, b.x],
      [21, b.y],
      [31, 0],
    ]);
  }

  arc(layer: string, c: P, r: number, start: number, end: number, into = this.body) {
    this.entity(into, "ARC", layer, [
      [10, c.x],
      [20, c.y],
      [30, 0],
      [40, r],
      [50, start],
      [51, end],
    ]);
  }

  lwpolyline(layer: string, pts: readonly P[], closed: boolean, into = this.body) {
    this.entity(into, "LWPOLYLINE", layer, [
      [90, pts.length],
      [70, closed ? 1 : 0],
      ...pts.flatMap((p): [number, number][] => [
        [10, p.x],
        [20, p.y],
      ]),
    ]);
  }

  text(layer: string, at: P, height: number, value: string) {
    this.entity(this.body, "TEXT", layer, [
      [10, at.x],
      [20, at.y],
      [30, 0],
      [40, height],
      [1, value],
      [72, 1],
      [11, at.x],
      [21, at.y],
      [31, 0],
    ]);
  }

  mtext(layer: string, at: P, height: number, lines: string[]) {
    this.entity(this.body, "MTEXT", layer, [
      [10, at.x],
      [20, at.y],
      [30, 0],
      [40, height],
      [71, 5],
      [1, `{\\fArial|b0|i0;${lines.join("\\P")}}`],
    ]);
  }

  insert(layer: string, block: string, at: P, sx: number, sy: number, rotation: number) {
    this.entity(this.body, "INSERT", layer, [
      [2, block],
      [10, at.x],
      [20, at.y],
      [30, 0],
      [41, sx],
      [42, sy],
      [43, 1],
      [50, rotation],
    ]);
  }

  dimension(layer: string, a: P, b: P, angle: number, text: string, at: P) {
    this.entity(this.body, "DIMENSION", layer, [
      [2, "*D"],
      [10, at.x],
      [20, at.y],
      [11, at.x],
      [21, at.y],
      [70, 32],
      [1, text],
      [13, a.x],
      [23, a.y],
      [14, b.x],
      [24, b.y],
      [50, angle],
    ]);
  }

  block(name: string, draw: (into: string[]) => void) {
    this.pairs(this.blocks, [
      [0, "BLOCK"],
      [8, "0"],
      [2, name],
      [70, 0],
      [10, 0],
      [20, 0],
      [30, 0],
      [3, name],
    ]);
    draw(this.blocks);
    this.pairs(this.blocks, [
      [0, "ENDBLK"],
      [8, "0"],
    ]);
  }

  toString(): string {
    const out: string[] = [];
    const push = (pairs: [number, string | number][]) => this.pairs(out, pairs);
    push([
      [0, "SECTION"],
      [2, "HEADER"],
      [9, "$ACADVER"],
      [1, "AC1015"],
    ]);
    if (this.insUnits !== null)
      push([
        [9, "$INSUNITS"],
        [70, this.insUnits],
      ]);
    push([
      [0, "ENDSEC"],
      [0, "SECTION"],
      [2, "TABLES"],
      [0, "TABLE"],
      [2, "LAYER"],
      [70, this.layers.size + 1],
      [0, "LAYER"],
      [2, "0"],
      [70, 0],
      [62, 7],
      [6, "CONTINUOUS"],
    ]);
    for (const [name, l] of [...this.layers].sort((x, y) => x[0].localeCompare(y[0])))
      push([
        [0, "LAYER"],
        [2, name],
        [70, l.frozen ? 1 : 0],
        [62, l.color],
        [6, "CONTINUOUS"],
      ]);
    push([
      [0, "ENDTAB"],
      [0, "ENDSEC"],
      [0, "SECTION"],
      [2, "BLOCKS"],
    ]);
    out.push(...this.blocks);
    push([
      [0, "ENDSEC"],
      [0, "SECTION"],
      [2, "ENTITIES"],
    ]);
    out.push(...this.body);
    push([
      [0, "ENDSEC"],
      [0, "EOF"],
    ]);
    return `${out.join("\r\n")}\r\n`;
  }
}

// ---- plan geometry --------------------------------------------------------------------------------------------

const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: P, b: P): P => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: P, k: number): P => ({ x: a.x * k, y: a.y * k });
const len = (a: P) => Math.hypot(a.x, a.y);
const unit = (a: P) => mul(a, 1 / len(a));
const left = (u: P): P => ({ x: -u.y, y: u.x });
const deg = (v: P) => (Math.atan2(v.y, v.x) * 180) / Math.PI;

function frame(w: WallSpec) {
  const u = unit(sub(w.b, w.a));
  return { u, n: left(u), length: len(sub(w.b, w.a)) };
}

function rect(centre: P, u: P, halfAlong: number, halfAcross: number): Point[] {
  const n = left(u);
  return [
    add(add(centre, mul(u, -halfAlong)), mul(n, -halfAcross)),
    add(add(centre, mul(u, halfAlong)), mul(n, -halfAcross)),
    add(add(centre, mul(u, halfAlong)), mul(n, halfAcross)),
    add(add(centre, mul(u, -halfAlong)), mul(n, halfAcross)),
  ];
}

/** Wall face rings: the union of wall outlines (ends extended by half a thickness) minus the openings. */
function faceRings(plan: Plan): P[][] {
  const outlines = plan.walls.map((w) => {
    const f = frame(w);
    return ringToMulti(rect(mul(add(w.a, w.b), 0.5), f.u, f.length / 2 + w.t / 2, w.t / 2));
  });
  const cuts: MultiPoly[] = plan.openings.map((o) => {
    const w = plan.walls[o.wall] as WallSpec;
    const f = frame(w);
    return ringToMulti(rect(add(w.a, mul(f.u, o.offset)), f.u, o.width / 2, w.t / 2 + 5));
  });
  const solid = difference(union(...outlines), ...cuts);
  return solid
    .flatMap((p) => [p.outer, ...p.holes])
    .map((ring) => {
      const r = [...ring];
      const first = r[0] as P;
      const last = r[r.length - 1] as P;
      if (r.length > 1 && first.x === last.x && first.y === last.y) r.pop();
      return r;
    });
}

function build(plan: Plan) {
  const r = (plan.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const rotMm = (p: P): P => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos });
  const tx = (p: P): P => mul(rotMm(p), 1 / plan.mmPerUnit);
  const k = 1 / plan.mmPerUnit;
  const d = new Dxf(plan.insUnits);
  const L = plan.layers;
  d.layer(L.wall, 7);
  d.layer(L.door, 3);
  d.layer(L.window, 4);
  d.layer(L.text, 2);
  d.layer(L.dims, 1);
  if (L.room) d.layer(L.room, 6);
  for (const e of L.extra) d.layer(e.name, e.color ?? 8, e.frozen ?? false);

  // wall faces
  for (const ring of faceRings(plan)) {
    const pts = ring.map(tx);
    if (plan.style.faces === "polylines") d.lwpolyline(L.wall, pts, true);
    else pts.forEach((p, i) => d.line(L.wall, p, pts[(i + 1) % pts.length] as P));
  }

  // door and window symbols
  if (plan.style.doors === "blocks")
    d.block("DOOR", (into) => {
      d.line("0", { x: 0, y: 0 }, { x: 0, y: 1 }, into);
      d.arc("0", { x: 0, y: 0 }, 1, 0, 90, into);
    });
  if (plan.style.windows === "blocks")
    d.block("WIN", (into) => {
      d.line("0", { x: 0, y: -0.25 }, { x: 1, y: -0.25 }, into);
      d.line("0", { x: 0, y: 0.25 }, { x: 1, y: 0.25 }, into);
      d.line("0", { x: 0, y: -0.5 }, { x: 0, y: 0.5 }, into);
      d.line("0", { x: 1, y: -0.5 }, { x: 1, y: 0.5 }, into);
    });
  for (const o of plan.openings) {
    const w = plan.walls[o.wall] as WallSpec;
    const f = frame(w);
    const centre = add(w.a, mul(f.u, o.offset));
    if (o.kind === "door") {
      const hingeSign = o.hinge === "end" ? 1 : -1;
      const side = o.side ?? 1;
      const hinge = add(add(centre, mul(f.u, (hingeSign * o.width) / 2)), mul(f.n, (side * w.t) / 2));
      const latchDir = mul(f.u, -hingeSign);
      const leafDir = mul(f.n, side);
      if (plan.style.doors === "blocks") {
        const ccw = len(sub(left(latchDir), leafDir)) < 1e-9;
        const rotation = deg(ccw ? latchDir : mul(latchDir, -1)) + plan.rotationDeg;
        const size = o.width * k;
        d.insert(L.door, "DOOR", tx(hinge), ccw ? size : -size, size, rotation);
      } else {
        const tip = add(hinge, mul(leafDir, o.width));
        d.line(L.door, tx(hinge), tx(tip));
        const aLatch = deg(rotMm(latchDir));
        const aLeaf = deg(rotMm(leafDir));
        const ccw = len(sub(left(latchDir), leafDir)) < 1e-9;
        d.arc(L.door, tx(hinge), o.width * k, ccw ? aLatch : aLeaf, ccw ? aLeaf : aLatch);
      }
    } else if (o.kind === "window") {
      const start = add(centre, mul(f.u, -o.width / 2));
      if (plan.style.windows === "blocks")
        d.insert(L.window, "WIN", tx(start), o.width * k, w.t * k, deg(f.u) + plan.rotationDeg);
      else if (plan.style.windows === "rectangles")
        d.lwpolyline(L.window, rect(centre, f.u, o.width / 2, w.t / 4).map(tx), true);
      else
        for (const s of [-1, 0, 1]) {
          const off = mul(f.n, (s * w.t) / 4);
          d.line(L.window, tx(add(start, off)), tx(add(add(start, mul(f.u, o.width)), off)));
        }
    }
  }

  // rooms and names
  for (const room of plan.rooms) {
    const c = mul(
      room.outline.reduce((acc, p) => add(acc, p), { x: 0, y: 0 }),
      1 / room.outline.length,
    );
    if (L.room) d.lwpolyline(L.room, room.outline.map(tx), true);
    const lines = room.note ? [room.name, room.note] : [room.name];
    if (plan.style.names === "mtext") d.mtext(L.text, tx(c), 250 * k, lines);
    else d.text(L.text, tx(c), 250 * k, lines.join(" "));
  }
  for (const dim of plan.dims)
    d.dimension(L.dims, tx(dim.a), tx(dim.b), dim.angle + plan.rotationDeg, dim.text, tx(dim.at));
  plan.noise(d, tx);

  const area = (poly: readonly P[]) =>
    Math.abs(
      poly.reduce(
        (s, p, i) =>
          s + p.x * (poly[(i + 1) % poly.length] as P).y - (poly[(i + 1) % poly.length] as P).x * p.y,
        0,
      ),
    ) /
    2 /
    1e6;
  const rnd = (p: P): P => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });
  const expected = {
    name: plan.name,
    mmPerUnit: plan.mmPerUnit,
    walls: plan.walls.map((w) => ({ points: [rnd(rotMm(w.a)), rnd(rotMm(w.b))], thickness: w.t })),
    openings: plan.openings.map((o) => {
      const w = plan.walls[o.wall] as WallSpec;
      return { at: rnd(rotMm(add(w.a, mul(frame(w).u, o.offset)))), kind: o.kind, width: o.width };
    }),
    rooms: plan.rooms.map((room) => ({
      name: room.name,
      areaM2: L.room ? Math.round(area(room.outline) * 100) / 100 : null,
    })),
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}${plan.name}.dxf`, d.toString());
  writeFileSync(`${OUT}${plan.name}.expected.json`, `${JSON.stringify(expected, null, 2)}\n`);
  console.log(
    `${plan.name}: ${plan.walls.length} walls, ${plan.openings.length} openings, ${plan.rooms.length} rooms`,
  );
}

// ---- a small deterministic vector PDF writer --------------------------------------------------------------

const pf = (n: number) => {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};

class Pdf {
  private readonly ops: string[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  style(lineWidth: number, rgb: [number, number, number] = [0, 0, 0], dash: number[] = []) {
    this.ops.push(`${pf(lineWidth)} w ${rgb.map(pf).join(" ")} RG [${dash.map(pf).join(" ")}] 0 d`);
  }

  polyline(pts: readonly P[], closed: boolean) {
    const path = pts.map((p, i) => `${pf(p.x)} ${pf(p.y)} ${i === 0 ? "m" : "l"}`).join(" ");
    this.ops.push(`${path}${closed ? " h S" : " S"}`);
  }

  /** A circular arc as cubic Bezier curves of at most 90 degrees; degrees counter-clockwise, sweep signed. */
  arc(c: P, r: number, fromDeg: number, sweepDeg: number) {
    const n = Math.max(1, Math.ceil(Math.abs(sweepDeg) / 90 - 1e-9));
    const step = (sweepDeg * Math.PI) / 180 / n;
    const k = (4 / 3) * Math.tan(step / 4) * r;
    const at = (t: number): P => ({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
    let a = (fromDeg * Math.PI) / 180;
    const start = at(a);
    const parts = [`${pf(start.x)} ${pf(start.y)} m`];
    for (let i = 0; i < n; i += 1) {
      const b = a + step;
      const p0 = at(a);
      const p3 = at(b);
      const c1 = { x: p0.x - k * Math.sin(a), y: p0.y + k * Math.cos(a) };
      const c2 = { x: p3.x + k * Math.sin(b), y: p3.y - k * Math.cos(b) };
      parts.push(`${pf(c1.x)} ${pf(c1.y)} ${pf(c2.x)} ${pf(c2.y)} ${pf(p3.x)} ${pf(p3.y)} c`);
      a = b;
    }
    this.ops.push(`${parts.join(" ")} S`);
  }

  text(at: P, size: number, value: string, rotationDeg = 0) {
    const r = (rotationDeg * Math.PI) / 180;
    const escaped = value.replace(/[\\()]/g, (ch) => `\\${ch}`);
    const m = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), at.x, at.y].map(pf).join(" ");
    this.ops.push(`BT /F1 ${pf(size)} Tf ${m} Tm (${escaped}) Tj ET`);
  }

  toString(): string {
    const content = this.ops.join("\n");
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pf(this.width)} ${pf(this.height)}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    objs.forEach((o, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
    return `${out}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  }
}

/**
 * The plan drawn on an A3 landscape sheet at 1:`scale` the way a CAD program prints it: wall faces heavy,
 * everything else light. Writes `<name>.pdf` and `<name>.pdf.expected.json`, whose coordinates are sheet
 * millimetres at full size (the draft's own frame) and whose rooms have no outlines.
 */
function buildPdf(plan: Plan, scale: number, noise: (pdf: Pdf, tx: (p: P) => P) => void) {
  if (plan.rotationDeg !== 0) throw new Error("buildPdf draws unrotated plans");
  const k = 72 / 25.4 / scale; // sheet points per plan millimetre
  const origin: P = { x: 300, y: 250 };
  const tx = (p: P): P => add(origin, mul(p, k));
  const pdf = new Pdf(1190.55, 841.89);
  pdf.style(0.7);
  for (const ring of faceRings(plan)) pdf.polyline(ring.map(tx), true);
  pdf.style(0.25);
  for (const o of plan.openings) {
    const w = plan.walls[o.wall] as WallSpec;
    const f = frame(w);
    const centre = add(w.a, mul(f.u, o.offset));
    if (o.kind === "door") {
      const hingeSign = o.hinge === "end" ? 1 : -1;
      const side = o.side ?? 1;
      const hinge = add(add(centre, mul(f.u, (hingeSign * o.width) / 2)), mul(f.n, (side * w.t) / 2));
      const latchDir = mul(f.u, -hingeSign);
      const leafDir = mul(f.n, side);
      pdf.polyline([tx(hinge), tx(add(hinge, mul(leafDir, o.width)))], false);
      const ccw = len(sub(left(latchDir), leafDir)) < 1e-9;
      pdf.arc(tx(hinge), o.width * k, deg(latchDir), ccw ? 90 : -90);
    } else if (o.kind === "window") {
      const start = add(centre, mul(f.u, -o.width / 2));
      for (const s of [-1, 0, 1]) {
        const off = mul(f.n, (s * w.t) / 4);
        pdf.polyline([tx(add(start, off)), tx(add(add(start, mul(f.u, o.width)), off))], false);
      }
    }
  }
  const nameSize = 250 * k;
  for (const room of plan.rooms) {
    const c = mul(
      room.outline.reduce((acc, p) => add(acc, p), { x: 0, y: 0 }),
      1 / room.outline.length,
    );
    const lines = room.note ? [room.name, room.note] : [room.name];
    lines.forEach((value, i) => {
      const at = tx(c);
      pdf.text(
        { x: at.x - (0.62 * nameSize * value.length) / 2, y: at.y - i * 1.4 * nameSize },
        nameSize,
        value,
      );
    });
  }
  const dimSize = 200 * k;
  for (const dim of plan.dims) {
    const horizontal = dim.angle === 0;
    const a = horizontal ? { x: dim.a.x, y: dim.at.y } : { x: dim.at.x, y: dim.a.y };
    const b = horizontal ? { x: dim.b.x, y: dim.at.y } : { x: dim.at.x, y: dim.b.y };
    pdf.polyline([tx(a), tx(b)], false);
    pdf.polyline([tx(dim.a), tx(a)], false);
    pdf.polyline([tx(dim.b), tx(b)], false);
    const shown = dim.text === "<>" ? String(Math.round(len(sub(b, a)))) : dim.text;
    const mid = tx(mul(add(a, b), 0.5));
    const half = (0.56 * dimSize * shown.length) / 2;
    const lift = 0.4 * dimSize;
    if (horizontal) pdf.text({ x: mid.x - half, y: mid.y + lift }, dimSize, shown);
    else pdf.text({ x: mid.x - lift, y: mid.y - half }, dimSize, shown, 90);
  }
  noise(pdf, tx);

  const mmPerUnit = 1 / k;
  const offset = mul(origin, mmPerUnit);
  const rnd = (p: P): P => ({
    x: Math.round((p.x + offset.x) * 10) / 10,
    y: Math.round((p.y + offset.y) * 10) / 10,
  });
  const expected = {
    name: `${plan.name}-pdf`,
    mmPerUnit,
    walls: plan.walls.map((w) => ({ points: [rnd(w.a), rnd(w.b)], thickness: w.t })),
    openings: plan.openings.map((o) => {
      const w = plan.walls[o.wall] as WallSpec;
      return { at: rnd(add(w.a, mul(frame(w).u, o.offset))), kind: o.kind, width: o.width };
    }),
    rooms: plan.rooms.map((room) => ({ name: room.name, areaM2: null })),
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}${plan.name}.pdf`, pdf.toString());
  writeFileSync(`${OUT}${plan.name}.pdf.expected.json`, `${JSON.stringify(expected, null, 2)}\n`);
  console.log(`${plan.name}.pdf: sheet at 1:${scale}`);
}

const box = (x0: number, y0: number, x1: number, y1: number): P[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

// ---- 1. office in millimetres ------------------------------------------------------------------------------

const officeMm: Plan = {
  name: "office-mm",
  mmPerUnit: 1,
  insUnits: 4,
  rotationDeg: 0,
  layers: {
    wall: "A-WALL",
    door: "A-DOOR",
    window: "A-GLAZ",
    room: "A-AREA",
    text: "A-AREA-IDEN",
    dims: "A-ANNO-DIMS",
    extra: [{ name: "A-WALL-DEMO", frozen: true, color: 1 }, { name: "A-FURN" }, { name: "S-GRID" }],
  },
  walls: [
    { a: { x: 0, y: 0 }, b: { x: 12000, y: 0 }, t: 250 },
    { a: { x: 12000, y: 0 }, b: { x: 12000, y: 8000 }, t: 250 },
    { a: { x: 12000, y: 8000 }, b: { x: 0, y: 8000 }, t: 250 },
    { a: { x: 0, y: 8000 }, b: { x: 0, y: 0 }, t: 250 },
    { a: { x: 5000, y: 0 }, b: { x: 5000, y: 8000 }, t: 100 },
    { a: { x: 5000, y: 4500 }, b: { x: 12000, y: 4500 }, t: 100 },
  ],
  openings: [
    { wall: 0, offset: 8500, width: 1000, kind: "door", hinge: "start", side: 1 },
    { wall: 4, offset: 2000, width: 900, kind: "door", hinge: "end", side: -1 },
    { wall: 4, offset: 6000, width: 900, kind: "door", hinge: "start", side: 1 },
    { wall: 5, offset: 5500, width: 1200, kind: "passage" },
    { wall: 0, offset: 2500, width: 1800, kind: "window" },
    { wall: 1, offset: 2200, width: 1500, kind: "window" },
    { wall: 2, offset: 3000, width: 1800, kind: "window" },
    { wall: 3, offset: 4000, width: 2400, kind: "window" },
  ],
  rooms: [
    { name: "BOARDROOM", note: "12 PAX", outline: box(125, 125, 4950, 7875) },
    { name: "OPEN OFFICE", outline: box(5050, 125, 11875, 4450) },
    { name: "MEETING ROOM", note: "6 PAX", outline: box(5050, 4550, 11875, 7875) },
  ],
  style: { faces: "lines", doors: "blocks", windows: "lines", names: "mtext" },
  dims: [
    { a: { x: -125, y: 0 }, b: { x: 12125, y: 0 }, angle: 0, text: "12250", at: { x: 6000, y: -1500 } },
    { a: { x: 0, y: -125 }, b: { x: 0, y: 8125 }, angle: 90, text: "8250", at: { x: -1500, y: 4000 } },
    { a: { x: 5000, y: 0 }, b: { x: 12000, y: 0 }, angle: 0, text: "<>", at: { x: 8500, y: -900 } },
  ],
  noise: (d, tx) => {
    // a demolished wall on a frozen layer, a table and chairs, and a grid line: none of it is a wall
    d.line("A-WALL-DEMO", tx({ x: 2500, y: 125 }), tx({ x: 2500, y: 7875 }));
    d.line("A-WALL-DEMO", tx({ x: 2650, y: 125 }), tx({ x: 2650, y: 7875 }));
    d.lwpolyline("A-FURN", box(1500, 2500, 3500, 5500).map(tx), true);
    d.lwpolyline("A-FURN", box(1600, 2600, 3400, 5400).map(tx), true);
    d.line("S-GRID", tx({ x: -3000, y: 0 }), tx({ x: 15000, y: 0 }));
  },
};
build(officeMm);
buildPdf(officeMm, 100, (pdf, tx) => {
  pdf.style(0.25, [0.4, 0.4, 0.4]);
  pdf.polyline(box(1500, 2500, 3500, 5500).map(tx), true);
  pdf.polyline(box(1600, 2600, 3400, 5400).map(tx), true);
  pdf.style(0.25, [0.5, 0.5, 0.5], [6, 3]);
  pdf.polyline([tx({ x: -3000, y: 0 }), tx({ x: 15000, y: 0 })], false);
  pdf.style(0.5);
  pdf.polyline(box(20, 20, pdf.width - 20, pdf.height - 20), true);
  pdf.text({ x: pdf.width - 220, y: 40 }, 10, "SCALE 1:100");
});

// ---- 2. L-shaped floor in metres, no header units --------------------------------------------------------

build({
  name: "lshape-metres",
  mmPerUnit: 1000,
  insUnits: null,
  rotationDeg: 0,
  layers: {
    wall: "MURS",
    door: "PORTES",
    window: "FENETRES",
    room: null,
    text: "TEXTE",
    dims: "COTES",
    extra: [],
  },
  walls: [
    { a: { x: 0, y: 0 }, b: { x: 14000, y: 0 }, t: 300 },
    { a: { x: 14000, y: 0 }, b: { x: 14000, y: 6000 }, t: 300 },
    { a: { x: 14000, y: 6000 }, b: { x: 6000, y: 6000 }, t: 300 },
    { a: { x: 6000, y: 6000 }, b: { x: 6000, y: 11000 }, t: 300 },
    { a: { x: 6000, y: 11000 }, b: { x: 0, y: 11000 }, t: 300 },
    { a: { x: 0, y: 11000 }, b: { x: 0, y: 0 }, t: 300 },
    { a: { x: 6000, y: 0 }, b: { x: 6000, y: 6000 }, t: 120 },
    { a: { x: 0, y: 6000 }, b: { x: 6000, y: 6000 }, t: 120 },
  ],
  openings: [
    { wall: 4, offset: 3000, width: 1000, kind: "door", hinge: "end", side: -1 },
    { wall: 6, offset: 3000, width: 900, kind: "door", hinge: "start", side: -1 },
    { wall: 7, offset: 4000, width: 1500, kind: "passage" },
    { wall: 0, offset: 3000, width: 2000, kind: "window" },
    { wall: 0, offset: 10000, width: 2400, kind: "window" },
    { wall: 1, offset: 3000, width: 1800, kind: "window" },
    { wall: 3, offset: 2500, width: 1600, kind: "window" },
  ],
  rooms: [
    { name: "Meeting Room", outline: box(150, 150, 5940, 5940) },
    { name: "Open Office", outline: box(6060, 150, 13850, 5850) },
    { name: "Reception", outline: box(150, 6060, 5850, 10850) },
  ],
  style: { faces: "lines", doors: "arcs", windows: "rectangles", names: "text" },
  dims: [
    { a: { x: -150, y: 0 }, b: { x: 14150, y: 0 }, angle: 0, text: "14.30", at: { x: 7000, y: -1500 } },
    { a: { x: 0, y: -150 }, b: { x: 0, y: 11150 }, angle: 90, text: "11.30", at: { x: -1500, y: 5500 } },
    {
      a: { x: 14000, y: -150 },
      b: { x: 14000, y: 6150 },
      angle: 90,
      text: "6.30",
      at: { x: 15500, y: 3000 },
    },
  ],
  noise: () => {},
});

// ---- 3. rotated plan in inches ------------------------------------------------------------------------------

const IN = 25.4;
build({
  name: "rotated-inches",
  mmPerUnit: IN,
  insUnits: 1,
  rotationDeg: 30,
  layers: {
    wall: "WALLS",
    door: "DOORS",
    window: "WINDOWS",
    room: null,
    text: "ROOM-NAMES",
    dims: "DIMENSIONS",
    extra: [],
  },
  walls: [
    { a: { x: 0, y: 0 }, b: { x: 480 * IN, y: 0 }, t: 8 * IN },
    { a: { x: 480 * IN, y: 0 }, b: { x: 480 * IN, y: 336 * IN }, t: 8 * IN },
    { a: { x: 480 * IN, y: 336 * IN }, b: { x: 0, y: 336 * IN }, t: 8 * IN },
    { a: { x: 0, y: 336 * IN }, b: { x: 0, y: 0 }, t: 8 * IN },
    { a: { x: 192 * IN, y: 0 }, b: { x: 192 * IN, y: 336 * IN }, t: 4.5 * IN },
    { a: { x: 192 * IN, y: 168 * IN }, b: { x: 480 * IN, y: 168 * IN }, t: 4.5 * IN },
    { a: { x: 336 * IN, y: 0 }, b: { x: 336 * IN, y: 168 * IN }, t: 4.5 * IN },
  ],
  openings: [
    { wall: 0, offset: 408 * IN, width: 36 * IN, kind: "door", hinge: "end", side: 1 },
    { wall: 4, offset: 84 * IN, width: 36 * IN, kind: "door", hinge: "start", side: -1 },
    { wall: 6, offset: 84 * IN, width: 36 * IN, kind: "door", hinge: "end", side: 1 },
    { wall: 5, offset: 216 * IN, width: 36 * IN, kind: "door", hinge: "start", side: -1 },
    { wall: 2, offset: 120 * IN, width: 72 * IN, kind: "window" },
    { wall: 3, offset: 168 * IN, width: 96 * IN, kind: "window" },
    { wall: 0, offset: 96 * IN, width: 60 * IN, kind: "window" },
  ],
  rooms: [
    { name: "Training Room", note: "(20)", outline: box(4 * IN, 4 * IN, 189.75 * IN, 332 * IN) },
    { name: "Huddle 1", outline: box(194.25 * IN, 4 * IN, 333.75 * IN, 165.75 * IN) },
    { name: "Huddle 2", outline: box(338.25 * IN, 4 * IN, 476 * IN, 165.75 * IN) },
    { name: "Pantry", outline: box(194.25 * IN, 170.25 * IN, 476 * IN, 332 * IN) },
  ],
  style: { faces: "polylines", doors: "blocks", windows: "blocks", names: "mtext" },
  dims: [
    {
      a: { x: 0, y: 0 },
      b: { x: 480 * IN, y: 0 },
      angle: 0,
      text: `40'-0"`,
      at: { x: 240 * IN, y: -60 * IN },
    },
    {
      a: { x: 0, y: 0 },
      b: { x: 0, y: 336 * IN },
      angle: 90,
      text: `28'-0"`,
      at: { x: -60 * IN, y: 168 * IN },
    },
    {
      a: { x: 192 * IN, y: 0 },
      b: { x: 336 * IN, y: 0 },
      angle: 0,
      text: `12'-0"`,
      at: { x: 264 * IN, y: -30 * IN },
    },
  ],
  noise: () => {},
});

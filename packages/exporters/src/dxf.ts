// A DXF written by hand (ADR-013 D5): AutoCAD R12, the version every CAD program and viewer still opens,
// in millimetres, y up. Only what R12 has: lines, arcs, closed polylines, solid triangles for a filled
// wall, and single-line text. A layer per kind of thing, so a fitter can switch off the furniture.

/** A layer the drawing uses: its name, an AutoCAD colour index, and a line type. */
export interface DxfLayer {
  name: string;
  colour: number;
  lineType?: "CONTINUOUS" | "DASHED";
}

export type DxfAlign = "left" | "center" | "right";

interface Pt {
  x: number;
  y: number;
}

/** A number as a DXF value: at most three decimals, no trailing zeros, never "-0". */
function n(v: number): string {
  const s = (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

/**
 * Text as an R12 file holds it: ASCII as it is, anything else as the \U+XXXX escape AutoCAD reads, and no
 * line breaks, which would end the value.
 */
export function dxfText(text: string): string {
  let out = "";
  for (const ch of text.replace(/[\r\n]+/g, " ")) {
    const code = ch.codePointAt(0) as number;
    out += code >= 0x20 && code <= 0x7e ? ch : `\\U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

/** Degrees in [0, 360). */
function deg(radians: number): number {
  const d = ((((radians * 180) / Math.PI) % 360) + 360) % 360;
  return d >= 359.9995 ? 0 : d;
}

export class DxfWriter {
  private readonly entities: string[] = [];
  private readonly extent = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  /** Entities written, by layer. */
  readonly counts: Record<string, number> = {};

  constructor(private readonly layers: readonly DxfLayer[]) {}

  private push(layer: string, pairs: (string | number)[], points: readonly Pt[]): void {
    if (!this.layers.some((l) => l.name === layer)) throw new Error(`no layer ${layer}`);
    const lines: string[] = [];
    for (let i = 0; i < pairs.length; i += 2) lines.push(String(pairs[i]), String(pairs[i + 1]));
    this.entities.push(lines.join("\n"));
    this.counts[layer] = (this.counts[layer] ?? 0) + 1;
    for (const p of points) {
      this.extent.minX = Math.min(this.extent.minX, p.x);
      this.extent.minY = Math.min(this.extent.minY, p.y);
      this.extent.maxX = Math.max(this.extent.maxX, p.x);
      this.extent.maxY = Math.max(this.extent.maxY, p.y);
    }
  }

  line(layer: string, a: Pt, b: Pt): void {
    this.push(
      layer,
      [0, "LINE", 8, layer, 10, n(a.x), 20, n(a.y), 30, 0, 11, n(b.x), 21, n(b.y), 31, 0],
      [a, b],
    );
  }

  /** An arc from `start` sweeping `sweep` radians; DXF's arcs run counter-clockwise, so a negative sweep is turned round. */
  arc(layer: string, centre: Pt, radius: number, start: number, sweep: number): void {
    const [from, to] = sweep >= 0 ? [start, start + sweep] : [start + sweep, start];
    this.push(
      layer,
      [
        0,
        "ARC",
        8,
        layer,
        10,
        n(centre.x),
        20,
        n(centre.y),
        30,
        0,
        40,
        n(radius),
        50,
        n(deg(from)),
        51,
        n(deg(to)),
      ],
      [
        { x: centre.x - radius, y: centre.y - radius },
        { x: centre.x + radius, y: centre.y + radius },
      ],
    );
  }

  /** A polyline, closed by default. */
  polyline(layer: string, points: readonly Pt[], closed = true): void {
    if (points.length < 2) return;
    const pairs: (string | number)[] = [
      0,
      "POLYLINE",
      8,
      layer,
      66,
      1,
      10,
      0,
      20,
      0,
      30,
      0,
      70,
      closed ? 1 : 0,
    ];
    for (const p of points) pairs.push(0, "VERTEX", 8, layer, 10, n(p.x), 20, n(p.y), 30, 0);
    pairs.push(0, "SEQEND", 8, layer);
    this.push(layer, pairs, points);
  }

  /** A filled triangle. */
  solid(layer: string, a: Pt, b: Pt, c: Pt): void {
    // R12's SOLID takes four corners in zigzag order; a triangle repeats its last.
    this.push(
      layer,
      [
        0,
        "SOLID",
        8,
        layer,
        10,
        n(a.x),
        20,
        n(a.y),
        30,
        0,
        11,
        n(b.x),
        21,
        n(b.y),
        31,
        0,
        12,
        n(c.x),
        22,
        n(c.y),
        32,
        0,
        13,
        n(c.x),
        23,
        n(c.y),
        33,
        0,
      ],
      [a, b, c],
    );
  }

  /** One line of text, its height in model millimetres, aligned at `at` and centred on it vertically when not left. */
  text(layer: string, content: string, at: Pt, height: number, align: DxfAlign = "left", angleDeg = 0): void {
    const pairs: (string | number)[] = [0, "TEXT", 8, layer, 10, n(at.x), 20, n(at.y), 30, 0, 40, n(height)];
    pairs.push(1, dxfText(content));
    if (angleDeg) pairs.push(50, n(angleDeg));
    if (align !== "left") {
      // horizontal 1 centre, 2 right; vertical 2 middle; then the alignment point
      pairs.push(72, align === "center" ? 1 : 2, 11, n(at.x), 21, n(at.y), 31, 0, 73, 2);
    }
    this.push(layer, pairs, [at]);
  }

  /** The whole file. */
  toString(): string {
    const e = Number.isFinite(this.extent.minX) ? this.extent : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const out: (string | number)[] = [
      0,
      "SECTION",
      2,
      "HEADER",
      9,
      "$ACADVER",
      1,
      "AC1009",
      9,
      "$INSUNITS",
      70,
      4,
      9,
      "$MEASUREMENT",
      70,
      1,
      9,
      "$EXTMIN",
      10,
      n(e.minX),
      20,
      n(e.minY),
      30,
      0,
      9,
      "$EXTMAX",
      10,
      n(e.maxX),
      20,
      n(e.maxY),
      30,
      0,
      0,
      "ENDSEC",
      0,
      "SECTION",
      2,
      "TABLES",
      0,
      "TABLE",
      2,
      "LTYPE",
      70,
      2,
      0,
      "LTYPE",
      2,
      "CONTINUOUS",
      70,
      0,
      3,
      "Solid line",
      72,
      65,
      73,
      0,
      40,
      0,
      0,
      "LTYPE",
      2,
      "DASHED",
      70,
      0,
      3,
      "Dashed __ __ __",
      72,
      65,
      73,
      2,
      40,
      300,
      49,
      200,
      49,
      -100,
      0,
      "ENDTAB",
      0,
      "TABLE",
      2,
      "LAYER",
      70,
      this.layers.length,
    ];
    for (const l of this.layers)
      out.push(0, "LAYER", 2, l.name, 70, 0, 62, l.colour, 6, l.lineType ?? "CONTINUOUS");
    out.push(
      0,
      "ENDTAB",
      0,
      "TABLE",
      2,
      "STYLE",
      70,
      1,
      0,
      "STYLE",
      2,
      "STANDARD",
      70,
      0,
      40,
      0,
      41,
      1,
      50,
      0,
      71,
      0,
      42,
      2.5,
      3,
      "txt",
      4,
      "",
      0,
      "ENDTAB",
      0,
      "ENDSEC",
      0,
      "SECTION",
      2,
      "ENTITIES",
    );
    const lines: string[] = [];
    for (let i = 0; i < out.length; i += 2) lines.push(String(out[i]), String(out[i + 1]));
    lines.push(...this.entities.flatMap((e) => e.split("\n")));
    lines.push("0", "ENDSEC", "0", "EOF");
    return `${lines.join("\n")}\n`;
  }
}

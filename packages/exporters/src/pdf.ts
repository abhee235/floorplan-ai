// A PDF written by hand (ADR-013 D5): pages of vector paths and text in the standard Helvetica every reader
// carries, so nothing is embedded and nothing is licensed. Content streams are left uncompressed, which
// keeps the file small enough for a plan and lets a test read what a page draws. The same pages and the
// same document information give the same bytes.

/** Points per millimetre. */
export const PT_PER_MM = 72 / 25.4;

export type PdfFont = "regular" | "bold";
export type TextAlign = "left" | "center" | "right";

/** A colour as the plan writes it: #rrggbb, or rgba(r, g, b, a). */
interface Paint {
  rgb: [number, number, number];
  alpha: number;
}

function parseColour(css: string): Paint {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css.trim());
  if (hex)
    return {
      rgb: [1, 2, 3].map((i) => Number.parseInt(hex[i] as string, 16) / 255) as Paint["rgb"],
      alpha: 1,
    };
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
    css.trim(),
  );
  if (rgba)
    return {
      rgb: [1, 2, 3].map((i) => Number(rgba[i]) / 255) as Paint["rgb"],
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  throw new Error(`not a colour: ${css}`);
}

/** A number as PDF writes it: at most three decimals, no trailing zeros, never "-0". */
export function num(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`not a finite number: ${v}`);
  const s = (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

// ---- text ----------------------------------------------------------------------------------------------

/** WinAnsiEncoding codes for the characters outside Latin-1 that a plan is likely to hold. */
const WIN_ANSI_EXTRA: Record<string, number> = {
  "€": 0x80,
  "…": 0x85,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
};

/** A string as WinAnsi bytes, one character each; anything the standard fonts cannot show becomes "?". */
export function winAnsi(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    const extra = WIN_ANSI_EXTRA[ch];
    if (extra !== undefined) out += String.fromCharCode(extra);
    else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) out += ch;
    else out += "?";
  }
  return out;
}

/** A WinAnsi string as a PDF literal string, with every byte outside printable ASCII written in octal. */
function literal(ansi: string): string {
  let out = "(";
  for (let i = 0; i < ansi.length; i += 1) {
    const c = ansi.charCodeAt(i);
    const ch = ansi[i] as string;
    if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`;
    else if (c < 0x20 || c > 0x7e) out += `\\${c.toString(8).padStart(3, "0")}`;
    else out += ch;
  }
  return `${out})`;
}

// Glyph widths of the standard Helvetica faces in thousandths of an em, from the fonts' published metrics,
// for the printable ASCII range; enough to centre a label and to tell whether it fits.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278,
  500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469,
  556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
  278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278,
  556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584,
  556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556,
  333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
/** The few WinAnsi characters above ASCII a plan uses, by code; anything else is taken as a typical letter. */
const UPPER: Record<number, [number, number]> = {
  0x96: [556, 556],
  0x97: [1000, 1000],
  0x95: [350, 350],
  0xb0: [400, 400],
  0xb2: [333, 333],
  0xb7: [278, 278],
  0xd7: [584, 584],
};

/** How wide a string sets, in points. */
export function textWidth(text: string, sizePt: number, font: PdfFont = "regular"): number {
  const table = font === "bold" ? HELVETICA_BOLD : HELVETICA;
  const ansi = winAnsi(text);
  let units = 0;
  for (let i = 0; i < ansi.length; i += 1) {
    const c = ansi.charCodeAt(i);
    units +=
      c >= 0x20 && c <= 0x7e ? (table[c - 0x20] as number) : (UPPER[c]?.[font === "bold" ? 1 : 0] ?? 556);
  }
  return (units / 1000) * sizePt;
}

// ---- pages ---------------------------------------------------------------------------------------------

/**
 * One page, drawn in points from its bottom-left corner, y up. The methods are PDF's own operators with
 * readable names; a page is a list of them and nothing else.
 */
export class PdfPage {
  private readonly ops: string[] = [];
  /** Fill opacities used on the page, each a graphics state the resources must name. */
  readonly alphas = new Set<number>();

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  private op(s: string): this {
    this.ops.push(s);
    return this;
  }

  save(): this {
    return this.op("q");
  }
  restore(): this {
    return this.op("Q");
  }

  /** Stroke colour; an rgba alpha is ignored, strokes are opaque. */
  stroke(css: string): this {
    const { rgb } = parseColour(css);
    return this.op(`${rgb.map(num).join(" ")} RG`);
  }

  /** Fill colour, and its opacity through a named graphics state when it is not opaque. */
  fill(css: string): this {
    const { rgb, alpha } = parseColour(css);
    this.op(`${rgb.map(num).join(" ")} rg`);
    const a = Math.round(alpha * 100) / 100;
    this.alphas.add(a);
    return this.op(`/${alphaName(a)} gs`);
  }

  lineWidth(pt: number): this {
    return this.op(`${num(pt)} w`);
  }
  dash(pattern: readonly number[]): this {
    return this.op(`[${pattern.map(num).join(" ")}] 0 d`);
  }
  /** Round caps and joins, which keep fine lines meeting cleanly. */
  round(): this {
    return this.op("1 J 1 j");
  }

  moveTo(x: number, y: number): this {
    return this.op(`${num(x)} ${num(y)} m`);
  }
  lineTo(x: number, y: number): this {
    return this.op(`${num(x)} ${num(y)} l`);
  }
  curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): this {
    return this.op(`${[x1, y1, x2, y2, x, y].map(num).join(" ")} c`);
  }
  close(): this {
    return this.op("h");
  }
  rect(x: number, y: number, w: number, h: number): this {
    return this.op(`${[x, y, w, h].map(num).join(" ")} re`);
  }
  /** A closed ring as a subpath. */
  ring(points: readonly { x: number; y: number }[]): this {
    points.forEach((p, i) => (i === 0 ? this.moveTo(p.x, p.y) : this.lineTo(p.x, p.y)));
    return this.close();
  }
  /**
   * An arc as Bézier curves, continuing the current path: centre, radius, start angle and signed sweep in
   * radians. Each piece is at most a quarter turn, where the cubic is within 0.03 % of the circle.
   */
  arc(cx: number, cy: number, r: number, start: number, sweep: number): this {
    const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
    const step = sweep / pieces;
    const k = (4 / 3) * Math.tan(step / 4);
    for (let i = 0; i < pieces; i += 1) {
      const a0 = start + i * step;
      const a1 = a0 + step;
      const [c0, s0, c1, s1] = [Math.cos(a0), Math.sin(a0), Math.cos(a1), Math.sin(a1)];
      this.curveTo(
        cx + r * (c0 - k * s0),
        cy + r * (s0 + k * c0),
        cx + r * (c1 + k * s1),
        cy + r * (s1 - k * c1),
        cx + r * c1,
        cy + r * s1,
      );
    }
    return this;
  }

  fillPath(evenOdd = false): this {
    return this.op(evenOdd ? "f*" : "f");
  }
  strokePath(): this {
    return this.op("S");
  }
  fillAndStroke(evenOdd = false): this {
    return this.op(evenOdd ? "B*" : "B");
  }
  /** Clip to the current path, which is then discarded. */
  clip(evenOdd = false): this {
    return this.op(evenOdd ? "W* n" : "W n");
  }

  /**
   * One line of text in the current fill colour, its baseline at y, aligned at x, turned by `angleDeg`
   * counter-clockwise about that point.
   */
  text(
    content: string,
    x: number,
    y: number,
    options: { size: number; font?: PdfFont; align?: TextAlign; angleDeg?: number },
  ): this {
    const font = options.font ?? "regular";
    const w = textWidth(content, options.size, font);
    const shift = options.align === "center" ? -w / 2 : options.align === "right" ? -w : 0;
    const a = ((options.angleDeg ?? 0) * Math.PI) / 180;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    const tx = x + shift * c;
    const ty = y + shift * s;
    return this.op(
      `BT /${font === "bold" ? "F2" : "F1"} ${num(options.size)} Tf ${[c, s, -s, c, tx, ty].map(num).join(" ")} Tm ${literal(winAnsi(content))} Tj ET`,
    );
  }

  /** The page's content stream. */
  content(): string {
    return this.ops.join("\n");
  }
}

function alphaName(a: number): string {
  return `GA${Math.round(a * 100)}`;
}

// ---- the document -------------------------------------------------------------------------------------

export interface PdfInfo {
  title: string;
  producer: string;
  /** ISO time; written as the document's creation date. */
  createdAt: string;
}

/** D:YYYYMMDDHHmmSSZ, from an ISO time. */
function pdfDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "D:19700101000000Z";
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** The pages as one PDF file. */
export function writePdf(pages: readonly PdfPage[], info: PdfInfo): Uint8Array {
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };
  // fixed numbers for the shared objects, so the page objects can name them before they are written
  const CATALOG = add("<< /Type /Catalog /Pages 2 0 R >>");
  const PAGES = add(""); // filled in once the kids are known
  const F1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const F2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const INFO = add(
    `<< /Title ${literal(winAnsi(info.title))} /Producer ${literal(winAnsi(info.producer))} /CreationDate ${literal(pdfDate(info.createdAt))} >>`,
  );
  const kids: number[] = [];
  for (const page of pages) {
    // ASCII by construction: every string in it was written through literal(), which escapes the rest.
    const stream = page.content();
    if (/[^\n\x20-\x7e]/.test(stream)) throw new Error("a page's content is not plain ASCII");
    const contents = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const states = [...page.alphas]
      .sort((a, b) => a - b)
      .map((a) => `/${alphaName(a)} << /Type /ExtGState /ca ${num(a)} >>`)
      .join(" ");
    kids.push(
      add(
        `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
          `/Resources << /Font << /F1 ${F1} 0 R /F2 ${F2} 0 R >> /ExtGState << ${states} >> >> /Contents ${contents} 0 R >>`,
      ),
    );
  }
  objects[PAGES - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  // Every character is one byte (winAnsi above), so string lengths are byte offsets.
  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${CATALOG} 0 R /Info ${INFO} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i += 1) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

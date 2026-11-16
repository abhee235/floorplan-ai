// Pictures for the code sandbox (ADR-030 D3): an attachment decoded to pixels, a region of it enlarged
// under a labelled grid, and marks drawn over it -- the three things that turned one reading of an
// office plan from a guess into a measurement.
//
// Everything here is plain arithmetic on byte arrays, so it runs the same on the host and in a test.
// The grid's numbers are drawn with a five-by-seven digit font kept below, because a coordinate the
// model cannot read off the picture is not a coordinate.

import { deflateSync, inflateSync } from "node:zlib";
import { encodePng } from "@fpv/assets";
import { decodePngGray } from "@fpv/importers";
import jpeg from "jpeg-js";

/** A decoded picture: one byte a pixel, 0 black to 255 white, rows top to bottom. */
export interface Gray {
  width: number;
  height: number;
  gray: Uint8Array;
  /** How many source pixels one of these pixels is; 1 unless the source was shrunk to fit. */
  scale: number;
}

/** A picture made to be looked at, with the source rectangle it shows. */
export interface Picture {
  width: number;
  height: number;
  png: Uint8Array;
}

/** The longest side a decoded picture keeps; larger ones are shrunk, and say by how much. */
export const MAX_DECODED_SIDE = 4000;
/** The longest side of a picture handed back to the model. */
export const MAX_SHOWN_SIDE = 1600;

const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;

/** A PNG or JPEG as grey pixels, shrunk by a whole factor if its long side is over the limit. */
export function decodeGray(bytes: Uint8Array): Gray {
  let img: { width: number; height: number; gray: Uint8Array };
  if (isPng(bytes)) img = decodePngGray(bytes, (d) => new Uint8Array(inflateSync(d)));
  else if (isJpeg(bytes)) {
    const raw = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
    const gray = new Uint8Array(raw.width * raw.height);
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4)
      gray[i] = Math.round(
        0.299 * (raw.data[p] ?? 0) + 0.587 * (raw.data[p + 1] ?? 0) + 0.114 * (raw.data[p + 2] ?? 0),
      );
    img = { width: raw.width, height: raw.height, gray };
  } else throw new Error("not a PNG or a JPEG");
  const factor = Math.ceil(Math.max(img.width, img.height) / MAX_DECODED_SIDE);
  if (factor <= 1) return { ...img, scale: 1 };
  // A box filter by a whole factor: thin lines survive as lighter lines rather than vanishing.
  const width = Math.floor(img.width / factor);
  const height = Math.floor(img.height / factor);
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy += 1)
        for (let dx = 0; dx < factor; dx += 1)
          sum += img.gray[(y * factor + dy) * img.width + x * factor + dx] ?? 255;
      gray[y * width + x] = Math.round(sum / (factor * factor));
    }
  return { width, height, gray, scale: factor };
}

// ---- drawing ---------------------------------------------------------------------------------

type Rgb = [number, number, number];

export const COLOURS: Readonly<Record<string, Rgb>> = {
  red: [220, 20, 20],
  green: [0, 150, 0],
  blue: [20, 90, 230],
  orange: [240, 130, 0],
  magenta: [210, 0, 170],
  cyan: [0, 170, 200],
  black: [0, 0, 0],
  grey: [120, 120, 120],
};

class Canvas {
  readonly rgb: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.rgb = new Uint8Array(width * height * 3).fill(255);
  }
  set(x: number, y: number, c: Rgb, alpha = 1): void {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.height) return;
    const i = (yi * this.width + xi) * 3;
    for (let k = 0; k < 3; k += 1)
      this.rgb[i + k] = Math.round((this.rgb[i + k] ?? 255) * (1 - alpha) + (c[k] ?? 0) * alpha);
  }
  line(x1: number, y1: number, x2: number, y2: number, c: Rgb, width = 1, alpha = 1): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1)));
    const r = (width - 1) / 2;
    for (let s = 0; s <= steps; s += 1) {
      const x = x1 + ((x2 - x1) * s) / steps;
      const y = y1 + ((y2 - y1) * s) / steps;
      for (let dy = -Math.floor(r); dy <= Math.ceil(r); dy += 1)
        for (let dx = -Math.floor(r); dx <= Math.ceil(r); dx += 1) this.set(x + dx, y + dy, c, alpha);
    }
  }
  png(): Picture {
    return {
      width: this.width,
      height: this.height,
      png: encodePng(
        { width: this.width, height: this.height, rgb: this.rgb },
        (d) => new Uint8Array(deflateSync(d)),
      ),
    };
  }
}

/** Five columns by seven rows, a bit per pixel, most significant bit on the left. */
const GLYPHS: Readonly<Record<string, readonly number[]>> = {
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  "-": [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  ".": [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
};

/** Digits at (x, y), top-left, on a white box so they read over anything. */
function label(c: Canvas, text: string, x: number, y: number, colour: Rgb, size = 1): void {
  const w = text.length * 6 * size + 1;
  for (let dy = -1; dy < 8 * size; dy += 1)
    for (let dx = -1; dx < w; dx += 1) c.set(x + dx, y + dy, [255, 255, 255], 0.85);
  for (const [i, ch] of [...text].entries()) {
    const rows = GLYPHS[ch];
    if (!rows) continue;
    for (const [r, bits] of rows.entries())
      for (let col = 0; col < 5; col += 1)
        if (bits & (0x10 >> col))
          for (let sy = 0; sy < size; sy += 1)
            for (let sx = 0; sx < size; sx += 1)
              c.set(x + (i * 6 + col) * size + sx, y + r * size + sy, colour);
  }
}

/** A grid step that gives between about six and fifteen lines across `span`. */
export function niceStep(span: number): number {
  const target = span / 10;
  const pow = 10 ** Math.floor(Math.log10(Math.max(1, target)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= target) return m * pow;
  return 10 * pow;
}

export interface CropOptions {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** Output pixels per source pixel; default fits the region into MAX_SHOWN_SIDE, at most 8. */
  scale?: number;
  /** Grid spacing in source pixels; 0 for none; default a round number giving about ten lines. */
  grid?: number;
}

/**
 * A region of a picture, enlarged, with a grid labelled in the source picture's own pixel
 * coordinates -- so a position read off the grid is a position in the picture, whatever the zoom.
 */
export function crop(
  img: Gray,
  o: CropOptions = {},
): Picture & { region: { x: number; y: number; w: number; h: number }; scale: number; grid: number } {
  const x0 = Math.max(0, Math.floor(o.x ?? 0));
  const y0 = Math.max(0, Math.floor(o.y ?? 0));
  const w = Math.max(1, Math.min(img.width - x0, Math.floor(o.w ?? img.width - x0)));
  const h = Math.max(1, Math.min(img.height - y0, Math.floor(o.h ?? img.height - y0)));
  const fit = Math.max(1, Math.floor(MAX_SHOWN_SIDE / Math.max(w, h)));
  // A whole number: a scale of 1.5 made a 697.5-pixel canvas and a PNG OpenAI refused as "not a valid
  // image", which ended a gpt-6-sol run at step five.
  const k = Math.max(1, Math.floor(Math.min(o.scale ?? Math.min(fit, 8), fit)));
  const c = new Canvas(w * k, h * k);
  for (let y = 0; y < h * k; y += 1)
    for (let x = 0; x < w * k; x += 1) {
      const v = img.gray[(y0 + Math.floor(y / k)) * img.width + x0 + Math.floor(x / k)] ?? 255;
      const i = (y * c.width + x) * 3;
      c.rgb[i] = v;
      c.rgb[i + 1] = v;
      c.rgb[i + 2] = v;
    }
  const step = o.grid === undefined ? niceStep(Math.max(w, h)) : o.grid;
  if (step > 0) {
    const red: Rgb = [230, 30, 30];
    for (let gx = Math.ceil(x0 / step) * step; gx < x0 + w; gx += step) {
      c.line((gx - x0) * k, 0, (gx - x0) * k, h * k - 1, red, 1, 0.45);
      label(c, String(gx), (gx - x0) * k + 2, 2, red);
    }
    for (let gy = Math.ceil(y0 / step) * step; gy < y0 + h; gy += step) {
      c.line(0, (gy - y0) * k, w * k - 1, (gy - y0) * k, red, 1, 0.45);
      label(c, String(gy), 2, (gy - y0) * k + 2, red);
    }
  }
  return { ...c.png(), region: { x: x0, y: y0, w, h }, scale: k, grid: step };
}

/** Something to draw over a picture, in the picture's own pixel coordinates. */
export interface Mark {
  line?: [number, number, number, number];
  rect?: [number, number, number, number];
  poly?: [number, number][];
  circle?: [number, number, number];
  point?: [number, number];
  /** A number to write beside the mark. */
  label?: string | number;
  colour?: string;
  width?: number;
}

/**
 * The picture, faded, with marks drawn over it at the given scale: how a model checks what it built
 * against what it was given (ADR-030 D6).
 */
export function draw(img: Gray, marks: readonly Mark[], scale?: number): Picture & { scale: number } {
  const k = Math.max(
    1,
    Math.floor(Math.min(scale ?? Math.floor(MAX_SHOWN_SIDE / Math.max(img.width, img.height)), 4)),
  );
  const c = new Canvas(img.width * k, img.height * k);
  for (let y = 0; y < c.height; y += 1)
    for (let x = 0; x < c.width; x += 1) {
      // Faded, so the marks are what stands out.
      const v =
        255 - Math.round((255 - (img.gray[Math.floor(y / k) * img.width + Math.floor(x / k)] ?? 255)) * 0.45);
      const i = (y * c.width + x) * 3;
      c.rgb[i] = v;
      c.rgb[i + 1] = v;
      c.rgb[i + 2] = v;
    }
  for (const m of marks.slice(0, 5000)) {
    const col = COLOURS[m.colour ?? "red"] ?? (COLOURS.red as Rgb);
    const wd = Math.max(1, Math.min(8, m.width ?? 2));
    let at: [number, number] | null = null;
    if (m.line) {
      const [a, b, cc, d] = m.line;
      c.line(a * k, b * k, cc * k, d * k, col, wd);
      at = [(a + cc) / 2, (b + d) / 2];
    }
    if (m.rect) {
      const [x, y, w, h] = m.rect;
      c.line(x * k, y * k, (x + w) * k, y * k, col, wd);
      c.line((x + w) * k, y * k, (x + w) * k, (y + h) * k, col, wd);
      c.line((x + w) * k, (y + h) * k, x * k, (y + h) * k, col, wd);
      c.line(x * k, (y + h) * k, x * k, y * k, col, wd);
      at = [x, y];
    }
    if (m.poly && m.poly.length > 1) {
      for (let i = 0; i < m.poly.length; i += 1) {
        const p = m.poly[i] as [number, number];
        const q = m.poly[(i + 1) % m.poly.length] as [number, number];
        c.line(p[0] * k, p[1] * k, q[0] * k, q[1] * k, col, wd);
      }
      at = m.poly[0] ?? null;
    }
    if (m.circle) {
      const [cx, cy, r] = m.circle;
      const n = Math.max(16, Math.ceil(r * k));
      for (let i = 0; i < n; i += 1) {
        const a = (i / n) * 2 * Math.PI;
        const b = ((i + 1) / n) * 2 * Math.PI;
        c.line(
          (cx + r * Math.cos(a)) * k,
          (cy + r * Math.sin(a)) * k,
          (cx + r * Math.cos(b)) * k,
          (cy + r * Math.sin(b)) * k,
          col,
          wd,
        );
      }
      at = [cx, cy];
    }
    if (m.point) {
      const [x, y] = m.point;
      c.line((x - 3) * k, y * k, (x + 3) * k, y * k, col, wd);
      c.line(x * k, (y - 3) * k, x * k, (y + 3) * k, col, wd);
      at = [x, y];
    }
    if (m.label !== undefined && at) label(c, String(m.label), at[0] * k + 3, at[1] * k + 3, col);
  }
  return { ...c.png(), scale: k };
}

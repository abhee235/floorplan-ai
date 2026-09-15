// A small PNG decoder to greyscale, so a raster plan's pixels can refine what a vision model reads (ADR-011 D2
// classical clean-up). Pure: the caller passes zlib inflate (node:zlib in the host, tests). Handles every
// non-interlaced PNG colour type at bit depths 1 to 16; transparency is composited onto white.

export interface GrayBitmap {
  width: number;
  height: number;
  /** One byte per pixel, row by row, 0 black to 255 white. */
  gray: Uint8Array;
}

export class PngDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PngDecodeError";
  }
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const luma = (r: number, g: number, b: number) => Math.round(0.299 * r + 0.587 * g + 0.114 * b);
const overWhite = (v: number, a: number) => Math.round((v * a) / 255 + 255 * (1 - a / 255));

export function decodePngGray(bytes: Uint8Array, inflate: (data: Uint8Array) => Uint8Array): GrayBitmap {
  if (bytes.length < 8 || SIGNATURE.some((v, i) => bytes[i] !== v))
    throw new PngDecodeError("not a PNG file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = -1;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos);
    const kind = String.fromCharCode(
      bytes[pos + 4] ?? 0,
      bytes[pos + 5] ?? 0,
      bytes[pos + 6] ?? 0,
      bytes[pos + 7] ?? 0,
    );
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (kind === "IHDR") {
      const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = d.getUint32(0);
      height = d.getUint32(4);
      depth = data[8] ?? 0;
      type = data[9] ?? -1;
      interlace = data[12] ?? 0;
    } else if (kind === "PLTE") palette = data;
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
  }
  const channels = CHANNELS[type];
  if (!channels || width === 0 || height === 0)
    throw new PngDecodeError("the PNG header is missing or unsupported");
  if (![1, 2, 4, 8, 16].includes(depth)) throw new PngDecodeError(`bit depth ${depth} is not supported`);
  if (interlace !== 0) throw new PngDecodeError("interlaced PNG is not supported");
  if (type === 3 && !palette) throw new PngDecodeError("a palette PNG has no palette");
  const total = idat.reduce((acc, c) => acc + c.length, 0);
  const packed = new Uint8Array(total);
  let off = 0;
  for (const c of idat) {
    packed.set(c, off);
    off += c.length;
  }
  const raw = inflate(packed);
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  if (raw.length < (stride + 1) * height)
    throw new PngDecodeError("the image data is shorter than the header says");
  const gray = new Uint8Array(width * height);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  const max = (1 << depth) - 1;
  for (let y = 0; y < height; y += 1) {
    const base = y * (stride + 1);
    const filter = raw[base] ?? 0;
    for (let x = 0; x < stride; x += 1) {
      const v = raw[base + 1 + x] ?? 0;
      const a = x >= bpp ? (cur[x - bpp] ?? 0) : 0;
      const b = prev[x] ?? 0;
      const c = x >= bpp ? (prev[x - bpp] ?? 0) : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new PngDecodeError(`unknown row filter ${filter}`);
      cur[x] = (v + pred) & 255;
    }
    const sample = (px: number, ch: number): number => {
      if (depth === 8) return cur[px * channels + ch] ?? 0;
      if (depth === 16) return cur[(px * channels + ch) * 2] ?? 0;
      const bit = (px * channels + ch) * depth;
      const byte = cur[bit >> 3] ?? 0;
      return (byte >> (8 - depth - (bit & 7))) & max;
    };
    const scale = (v: number) => (depth < 8 ? Math.round((v * 255) / max) : v);
    for (let x = 0; x < width; x += 1) {
      let g: number;
      if (type === 0) g = scale(sample(x, 0));
      else if (type === 2) g = luma(sample(x, 0), sample(x, 1), sample(x, 2));
      else if (type === 3) {
        const i = sample(x, 0) * 3;
        g = luma(palette?.[i] ?? 0, palette?.[i + 1] ?? 0, palette?.[i + 2] ?? 0);
      } else if (type === 4) g = overWhite(scale(sample(x, 0)), sample(x, 1));
      else g = overWhite(luma(sample(x, 0), sample(x, 1), sample(x, 2)), sample(x, 3));
      gray[y * width + x] = g;
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, gray };
}

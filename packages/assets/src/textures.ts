// Textures the app draws itself (P3-5). Seeded and deterministic, so the same name always gives the same
// pixels, and made from code, so there is no image file to ship and no licence to track. Every one tiles:
// its noise wraps and its patterns repeat on the image's edges, because a floor is covered by repeating it.
//
// PNG encoding is here too, with the compressor passed in: this package runs in the browser and in Node,
// and only the host has zlib to hand.

export interface RgbImage {
  width: number;
  height: number;
  /** Rows top to bottom, three bytes a pixel. */
  rgb: Uint8Array;
}

type Rgb = readonly [number, number, number];

export interface GeneratedTexture {
  /** The slug after "generated/" in the texture's catalog id, and after "generated:" in its image. */
  name: string;
  title: string;
  /** How much of a surface one copy of the image covers, in millimetres. */
  widthMm: number;
  heightMm: number;
  tags: readonly string[];
}

/** What the app can draw, with the real-world size of one tile of each. */
export const GENERATED_TEXTURES: readonly GeneratedTexture[] = [
  { name: "oak", title: "Oak planks", widthMm: 880, heightMm: 1800, tags: ["wood", "floor"] },
  { name: "walnut", title: "Walnut planks", widthMm: 880, heightMm: 1800, tags: ["wood", "floor"] },
  { name: "carpet-grey", title: "Grey carpet", widthMm: 500, heightMm: 500, tags: ["carpet", "floor"] },
  { name: "carpet-blue", title: "Blue carpet", widthMm: 500, heightMm: 500, tags: ["carpet", "floor"] },
  {
    name: "concrete",
    title: "Polished concrete",
    widthMm: 1500,
    heightMm: 1500,
    tags: ["stone", "floor", "wall"],
  },
  { name: "tiles-white", title: "White tiles", widthMm: 600, heightMm: 600, tags: ["tile", "floor", "wall"] },
  { name: "brick-red", title: "Red brick", widthMm: 450, heightMm: 300, tags: ["brick", "wall"] },
  {
    name: "fabric-grey",
    title: "Grey woven fabric",
    widthMm: 60,
    heightMm: 60,
    tags: ["fabric", "upholstery"],
  },
  {
    name: "fabric-navy",
    title: "Navy woven fabric",
    widthMm: 60,
    heightMm: 60,
    tags: ["fabric", "upholstery"],
  },
  { name: "felt-green", title: "Green acoustic felt", widthMm: 400, heightMm: 400, tags: ["felt", "wall"] },
];

/** The pixels of a generated texture, or null for a name the app does not draw. */
export function renderGeneratedTexture(name: string, size = 256): RgbImage | null {
  const draw = PAINTERS[name];
  if (!draw) return null;
  const rgb = new Uint8Array(size * size * 3);
  const paint = draw(size, seedOf(name));
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = paint(x / size, y / size);
      const i = (y * size + x) * 3;
      rgb[i] = clampByte(r);
      rgb[i + 1] = clampByte(g);
      rgb[i + 2] = clampByte(b);
    }
  return { width: size, height: size, rgb };
}

// ---- painters -----------------------------------------------------------------------------------------
// Each returns a function of (u, v) in [0, 1): the colour at that point of one tile.

type Painter = (size: number, seed: number) => (u: number, v: number) => Rgb;

const PAINTERS: Readonly<Record<string, Painter>> = {
  oak: planks([176, 132, 88], [138, 96, 58]),
  walnut: planks([104, 72, 50], [70, 46, 32]),
  "carpet-grey": carpet([118, 120, 124]),
  "carpet-blue": carpet([58, 76, 112]),
  concrete: (_size, seed) => {
    const cloud = noise(seed, 6);
    const grain = noise(seed + 1, 64);
    return (u, v) => {
      const t = 0.75 * fbm(cloud, u, v, 4) + 0.25 * grain(u, v);
      return mix([150, 150, 146], [196, 195, 190], t);
    };
  },
  "tiles-white": (_size, seed) => {
    const grain = noise(seed, 48);
    return (u, v) => {
      // two tiles each way, the grout between them about 5 per cent of a tile wide
      if (nearLine(u, 2, 0.012) || nearLine(v, 2, 0.012)) return [190, 190, 186];
      const t = grain(u, v);
      return mix([236, 236, 232], [246, 246, 243], t);
    };
  },
  "brick-red": (_size, seed) => {
    const grain = noise(seed, 40);
    return (u, v) => {
      // four courses, two bricks a course, every other course set over by half a brick
      const course = Math.floor(v * 4);
      const shift = course % 2 === 0 ? 0 : 0.25;
      const along = (u + shift) % 1;
      if (nearLine(v, 4, 0.02) || nearLine(along, 2, 0.012)) return [184, 178, 168];
      const brick = hash(seed, course, Math.floor(along * 2));
      const base = mix([150, 62, 44], [120, 50, 38], brick);
      return shade(base, 0.9 + 0.2 * grain(u, v));
    };
  },
  "fabric-grey": weave([112, 114, 118]),
  "fabric-navy": weave([42, 52, 84]),
  "felt-green": (_size, seed) => {
    const soft = noise(seed, 12);
    const fibre = noise(seed + 1, 96);
    return (u, v) => shade([82, 110, 86], 0.92 + 0.1 * fbm(soft, u, v, 3) + 0.05 * fibre(u, v));
  },
};

/** Boards running along v, four across the tile, each with its own grain and an end joint of its own. */
function planks(light: Rgb, dark: Rgb): Painter {
  return (_size, seed) => {
    const warp = noise(seed, 8);
    const fleck = noise(seed + 1, 96);
    return (u, v) => {
      const board = Math.floor(u * 4);
      const across = u * 4 - board;
      if (across < 0.012 || across > 0.988) return shade(dark, 0.7); // the seam between boards
      const joint = hash(seed, board, 7);
      if (Math.abs(((v + joint) % 1) - 0.5) < 0.004) return shade(dark, 0.75); // where two boards meet end on
      // fine lines along the board, bent a little: straight grain, not waves
      const grain = Math.sin((across * 16 + 1.1 * warp(u, v) + hash(seed, board, 3) * 10) * Math.PI * 2);
      const tone = 0.55 + 0.22 * grain + 0.2 * fleck(u, v);
      return shade(mix(dark, light, tone), 0.94 + 0.12 * hash(seed, board, 5));
    };
  };
}

function carpet(base: Rgb): Painter {
  return (_size, seed) => {
    const loops = noise(seed, 128);
    const patch = noise(seed + 1, 5);
    return (u, v) => shade(base, 0.82 + 0.26 * loops(u, v) + 0.08 * fbm(patch, u, v, 3));
  };
}

/** A plain weave: warp and weft crossing over and under, with a little unevenness in the yarn. */
function weave(base: Rgb): Painter {
  return (_size, seed) => {
    const yarn = noise(seed, 32);
    const threads = 16;
    return (u, v) => {
      const over = (Math.floor(u * threads) + Math.floor(v * threads)) % 2 === 0;
      const along = over ? (u * threads) % 1 : (v * threads) % 1;
      const round = Math.sin(along * Math.PI);
      return shade(base, 0.72 + 0.3 * round + 0.1 * yarn(u, v));
    };
  };
}

// ---- noise --------------------------------------------------------------------------------------------

/** Tileable value noise with `cells` cells across: the lattice wraps, so the edges meet. */
function noise(seed: number, cells: number): (u: number, v: number) => number {
  const lattice = new Float64Array(cells * cells);
  const next = mulberry32(seed);
  for (let i = 0; i < lattice.length; i += 1) lattice[i] = next();
  const at = (x: number, y: number) =>
    lattice[(((y % cells) + cells) % cells) * cells + (((x % cells) + cells) % cells)] as number;
  return (u, v) => {
    const x = u * cells;
    const y = v * cells;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const sx = smooth(x - x0);
    const sy = smooth(y - y0);
    const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return top + (bottom - top) * sy;
  };
}

/** Octaves of one noise, each at twice the frequency and half the weight; whole multiples keep it tiling. */
function fbm(n: (u: number, v: number) => number, u: number, v: number, octaves: number): number {
  let sum = 0;
  let weight = 0.5;
  let scale = 1;
  let total = 0;
  for (let o = 0; o < octaves; o += 1) {
    sum += weight * n((u * scale) % 1, (v * scale) % 1);
    total += weight;
    weight /= 2;
    scale *= 2;
  }
  return sum / total;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A number in [0, 1) fixed by the seed and two integers: the same board always gets the same grain. */
function hash(seed: number, a: number, b: number): number {
  return mulberry32(seed ^ Math.imul(a + 1, 73856093) ^ Math.imul(b + 1, 19349663))();
}

function seedOf(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i += 1) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** True within `half` (a fraction of the whole image) of the lines dividing [0, 1) into `count` repeats. */
function nearLine(t: number, count: number, half: number): boolean {
  const f = (t * count) % 1;
  return f < half * count || f > 1 - half * count;
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => {
  const k = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
};
const shade = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k];
const clampByte = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

// ---- PNG ----------------------------------------------------------------------------------------------

/**
 * An RGB image as PNG bytes: 8 bits a channel, no filtering, one IDAT chunk. `deflate` is zlib's (the
 * host passes node:zlib's deflateSync).
 */
export function encodePng(image: RgbImage, deflate: (data: Uint8Array) => Uint8Array): Uint8Array {
  const { width, height, rgb } = image;
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), row + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolour, deflate, adaptive filtering, no interlace
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

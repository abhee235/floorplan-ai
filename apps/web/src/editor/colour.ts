// Colour arithmetic for the colour picker: the colour models its inputs speak, the harmonies its guide
// offers, and the colours a project already uses. Free of the DOM.
//
// Colours cross this module as the model keeps them, "#RRGGBB". Hue is carried in HSV while the picker is
// open, because a grey has no hue of its own: converting through hex at every step would snap the hue
// slider back to red the moment the saturation reached zero.
import { parseHexColour } from "@fpv/ir";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}
/** Hue in degrees [0, 360); saturation and value (brightness) in [0, 1]. */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}
/** Hue in degrees [0, 360); saturation and lightness in [0, 1]. */
export interface Hsl {
  h: number;
  s: number;
  l: number;
}
/** Each in [0, 1]. */
export interface Cmyk {
  c: number;
  m: number;
  y: number;
  k: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const wrapHue = (h: number): number => ((h % 360) + 360) % 360;

export function hexToRgb(hex: string): Rgb | null {
  const six = parseHexColour(hex);
  if (!six) return null;
  const n = Number.parseInt(six.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (v: number) =>
    Math.round(clamp(v, 0, 255))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const d = max - Math.min(rr, gg, bb);
  let h = 0;
  if (d > 0) {
    if (max === rr) h = 60 * (((gg - bb) / d) % 6);
    else if (max === gg) h = 60 * ((bb - rr) / d + 2);
    else h = 60 * ((rr - gg) / d + 4);
  }
  return { h: wrapHue(h), s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const c = v * s;
  const hh = wrapHue(h) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const [r, g, b] =
    hh < 1
      ? [c, x, 0]
      : hh < 2
        ? [x, c, 0]
        : hh < 3
          ? [0, c, x]
          : hh < 4
            ? [0, x, c]
            : hh < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = v - c;
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

export function hsvToHsl({ h, s, v }: Hsv): Hsl {
  const l = v * (1 - s / 2);
  return { h, s: l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l), l };
}

export function hslToHsv({ h, s, l }: Hsl): Hsv {
  const v = l + s * Math.min(l, 1 - l);
  return { h, s: v === 0 ? 0 : 2 * (1 - l / v), v };
}

export function rgbToCmyk({ r, g, b }: Rgb): Cmyk {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const k = 1 - Math.max(rr, gg, bb);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 1 };
  return { c: (1 - rr - k) / (1 - k), m: (1 - gg - k) / (1 - k), y: (1 - bb - k) / (1 - k), k };
}

export function cmykToRgb({ c, m, y, k }: Cmyk): Rgb {
  return { r: 255 * (1 - c) * (1 - k), g: 255 * (1 - m) * (1 - k), b: 255 * (1 - y) * (1 - k) };
}

export const hsvToHex = (hsv: Hsv): string => rgbToHex(hsvToRgb(hsv));

/** A colour as HSV, keeping `hue` when the colour itself has none (a grey, black or white). */
export function hexToHsv(hex: string, hue = 0): Hsv | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const hsv = rgbToHsv(rgb);
  return hsv.s === 0 || hsv.v === 0 ? { ...hsv, h: hue } : hsv;
}

/** The input groups the picker offers, and what each number is called and runs to. */
export type ColourModel = "hex" | "rgb" | "hsl" | "hsv" | "cmyk";
export const COLOUR_MODELS: readonly { value: ColourModel; label: string }[] = [
  { value: "hex", label: "Hex" },
  { value: "rgb", label: "RGB" },
  { value: "hsl", label: "HSL" },
  { value: "hsv", label: "HSB" },
  { value: "cmyk", label: "CMYK" },
];

export interface Channel {
  key: string;
  /** Read aloud, and shown as the input's title. */
  name: string;
  /** Printed above the input. */
  short: string;
  max: number;
}

export const CHANNELS: Record<Exclude<ColourModel, "hex">, readonly Channel[]> = {
  rgb: [
    { key: "r", name: "Red", short: "R", max: 255 },
    { key: "g", name: "Green", short: "G", max: 255 },
    { key: "b", name: "Blue", short: "B", max: 255 },
  ],
  hsl: [
    { key: "h", name: "Hue", short: "H", max: 360 },
    { key: "s", name: "Saturation", short: "S", max: 100 },
    { key: "l", name: "Lightness", short: "L", max: 100 },
  ],
  hsv: [
    { key: "h", name: "Hue", short: "H", max: 360 },
    { key: "s", name: "Saturation", short: "S", max: 100 },
    { key: "v", name: "Brightness", short: "B", max: 100 },
  ],
  cmyk: [
    { key: "c", name: "Cyan", short: "C", max: 100 },
    { key: "m", name: "Magenta", short: "M", max: 100 },
    { key: "y", name: "Yellow", short: "Y", max: 100 },
    { key: "k", name: "Black", short: "K", max: 100 },
  ],
};

/** The whole numbers a model's inputs show for a colour. */
export function channelValues(model: Exclude<ColourModel, "hex">, hsv: Hsv): Record<string, number> {
  const pct = (v: number) => Math.round(v * 100);
  const hue = Math.round(hsv.h) % 360;
  switch (model) {
    case "rgb": {
      const { r, g, b } = hsvToRgb(hsv);
      return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
    }
    case "hsl": {
      const { s, l } = hsvToHsl(hsv);
      return { h: hue, s: pct(s), l: pct(l) };
    }
    case "hsv":
      return { h: hue, s: pct(hsv.s), v: pct(hsv.v) };
    case "cmyk": {
      const { c, m, y, k } = rgbToCmyk(hsvToRgb(hsv));
      return { c: pct(c), m: pct(m), y: pct(y), k: pct(k) };
    }
  }
}

/** The colour a model's inputs describe once one of them is changed; out-of-range numbers are held in range. */
export function fromChannels(
  model: Exclude<ColourModel, "hex">,
  values: Record<string, number>,
  hue: number,
): Hsv {
  const get = (key: string, max: number) => clamp(values[key] ?? 0, 0, max);
  switch (model) {
    case "rgb":
      return hexToHsv(rgbToHex({ r: get("r", 255), g: get("g", 255), b: get("b", 255) }), hue) as Hsv;
    case "hsl":
      return hslToHsv({ h: get("h", 360) % 360, s: get("s", 100) / 100, l: get("l", 100) / 100 });
    case "hsv":
      return { h: get("h", 360) % 360, s: get("s", 100) / 100, v: get("v", 100) / 100 };
    case "cmyk":
      return hexToHsv(
        rgbToHex(
          cmykToRgb({
            c: get("c", 100) / 100,
            m: get("m", 100) / 100,
            y: get("y", 100) / 100,
            k: get("k", 100) / 100,
          }),
        ),
        hue,
      ) as Hsv;
  }
}

/** Colour-guide rows: colours that sit well with this one. */
export function harmonies(hsv: Hsv): { name: string; colours: string[] }[] {
  const hsl = hsvToHsl(hsv);
  const turn = (deg: number) => hsvToHex(hslToHsv({ ...hsl, h: wrapHue(hsl.h + deg) }));
  const lightness = (l: number) => hsvToHex(hslToHsv({ ...hsl, l }));
  return [
    { name: "Analogous", colours: [-30, -15, 0, 15, 30].map(turn) },
    { name: "Shades", colours: [0.2, 0.35, 0.5, 0.65, 0.8].map(lightness) },
    { name: "Triad", colours: [0, 120, 240].map(turn) },
    { name: "Tetrad", colours: [0, 90, 180, 270].map(turn) },
  ];
}

/** Colours an interior is often finished in: whites and greys, two woods, and a few accents. */
export const INTERIOR_COLOURS: readonly string[] = [
  "#FFFFFF",
  "#F4F1EA",
  "#E8E6E1",
  "#D9D4CC",
  "#BFB8AD",
  "#8C857B",
  "#4A4744",
  "#1F1F1F",
  "#C9A27E",
  "#8B5A3C",
  "#6E8B74",
  "#5B6B4E",
  "#2E7D6B",
  "#7A9CB8",
  "#3E5C76",
  "#D9A441",
  "#B5523B",
  "#A64D79",
];

/** The colours a project already uses, most used first: every `color` the model holds, of any entity. */
export function projectColours(project: unknown, limit = 9): string[] {
  const counts = new Map<string, number>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "color" && typeof value === "string") {
        const hex = parseHexColour(value);
        if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
      } else if (typeof value === "object") walk(value);
    }
  };
  walk(project);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([hex]) => hex);
}

/** Whether a colour is light enough to want a dark mark drawn on it. */
export function isLight(hex: string): boolean {
  const rgb = hexToRgb(hex);
  if (!rgb) return true;
  return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b > 160;
}

// Page text and grounding (ADR-008 D3 steps 4 and 5): turn HTML into plain text, find the quantities a
// page states with their units, and decide whether a proposed value is actually written on the page.
// Grounding is what separates a verified record from a model's confident guess.

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  times: "x",
  deg: "°",
  prime: "′",
  Prime: "″",
  frac12: "½",
  ndash: "-",
  mdash: "-",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};

/** Plain text from HTML: scripts, styles and tags removed, entities decoded, whitespace collapsed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/td|\/th|\/dd|\/dt)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name] ?? m)
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n[ \n]*/g, "\n")
    .trim();
}

export type QuantityKind = "length" | "mass" | "plain";

export interface Quantity {
  /** Millimetres for length, kilograms for mass, the number as written for plain. */
  value: number;
  kind: QuantityKind;
  /** The number as written and its unit, for notes. */
  raw: string;
  /** Character offset of the number in the text. */
  at: number;
  /** Which run of numbers it came from: "a x b x c" is one run, so its three numbers share this. */
  run: number;
  /** The unit was an inch mark (" or ″), which pages also use for screen sizes. */
  mark: boolean;
}

const LENGTH_TO_MM: Readonly<Record<string, number>> = {
  mm: 1,
  millimeter: 1,
  millimeters: 1,
  millimetre: 1,
  millimetres: 1,
  cm: 10,
  centimeter: 10,
  centimeters: 10,
  centimetre: 10,
  centimetres: 10,
  m: 1000,
  meter: 1000,
  meters: 1000,
  metre: 1000,
  metres: 1000,
  in: 25.4,
  inch: 25.4,
  inches: 25.4,
  '"': 25.4,
  "″": 25.4,
  "''": 25.4,
  ft: 304.8,
  feet: 304.8,
  foot: 304.8,
};
const MASS_TO_KG: Readonly<Record<string, number>> = {
  kg: 1,
  kgs: 1,
  kilogram: 1,
  kilograms: 1,
  g: 0.001,
  grams: 0.001,
  lb: 0.45359237,
  lbs: 0.45359237,
  pound: 0.45359237,
  pounds: 0.45359237,
  oz: 0.028349523,
};

const UNIT_PATTERN = `(mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|met(?:er|re)s?|m|inch(?:es)?|in|ft|feet|foot|"|″|''|kgs?|kilograms?|g|grams|lbs?|pounds?|oz)`;
const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
/**
 * A number never ends before another digit, so "230W" reads as 230 rather than backtracking to 23; a
 * unit must not run on into a word, so "75 most" is a plain 75 and not 75 metres.
 */
const N = String.raw`(${NUM})(?!\d)`;
const U = String.raw`(?:\s*${UNIT_PATTERN}(?![a-z]))?`;
/** A run of numbers joined by x or × (w x h x d), with an optional unit after each, after the last, or bracketed after. */
const RUN = new RegExp(
  String.raw`${N}${U}(?:\s*[x×*]\s*${N}${U})?(?:\s*[x×*]\s*${N}${U})?(?:\s*[(\[]\s*${UNIT_PATTERN}\s*[)\]])?`,
  "gi",
);
/** A unit declared in brackets before the numbers: "Dimensions (mm)", "Weight [kg]". */
const DECLARED = new RegExp(String.raw`[(\[]\s*${UNIT_PATTERN}\s*[)\]]`, "gi");

function toNumber(s: string): number {
  return Number(s.replace(/,/g, ""));
}

function convert(n: number, unit: string | undefined): { value: number; kind: QuantityKind } {
  const u = unit?.toLowerCase();
  if (u && u in LENGTH_TO_MM) return { value: n * (LENGTH_TO_MM[u] as number), kind: "length" };
  if (u && u in MASS_TO_KG) return { value: n * (MASS_TO_KG[u] as number), kind: "mass" };
  return { value: n, kind: "plain" };
}

/**
 * Every quantity a text states. A unit after a number applies to it; a unit after the last number of an
 * "a x b x c" run applies to the whole run; a unit declared in brackets within 60 characters before
 * applies to numbers that have none. Every number is also reported as plain so spec values such as
 * "75" or "210 W" can be found.
 */
export function quantities(text: string): Quantity[] {
  const declared: { at: number; unit: string }[] = [];
  for (const m of text.matchAll(DECLARED)) declared.push({ at: m.index ?? 0, unit: m[1] as string });
  const out: Quantity[] = [];
  let run = 0;
  for (const m of text.matchAll(RUN)) {
    const at = m.index ?? 0;
    run += 1;
    const nums = [m[1], m[3], m[5]].filter((v): v is string => v !== undefined);
    const units = [m[2], m[4], m[6]];
    const trailing = m[7]; // "1679 x 969 x 70 (mm)"
    const runUnit = [...units].reverse().find((u) => u !== undefined);
    const before = declared.filter((d) => d.at < at && at - d.at <= 60).at(-1)?.unit;
    let cursor = 0;
    nums.forEach((raw, i) => {
      const offset = m[0].indexOf(raw, cursor);
      cursor = offset + raw.length;
      const n = toNumber(raw);
      if (!Number.isFinite(n)) return;
      const unit = units[i] ?? (nums.length > 1 ? runUnit : undefined) ?? trailing ?? before;
      const q = convert(n, unit);
      const where = { at: at + offset, run };
      const mark = unit === '"' || unit === "″" || unit === "''";
      out.push({ ...q, raw: unit ? `${raw} ${unit}` : raw, ...where, mark });
      if (q.kind !== "plain") out.push({ value: n, kind: "plain", raw, ...where, mark: false });
    });
  }
  return out;
}

/** True when b is within tolerance of a (relative), with half a unit of slack for small rounded values. */
export function within(a: number, b: number, tol: number): boolean {
  return close(a, b, tol);
}

/** Relative tolerance for a stated value to match a proposed one: 2 percent (PRD P1-2). */
export const GROUNDING_TOLERANCE = 0.02;

function close(a: number, b: number, tol: number): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  // rounding of small values: 45 mm written as "1.8 in" is 45.72 mm, so allow half a unit of the writing
  return Math.abs(a - b) <= Math.max(scale * tol, 0.5);
}

/** The first stated quantity of this kind within tolerance, or null. */
export function findQuantity(
  qs: readonly Quantity[],
  kind: QuantityKind,
  value: number,
  tol = GROUNDING_TOLERANCE,
): Quantity | null {
  return qs.find((q) => q.kind === kind && close(q.value, value, tol)) ?? null;
}

/** Letters and digits only, lower case: "QM75C", "qm-75c" and "QM 75 C" all become "qm75c". */
export function alnum(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** True when the page names the model. Short model keys need a word boundary so "A30" does not match "A300". */
export function mentionsModel(text: string, model: string): boolean {
  const mk = alnum(model);
  if (mk.length < 2) return false;
  const squashed = alnum(text);
  if (mk.length >= 6) return squashed.includes(mk);
  const parts = model
    .trim()
    .split(/[\s-]+/)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(^|[^a-z0-9])${parts.join("[\\s-]*")}(?![a-z0-9])`, "i");
  return re.test(text);
}

/**
 * The part of a long page worth sending to a model: windows around the model name and dimension words,
 * merged, in page order, capped at `maxChars`.
 */
export function relevantExcerpt(text: string, model: string, maxChars = 12_000): string {
  if (text.length <= maxChars) return text;
  const words = [
    model,
    "dimension",
    "size",
    "weight",
    "width",
    "height",
    "depth",
    "vesa",
    "specification",
    "power",
  ];
  const hits: [number, number][] = [];
  const lower = text.toLowerCase();
  for (const w of words) {
    const needle = w.toLowerCase();
    let i = lower.indexOf(needle);
    while (i >= 0 && hits.length < 400) {
      hits.push([Math.max(0, i - 400), Math.min(text.length, i + needle.length + 600)]);
      i = lower.indexOf(needle, i + needle.length);
    }
  }
  if (hits.length === 0) return text.slice(0, maxChars);
  hits.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const h of hits) {
    const last = merged.at(-1);
    if (last && h[0] <= last[1]) last[1] = Math.max(last[1], h[1]);
    else merged.push([h[0], h[1]]);
  }
  let out = "";
  for (const [a, b] of merged) {
    const piece = `${text.slice(a, b)}\n…\n`;
    if (out.length + piece.length > maxChars) {
      out += piece.slice(0, maxChars - out.length);
      break;
    }
    out += piece;
  }
  return out;
}

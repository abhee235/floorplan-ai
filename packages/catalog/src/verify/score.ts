// Confidence scoring (ADR-008 D3 step 5). Deterministic and explainable: every point comes from a check
// that can be read back in `checks`. A proposal is verified only when its three dimensions are written
// on a page that names the model and the total reaches the threshold; nothing a model says counts
// unless a fetched page says it too.
import { hostOf, isManufacturerUrl } from "./makes.js";
import type { ProductProposal } from "./proposal.js";
import {
  alnum,
  findQuantity,
  GROUNDING_TOLERANCE,
  mentionsModel,
  type Quantity,
  quantities,
  within,
} from "./text.js";

export interface EvidencePage {
  url: string;
  text: string;
}

export const VERIFIED_THRESHOLD = 0.6;
export const WEIGHTS = {
  manufacturer: 0.3,
  dimsInOnePage: 0.3,
  dimsPartial: 0.15,
  agreement: 0.15,
  specs: 0.15,
  plausible: 0.1,
} as const;

/** Outer size bounds per category in mm, [min, max] for w, d, h; categories not listed use the generic row. */
const BOUNDS: Readonly<
  Record<string, readonly [readonly [number, number], readonly [number, number], readonly [number, number]]>
> = {
  display: [
    [400, 3000],
    [10, 300],
    [250, 1800],
  ],
  "video-bar": [
    [150, 1600],
    [30, 250],
    [30, 250],
  ],
  camera: [
    [50, 600],
    [40, 400],
    [40, 400],
  ],
  "ceiling-mic": [
    [50, 1300],
    [50, 1300],
    [10, 200],
  ],
  "ceiling-speaker": [
    [100, 700],
    [100, 700],
    [50, 500],
  ],
  "table-mic": [
    [30, 600],
    [30, 600],
    [10, 150],
  ],
  scheduler: [
    [100, 450],
    [10, 150],
    [80, 350],
  ],
  "touch-panel": [
    [100, 450],
    [10, 250],
    [80, 350],
  ],
  table: [
    [500, 9000],
    [500, 3500],
    [300, 1200],
  ],
  desk: [
    [600, 3600],
    [400, 2000],
    [600, 1300],
  ],
  chair: [
    [350, 1100],
    [350, 1100],
    [600, 1400],
  ],
  whiteboard: [
    [300, 6000],
    [5, 150],
    [300, 2500],
  ],
};
const GENERIC: readonly [readonly [number, number], readonly [number, number], readonly [number, number]] = [
  [1, 12000],
  [1, 12000],
  [1, 12000],
];

export function plausibility(
  category: string | null,
  dims: { w: number; d: number; h: number } | null,
  weightKg: number | null,
): { ok: boolean; notes: string[] } {
  const notes: string[] = [];
  if (dims) {
    const [bw, bd, bh] = BOUNDS[category ?? ""] ?? GENERIC;
    const check = (label: string, v: number, [lo, hi]: readonly [number, number]) => {
      if (v < lo || v > hi)
        notes.push(`${label} ${Math.round(v)} mm is outside ${lo}..${hi} mm for ${category ?? "a product"}`);
    };
    check("width", dims.w, bw);
    check("depth", dims.d, bd);
    check("height", dims.h, bh);
  }
  if (weightKg !== null && (weightKg <= 0 || weightKg > 600))
    notes.push(`weight ${weightKg} kg is implausible`);
  return { ok: notes.length === 0, notes };
}

export interface VerificationChecks {
  /** Pages that name the requested model. */
  mentionedBy: string[];
  manufacturerPages: string[];
  /** Pages stating all three proposed dimensions. */
  dimsGroundedIn: string[];
  specsGrounded: string[];
  specsUngrounded: string[];
  weightGrounded: boolean | null;
  priceGrounded: boolean | null;
  plausible: boolean;
}

export interface Score {
  status: "verified" | "unverified" | "rejected";
  confidence: number;
  checks: VerificationChecks;
  /** Pages that name the model: the record's sources. */
  sources: string[];
  notes: string[];
  /** Proposal fields that a page actually states; only these may be persisted. */
  grounded: {
    dims: boolean;
    weightKg: boolean;
    specs: Record<string, ProductProposal["specs"][string]>;
    price: boolean;
  };
}

function groundedSpec(
  key: string,
  value: string | number | boolean,
  qs: readonly Quantity[],
  text: string,
): boolean | null {
  return specStated(key, value, text, qs);
}

/** Largest span, in characters, over which three dimensions may be spread and still count as one statement. */
export const DIMS_WINDOW = 200;

function grouped(picks: readonly Quantity[]): boolean {
  if (new Set(picks).size !== picks.length) return false; // each dimension needs its own number
  const ats = picks.map((q) => q.at);
  if (Math.max(...ats) - Math.min(...ats) > DIMS_WINDOW) return false;
  // inch marks are also how pages list screen sizes; only marks from one "a x b x c" run count together
  const marks = picks.filter((q) => q.mark);
  return !(marks.length >= 2 && new Set(marks.map((q) => q.run)).size > 1);
}

/**
 * How many of the three dimensions a page states together: distinct numbers, close to each other, not
 * stitched from unrelated inch marks. 3 means the page states the size; scattered matches count for nothing.
 */
export function dimsStatedCount(qs: readonly Quantity[], dims: { w: number; d: number; h: number }): number {
  const lengths = qs.filter((q) => q.kind === "length");
  const cands = [dims.w, dims.d, dims.h].map((v) =>
    lengths.filter((q) => within(q.value, v, GROUNDING_TOLERANCE)).slice(0, 40),
  );
  const [cw, cd, ch] = cands as [Quantity[], Quantity[], Quantity[]];
  for (const a of cw) for (const b of cd) for (const c of ch) if (grouped([a, b, c])) return 3;
  for (const [x, y] of [
    [cw, cd],
    [cw, ch],
    [cd, ch],
  ] as const)
    for (const a of x) for (const b of y) if (grouped([a, b])) return 2;
  return cands.some((c) => c.length > 0) ? 1 : 0;
}

export function dimsStated(qs: readonly Quantity[], dims: { w: number; d: number; h: number }): boolean {
  return dimsStatedCount(qs, dims) === 3;
}

/** Words that must appear near a spec's number, and the unit that may follow it directly. */
const SPEC_WORDS: Readonly<Record<string, { words: readonly string[]; unit?: RegExp }>> = {
  diagonalIn: { words: ["diagonal", "inch", "class", "screen size"], unit: /^\s?("|″|-?inch)/i },
  screenIn: { words: ["screen", "inch", "display"], unit: /^\s?("|″|-?inch)/i },
  powerW: { words: ["power", "consumption", "watt"], unit: /^\s?w(?![a-z])/i },
  powerPerChannelW: { words: ["per channel", "power", "watt"], unit: /^\s?w(?![a-z])/i },
  poeBudgetW: { words: ["poe", "budget"], unit: /^\s?w(?![a-z])/i },
  fovDeg: { words: ["field of view", "fov", "viewing angle", "angle"], unit: /^\s?°/ },
  maxRoomDepthMm: { words: ["room", "depth", "distance", "range", "pickup"] },
  coverageRadiusMm: { words: ["coverage", "radius", "pickup", "range"] },
  lengthMm: { words: ["length", "long"] },
  channels: { words: ["channel"] },
  impedanceOhm: { words: ["impedance", "ohm"], unit: /^\s?(Ω|ohm)/i },
  inputs: { words: ["input"] },
  outputs: { words: ["output"] },
  ports: { words: ["port"] },
  seats: { words: ["seat", "people", "person", "pax"] },
};
const UNIT_TOKENS = new Set(["mm", "in", "w", "deg", "ohm", "kg", "hz", "mbps"]);

function wordsFor(key: string): { words: readonly string[]; unit?: RegExp } {
  const known = SPEC_WORDS[key];
  if (known) return known;
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(" ")
    .filter((p) => p.length >= 3 && !UNIT_TOKENS.has(p));
  return { words: parts };
}

/**
 * Whether a page states a spec value. Strings match by letters and digits; numbers must sit near a word
 * for the spec (or be followed by its unit), so "280" in a model name does not ground "powerW: 280".
 * Booleans are not checkable and give null.
 */
export function specStated(
  key: string,
  value: string | number | boolean,
  text: string,
  qs: readonly Quantity[],
): boolean | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "string") {
    const v = alnum(value);
    return v.length >= 2 && alnum(text).includes(v);
  }
  const { words, unit } = wordsFor(key);
  const lower = text.toLowerCase();
  const near = (q: Quantity) => {
    const numberEnd = q.at + q.raw.split(" ")[0]!.length;
    if (unit?.test(text.slice(numberEnd, numberEnd + 8))) return true;
    const window = lower.slice(Math.max(0, q.at - 60), numberEnd + 40);
    // a word must start at a word boundary: "nits" is not in "units", "port" is not in "support"
    return words.some((w) =>
      new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(window),
    );
  };
  const lengthKey = /Mm$/.test(key);
  return qs.some(
    (q) =>
      ((q.kind === "plain" && within(q.value, value, 0.01)) ||
        (lengthKey && q.kind === "length" && within(q.value, value, GROUNDING_TOLERANCE))) &&
      near(q),
  );
}

/**
 * Score a proposal against the pages that were fetched. `requested` is the make and model the caller
 * asked about; a proposal that describes a different model is not credited.
 */
export function scoreProposal(
  proposal: ProductProposal | null,
  pages: readonly EvidencePage[],
  requested: { make: string; model: string },
): Score {
  const notes: string[] = [];
  const mentioning = pages.filter((p) => mentionsModel(p.text, requested.model));
  const checks: VerificationChecks = {
    mentionedBy: mentioning.map((p) => p.url),
    manufacturerPages: mentioning.filter((p) => isManufacturerUrl(p.url, requested.make)).map((p) => p.url),
    dimsGroundedIn: [],
    specsGrounded: [],
    specsUngrounded: [],
    weightGrounded: null,
    priceGrounded: null,
    plausible: false,
  };
  const none = { dims: false, weightKg: false, specs: {}, price: false };
  if (mentioning.length === 0) {
    notes.push(`no page names ${requested.make} ${requested.model}`);
    return { status: "rejected", confidence: 0, checks, sources: [], notes, grounded: none };
  }
  if (!proposal || !proposal.found) {
    notes.push("pages name the model but no product details could be read from them");
    return {
      status: "unverified",
      confidence: 0.1,
      checks,
      sources: checks.mentionedBy,
      notes,
      grounded: none,
    };
  }
  if (alnum(proposal.model) !== alnum(requested.model) && !mentionsModel(proposal.model, requested.model)) {
    notes.push(`the proposal describes ${proposal.model}, not ${requested.model}`);
    return {
      status: "unverified",
      confidence: 0.1,
      checks,
      sources: checks.mentionedBy,
      notes,
      grounded: none,
    };
  }

  const parsed = mentioning.map((p) => ({ page: p, qs: quantities(p.text) }));
  let confidence = 0;
  if (checks.manufacturerPages.length > 0) confidence += WEIGHTS.manufacturer;
  else notes.push("no manufacturer page among the sources");

  let dimsGrounded = false;
  if (proposal.dims) {
    const { w, d, h } = proposal.dims;
    let bestPartial = 0;
    for (const { page, qs } of parsed) {
      const found = dimsStatedCount(qs, { w, d, h });
      if (found === 3) checks.dimsGroundedIn.push(page.url);
      bestPartial = Math.max(bestPartial, found);
    }
    if (checks.dimsGroundedIn.length > 0) {
      dimsGrounded = true;
      confidence += WEIGHTS.dimsInOnePage;
      const hosts = new Set(checks.dimsGroundedIn.map((u) => hostOf(u)));
      if (hosts.size >= 2) confidence += WEIGHTS.agreement;
    } else if (bestPartial === 2) {
      confidence += WEIGHTS.dimsPartial;
      notes.push("only two of the three dimensions are stated on any one page");
    } else notes.push("the proposed dimensions are not stated on any page");
  } else notes.push("no dimensions were found");

  const specChecks: [string, string | number | boolean][] = Object.entries(proposal.specs);
  const groundedSpecs: Record<string, string | number | boolean> = {};
  let checkable = 0;
  let ok = 0;
  for (const [key, value] of specChecks) {
    const result = parsed.map(({ page, qs }) => groundedSpec(key, value, qs, page.text));
    if (result.every((r) => r === null)) {
      groundedSpecs[key] = value; // booleans ride along but earn nothing
      continue;
    }
    checkable += 1;
    if (result.some((r) => r === true)) {
      ok += 1;
      checks.specsGrounded.push(key);
      groundedSpecs[key] = value;
    } else checks.specsUngrounded.push(key);
  }
  if (proposal.weightKg !== null) {
    checkable += 1;
    checks.weightGrounded = parsed.some(
      ({ qs }) => findQuantity(qs, "mass", proposal.weightKg as number, 0.03) !== null,
    );
    if (checks.weightGrounded) ok += 1;
  }
  if (checkable > 0) confidence += WEIGHTS.specs * (ok / checkable);
  if (checks.specsUngrounded.length > 0)
    notes.push(`specs not stated on any page: ${checks.specsUngrounded.join(", ")}`);

  if (proposal.price) {
    const amount = proposal.price.amount;
    const page = parsed.find(({ page }) => page.url === proposal.price?.sourceUrl);
    checks.priceGrounded = page ? findQuantity(page.qs, "plain", amount, 0.005) !== null : false;
    if (!checks.priceGrounded) notes.push("the price is not stated on its source page and was dropped");
  }

  const plaus = plausibility(proposal.category, proposal.dims, proposal.weightKg);
  checks.plausible = plaus.ok;
  if (plaus.ok) confidence += WEIGHTS.plausible;
  else {
    notes.push(...plaus.notes);
    confidence = Math.min(confidence, 0.4);
  }

  confidence = Math.round(confidence * 100) / 100;
  const status = dimsGrounded && confidence >= VERIFIED_THRESHOLD ? "verified" : "unverified";
  if (status === "unverified" && dimsGrounded)
    notes.push(`confidence ${confidence} is below ${VERIFIED_THRESHOLD}`);
  return {
    status,
    confidence,
    checks,
    sources: checks.mentionedBy,
    notes,
    grounded: {
      dims: dimsGrounded,
      weightKg: checks.weightGrounded === true,
      specs: groundedSpecs,
      price: checks.priceGrounded === true,
    },
  };
}

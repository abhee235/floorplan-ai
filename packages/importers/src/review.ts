// Draft review helpers shared by the import tool and the app's review panel (spec 06 A2 rule 1, ADR-011 D3,
// D5): when the scale counts as confirmed, how a person's answer sets it, and the draft's extent. Pure.
import type { DraftUnits, PlanDraft } from "./draft.js";

/** Millimetres per unit for the units a person can name. */
export const UNIT_MM: Readonly<Record<Exclude<DraftUnits, "unknown">, number>> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

/** Dimension checks must agree within this fraction to confirm a scale on their own. */
export const SCALE_AGREEMENT = 0.02;

export type ScaleInput =
  | { mmPerUnit: number }
  | { units: Exclude<DraftUnits, "unknown"> }
  /** A length measured on the drawing in draft units and what it really is. */
  | { measuredUnits: number; lengthMm: number };

export interface ScaleStatus {
  confirmed: boolean;
  /** Why it is or is not confirmed, in a sentence. */
  reason: string;
}

/** Spec 06 A2 rule 1: a person set the scale, or at least two dimension texts agree with it within 2 percent. */
export function scaleStatus(draft: PlanDraft): ScaleStatus {
  const f = draft.units.mmPerUnit;
  if (f === null) return { confirmed: false, reason: "the drawing has no scale yet" };
  if (draft.units.scaleSource === "user") return { confirmed: true, reason: "the scale was set by a person" };
  const agreeing = draft.units.checks.filter((c) => Math.abs(c.impliedMmPerUnit - f) / f <= SCALE_AGREEMENT);
  if (draft.units.scaleSource === "dimension-text" && agreeing.length >= 2)
    return {
      confirmed: true,
      reason: `${agreeing.length} dimension texts agree with the scale within 2 percent`,
    };
  const from =
    draft.units.scaleSource === "dimension-text"
      ? `only ${agreeing.length} dimension text agrees`
      : draft.units.scaleSource === "header"
        ? "the scale comes from the drawing header"
        : "the scale is a guess";
  return { confirmed: false, reason: `${from}; confirm it or give one known length` };
}

const UNIT_WORDS: readonly [RegExp, Exclude<DraftUnits, "unknown">][] = [
  [/^(mm|millimet(er|re)s?)$/, "mm"],
  [/^(cm|centimet(er|re)s?)$/, "cm"],
  [/^(m|met(er|re)s?)$/, "m"],
  [/^(in|inch|inches|")$/, "in"],
  [/^(ft|foot|feet|')$/, "ft"],
];

/**
 * A person's answer to a scale question: "yes" keeps the current scale, a unit word sets it, a number or
 * "25.4 mm per unit" sets millimetres per unit, and "4200 = 4.2 m" style pairs are not guessed. Null when
 * the answer says nothing usable.
 */
export function parseScaleAnswer(text: string): ScaleInput | "confirm" | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^(y|yes|ok|okay|confirm(ed)?|correct|right|keep|looks good)\.?$/.test(t)) return "confirm";
  for (const [re, units] of UNIT_WORDS) if (re.test(t)) return { units };
  const perUnit =
    /^(?:1 ?(?:drawing )?unit ?= ?)?(\d+(?:\.\d+)?) ?mm(?: ?(?:per|\/) ?(?:drawing )?unit)?$/.exec(t);
  if (perUnit) return { mmPerUnit: Number(perUnit[1]) };
  if (/^\d+(\.\d+)?$/.test(t)) return { mmPerUnit: Number(t) };
  return null;
}

function unitsFor(mmPerUnit: number): DraftUnits {
  for (const [u, f] of Object.entries(UNIT_MM) as [Exclude<DraftUnits, "unknown">, number][])
    if (Math.abs(mmPerUnit - f) / f < SCALE_AGREEMENT) return u;
  return "unknown";
}

/** The draft with a person's scale: source "user", scale questions answered. Throws on a non-positive scale. */
export function withScale(draft: PlanDraft, input: ScaleInput | "confirm"): PlanDraft {
  let mmPerUnit: number;
  let note: string;
  if (input === "confirm") {
    if (draft.units.mmPerUnit === null)
      throw new RangeError("there is no scale to confirm; give units or a known length");
    mmPerUnit = draft.units.mmPerUnit;
    note = "confirmed";
  } else if ("units" in input) {
    mmPerUnit = UNIT_MM[input.units];
    note = input.units;
  } else if ("mmPerUnit" in input) {
    mmPerUnit = input.mmPerUnit;
    note = `${input.mmPerUnit} mm per unit`;
  } else {
    if (!(input.measuredUnits > 0)) throw new RangeError("the measured length must be positive");
    mmPerUnit = input.lengthMm / input.measuredUnits;
    note = `${input.lengthMm} mm over ${input.measuredUnits} units`;
  }
  if (!(Number.isFinite(mmPerUnit) && mmPerUnit > 0))
    throw new RangeError("the scale must be a positive number");
  return {
    ...draft,
    units: { ...draft.units, mmPerUnit, scaleSource: "user", detected: unitsFor(mmPerUnit) },
    questions: draft.questions.map((q) =>
      q.kind === "scale" && q.answer === null ? { ...q, answer: note } : q,
    ),
  };
}

/**
 * Record answers by question id. An answer to a scale question also sets the scale when it can be read.
 * Returns the ids that match no question and the scale answers that could not be read.
 */
export function applyAnswers(
  draft: PlanDraft,
  answers: Readonly<Record<string, string>>,
): { draft: PlanDraft; unknownIds: string[]; unreadable: string[] } {
  const unknownIds: string[] = [];
  const unreadable: string[] = [];
  let out: PlanDraft = draft;
  for (const [id, text] of Object.entries(answers)) {
    const q = out.questions.find((x) => x.id === id);
    if (!q) {
      unknownIds.push(id);
      continue;
    }
    if (q.kind === "scale") {
      const parsed = parseScaleAnswer(text);
      if (parsed === null) {
        unreadable.push(id);
        continue;
      }
      out = withScale(out, parsed);
    }
    out = { ...out, questions: out.questions.map((x) => (x.id === id ? { ...x, answer: text } : x)) };
  }
  return { draft: out, unknownIds, unreadable };
}

export interface DraftBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Extent of walls, rooms and openings in draft units, or null for an empty draft. */
export function draftBounds(draft: PlanDraft): DraftBounds | null {
  const pts = [
    ...draft.walls.flatMap((w) => w.points),
    ...draft.rooms.flatMap((r) => r.polygon ?? (r.labelAt ? [r.labelAt] : [])),
    ...draft.openings.map((o) => o.at),
  ];
  if (pts.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Stable short id for a draft's content, so a confirm call can name the draft it reviewed. */
export function draftId(draft: PlanDraft): string {
  const text = JSON.stringify(draft);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `draft_${h1.toString(36)}${h2.toString(36)}`;
}

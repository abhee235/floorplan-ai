// Finish words and baseboard defaults (ADR-014 D8). The properties panel and the agent's finish_wall tool
// both speak in these, so they live here once rather than in each: two places working out what "gloss"
// means is how they would come to mean different things.
import type { FinishRef } from "./schema.js";

/** A side's finish as a person names it, and the shininess each name stores. Matt stores none. */
export const FINISH_SHININESS = { matt: null, satin: 0.25, gloss: 0.6 } as const;

export type FinishName = keyof typeof FINISH_SHININESS;

export const FINISH_NAMES = Object.keys(FINISH_SHININESS) as FinishName[];

/** The named finish nearest a stored shininess, so a value set some other way still reads as one of three. */
export function finishNameOf(shininess: number | null): FinishName {
  if (shininess === null || shininess < 0.125) return "matt";
  return shininess < 0.425 ? "satin" : "gloss";
}

/**
 * A colour as someone wrote it, in the form the model stores ("#RRGGBB", upper case), or null when it is not
 * one. Takes three or six hex digits, with or without the hash, because that is how colours get copied
 * around, by people and by models alike.
 */
export function parseHexColour(text: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!m) return null;
  const digits = m[1] as string;
  const six = digits.length === 3 ? [...digits].map((d) => d + d).join("") : digits;
  return `#${six.toUpperCase()}`;
}

/** A finish with nothing set, to change one field of. */
export function blankFinish(): FinishRef {
  return { color: null, textureId: null, placement: null, mirrorForLeftSide: false, shininess: null };
}

/** A finish that says nothing is stored as no finish, so a reset side reads exactly like an untouched one. */
export function tidyFinish(f: FinishRef): FinishRef | null {
  const blank =
    f.color === null &&
    f.textureId === null &&
    f.placement === null &&
    f.shininess === null &&
    !f.mirrorForLeftSide;
  return blank ? null : f;
}

/** How deep a baseboard is when only its height was asked for: a common painted skirting board. */
export const SKIRTING_DEPTH = 12;

/** A baseboard deeper than this is a plinth or a slip, not a skirting board. */
export const SKIRTING_DEPTH_RANGE = { min: 1, max: 200 } as const;

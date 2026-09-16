// What the chrome says in words: the status bar, the zoom readout and the palette's sections
// (ADR-017 D1, D3, D5). Pure string building, kept out of the DOM shell so the wording is testable.
import type { CommandMatch } from "./commands.js";

/** Enough of an IR Problem to summarise; a real Problem satisfies it. */
export interface ProblemLike {
  severity: string;
}

const GROUP = " "; // narrow no-break space: "12 250" reads as one number, and never wraps

/** A length for the eye: grouped in thousands, as drawings write them. */
export function formatMm(mm: number, group = true): string {
  const rounded = Math.round(mm);
  const digits = Math.abs(rounded).toString();
  // drawings group at the thousand: "4 250" and "12 250", but "900" plain
  if (!group || digits.length < 4) return rounded.toString();
  const parts: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) parts.unshift(digits.slice(Math.max(0, end - 3), end));
  return `${rounded < 0 ? "-" : ""}${parts.join(GROUP)}`;
}

const MM_PER: Record<string, number> = { mm: 1, cm: 10, m: 1000 };

/**
 * A length someone typed, in whole millimetres, or null when the text is not one.
 *
 * Reads back what formatMm writes, so a grouped "12 250" is fine whatever space groups it. A unit may be
 * typed because "1.2 m" is how people think of a length even on a millimetre drawing; a bare number is
 * millimetres. Rounded, because Mm is an integer and the host refuses anything else. A comma is refused
 * rather than guessed at: it is a thousands separator in one locale and a decimal point in the next.
 */
export function parseMm(text: string): number | null {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(mm|cm|m)?$/.exec(text.replace(/\s/g, "").toLowerCase());
  if (!match) return null;
  const mm = Number(match[1]) * (MM_PER[match[2] ?? "mm"] ?? 1);
  return Number.isFinite(mm) ? Math.round(mm) : null;
}

/**
 * An angle someone typed, in degrees to a tenth, or null when the text is not one. The degree sign or
 * "deg" may follow; nothing else. A tenth because nothing on a plan is drawn finer, and a float typed as
 * "33.3" should not come back as 33.29999.
 */
export function parseDegrees(text: string): number | null {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:°|deg|degrees?)?$/.exec(
    text.replace(/\s/g, "").toLowerCase(),
  );
  if (!match) return null;
  const deg = Number(match[1]);
  return Number.isFinite(deg) ? roundTenth(deg) : null;
}

/** An angle for the eye and for parseDegrees alike: a tenth at most, and no ".0". */
export function formatDegrees(deg: number): string {
  return String(roundTenth(deg));
}

// Halves away from zero, not Math.round's towards +∞: a curve and its mirror image are the same size,
// so -45.25 and 45.25 have to round alike. `+ 0` turns the -0 a small negative rounds to into 0; it
// prints the same, but Object.is tells them apart, and so does a deep-equal of a command built from it.
const roundTenth = (n: number): number => (Math.sign(n) * Math.round(Math.abs(n) * 10)) / 10 + 0;

/** A length for a screen reader: plain digits, which are read as a number rather than spelled out. */
export function describeLength(mm: number): string {
  return `${Math.round(mm)} millimetres`;
}

/** The pointer's place on the plan, for the status bar. */
export function pointerText(at: { x: number; y: number } | null): string {
  if (!at) return "";
  return `x ${formatMm(at.x)} · y ${formatMm(at.y)} mm`;
}

export interface ProblemSummary {
  text: string;
  tone: "ok" | "warning" | "error";
}

/** "No problems", "1 error, 2 warnings" — never a code (ADR-017 D3). */
export function problemSummary(problems: readonly ProblemLike[]): ProblemSummary {
  const errors = problems.filter((p) => p.severity === "error").length;
  return problemCounts(errors, problems.length - errors);
}

/**
 * The same wording from the two counts alone. Severity is only ever "error" or "warning", so the counts
 * carry everything the sentence needs; a caller that already holds them should not have to build a list of
 * objects just to be counted again.
 */
export function problemCounts(errors: number, warnings: number): ProblemSummary {
  if (errors + warnings === 0) return { text: "No problems", tone: "ok" };
  const parts: string[] = [];
  if (errors) parts.push(`${errors} ${errors === 1 ? "error" : "errors"}`);
  if (warnings) parts.push(`${warnings} ${warnings === 1 ? "warning" : "warnings"}`);
  return { text: parts.join(", "), tone: errors ? "error" : "warning" };
}

/**
 * The drawing scale, as a drawing states it: "1:50" means one millimetre on the screen is fifty on the
 * plan. `pixelsPerMm` is the renderer's device pixels per millimetre, so the device pixel ratio has to
 * come out again before comparing with a real millimetre of screen (96 CSS pixels to the inch).
 */
export function scaleLabel(pixelsPerMm: number, devicePixelRatio = 1): string {
  if (!(pixelsPerMm > 0) || !(devicePixelRatio > 0)) return "—";
  const ratio = (devicePixelRatio * (96 / 25.4)) / pixelsPerMm;
  if (ratio >= 1) return `1:${Math.round(ratio)}`;
  return `${Math.round(1 / ratio)}:1`;
}

export interface CountsLike {
  walls: readonly unknown[];
  rooms: readonly unknown[];
  items: readonly unknown[];
}

/** What this level holds, for the properties panel when nothing is selected (ADR-017 D3). */
export function countsText(project: CountsLike | null): string {
  if (!project) return "Nothing loaded yet";
  const n = (list: readonly unknown[], one: string, many: string) =>
    `${list.length} ${list.length === 1 ? one : many}`;
  return [
    n(project.walls, "wall", "walls"),
    n(project.rooms, "room", "rooms"),
    n(project.items, "item", "items"),
  ].join(" · ");
}

export interface PaletteSection {
  group: string;
  items: CommandMatch[];
}

/** The palette's rows under their headings, each group first appearing where its best match ranked. */
export function paletteSections(matches: readonly CommandMatch[]): PaletteSection[] {
  const sections: PaletteSection[] = [];
  const byGroup = new Map<string, PaletteSection>();
  for (const match of matches) {
    const group = match.command.group;
    let section = byGroup.get(group);
    if (!section) {
      section = { group, items: [] };
      byGroup.set(group, section);
      sections.push(section);
    }
    section.items.push(match);
  }
  return sections;
}

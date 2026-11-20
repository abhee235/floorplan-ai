// What the model import dialog works out (ADR-010 D10, PRD P3-8), kept apart from the component so it can
// be tested: the size a model has once it is turned and stood up, in the units its file means, and the
// size a person asks for instead. The host normalises the file the same way and has the last word.
import type { Size3 } from "@fpv/ir";
import { CATEGORY_CHOICES } from "./catalog.js";

export type ModelUnits = "m" | "cm" | "mm" | "in";

/** What a file's numbers can mean, in the order offered. glTF says metres; plenty of files disagree. */
export const UNIT_CHOICES: readonly { value: ModelUnits; label: string; metres: number }[] = [
  { value: "m", label: "Metres", metres: 1 },
  { value: "cm", label: "Centimetres", metres: 0.01 },
  { value: "mm", label: "Millimetres", metres: 0.001 },
  { value: "in", label: "Inches", metres: 0.0254 },
];

/** What an imported model can be: any category but a door or a window, which need an opening. */
export const MODEL_CATEGORIES = CATEGORY_CHOICES.filter((c) => c.value !== "door" && c.value !== "window");

/** The host's limits on a side, in millimetres. */
export const SIDE_RANGE = { min: 1, max: 100_000 } as const;

/** A model's extent in its file's units, as the file is: x across, y up, z toward its front. */
export interface Extent {
  w: number;
  d: number;
  h: number;
}

/**
 * The extent once stood up (`tip` quarter turns about x) and turned (`turn` about the vertical). Quarter
 * turns only swap sides, so the box of the turned model is the turned box, exactly.
 */
export function shapedExtent(extent: Extent, turn: number, tip: number): Extent {
  const stood = tip % 2 === 1 ? { w: extent.w, d: extent.h, h: extent.d } : extent;
  return turn % 2 === 1 ? { w: stood.d, d: stood.w, h: stood.h } : stood;
}

/** An extent in millimetres, each side at least one, as a product's size is. */
export function sizeInMm(extent: Extent, units: ModelUnits): Size3 {
  const metres = UNIT_CHOICES.find((u) => u.value === units)?.metres ?? 1;
  const mm = (v: number) => Math.max(SIDE_RANGE.min, Math.round(v * metres * 1000));
  return { w: mm(extent.w), d: mm(extent.d), h: mm(extent.h) };
}

/**
 * What a file's units probably are, from its longest side: furniture tens of metres long was drawn in
 * centimetres, and thousands of metres long in millimetres. Anything else is taken at its word.
 */
export function suggestUnits(extent: Extent): ModelUnits {
  const longest = Math.max(extent.w, extent.d, extent.h);
  if (longest > 2500) return "mm";
  if (longest > 25) return "cm";
  return "m";
}

/**
 * A size with one side changed. Kept in proportion, the other sides follow by the same factor; otherwise
 * they stay as they were.
 */
export function withSide(size: Size3, side: keyof Size3, value: number, proportional: boolean): Size3 {
  if (!proportional || !(size[side] > 0)) return { ...size, [side]: value };
  const factor = value / size[side];
  const scaled = (v: number) => Math.min(SIDE_RANGE.max, Math.max(SIDE_RANGE.min, Math.round(v * factor)));
  return { w: scaled(size.w), d: scaled(size.d), h: scaled(size.h), [side]: value };
}

export function validSide(v: number): boolean {
  return Number.isInteger(v) && v >= SIDE_RANGE.min && v <= SIDE_RANGE.max;
}

/** A product's name from a model file's: "lounge_chair-02.glb" reads "Lounge chair 02". */
export function modelNameFromFile(fileName: string): string {
  const bare = fileName
    .replace(/^.*[\\/]/, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : "Imported model";
}

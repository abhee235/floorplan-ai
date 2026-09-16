// What the catalog tab shows about a search hit (P3-5), kept apart from the component so it can be tested:
// the words for a category, a size and a verification status, and the shape a search answer must have.
import { CATEGORIES } from "@fpv/catalog";
import type { Size3 } from "@fpv/ir";
import { formatMm } from "./status.js";

export interface CatalogHit {
  id: string;
  name: string;
  make: string;
  model: string;
  category: string;
  dims: Size3;
  verified: boolean;
  price: number | null;
  status?: string;
  /** Present on a generic shape: what to place instead of a product. */
  recipe?: unknown;
}

export interface CatalogPage {
  hits: CatalogHit[];
  total: number;
  cursor: string | null;
}

/** The categories a search can be narrowed to, in the catalog's own order, with the words to show. */
export const CATEGORY_CHOICES: readonly { value: string; label: string }[] = CATEGORIES.map((value) => ({
  value,
  label: categoryLabel(value),
}));

/** "video-bar" is "Video bar"; the catalog's ids are slugs, not words. */
export function categoryLabel(category: string): string {
  const words = category.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A size as a drawing writes it, and as a screen reader should say it. */
export function sizeText(size: Size3): { shown: string; said: string } {
  return {
    shown: `${formatMm(size.w)} × ${formatMm(size.d)} × ${formatMm(size.h)} mm`,
    said: `${size.w} wide, ${size.d} deep, ${size.h} high, in millimetres`,
  };
}

/**
 * What to say about how far a product can be trusted, or null when there is nothing to warn about. Only a
 * verified or hand-checked product needs no word; an unverified one's size may be wrong (spec 02 section 6).
 */
export function trustNote(hit: CatalogHit): string | null {
  if (hit.recipe) return "Generic";
  if (hit.verified) return null;
  return hit.status === "rejected" ? "Rejected" : "Unverified";
}

/** A search answer as the host's tool call returns it, or null when it is not one. */
export function pageOf(result: unknown): CatalogPage | null {
  const r = (result as { result?: unknown } | null)?.result as
    | { hits?: unknown; total?: unknown; cursor?: unknown }
    | undefined;
  if (!r || !Array.isArray(r.hits) || typeof r.total !== "number") return null;
  return {
    hits: r.hits as CatalogHit[],
    total: r.total,
    cursor: typeof r.cursor === "string" ? r.cursor : null,
  };
}

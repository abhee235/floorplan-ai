// The seed library (ADR-008 D5): installed on first run as library "seed"; a newer seed version in a
// later release replaces it through the normal library precedence (C-027), and products a user wrote
// directly are never touched.
import type { LibraryManifestInput } from "./schema.js";
import { SEED_PRODUCTS } from "./seed/products.js";

export const SEED_LIBRARY_ID = "seed";
export const SEED_VERSION = "1.0.0";

export const SEED_LIBRARY: LibraryManifestInput = {
  id: SEED_LIBRARY_ID,
  name: "Built-in seed products",
  version: SEED_VERSION,
  licence: { id: "own", author: null, sourceUrl: null, attribution: null },
  provider: null,
  products: SEED_PRODUCTS,
  textures: [],
  assets: { version: 1, entries: [] },
  localized: {},
};

/** Anything that can install a library manifest and say which versions it holds. */
export interface SeedTarget {
  library(id: string, version: string): unknown | null;
  installLibrary(manifest: LibraryManifestInput, now: string): unknown;
}

/** Install the seed unless this exact version is already present. Returns true when it installed. */
export function ensureSeed(store: SeedTarget, now: string): boolean {
  if (store.library(SEED_LIBRARY_ID, SEED_VERSION)) return false;
  store.installLibrary(SEED_LIBRARY, now);
  return true;
}

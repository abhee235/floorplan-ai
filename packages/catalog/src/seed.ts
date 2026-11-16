// The seed library (ADR-008 D5): installed on first run as library "seed"; a newer seed version in a
// later release replaces it through the normal library precedence (C-027), and products a user wrote
// directly are never touched.
import { GENERATED_TEXTURES } from "@fpv/assets";
import type { LibraryManifestInput } from "./schema.js";
import { SEED_PRODUCTS } from "./seed/products.js";

export const SEED_LIBRARY_ID = "seed";
export const SEED_VERSION = "1.2.0";

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

/** The textures the app draws itself (P3-5), as a library of their own so they are listed and snapshotted
 *  like any other. They have no files, so nothing about them needs verifying. */
export const GENERATED_LIBRARY_ID = "generated";
export const GENERATED_VERSION = "1.0.0";

export const GENERATED_LIBRARY: LibraryManifestInput = {
  id: GENERATED_LIBRARY_ID,
  name: "Built-in drawn textures",
  version: GENERATED_VERSION,
  licence: { id: "generated", author: null, sourceUrl: null, attribution: null },
  provider: null,
  products: [],
  textures: GENERATED_TEXTURES.map((t) => ({
    id: `${GENERATED_LIBRARY_ID}/${t.name}`,
    name: t.title,
    image: `generated:${t.name}`,
    widthMm: t.widthMm,
    heightMm: t.heightMm,
    transparent: false,
    creator: null,
    licence: { id: "generated", author: null, sourceUrl: null, attribution: null },
    tags: [...t.tags],
  })),
  assets: { version: 1, entries: [] },
  localized: {},
};

/** Anything that can install a library manifest and say which versions it holds. */
export interface SeedTarget {
  library(id: string, version: string): unknown | null;
  installLibrary(manifest: LibraryManifestInput, now: string): unknown;
}

/**
 * Install the seed products and the drawn textures unless these exact versions are already present.
 * Returns true when it installed either.
 */
export function ensureSeed(store: SeedTarget, now: string): boolean {
  let installed = false;
  for (const [id, version, manifest] of [
    [SEED_LIBRARY_ID, SEED_VERSION, SEED_LIBRARY],
    [GENERATED_LIBRARY_ID, GENERATED_VERSION, GENERATED_LIBRARY],
  ] as const) {
    if (store.library(id, version)) continue;
    store.installLibrary(manifest, now);
    installed = true;
  }
  return installed;
}

# Spec 02: Catalog, texture, and asset manifest schemas

Status: Draft
Date: 2026-09-14
Implements: ADR-008, ADR-010
Packages: `packages/catalog`, `packages/assets`
Ledger coverage: section 7

## 1. Product

```ts
export const Category = z.enum([
  "display", "video-bar", "camera", "ceiling-mic", "table-mic", "ceiling-speaker", "soundbar",
  "amplifier", "dsp", "controller", "touch-panel", "scheduler", "mount", "cable", "connector",
  "switch", "rack", "table", "desk", "chair", "sofa", "storage", "whiteboard", "door", "window",
  "partition", "lighting", "appliance", "plant", "other",
]);

export const MountPoint = z.object({
  name: z.string().min(1),                 // "top", "front", "underside"
  kind: z.enum(["surface", "wall-face", "ceiling-face"]),
  dropRatio: Fraction.nullable(),          // for "surface": fraction of height where items land; null: not stackable (F-062)
  offset: z.object({ x: Mm, y: Mm, z: Mm }).nullable(),
});

// Axes are ratios of width and depth and may fall outside the leaf (a hinge past the frame, O-087);
// angles are signed degrees so a sash can open either way (-90 to 270 in O-087).
export const Sash = z.object({ xAxis: z.number(), yAxis: z.number(), width: Fraction, startAngle: DegSigned, endAngle: DegSigned });

export const OpeningSpec = z.object({
  embed: z.object({ thickness: Fraction, distance: Fraction, width: Fraction, left: Fraction, height: Fraction, top: Fraction }),
  cutOutPath: z.string().nullable(),       // SVG path in the unit square, y down as SVG; null means rectangle
  cutBothSides: z.boolean(),               // default true
  sashes: z.array(Sash),
});

export const Price = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().length(3),
  type: z.enum(["list", "street", "quote"]),
  sourceUrl: z.string().url().nullable(),
  capturedAt: Timestamp,
  expiresAt: Timestamp,
});

export const Verification = z.object({
  status: z.enum(["verified", "unverified", "rejected", "manual"]),
  confidence: Fraction,
  sources: z.array(z.string().url()),
  verifiedAt: Timestamp.nullable(),
  notes: z.string().nullable(),
});

export const Product = z.object({
  id: ProductId,                           // slug: lowercase make and model, [a-z0-9-], e.g. "samsung-qm75c"
  make: z.string().min(1),
  model: z.string().min(1),
  variant: z.string().nullable(),
  name: z.string().min(1),
  category: Category,
  dims: Size3,                             // all > 0 (C-006 reversed)
  weightKg: z.number().positive().nullable(),
  mount: z.object({ kinds: z.array(MountKind).min(1), vesa: z.string().nullable(), defaultHeight: MmNonNegative.nullable() }),
  mountPoints: z.array(MountPoint),
  clearance: z.object({ front: MmNonNegative, back: MmNonNegative, left: MmNonNegative, right: MmNonNegative }).nullable(),
  deformable: z.boolean(),
  meshRotation: z.array(z.number()).length(9).nullable(),   // row-major 3x3; null identity
  assetKey: AssetKey.nullable(),           // null: resolved from category and size class
  materialSlots: z.array(z.string()),      // copied from the asset manifest at link time
  presets: z.array(z.string()),            // articulation preset names (reserved)
  opening: OpeningSpec.nullable(),         // required when category is door or window (validated)
  specs: z.record(z.union([z.string(), z.number(), z.boolean()])),
  price: Price.nullable(),
  verification: Verification,
  lifecycle: z.enum(["active", "discontinued", "unknown"]),
  tags: z.array(z.string()),
  aliases: z.array(z.string()),            // search aliases
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
```

Validation beyond shape: `opening` present iff category is door or window;
`dims` plausible for category (a display deeper than 300 mm is a warning);
`mount.kinds` includes `wall` when `mount.vesa` is set; duplicate `id` on
insert is an error (C-026 reversed).

### 1.1 Snapshot in projects

```ts
export const ProductSnapshot = Product.pick({
  id: true, make: true, model: true, name: true, category: true, dims: true, weightKg: true, mount: true,
  mountPoints: true, clearance: true, deformable: true, meshRotation: true, assetKey: true, materialSlots: true,
  opening: true, specs: true, price: true, verification: true,
}).extend({ snapshotAt: Timestamp });
```

A project carries `catalogRefs` for every product any item or opening
references. Commands that reference a product copy the snapshot on first
use; `catalog.refresh` updates snapshots on request and records the diff.

### 1.2 Category specs, first release

| Category | Required spec keys |
|---|---|
| display | `diagonalIn`, `resolution`, `vesa`, `powerW` |
| video-bar, camera | `fovDeg`, `maxRoomDepthMm`, `interfaces` |
| ceiling-mic, table-mic | `coverageRadiusMm`, `channels` |
| ceiling-speaker, soundbar | `coverageRadiusMm`, `impedanceOhm`, `powerW` |
| amplifier | `channels`, `powerPerChannelW` |
| dsp | `inputs`, `outputs`, `dante` (boolean) |
| switch | `ports`, `poeBudgetW` |
| cable | `type`, `lengthMm`, `connectors` |
| table, desk | `seats` |

Rules in spec 07 read these keys.

## 2. Texture

```ts
export const Texture = z.object({
  id: TextureId,                           // "<library>/<slug>"
  name: z.string().min(1),
  image: z.string(),                       // asset file reference by hash: "sha256:<hex>"
  widthMm: MmPositive,
  heightMm: MmPositive,
  transparent: z.boolean(),
  creator: z.string().nullable(),
  licence: Licence,
  tags: z.array(z.string()),
});
export const TextureSnapshot = Texture;  // whole record, small
```

## 3. Asset manifest

```ts
export const Licence = z.object({
  id: z.enum(["CC0-1.0", "CC-BY-3.0", "CC-BY-4.0", "generated", "own"]),
  author: z.string().nullable(),
  sourceUrl: z.string().url().nullable(),
  attribution: z.string().nullable(),      // text rendered in credits, verbatim
});

export const Articulation = z.object({ node: z.string(), kind: z.enum(["hinge", "slide", "lift", "tilt"]), axis: z.enum(["x", "y", "z"]), min: z.number(), max: z.number(), unit: z.enum(["deg", "mm"]) });

export const AssetEntry = z.object({
  key: AssetKey,
  kind: z.enum(["gltf", "recipe"]),
  file: z.string().nullable(),             // relative path under assets/files for gltf; null for recipe
  recipe: z.string().nullable(),           // recipe kind for recipe entries
  bbox: z.object({ w: z.number(), d: z.number(), h: z.number() }),   // metres, after normalisation
  triangles: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  materialSlots: z.array(z.string()),      // glTF material names, unique
  articulations: z.array(Articulation),
  presets: z.record(z.record(z.number())), // preset name -> node -> value
  planIcon: z.string().nullable(),         // relative path to a PNG rendered top-down
  licence: Licence,
  tags: z.array(z.string()),
});

export const AssetManifest = z.object({ version: z.literal(1), entries: z.array(AssetEntry) });
```

Constraints: `key` unique; a gltf entry has a file and a sha256; `bbox` all
positive; `triangles` at most 30 000 and `bytes` at most 2 097 152 for gltf
entries; `licence.id` never NC, ND, or copyleft; `attribution` required when
`licence.id` is CC-BY.

### 3.1 Size classes and key resolution

`resolveAssetKey(product): AssetKey`:

1. If `product.assetKey` is set and exists, use it.
2. Else `category/default/<sizeClass>` where sizeClass is chosen from the
   manifest entries under `category/default/*` by nearest bounding box
   (sum of absolute log ratios of w, d, h).
3. Else `category/default/std` if present, else the recipe for the category
   from the table below, else `other/default/std` which is a labelled box.

| Category | Fallback recipe |
|---|---|
| table, desk | table |
| chair, sofa | chair |
| display | display |
| video-bar, soundbar | video-bar |
| ceiling-speaker | ceiling-speaker |
| ceiling-mic | ceiling-mic |
| everything else | box |

A product without a model of its own is drawn as that recipe, built at the
product's size, and takes the recipe's material slots, so its parts can be
finished like any recipe's (P3-5). Recipes are built one part per slot:

| Recipe | Slots |
|---|---|
| table | top, legs |
| chair | fabric, frame |
| display | screen, frame |
| box, cylinder, video-bar, ceiling-speaker, ceiling-mic | body |

A product whose model the viewer has not loaded is a white box at its size
(S-042).

## 4. Library package

`library.json` at the root of a library zip:

```ts
export const LibraryManifest = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  licence: Licence,
  provider: z.string().nullable(),
  products: z.array(Product),
  textures: z.array(Texture),
  assets: AssetManifest,
  localized: z.record(z.record(z.string())),   // locale -> product or texture id -> name
});
```

Files sit beside it under `assets/files`, `textures/`, and `icons/`. Install
verifies every declared sha256 and byte count first (C-025), copies the tree
to `<data>/libraries/<id>/<version>/` (C-029) and re-indexes; the highest
version of an id wins product clashes (C-027); a product id already provided
by another owner fails the install whole (C-026 reversed); uninstall removes
one version and re-indexes from what remains. Phase 1 installs from an
extracted directory; zip extraction arrives with the asset packs in phase 2.
Flat `key#index=value` catalogs in centimetres are converted by
`importFlatCatalog` (ledger C-001..C-029, O-007..O-013, O-084..O-087) into
product records plus file references for the installer.

## 5. Catalog store

SQLite tables: `products(id primary key, make, model, category, status, json)`,
`textures(id primary key, json)`, `assets(key primary key, library, version, json)`,
`libraries(id, version, installedAt)`, plus an FTS5 table over product name,
model, tags and aliases. All writes are in a transaction. The store exposes:

```ts
get(id), upsert(product), remove(id)
search({ kind, query, category, limit, cursor }): { hits, total, cursor }
byCategory(category, constraints): Product[]
snapshot(ids): Record<ProductId, ProductSnapshot>
```

Search order: exact id (as typed or as the slug of make and model); exact
model with spaces, dashes and case ignored; every query word in name, model,
make or variant; tags and aliases, with the synonym table (tv, screen, couch
and the like) applied; FTS ranking with each word as a prefix. Limit at most
20; `total` counts the whole ordered list and `cursor` pages through it.
An empty query lists the catalog to browse it: a category's products by name
when a category is given, otherwise every product by category and name.
Rejected products answer only to their exact id. Ambiguity returns all hits
with id, category, dims and the tier that matched. The store is reached
through the Node-only `@fpv/catalog/store` entry (ADR-002); `node:sqlite`
provides SQLite, so there is no native module.

## 6. Verification records

`verify_product` writes a `VerificationRun` row per attempt for audit:
`{ id, productId, make, model, startedAt, finishedAt, provider, queries: string[], pagesFetched: string[], proposal: ProductProposal | null, score, outcome, notes: string[] }`.
`ProductProposal` is the JSON the verifier model must return: `found`, make,
model, name, category, `dims` in mm, `weightKg`, `mount`, `specs`, `price`
with its `sourceUrl`, lifecycle, and a `fieldSources` map from field name to
page URL. Scoring per ADR-008 D3.

### 6.1 Grounding and scoring

A value is **grounded** when a fetched page that names the model states it:
lengths are read with their units (mm, cm, m, inches, feet, including
`a x b x c unit` runs and units declared in brackets before or after) and
match within 2 percent or half a millimetre; masses in kg or lb within 3
percent; string specs by their letters and digits.

Dimensions are grounded **as a group**: three distinct numbers, one per
dimension, within 200 characters of each other, and inch marks count
together only when they belong to one `a x b x c` run. A page listing screen
size options (75", 43") and a marketing line ("28.5mm depth") must not state
1904 x 29 x 1085 mm one number at a time; a live run produced exactly that
false match before this rule. Numeric specs are grounded within 1 percent
only when a word for the spec starts at a word boundary within 60 characters
before or 40 after the number (power, channel, coverage, field of view, and
the words of the key's own name for other keys), or the spec's unit follows
the number directly (W, °, Ω, inch marks). Points: manufacturer page naming the model 0.30;
all three dimensions on one page 0.30 (two of three 0.15); the same
dimensions on a second host 0.15; grounded fraction of numeric specs and
weight 0.15; plausible size for the category 0.10 (implausible caps the
total at 0.40). **verified** needs grounded dimensions and at least 0.60.
**rejected** means no page names the model; no model is asked and nothing
is saved. Otherwise **unverified**.

Persistence: a verified result replaces dimensions, weight, grounded specs,
grounded price (expiring after 90 days) and lifecycle. For a product a
library provides, those fields are stored as an overlay that survives later
library versions. A new product is created, unverified or verified, only
when its dimensions are grounded. An unverified attempt never downgrades a
verified record, and a `manual` record is never touched. A current verified
record answers from the catalog without searching unless `force` is set or
its price has expired.

Pages come from the configured search provider (manufacturer domains first,
at most three) or from `sources`. HTML and plain text are read; PDF spec
sheets are reported and skipped until a PDF text reader lands. The host's
page fetcher refuses loopback, private and link-local addresses on every
redirect hop unless the configuration allows them, and caps bodies at 3 MB.

## 7. Ledger coverage for this spec

Tests in `packages/catalog` and `packages/assets`:

- Fractions and defaults: O-007, O-008 (defaults 1 and 0 as fractions),
  O-009 (cutBothSides default true), O-010 (deformable, product level),
  O-011 (reversed: null means rectangle), O-012, O-013 (doors never tilt:
  `mount.kinds` excludes nothing, but items with opening products are not
  items at all), O-084..O-087 (sash conversion in library import: cm to
  fractions, degrees kept).
- Catalog reading and libraries: C-001 (no index scan: arrays), C-003
  (reversed), C-004..C-008 (required keys and defaults via zod), C-009,
  C-010, C-011 (single default), C-012..C-014 (sash and light lists validated
  by schema), C-016, C-017 (strict 9 values), C-019 (bytes from manifest),
  C-020, C-021 (assets by hash, no multi-part), C-022, C-023, C-026
  (duplicates rejected), C-027 (highest version wins), C-030..C-033
  (categories are a closed enum; ordering is a view concern), C-034, C-035
  (localised names only, never dimensions), C-038, C-039 (plan icon from
  manifest), C-040, C-041..C-048 (import wizard behaviours, ADR-010 D10),
  C-049 (no mesh-derived cut-outs), C-050 (invalid path warns and falls
  back to rectangle).
- Sync and loading: S-039..S-043 (cache by key, clone, placeholder, red box).

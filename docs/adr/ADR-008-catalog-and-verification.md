# ADR-008: Product catalog record, verification pipeline, and persistence

Status: Proposed
Date: 2026-09-14
Supersedes: section 5.7 (catalog) of 00-brainstorm.md
Related: ADR-001 (openings, items), ADR-006 (search_catalog, verify_product), ADR-009 (BOM), ADR-010 (assets)
Ledger lines this ADR must satisfy: O-007..O-013, O-084..O-087, C-001..C-040

## Context

The BOM is only as good as the catalog. The user chose "agent proposes from
vendor knowledge", which produces confident but sometimes wrong model numbers
and stale prices. Flat key=value catalog files can carry the door and window
intelligence we need (embed fractions, cut-out shape, mesh rotation), but
their readers tend to parse leniently and let the first duplicate win.

## Decision

### D1. Product record

Normative zod schema in `catalog`. Sketch:

```
Product {
  id: string                        // "<make>-<model>" slug, unique, rejected on duplicate (C-026 reversed)
  make, model, variant?, name       // display name
  category: Category                // closed enum, see D2
  dims: { w: mm, d: mm, h: mm }     // required, all > 0 (C-006 reversed)
  weightKg?: number
  mount: { kinds: MountKind[], vesa?: string, defaultHeight?: mm }
  mountPoints?: MountPoint[]        // named surfaces others can attach to: "top" (dropOnTop ratio), "front", ...
  clearance?: { front?, back?, left?, right?: mm }   // access and egress checks
  deformable: boolean               // non-uniform scaling allowed
  meshRotation?: number[9]          // 3x3 row-major, identity default
  assetKey?: string                 // ADR-010; defaults to category + size class
  opening?: {                       // only for door and window products
    embed: { thickness: fraction, distance: fraction, width: fraction, left: fraction, height: fraction, top: fraction }
    cutOutPath?: string             // SVG path in unit square; null means rectangle (O-011 reversed: we never derive from mesh)
    cutBothSides: boolean           // default true
    sashes?: Sash[]                 // fractions and degrees (O-084, C-013)
  }
  specs: Record<string, string | number | boolean>   // category-specific: diagonal, ports, coverage radius, channels
  price?: { amount, currency, type: "list" | "street" | "quote", sourceUrl, capturedAt, expiresAt }
  verification: { status: "verified" | "unverified" | "rejected" | "manual", confidence: number, sources: string[], verifiedAt?, notes? }
  lifecycle: "active" | "discontinued" | "unknown"
  tags: string[]
  createdAt, updatedAt
}
```

Fractions are validated to the closed range 0 to 1 (O-005 reversed). Sash
angles are degrees. Catalog dimensions are the truth for placement and BOM;
the mesh is scaled to them (ADR-003 D3).

### D2. Categories

Closed enum, extendable only by a schema change: `display`, `video-bar`,
`camera`, `ceiling-mic`, `table-mic`, `ceiling-speaker`, `soundbar`,
`amplifier`, `dsp`, `controller`, `touch-panel`, `scheduler`, `mount`,
`cable`, `connector`, `switch`, `rack`, `table`, `desk`, `chair`, `sofa`,
`storage`, `whiteboard`, `door`, `window`, `partition`, `lighting`,
`appliance`, `plant`, `other`.

### D3. Verification pipeline

`verify_product(make, model)` runs:

1. **Normalise** the proposal: trim, canonical make spelling from an alias
   table, model number uppercase without spaces.
2. **Local hit**: if the catalog has the id and the price is not expired,
   return it.
3. **Search**: query the configured web search provider for the make and
   model plus "specifications". Providers are behind one interface with
   implementations for a generic HTTP search API and, in development, the
   Claude Code environment's own search and fetch.
4. **Fetch and extract**: fetch up to three result pages, prefer the
   manufacturer domain, and ask the verifier model for a JSON `ProductProposal`
   with dimensions, weight, category, specs, price if shown, and a source
   URL per field. Validated by zod, retried on failure (ADR-007 D2).
5. **Score**: confidence from manufacturer-domain presence, field agreement
   across sources, and dimension plausibility for the category. Below 0.6
   the status is `unverified`; nothing found is `rejected`. A value earns
   points only when a fetched page states it (grounding, spec 02 section
   6.1), and `verified` additionally requires grounded dimensions, so a
   confident model output that no page supports can never verify. When the
   caller supplies `sources` and a `proposal` (the development path with
   Claude Code), the host fetches the pages itself and scores the proposal
   the same way.
6. **Persist** with sources and timestamps. Prices expire after 90 days by
   default; expired prices mark the product `unverified` for pricing only.
7. A human can set `manual` status with a note, which the pipeline never
   overrides.

Unverified products may be placed and rendered, but the BOM marks their lines
and `export` refuses a final BOM containing them unless `includeUnverified`
is passed and the sheet is watermarked.

### D4. Search behaviour

`search_catalog` matches exact id, then name and model substring, then tags,
then an alias table (sofa and couch, TV and display), with a hard limit of
20 and a total count. Ambiguity returns every candidate with id, category and
dimensions (ADR-006 D4).

### D5. Persistence

- SQLite, one file `catalog.db` in the user's data directory, through Node's
  built-in `node:sqlite` binding (no native module to build or ship; the
  earlier choice of `better-sqlite3` is withdrawn for that reason), with the
  product JSON in a column and indexed columns for id, make, model, category,
  status. Full-text search over name, model, make, tags and aliases. The
  store lives behind the `@fpv/catalog/store` entry so the package's root
  entry stays free of Node APIs (ADR-002).
- A seed catalog ships as JSON in `catalog/seed` with primitive recipes and
  a small set of verified common products, loaded on first run.
- Projects snapshot every referenced product into `catalogRefs` (ADR-001),
  so a project file is self-contained and a later catalog change does not
  silently re-price an old quote.
- Import and export of the catalog as JSON for sharing between machines.

### D6. Primitive recipes

Recipes are catalog-like records without make and model, with parametric
dimensions and an `assetKey` that names a generated mesh: `table(w, d, h)`,
`chair(w, d, h)`, `display(diagonalInches)`, `box(w, d, h)`, `ceiling-speaker(diameter)`.
They appear in `search_catalog` with `kind: "recipe"` and produce BOM lines
marked as placeholders.

## Alternatives considered

- **Trust vendor knowledge as-is.** Rejected by the user after the risk was
  explained.
- **JSON files instead of SQLite.** Fine for the seed; rejected for the live
  catalog because of search and concurrent access from the host and the app.
- **Deriving cut-out shapes from meshes** (O-011, O-077). Rejected: the
  catalog record carries the path explicitly; missing means rectangle.
- **First-wins duplicate ids** (C-026). Rejected: duplicates are an error.

## Consequences

- `verify_product` needs a search provider configured; without one the tool
  is advertised but returns "unavailable because no search provider".
- The Space Designer's room recipes reference products by id or by a
  category plus constraint (`display >= 75 inch`), resolved through
  `search_catalog` and, when missing, `verify_product`.
- The catalog schema is the second most important schema after the IR and is
  versioned and migrated the same way.

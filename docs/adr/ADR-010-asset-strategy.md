# ADR-010: 3D asset strategy, asset keys, offline conversion, and licence manifest

Status: Proposed
Date: 2026-09-14
Supersedes: section 5.9 of 00-brainstorm.md
Related: ADR-003 (rendering), ADR-008 (catalog assetKey)
Ledger lines this ADR must satisfy: F-121..F-128, C-041..C-047, S-039..S-043

## Context

The user chose primitives first, curated free packs, and AI-generated meshes
later, with no vendor CAD. Loading OBJ, Collada and 3DS inside zip files at
runtime means normalising every mesh on every load. We want glTF only,
normalised offline, keyed by category and size class so one mesh serves many
products, and a licence record per asset.

## Decision

### D1. Asset key

`assetKey = <category>/<variant>/<sizeClass>`, for example
`chair/task/std`, `display/flat/75`, `table/rect/240x120`, `ceiling-speaker/round/std`.
A product without an explicit `assetKey` resolves to `<category>/default/<nearest size class>`.
The registry maps keys to either a glTF file or a primitive recipe. Size
class is a bucket of the catalog dimensions; the mesh is still scaled to the
exact product dimensions at placement (ADR-003 D3), so buckets only pick the
best-looking base mesh.

### D2. Tiers

1. **Primitive recipes** generate meshes in code: box, cylinder, extruded
   profile, table with legs and top, chair (seat, back, legs), display panel
   with bezel, ceiling speaker disc, video bar. Always available. Ships in
   phase 0.
2. **Curated packs**: CC0 or CC-BY furniture and AV models converted to
   glTF. Each asset has a manifest entry with source URL, author, licence,
   and attribution text. CC-BY attribution is rendered in an About panel and
   in exports. No NC, ND, or copyleft art licences.

   Decision: source furniture from the **original authors' own
   collections** (Kator Legaz, Reallusion, individual Blend Swap authors,
   Poly Haven, Kenney, Quaternius) under their own CC-BY or CC0 terms, with
   attribution to those authors only, and never take any set under the Free
   Art License, which is copyleft. AV equipment (displays, bars,
   ceiling speakers, mics) is not in any of those packs and comes from
   primitives first, then generated meshes.
3. **AI-generated meshes**: allowed for categories with no pack asset, run
   offline, and always normalised to the catalog bounding box because
   generator scale is never trusted. Marked in the manifest as generated.

Vendor CAD and BIM files are out of scope for now.

### D3. Offline conversion pipeline

`tools/assets` scripts, run by a developer, not at runtime:

- Input: source model in any format Blender can read.
- Blender headless: import, apply transforms, recentre so the footprint
  centre is at the origin and the base sits on y = 0, rotate to y up with
  the front facing -z, scale to metres, decimate above 30,000 triangles,
  bake or drop textures above 1024 pixels, export glTF binary with
  meshopt compression.
- Post-process: validate with the glTF validator, compute the bounding box,
  write the manifest entry with size, triangle count, and SHA-256.
- The resulting file is named by asset key and placed under `assets/files`.

Because every asset is pre-oriented and pre-scaled, the runtime stage one
normalisation (ADR-003 D3) reduces to a bounding-box check and the catalog
`meshRotation` is rarely needed.

### D4. Manifest and storage

```
AssetEntry { key, file, kind: "gltf" | "recipe", bbox: { w, d, h } (metres), triangles, bytes, sha256,
             licence: { id: "CC0" | "CC-BY-4.0" | "generated" | "own", author?, sourceUrl?, attribution? }, tags }
```

`assets/manifest.json` is committed. Binary files are not committed; a
`pnpm assets:fetch` script downloads them from a release bucket by hash. A
small seed set (primitives need none) is enough for phase 0 and 1.

### D5. Runtime loading

- Loaded by asset key through one cache, cloned per item with shared
  geometry and per-item materials (S-039, S-040).
- Placeholder while loading: a neutral box at product size. Failure: red box
  and a logged warning naming the key (S-042, S-043). Failure never blocks
  the BOM or validation.
- Plan icons for the 2D view are generated once per asset key by rendering a
  top-down orthographic view to a small PNG at build time and stored beside
  the asset; recipes draw their own plan symbol.

### D6. Budgets

Per asset: 30,000 triangles, 2 MB after compression. Per scene: instancing
means a 500-desk floor loads each asset once.

### D7. Textures and finishes

A finish is a colour or a texture applied to a wall side, a floor, a
ceiling, or a whole item. The texture record and its placement, used by
`FinishRef` in ADR-001:

```
Texture { id, name, image: assetRef, widthMm, heightMm, creator, licence, transparent: boolean, tags }
FinishRef { color?: "#RRGGBB", textureId?, placement?: { offsetX: fraction, offsetY: fraction, angle: degrees, scale: number, fit: "tile" | "stretch" }, mirrorForLeftSide?: boolean, shininess?: number }
```

- Real-world texture size drives tiling: the engine generates UVs in
  millimetres along the surface (walls: distance along the side from its
  start corner and elevation; floors: plan coordinates), and the viewer sets
  the texture repeat to surface millimetres divided by texture millimetres.
  A 600 by 600 mm tile repeats every 600 mm on any wall length. `stretch`
  maps one image across the surface bounding box.
- Rotation and offset use the renderer's texture transform, never a
  re-rendered bitmap.
- Textures are content-addressed by hash, decoded once, mipmapped, and
  compressed to KTX2 offline when they enter the shared registry. Import of a
  user texture prompts to downscale above 2048 pixels on the long side and
  stores the original hash for de-duplication.
- Transparency is detected once at import and stored on the record so the
  viewer can pick double-sided alpha materials without inspecting pixels.
- Items use the UVs baked into their glTF; a whole-item finish overrides the
  base colour of every material unless a per-part override exists (D8).

### D8. Per-part material overrides

A product may expose named material slots, discovered from the glTF material
names at conversion time and stored on the asset manifest entry. An item may
carry `materials: { [slotKey]: FinishRef }` in the IR so a chair's fabric and
legs are recoloured independently. Rules:

- Slot keys are the glTF material names, made stable at conversion; they are
  mandatory and unique per asset.
- Slots named with the prefix `glass_` are never recoloured by a whole-item
  finish, so window panes and display screens stay as authored.
- Slots named with the prefix `edge_` may be excluded from recolouring by a
  product flag, for pieces with painted edges.
- The original material is kept as the reset value; overrides never mutate
  shared materials, they clone per item.
- Precedence: per-slot override, then whole-item finish, then the asset's
  own material.

### D9. Articulated parts and poses

Assets may declare named articulation nodes in the manifest (a door leaf, a
drawer, a sit-stand desk top, a display tilt). A pose is a named set of node
transforms. Products reference poses as `presets`; an item may store a
`pose` name or explicit node transforms. The engine applies the transforms
before computing the item's bounding box, and a posed item's footprint and
height follow the pose. Explicit manifest data, rather than transform groups
found by naming convention, gives opening doors and raised desks without a rig
format. Not in phase 0; the manifest field is reserved.

### D10. Library interchange and user imports

- A **library** is a zip with `library.json` (id, name, version, licence,
  provider, attribution), a manifest of assets, textures and products, and
  the files. Localised names are optional maps keyed by locale in the same
  manifest, not separate files. Install copies the zip into the user's
  library folder under its id and version; two versions may coexist and the
  higher version wins by product id; uninstall removes one version and
  re-indexes. Products already used by a project keep working because the
  project snapshots them (ADR-008 D5) and custom assets are copied into the
  project (ADR-012 D1).
- **User import of a model** accepts glTF directly and OBJ or FBX through the
  same offline converter run in-process; the import wizard sets size from
  the bounding box (model y becomes height, z becomes depth), lets the user
  turn the model in 90 degree steps to fix the front, clamps dimensions to
  at least 1 mm, and renders the catalog icon and plan icon from the model
  at a stored yaw, pitch and scale. Imported items are stored under the
  user's data directory keyed by hash and appear in a "User" category.
- **User import of a texture** accepts PNG, JPEG and WebP, asks for the
  real-world width in millimetres with height following the aspect ratio,
  defaults to 200 mm, and stores the file by hash.

## Alternatives considered

- **Runtime OBJ and Collada loading with zip archives.**
  Rejected: bigger loaders, slower, and normalisation on every load.
- **One mesh per SKU.** Rejected: hundreds of near-identical assets and a
  sourcing problem for every new product.
- **Committing binaries with git LFS.** Deferred; a fetch script with hashes
  is simpler until the pack grows.

## Consequences

- The catalog only needs an asset key; sourcing a nicer mesh for a category
  never touches the catalog or the IR.
- Blender is a developer tool for conversion only, never a runtime
  dependency, which honours the brainstorm decision.
- Attribution is a product feature (About panel, export footer), so the
  manifest must be complete before any CC-BY asset ships.

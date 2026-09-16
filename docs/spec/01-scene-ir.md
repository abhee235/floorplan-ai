# Spec 01: Scene IR schema

Status: Draft
Date: 2026-09-14
Implements: ADR-001, ADR-012 (serialisation rules)
Package: `packages/ir`
Ledger coverage: see section 9

This document is normative for the shape of a project. The zod definitions
below are the source; the TypeScript types are inferred from them and the
JSON Schema used by tool descriptors is generated from them. Prose explains
intent and lists the invariants the validator enforces.

## 1. Conventions

- Lengths are integer millimetres. Angles are degrees in the half-open range
  from 0 to 360, stored as numbers, normalised on write. Fractions are
  numbers from 0 to 1 inclusive.
- Plan coordinates: x right, y up. Rotation counter-clockwise positive, 0
  along +x. North is +y unless `meta.north` says otherwise; compass words in
  tools are computed from `meta.north`.
- Ids: `<type>_<6 base36 chars>`; unique per project; never reused.
- All collections are flat arrays at the project root, ordered by insertion.
  Order carries meaning only for draw order of items in the plan.
- Every field the schema defines is present in a saved file. Optional fields
  are written as `null`, never omitted. Unknown fields are preserved.

## 2. Primitives

```ts
import { z } from "zod";

export const Mm = z.number().int().finite();
export const MmPositive = Mm.min(1);
export const MmNonNegative = Mm.min(0);
export const Deg = z.number().finite().min(0).lt(360);       // normalised on write by normalizeDeg()
export const Fraction = z.number().finite().min(0).max(1);
export const Rgb = z.string().regex(/^#[0-9A-F]{6}$/);
export const Timestamp = z.string().datetime({ offset: true });

const idOf = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-z]{6}$`));
export const LevelId = idOf("level");
export const WallId = idOf("wall");
export const OpeningId = idOf("opening");
export const RoomId = idOf("room");
export const ItemId = idOf("item");
export const ZoneId = idOf("zone");
export const AnnotationId = idOf("annot");
export const ProductId = z.string().min(1);                  // catalog id, "<make>-<model>" slug (spec 02)
export const TextureId = z.string().min(1);
export const AssetKey = z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9x-]+$/);

export const Point = z.object({ x: Mm, y: Mm });
export const Polygon = z.array(Point).min(3);                // simple, counter-clockwise; checked by validate()
export const Size3 = z.object({ w: MmPositive, d: MmPositive, h: MmPositive });
```

`normalizeDeg(a)` returns `((a % 360) + 360) % 360`. Every command that writes
an angle applies it (ledger F-001, R-020).

## 3. Finishes

```ts
export const FinishRef = z.object({
  color: Rgb.nullable(),
  textureId: TextureId.nullable(),
  placement: z.object({
    offsetX: Fraction, offsetY: Fraction, angle: Deg, scale: z.number().positive(), fit: z.enum(["tile", "stretch"]),
  }).nullable(),
  mirrorForLeftSide: z.boolean(),                            // wall sides only; texture reads correctly from both faces
  shininess: Fraction.nullable(),
});
```

A finish with both `color` and `textureId` null means "asset default".

## 4. Entities

### 4.1 Level

```ts
export const Level = z.object({
  id: LevelId,
  name: z.string().min(1),
  elevation: Mm,                       // absolute, may be negative
  height: MmPositive,                  // default wall and ceiling height on this level
  floorThickness: MmNonNegative,
  index: z.number().int().min(0),      // tie-breaker among levels at one elevation
  viewable: z.boolean(),               // user flag: include this level at all
  backgroundImage: z.object({ assetRef: z.string(), scaleMmPerPx: z.number().positive(), origin: Point, angle: Deg }).nullable(),
});
```

Ordering of levels is by `(elevation, index)`; the array order in the file
is that order and is re-sorted on load. There is always at least one level.

### 4.2 Wall

```ts
export const WallKind = z.enum(["exterior", "interior", "partition", "glass"]);
export const Join = z.object({ wallId: WallId, end: z.enum(["start", "end"]) });

export const Wall = z.object({
  id: WallId,
  levelId: LevelId,
  start: Point,
  end: Point,
  thickness: MmPositive,
  height: MmPositive.nullable(),       // null: level.height
  heightAtEnd: MmPositive.nullable(),  // null: same as height; sloped top when different
  arcExtent: z.number().finite().min(-270).max(270).nullable(),   // degrees; null or 0: straight; sign per ADR-014 D4
  kind: WallKind,
  joins: z.object({ start: Join.nullable(), end: Join.nullable() }),
  finishes: z.object({ left: FinishRef.nullable(), right: FinishRef.nullable(), top: FinishRef.nullable() }),
  skirting: z.object({ left: Skirting.nullable(), right: Skirting.nullable() }),  // Skirting = { thickness: MmPositive, height: MmPositive, color: Rgb.nullable() }; null colour takes the side's (schema 2)
  properties: z.record(z.string()),
});
```

`arcExtent` of exactly 0 is written as `null`. `heightAtEnd` equal to
`height` is written as `null` (W-094).

### 4.3 Opening

```ts
export const OpeningKind = z.enum(["door", "window", "passage"]);

export const Opening = z.object({
  id: OpeningId,
  levelId: LevelId,
  wallId: WallId,
  kind: OpeningKind,
  position: Fraction,                  // centre along the wall centreline from start
  width: MmPositive,
  height: MmPositive,
  sill: MmNonNegative,                 // from level floor; doors and passages: 0
  swing: z.object({ hinge: z.enum(["start", "end"]), direction: z.enum(["left", "right"]) }).nullable(),  // relative to wall direction; null for windows and passages
  mirrored: z.boolean(),
  productId: ProductId.nullable(),     // door or window product; embed fractions and cut-out path come from it
  recipe: z.object({ style: z.enum(["single", "double", "sliding", "glazed", "plain"]) }).nullable(),   // used when productId is null
  finishes: z.object({ frame: FinishRef.nullable(), leaf: FinishRef.nullable() }),
  properties: z.record(z.string()),
});
```

An opening always cuts both faces of its wall. Its depth is the wall
thickness; the product's embed fractions describe where the frame sits
within that depth (spec 02).

### 4.4 Room

```ts
export const RoomPurpose = z.enum([
  "meeting", "huddle", "boardroom", "training", "open-office", "focus", "reception",
  "cafeteria", "corridor", "utility", "storage", "restroom", "other",
]);

export const Room = z.object({
  id: RoomId,
  levelId: LevelId,
  name: z.string().nullable(),
  polygon: Polygon,                    // counter-clockwise
  holes: z.array(Polygon),             // clockwise
  purpose: RoomPurpose,
  capacity: z.number().int().min(0).nullable(),
  ceilingHeight: MmPositive.nullable(),// null: level.height
  finishes: z.object({ floor: FinishRef.nullable(), ceiling: FinishRef.nullable() }),
  floorVisible: z.boolean(),
  ceilingVisible: z.boolean(),
  label: z.object({ offset: Point, angle: Deg, showArea: z.boolean() }),   // offset from the label anchor (section 7)
  source: z.enum(["manual", "detected", "imported"]),
  boundingWallIds: z.array(WallId),    // for detected rooms; used to mark them stale (ADR-015)
  properties: z.record(z.string()),
});
```

### 4.5 Item

```ts
export const PrimitiveRecipe = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("box"), size: Size3, label: z.string() }),
  z.object({ kind: z.literal("cylinder"), diameter: MmPositive, height: MmPositive, label: z.string() }),
  z.object({ kind: z.literal("table"), size: Size3, shape: z.enum(["rect", "round", "boat"]) }),
  z.object({ kind: z.literal("chair"), size: Size3 }),
  z.object({ kind: z.literal("display"), diagonalIn: z.number().positive(), bezelMm: MmNonNegative }),
  z.object({ kind: z.literal("video-bar"), size: Size3 }),
  z.object({ kind: z.literal("ceiling-speaker"), diameter: MmPositive }),
  z.object({ kind: z.literal("ceiling-mic"), size: Size3 }),
]);

export const MountKind = z.enum(["floor", "wall", "ceiling", "table", "item"]);

export const Item = z.object({
  id: ItemId,
  levelId: LevelId,
  ref: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("product"), productId: ProductId }),
    z.object({ kind: z.literal("recipe"), recipe: PrimitiveRecipe }),
  ]),
  position: Point,                     // centre of the footprint
  rotation: Deg,
  elevation: Mm,                       // from level floor; negative allowed
  size: Size3.nullable(),              // override; allowed only if the product is deformable (validated)
  mirrored: z.boolean(),
  mount: z.object({ kind: MountKind, targetId: z.union([WallId, ItemId]).nullable(), height: MmNonNegative.nullable() }),
  parentId: ItemId.nullable(),         // stacking parent; moving the parent moves this item
  roomId: RoomId.nullable(),           // maintained by commands from containment; validated
  finish: FinishRef.nullable(),        // whole-item finish
  materials: z.record(FinishRef),      // per-slot overrides keyed by asset material slot (ADR-010 D8)
  pose: z.string().nullable(),         // articulation preset name (reserved)
  visible: z.boolean(),
  tags: z.array(z.string()),
  properties: z.record(z.string()),
});
```

### 4.6 Zone

```ts
export const ArrangementRule = z.object({
  pattern: z.enum(["grid", "rows", "u-shape", "boardroom", "classroom", "bench"]),
  productId: ProductId.nullable(),
  recipe: PrimitiveRecipe.nullable(),
  count: z.number().int().min(1),
  spacing: z.object({ x: MmNonNegative, y: MmNonNegative }),
  facing: Deg,
  margin: MmNonNegative,
});

export const Zone = z.object({
  id: ZoneId,
  levelId: LevelId,
  name: z.string().nullable(),
  polygon: Polygon,
  kind: z.enum(["desk-cluster", "circulation", "av-coverage", "other"]),
  rule: ArrangementRule.nullable(),
  generatedItemIds: z.array(ItemId),   // items the rule produced; regenerated together
  properties: z.record(z.string()),
});
```

### 4.7 Annotation

```ts
export const Annotation = z.discriminatedUnion("kind", [
  z.object({ id: AnnotationId, levelId: LevelId, kind: z.literal("scale-bar"), from: Point, to: Point, lengthMm: MmPositive }),
  z.object({ id: AnnotationId, levelId: LevelId, kind: z.literal("north"), position: Point, angle: Deg }),
  z.object({ id: AnnotationId, levelId: LevelId, kind: z.literal("label"), position: Point, text: z.string(), angle: Deg, elevation: Mm.nullable() }),
  z.object({ id: AnnotationId, levelId: LevelId, kind: z.literal("dimension"), from: Point, to: Point, offset: Mm }),
  z.object({ id: AnnotationId, levelId: LevelId, kind: z.literal("note"), position: Point, text: z.string(), author: z.string().nullable() }),
]);
```

### 4.8 Provenance and meta

```ts
export const Provenance = z.object({
  sourceFile: z.string().nullable(),
  reader: z.string().nullable(),       // provider id and model that produced the draft
  confidence: Fraction.nullable(),
  questions: z.array(z.string()),
  importedAt: Timestamp.nullable(),
});

export const Meta = z.object({
  name: z.string().min(1),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  currency: z.string().length(3),      // ISO 4217
  north: Deg,                          // direction of north in plan degrees; 90 means +y
  units: z.literal("mm"),
});
```

### 4.9 Project

```ts
export const SCHEMA_VERSION = 1;

export const Project = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  meta: Meta,
  levels: z.array(Level).min(1),
  walls: z.array(Wall),
  openings: z.array(Opening),
  rooms: z.array(Room),
  items: z.array(Item),
  zones: z.array(Zone),
  annotations: z.array(Annotation),
  catalogRefs: z.record(ProductId, ProductSnapshot),   // spec 02
  textures: z.record(TextureId, TextureSnapshot),      // spec 02
  provenance: Provenance.nullable(),
  properties: z.record(z.string()),
});
export type Project = z.infer<typeof Project>;
```

`Project.parse` accepts only shape. Semantic invariants are the validator's
job (section 5), so a file can be loaded, shown, and repaired even when it is
inconsistent.

## 5. Validation

`validate(project): Problem[]` where

```ts
Problem = { code: string, severity: "error" | "warning", entityId: string | null, message: string, hint: string | null, related: string[] }
```

Errors block export and tool success; warnings are returned but do not
block. Codes, first release:

| Code | Severity | Rule |
|---|---|---|
| `level.none` | error | at least one level |
| `level.duplicate-order` | error | two levels share elevation and index |
| `ref.missing` | error | any levelId, wallId, roomId, itemId, parentId, targetId, productId, textureId does not resolve |
| `id.duplicate` | error | id appears twice |
| `id.format` | error | id does not match its type prefix |
| `wall.zero-length` | error | start equals end (W-004) |
| `wall.self-join` | error | a join references the wall itself (W-015) |
| `wall.join-not-reciprocal` | error | A.joins.end points to B.start but B.joins.start does not point to A.end (W-013) |
| `wall.join-endpoint-mismatch` | error | joined endpoints differ in coordinates (W-068) |
| `wall.join-cross-level` | error | joined walls on different levels |
| `wall.arc-degenerate` | warning | arc extent below 1 degree in magnitude |
| `opening.off-wall` | error | position with half width extends beyond the wall length |
| `opening.overlap` | error | two openings on one wall overlap in the along-wall interval |
| `opening.taller-than-wall` | warning | sill plus height above the wall top (O-054) |
| `opening.level-mismatch` | error | opening levelId differs from its wall's |
| `opening.swing-on-window` | error | swing set on a window or passage |
| `room.too-few-points` | error | fewer than 3 points (R-001 tightened) |
| `room.not-simple` | error | self-intersecting polygon or hole (R-150 reversed) |
| `room.winding` | error | polygon not counter-clockwise or hole not clockwise |
| `room.hole-outside` | error | a hole not contained in the polygon |
| `room.degenerate` | warning | area below 100000 mm² (0.1 m²) |
| `room.stale` | warning | detected room whose bounding walls changed since detection |
| `item.size-not-deformable` | error | `size` set but the product is not deformable |
| `item.parent-cycle` | error | parentId chain loops |
| `item.parent-level` | error | parent on another level |
| `item.outside-room` | warning | roomId set but centre not inside the room polygon |
| `item.in-wall` | warning | footprint fully inside a wall footprint (F-089) |
| `item.overlap` | warning | footprints of two floor-mounted items on one level overlap by more than 10 percent of the smaller |
| `item.mount-target` | error | mount kind wall or item without a resolving targetId |
| `item.elevation-range` | warning | elevation plus height above the level height plus 1000 mm |
| `zone.rule-orphan` | warning | generatedItemIds reference items that no longer exist |
| `catalog.unverified` | warning | an item references a product whose snapshot status is not verified |
| `catalog.missing-snapshot` | error | an item references a product with no entry in catalogRefs |

Problems for a whole entity list include `related` ids so the plan view can
highlight all of them.

## 6. Normalisation on write

Commands call `normalize(entity)` before validation:

- angles through `normalizeDeg`;
- `arcExtent` 0 to null; `heightAtEnd` equal to `height` to null;
- room polygons reoriented counter-clockwise and holes clockwise if the
  winding is merely reversed (a warning is still emitted so importers learn);
- consecutive duplicate polygon points removed, closing point removed
  (R-011 tolerated on input, never stored);
- item `rotation` and `elevation` unchanged; `size` set to null when equal to
  the product size.

## 7. Derived functions

All pure, in `packages/ir/derive`. Never persisted.

```ts
wallLength(w): number                       // chord for arcs (W-051 distinguishes arc length: wallArcLength)
wallArcLength(w): number
wallAngle(w): Deg
wallFootprint(w, joins: ResolvedJoins): Point[]     // delegates to geometry (ADR-014); index contract as W-003
wallSideNormal(w, side: "left" | "right"): { x, y }
wallCompassSide(w, side, meta): "north" | "south" | "east" | "west"   // by outward normal, nearest 90 degrees
openingCentre(o, w): Point
openingAlongInterval(o, w): { from: number, to: number }   // mm along the wall from start
roomArea(r): number                         // mm², absolute shoelace, holes subtracted (R-006)
roomPerimeter(r): number
roomLabelAnchor(r): Point                   // pole of inaccessibility (ADR-016 D2)
roomBounds(r): Rect
roomWallSides(r, walls): { wallId, side, compass, fromMm, toMm }[]   // which wall faces bound the room
freeWallSegments(r, walls, openings, items): { wallId, from, to }[] // for place_item anchors
itemSize(i, catalog): Size3                 // override or product or recipe size
itemFootprint(i, catalog): Point[]          // 4 points, rotated, index contract as F-007
itemGroundElevation(i, level): number
itemBounds3(i, catalog, level): { min: Point3, max: Point3 }
containingRoom(point, rooms, levelId): RoomId | null   // smallest containing polygon
levelOf(id, project): Level
projectBounds(project): Rect
```

## 8. Serialisation

- `serialize(project): string` writes keys in schema declaration order, two
  spaces, `null` for empty optionals, arrays in stored order except levels
  which are sorted by `(elevation, index)`.
- `deserialize(text): { project, unknownFields, migrated: boolean }` runs
  migrations from `schemaVersion` up to `SCHEMA_VERSION`, preserves unknown
  fields under `properties.__unknown` per entity, rejects NaN and Infinity,
  and returns problems from a shape parse as a single `file.shape` error
  with the zod path.
- Migrations are registered in `packages/ir/src/migrations.ts` by the version they upgrade from, pure, with
  a fixture pair each.
- Schema 2 (2026-09-17): baseboards gained `color`; version 1 files get `color: null` on every
  baseboard they have, which draws them exactly as before.

## 9. Ledger coverage for this spec

Tests in `packages/ir` named by ledger id:

- Angles and fractions: F-001, F-002, F-003, R-020, O-005 (reversed), O-006.
- Wall fields and joins: W-004 (rejected), W-006, W-007 (rejected), W-013,
  W-014 (reducers, spec 03), W-015 (rejected), W-016, W-029, W-030 (fixed),
  W-041, W-048, W-092, W-093, W-094, W-095, W-096 (level membership is an
  explicit levelId; the height-overlap rule becomes a viewer option, not a
  model rule), W-138.
- Openings: O-001, O-003, O-004 (reversed: bound is implicit), O-007..O-010
  (catalog, spec 02), O-040..O-050 (replaced by wall binding), O-051 (wall
  cut interval), O-060 (rejected as overlap).
- Rooms: R-001 (tightened), R-004..R-011, R-012 (improved), R-013..R-020,
  R-150 (reversed).
- Items: F-006, F-007, F-012, F-013, F-014, F-016 (replaced by levelId),
  F-017, F-018, F-019, F-020, F-062, F-070 (replaced by parentId).
- Levels: R-101 (reversed: always one level), R-105, R-106, R-107 (migration),
  R-113 (replaced), R-116, R-122.
- Serialisation: P-024 (reversed), P-027..P-030 (reversed: explicit),
  P-031, P-032, P-033 (now a problem), P-035 (now a problem), P-037, P-038,
  P-039, P-050, P-052, P-053, P-054, P-060.

## 10. Example

Our own fixture is `tools/fixtures/six-wall-room.fpviz/project.json`: an
L-shaped room of six 100 mm walls on centrelines (0,0), (8000,0), (8000,3000),
(5000,3000), (5000,5000), (0,5000), closed, with a 900 mm door centred on the
south wall. Expected values in `expected.json`, asserted by tests: six walls,
six joins, a detected room polygon (50,50) to (7950,4950) with the notch at
(4950,2950), area 32 710 000 mm² without the door threshold and 32 755 000 mm²
with it, and zero validation errors. It is the golden case for R-131
and W-141.

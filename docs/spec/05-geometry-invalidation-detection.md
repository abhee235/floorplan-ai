# Spec 05: Geometry contracts, invalidation table, room detection, magnetism, placement pipeline

Status: Draft
Date: 2026-09-14
Implements: ADR-003 D3, ADR-014, ADR-015, ADR-016
Packages: `packages/geometry`, `packages/engine`
Ledger coverage: section 8

All functions are pure. Inputs are IR entities in millimetres; internal
computation is float64 millimetres; engine output is float32 metres in the
three.js frame `(x, elevation, -y)`.

## 1. Tolerances

| Name | Value | Where |
|---|---|---|
| `WELD` | 0.1 mm | joined corner welding, endpoint coincidence |
| `PARALLEL_DEG` | 0.01 degrees | side-line intersection skipped below this |
| `PARALLEL_RATIO` | 0.004 | slope ratio test for near-parallel side lines |
| `CLAMP_FACTOR` | 2 | mitre clamp = factor times the larger thickness |
| `DEGENERATE` | 0.01 mm | edges shorter than this are dropped |
| `ARC_FLATTEN` | 5 mm | max chord deviation when flattening arcs |
| `ARC_MIN_SEGMENTS` | 4 | |
| `OPENING_PARALLEL_DEG` | 1 (straight), 10 (arc) | reserved for future non-bound openings |
| `LEVEL_SHIFT` | 1 mm | wall bottom and top nudges |
| `GAP_CLOSE_DEFAULT` | 20 mm | room detection morphological close |
| `GAP_CLOSE_MAX` | 100 mm | |
| `THRESHOLD_SILL_MAX` | 0 mm | openings with sill above this do not patch thresholds |

## 2. Geometry package API

```ts
// footprints and joins
wallFootprints(walls: Wall[]): Map<WallId, Point[]>        // resolves all joins in one symmetric pass (ADR-014 D3)
wallSidePolygon(footprint: Point[], side: "left" | "right"): Point[]  // half slab to the centreline
arcParams(w: Wall): { centre: Point, radius: number, startDeg: number, extentDeg: number }
arcTessellation(w: Wall): { outer: Point[], inner: Point[] }

// booleans and shapes
union(polys: Poly[]): MultiPoly
difference(a: MultiPoly, b: MultiPoly): MultiPoly
offset(poly: MultiPoly, delta: number): MultiPoly            // positive dilates, negative erodes; round joins
close(poly: MultiPoly, gap: number): MultiPoly                // offset(+gap) then offset(-gap)
rings(mp: MultiPoly): { outer: Point[], holes: Point[][] }[]
interiorRings(mp: MultiPoly): Point[][]                       // holes of the union, i.e. enclosures
flatten(points: Point[], tolerance: number): Point[]
dedupe(points: Point[], minEdge: number): Point[]
isSimple(poly: Point[]): boolean
isCounterClockwise(poly: Point[]): boolean
area(poly: Point[]): number
poleOfInaccessibility(poly: Point[], holes: Point[][]): Point
containsPoint(poly, holes, p): boolean
intersects(a: Point[], b: Point[]): boolean
overlapArea(a: Point[], b: Point[]): number
triangulate(outer: Point[], holes: Point[][]): Uint32Array    // earcut adapter

// lines
intersectLines(p1, p2, p3, p4): Point | null                 // null when parallel per tolerances
projectOntoSegment(p, a, b): { point: Point, t: number }
distancePointSegment(p, a, b): number

// openings
openingFootprint(o: Opening, w: Wall, footprint: Point[]): Point[]   // wall-thickness-plus-2mm deep rectangle
openingIntervals(openings: Opening[], w: Wall): { id, from, to }[]  // sorted along the wall

// rooms
detectEnclosures(walls: Wall[], gap: number): Point[][]
detectRoomAt(walls, openings, point, gap): { polygon: Point[], wallIds: WallId[] } | null
patchThresholds(polygon: Point[], walls, openings): Point[]
```

## 3. Engine package API

```ts
buildWalls(level, walls, openings, finishes): GeometryPart[]
buildRooms(level, rooms, isLowestLevel): GeometryPart[]
buildItems(level, items, catalog, assets): ItemInstance[]
buildRecipe(recipe): GeometryPart                              // primitive meshes
expand(changes: ChangeSet, project): RebuildSet                // ADR-015 D1
```

`GeometryPart` and `ItemInstance` as ADR-003 D2. Part naming:
`wall-left`, `wall-right`, `wall-top`, `wall-end-start`, `wall-end-end`,
`opening-sill`, `opening-head`, `opening-jamb`, `opening-reveal`, `floor`,
`floor-side`, `floor-bottom`, `ceiling`, `item`, `recipe`.

Wall construction follows ADR-014 D2 to D9. Room construction: floor at the
level elevation, underside at elevation minus floor thickness on non-lowest
levels, floor side strip on non-lowest levels, ceiling at the room's ceiling
height or the level height; later rooms on the same level subtract earlier
overlapping rooms from their floor (R-065); triangulation with holes via
`triangulate`; UVs in millimetres from the room bounds origin.

## 4. Room detection

`detectEnclosures(walls, gap)`:

1. `fp = wallFootprints(walls)`; `u = union(all fp)`.
2. `c = close(u, gap)`.
3. `enclosures = interiorRings(c)` each `flatten(ARC_FLATTEN)` then
   `dedupe(DEGENERATE)`, oriented counter-clockwise.
4. Discard rings with area below 100000 mm².

`detectRoomAt(walls, openings, point, gap)`:

1. Among enclosures containing `point`, pick the smallest area; none
   returns null.
2. `wallIds` = walls whose footprint shares an edge with the ring within
   `WELD` after flattening.
3. `polygon = patchThresholds(ring, walls, openings)`.

`patchThresholds`: for every opening of kind door or passage with
`sill <= THRESHOLD_SILL_MAX` on a wall in `wallIds`, compute the opening's
along-wall interval and the wall centreline; where the ring runs along that
wall's face across the interval, replace that stretch by a notch to the
centreline of width equal to the opening width (R-034). An opening whose
interval is not fully covered by the ring edge is skipped with no notch
(R-037 as a validation problem elsewhere).

## 5. Placement pipeline

`placeItem(item, ctx): { position, rotation, elevation, parentId, warnings }`
runs in order, each stage optional by flags `{ forceOrientation, adjustElevation }`:

1. **Elevation onto a surface.** Candidate surfaces: items on the level with
   a surface mount point whose `dropRatio` is not null, whose footprint
   contains all four footprint corners of the item within 5 percent of the
   item's smaller footprint dimension (F-063). The highest surface wins
   (F-064). On a hit: `elevation = candidate.elevation + candidate.height * dropRatio`,
   `parentId = candidate.id`. Runs only when `adjustElevation` and the item
   is not a wall- or ceiling-mounted product.
2. **Wall snap.** Reference wall: a wall whose footprint contains the
   position; else the wall with the largest footprint overlap with the item
   footprint inflated by 40 mm (F-082, the 4 px margin at typical zoom). With
   a reference wall: rotation set to the wall angle or its opposite so the
   item's back faces the nearer wall face (F-085) when `forceOrientation`;
   position pushed so the back edge touches the face plus skirting thickness
   (F-084); a position fully inside the wall footprint returns the input
   unchanged with warning `item.in-wall` (F-089). Arc walls use the tangent
   at the nearest point (F-090). Wall-mounted products additionally set
   `mount.targetId` and, when `mount.height` is null, the product's default
   height.
3. **Side by side.** Skipped when stage 1 hit (F-075). Candidates: other
   items on the level with overlapping vertical extent (F-092). If the item's
   footprint intersects a band of 80 mm around a candidate's footprint and
   does not penetrate its interior, translate the item so the nearest edges
   are flush, choosing front-back versus left-right by which pair of edges
   is closer (F-093, F-094). The move is accepted only if the footprints
   still touch afterwards (F-095) and never pushes the item into the
   reference wall from stage 2 (F-096).
4. **Clearance warning.** After placement, if the item's product clearance
   polygon intersects an opening swing area or another item, add a warning
   naming the ids.

Room-relative anchors resolve before the pipeline: `against-<compass>-wall`
picks the room wall side with that compass label and the longest free
segment (spec 01 `freeWallSegments`), centres the item on it, and sets
`forceOrientation`; corners place the item touching both walls; `center`
uses the pole of inaccessibility; `{ on: itemId }` sets stage 1 to that item.

### 5.1 As implemented (packages/geometry/src/placement.ts)

- `placeItem(subject, { project, sizes }, options, clearance)` is pure. The
  bands are fixed in millimetres because commands have no zoom: the wall
  margin is 40 mm and the side-by-side band 80 mm.
- Stage 1 surfaces: a recipe table or box is a surface at its full height;
  a product is a surface when its snapshot has a `surface` mount point with a
  non-null, non-negative `dropRatio`. Surfaces on other levels count at their
  height relative to the subject's level (F-065). Moving an item that had a
  parent off every surface returns it to elevation 0 with no parent (F-069).
  Shelf elevations and shelf boxes are not modelled (F-067, F-068, F-073,
  F-074 omitted).
- Stage 2 walls: arcs use the tangent at the nearest point of the centreline
  circle; F-088's second-wall slide is skipped for an arc wall when the item
  was re-oriented onto the right side (F-090). Edge anchoring (F-086) makes an
  item extend the same way whichever direction the wall was drawn, with an
  exact, symmetric boundary at plus or minus 90 degrees (F-087 reversed).
- Stage 3 neighbours: the face is chosen by the item's overlap with the
  front-back and left-right bow-tie triangles of the neighbour's band; when
  the flush move would leave the two touching only at a corner, the move is
  recomputed with the roles swapped, and dropped if that also fails (F-095);
  a move into the reference wall keeps only its component along the wall
  (F-096).
- Stage 4 warnings: `item.door-swing` when the footprint overlaps a door's
  swing square (door width by door width from either face) by more than
  1000 mm², and `item.clearance` when the product's clearance box overlaps a
  floor item.
- Commands: `item.place` runs the pipeline unless `magnetism: false`, with
  `forceOrientation` only when no rotation was given and elevation adjustment
  only when neither elevation nor parent was given; wall-mounted items take
  the snapped wall as `mount.targetId` when none was given; ceiling items skip
  it. `item.place` refuses door and window products (`item.opening-product`,
  F-091 reversed: they are openings, O-013). `item.move` runs it for a single
  moved item without re-orienting (F-076, F-077).
- Anchors `against-<compass>-wall` choose, among room edges facing that way,
  the longest free run (`freeRunsAlongEdge`) at least as wide as the item,
  excluding door swing squares, passages, windows whose sill is below the
  item's height, and items already along the edge; with no run wide enough,
  the item is centred on the edge and a warning says so.
- Editor helpers for gestures: `DragSession` (restores the press state on
  every move and ignores the first 100 ms, F-080, F-081),
  `alignedDragPoint` (15 degree rays, F-079) and `magnetizedSize` (whole
  millimetres, F-098). Recipes placed by `furnish_room` and the golden
  fixture builder pass `magnetism: false` because their positions are
  computed exactly.

## 6. Arrangement patterns

`arrange(polygon, rule, itemSize, clearance): Placement[]`:

- `grid`: fill the polygon's inset (by `margin` plus clearance) with a
  rectangular lattice of pitch `size + spacing`, facing `facing`.
- `rows`: rows along the longest polygon axis, all facing the same way.
- `bench`: pairs of desks back to back along rows.
- `boardroom`: one table centred (largest that fits with 900 mm clearance
  all round), chairs evenly spaced around it at 600 mm pitch, count from the
  rule.
- `u-shape`: tables in a U open toward the wall with the display (or the
  north wall), chairs on the outside.
- `classroom`: rows of tables facing the display wall, aisle 1000 mm.

Placements that do not fit are dropped and reported in warnings with the
count placed versus requested.

## 7. Invalidation table

`expand(changes, project)` applies, per entity ref in the change set, the
rows below and unions the results. Kinds of change are inferred from the
ref type and the command that produced it (the change set carries the
command type).

| Change | Rebuild |
|---|---|
| wall added or removed | the wall; walls joined at either end; openings on the wall; detected rooms bounded by it marked stale; layers structure; bounds |
| wall geometry changed (endpoints, thickness, height, heightAtEnd, arcExtent, joins) | as above |
| wall finish or skirting changed | the wall; layer structure |
| opening added, removed, moved, resized, kind or product changed | its wall; layer structure |
| room polygon or holes changed | the room; rooms on the level whose polygon intersects the old or new polygon; ground when the level is lowest; layer structure |
| room finish, name, label, visibility changed | the room; layer structure |
| item added, removed, moved, rotated, resized, mirrored, product, finish, materials, pose, visibility changed | the item; descendants by parentId; layer items; bounds |
| item elevation or parent changed | the item; descendants |
| level elevation, height, floorThickness changed | every wall and room on the level; walls on the adjacent levels; ground; all layers |
| level added, removed, viewable changed | every entity on the level; ground; all layers |
| zone regenerated | the generated items (as item rows) |
| annotation changed | layer overlay |
| meta.north changed | layer overlay |
| selection changed | layer overlay; 3D outline for old and new ids |

Ceilings follow level height or the room override, so wall height changes
do not rebuild rooms (S-009 reversed).

## 8. Ledger coverage for this spec

Tests in `packages/geometry` and `packages/engine`:

- Footprints and joins: W-001..W-003, W-005, W-008, W-018..W-028 (W-028
  reversed by the symmetric pass), W-059, W-119, W-123.
- Arcs: W-049, W-051..W-053, W-055, W-056, W-058, W-050 (impossible by
  normalisation), W-057 (skirting clamped), W-054 (omitted).
- Heights: W-093, W-097, W-098, W-099, W-102..W-105, W-101 (rejected).
- Sides and UVs: W-106..W-111, W-125, W-126, W-127.
- Openings: O-051..O-059 (O-057 always both faces; O-058 not applicable),
  O-061..O-068 (non-overlap makes stacking a sort), O-069..O-078 (reveals
  from cut-out path; O-077, O-078 not applicable), O-079 (rejected), O-082,
  O-083.
- Rooms 3D: R-061..R-067, R-075..R-080, R-082, R-083, R-084, R-088;
  R-068..R-071 (reversed: ceilings from level height); R-072..R-074
  (staircase cut-outs: phase 3, via an item flag); R-081 (omitted).
- Ground: R-089..R-100 (phase 2, simplified: one slab per lowest level
  minus room floors; underground terraces omitted).
- Detection: R-021..R-024 (gap tolerance added), R-026 (smallest),
  R-027..R-031, R-032..R-039 (threshold patching from bound openings), R-131.
- Magnetism and placement: F-063..F-068, F-075..F-077, F-080, F-082,
  F-084..F-086, F-088..F-096, F-097 (fixed), F-098, F-099, W-077..W-083,
  R-050..R-055.
- Invalidation: S-004..S-036 (with S-009, S-015 reversed and S-036 covered),
  W-120..W-122, O-102..O-111, R-132..R-137.

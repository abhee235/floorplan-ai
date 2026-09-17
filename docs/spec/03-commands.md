# Spec 03: Command catalogue

Status: Draft
Date: 2026-09-14
Implements: ADR-004
Package: `packages/commands`
Ledger coverage: section 6

Every mutation of a project is one of the commands below, applied by
`apply(project, command, ctx)`. Each entry gives the payload schema, the
preconditions that produce an error, the effect, and the change set. All
payload lengths are integer millimetres and angles degrees. `ctx` provides
`newId(type)`, `now()`, `catalog` (product lookup for dimensions), and
`geometry` (footprint and detection functions from spec 05).

## 1. Envelope

```ts
Command = { type: CommandType, payload: object }
Result  = { ok: true, project, changes: ChangeSet, inverse: Patch[], forward: Patch[], warnings: string[] }
        | { ok: false, error: { code, message, entityId: string | null, hint: string | null } }
ChangeSet = { added: Ref[], updated: Ref[], removed: Ref[] }   // Ref = { type, id, aspect?: "plan" }
```

Error codes are the validation codes of spec 01 section 5 plus the command
codes in section 5 below. A failed command leaves the project untouched.
Every successful command runs `normalize` then `validate`; a resulting
error-severity problem fails the command with that problem's code.

Common payload fragments:

```ts
Partial<T>   // any subset of an entity's mutable fields; ids and levelId are never mutable through modify commands
```

## 2. Structure commands

### wall.create
Payload: `{ levelId, start: Point, end: Point, thickness?: Mm, height?: Mm | null, heightAtEnd?: Mm | null, arcExtent?: Deg | null, kind?: WallKind, joinStart?: Join | null, joinEnd?: Join | null }`
Defaults: thickness 120, kind interior, height null.
Preconditions: `start != end`; joins, if given, reference walls on the same level with the named end free and coincident within 0.1 mm (else `wall.join-endpoint-mismatch`).
Effect: adds the wall; sets reciprocal joins on the joined walls.
Changes: added wall; updated joined walls.

### wall.createChain
Payload: `{ levelId, points: Point[] (>= 2), closed: boolean, thickness?, height?, kind?, snapMm?: Mm (default 20) }`
Preconditions: consecutive points distinct; when `closed`, at least 3 points.
Effect: one wall per segment, joined end to start in sequence; when `closed` the last is joined to the first; the first point and the last point (when not closed) snap to an existing free wall end on the level within `snapMm` and join to it (W-068, W-069, W-070). Zero-length segments after snapping are dropped (W-067).
Changes: added walls; updated any pre-existing wall joined at the ends.

### wall.modify
Payload: `{ wallId, changes: Partial<Wall minus joins> }`
Preconditions: thickness > 0; start != end after change.
Effect: applies changes. If start or end moves, joined neighbours' coincident endpoints move with it (propagation as in wall.move). heightAtEnd equal to height stored as null; arcExtent 0 stored as null. `finishes` and `skirting` replace the whole object, so a change to one side sends the other side as it is.
Changes: updated wall, joined neighbours, openings on the wall. A change to `pattern` alone lists only the wall, with `aspect: "plan"`: only the plan draws it, so nothing else depends on it (W-121, S-011). Where one change set holds both, the unnarrowed ref wins, in a transaction's merged set as in a single command.

### wall.move
Payload: `{ wallIds: WallId[], dx: Mm, dy: Mm }`
Effect: translates each wall. For each moved wall end joined to a wall not in the set, the neighbour's coincident endpoint is translated too; a neighbour in the set moves by its own delta only (W-031). Where the neighbour is joined to the moved wall at both of its ends, the end whose coordinates equal the moved endpoint before the move is the one moved (W-032).
Changes: updated moved walls, neighbours, openings on all of them.

### wall.split
Payload: `{ wallId, at?: Fraction (default 0.5) }`
Effect: two new walls with new ids, first from start to the split point, second from split point to end, joined to each other; the original's joins transfer to the corresponding halves and reciprocal links are rewritten; sloped tops interpolate height at the split (W-038); arc extent is divided proportionally (W-039 reversed); openings reassign to the half containing their centre with recomputed position; an opening straddling the split point fails with `wall.split-through-opening`. Original removed.
Changes: added two walls; removed one; updated neighbours and openings.

### wall.join
Payload: `{ a: Join, b: Join }`
Preconditions: both ends free, both walls on one level, not the same wall, neither an arc (W-066).
Effect: if the walls are not parallel (angle difference outside 0.5 degrees of 0 or 180, W-043), both endpoints move to the intersection of the centrelines; if parallel and collinear within 1 mm, the nearer free endpoints meet at the midpoint between them (W-044); else `wall.join-impossible`. Reciprocal joins set. Openings on both walls are re-validated for `opening.off-wall`.
Changes: updated both walls, their openings.

### wall.reverse
Payload: `{ wallIds: WallId[] }`
Effect: swaps start and end, negates arcExtent, swaps joins.start and joins.end and rewrites neighbours' references, swaps height and heightAtEnd when heightAtEnd is non-null, swaps left and right finishes and skirting (W-034, W-035), and for each opening on the wall sets `position = 1 - position` and flips `swing.hinge` so the opening stays in place.
Changes: updated walls, neighbours, openings.

### wall.delete
Payload: `{ wallIds: WallId[] }`
Effect: removes the walls and every opening on them; nulls every join on other walls that referenced them, at both ends when both did (W-029, W-030 fixed); marks detected rooms bounded by them stale.
Changes: removed walls and openings; updated neighbours and stale rooms.

### opening.add
Payload: `{ wallId, kind, position?: Fraction, atMm?: Mm, width, height?, sill?, swing?, mirrored?, productId?, recipe? }`
Defaults: door 900 by 2100 sill 0; window 1200 by 1200 sill 900; passage 1000 by 2100.
Preconditions: exactly one of position or atMm; the along-wall interval lies within the wall (`opening.off-wall`) and overlaps no other opening (`opening.overlap`); productId, if given, resolves to a door or window product matching kind and is snapshotted.
Changes: added opening; updated wall.

### opening.modify
Payload: `{ openingId, changes: Partial<Opening minus wallId> }`
Preconditions as add. Changes: updated opening and wall.

### opening.move
Payload: `{ openingId, wallId?: WallId, position?: Fraction, atMm?: Mm }`
Effect: moves along its wall or to another wall on the same level; recomputes position.
Changes: updated opening, old wall, new wall.

### opening.delete
Payload: `{ openingIds }`. Changes: removed openings; updated walls.

### room.create
Payload: `{ levelId, polygon?: Point[], rect?: { x, y, w, d }, atPoint?: Point, name?, purpose?, capacity?, gapToleranceMm?: Mm (default 20) }`
Preconditions: exactly one of polygon, rect, atPoint. For atPoint, detection (spec 05 section 4) must find an enclosure containing the point (`room.not-enclosed`). Polygon simple, at least 3 points.
Effect: adds the room with `source` manual, manual, or detected respectively; detected rooms record `boundingWallIds`. Items whose centre lies inside and have `roomId` null get `roomId` set.
Changes: added room; updated items.

### room.detectAll
Payload: `{ levelId, gapToleranceMm?, replaceStale?: boolean }`
Effect: creates a detected room per enclosure not already covered by an existing room (by centroid containment); with replaceStale, stale detected rooms are re-polygonised in place.
Changes: added and updated rooms.

### room.modify
Payload: `{ roomId, changes: Partial<Room minus polygon, holes, source> }`. Changes: updated room.

### room.setPolygon
Payload: `{ roomId, polygon, holes? }`
Effect: replaces geometry; `source` becomes manual; items are re-assigned by containment.
Changes: updated room, items whose roomId changed, rooms on the level intersecting the old or new polygon (for the invalidation table).

### room.addPoint / room.movePoint / room.removePoint
Payloads: `{ roomId, point }` inserts on the nearest edge, projected (ADR-016 D2); `{ roomId, index, point }`; `{ roomId, index }` refused below 3 points (`room.too-few-points`).
Changes: as setPolygon.

### room.delete
Payload: `{ roomIds }`. Effect: removes rooms; items' roomId nulled. Changes: removed rooms; updated items.

### level.add
Payload: `{ name?, elevation?, height?, floorThickness?, sameAs?: LevelId }`
Defaults: elevation = top level's elevation + height + floorThickness; height 2700; floorThickness 300; with `sameAs`, copy those three and take the next index at that elevation (R-103, R-104, R-105).
Changes: added level.

### level.modify
Payload: `{ levelId, changes: Partial<Level> }`
Effect: elevation or index changes re-sort levels and re-index siblings at the old and new elevations (R-119, R-120).
Changes: updated level and re-indexed siblings; the invalidation table treats an elevation change as level-wide.

### level.delete
Payload: `{ levelId }`
Preconditions: at least one level remains (`level.none`).
Effect: removes the level and every wall, opening, room, item, zone and annotation on it in one change set (R-108); joins from walls on other levels to deleted walls are nulled.
Changes: removed all; updated cross-level neighbours.

## 3. Item commands

### item.place
Payload: `{ levelId, ref: { productId } | { recipe }, position?: Point, roomId?: RoomId, anchor?: Anchor, rotation?: Deg, elevation?: Mm, mount?, parentId?, tags?, magnetism?: boolean (default true) }`
`magnetism: false` skips the placement pipeline and keeps the given position and rotation exactly. A door or window product fails with `item.opening-product` (use `opening.add`).
`Anchor = "center" | "against-north-wall" | "against-south-wall" | "against-east-wall" | "against-west-wall" | "north-east-corner" | "north-west-corner" | "south-east-corner" | "south-west-corner" | { alongWall: WallId, atMm: Mm } | { on: ItemId, dropRatio?: Fraction }`
Preconditions: exactly one of position or (roomId plus anchor); product resolves and is snapshotted.
Effect: resolves the anchor to a position and rotation using room wall sides (spec 01 section 7), the product footprint, and the product clearance; then runs the placement pipeline (spec 05 section 5) which may adjust position, rotation, elevation and set parentId (F-075). Sets roomId by containment. Warns `item.overlap` when overlapping another item.
Changes: added item; updated parent (none) and zone (none).

### item.move
Payload: `{ itemIds, dx, dy, dz?: Mm, magnetism?: boolean (default true when exactly one item) }`
Effect: translates items; descendants by parentId move with them; with magnetism on a single item the pipeline runs on the translated position without changing rotation (F-076, F-077); roomId recomputed.
Changes: updated items and descendants.

### item.rotate
Payload: `{ itemIds, angle?: Deg (absolute) | delta?: Deg, about?: Point }`
Effect: rotates each item; when `about` is given, positions orbit that point (used by group gestures). Descendants rotate with the parent about the parent's centre.
Changes: updated items and descendants.

### item.resize
Payload: `{ itemId, size: Size3 | null, anchor?: "center" | "back-left" (default back-left) }`
Preconditions: product deformable or size null (`item.size-not-deformable`).
Effect: sets size; recomputes position so the anchor corner stays fixed (F-100); descendants stacked on a surface keep their offsets.
Changes: updated item and descendants.

### item.setElevation
Payload: `{ itemIds, elevation }`. Changes: updated items and descendants (relative offsets preserved).

### item.setParent
Payload: `{ itemId, parentId: ItemId | null, dropRatio?: Fraction }`
Preconditions: no cycle; same level; parent has a surface mount point when dropRatio is used.
Effect: sets parentId; elevation set to the parent's surface height when dropRatio is given.
Changes: updated item.

### item.setProduct
Payload: `{ itemId, ref }`. Effect: swaps the reference, keeps position and rotation, clears size if the new product is not deformable, drops `materials` for slots the new reference does not have, re-snapshots. Changes: updated item.

### item.mirror
Payload: `{ itemIds }`. Effect: toggles mirrored. Changes: updated items.

### item.setFinish
Payload: `{ itemIds, finish?: FinishRef | null, materials?: Record<slot, FinishRef | null> }`
Preconditions: slots exist on the item: a recipe's slots, a product's `materialSlots`, or, when those are empty, the slots of the recipe its category falls back to (spec 02 section 3.1). A null finish for a slot removes it. The item's `finish` covers every slot without one of its own.
Changes: updated items.

### item.duplicate
Payload: `{ itemIds, dx?, dy? }` defaults 200, 200 (F-148 in mm).
Effect: copies with new ids, same level, parentId remapped when the parent is also duplicated, else kept; descendants duplicated with their parent.
Changes: added items.

### item.delete
Payload: `{ itemIds, withDescendants?: boolean (default true) }`
Effect: removes items; descendants removed, or re-parented to the deleted item's parent when `withDescendants` is false; zones drop them from generatedItemIds.
Changes: removed items; updated zones.

### item.align
Payload: `{ itemIds (>= 2), leadId, edge: "north" | "south" | "east" | "west" | "front" | "back" | "left-side" | "right-side" | "side-by-side" }`
Effect: as ledger F-165..F-167 with compass edges by footprint extremes and lead-relative edges in the lead's frame. Only positions change (F-169).
Changes: updated items.

### item.distribute
Payload: `{ itemIds (>= 3), axis: "x" | "y" }`. Effect: F-168. Changes: updated items.

### item.arrange
Payload: `{ target: { roomId } | { zoneId, polygon? } | { polygon, levelId }, rule: ArrangementRule, replace?: boolean }`
Effect: computes placements for the pattern inside the target polygon minus clearances (spec 05 section 6); creates a zone when the target is a room or polygon; places items with parentId null; with `replace`, previously generated items of the zone are deleted first. A `polygon` beside a `zoneId` reshapes that zone before it is filled, so resizing a cluster and filling the room it gains is one command.

The step between placements is the piece's footprint as the rule turns it, not its measured size, and the block is centred within the zone inside the margin. A piece whose footprint lands exactly on the zone's edge counts as inside. `bench` pairs its rows back to back and puts the gap between the pairs.
Changes: added zone and items; removed replaced items.

## 4. Zone, annotation, project commands

### zone.create `{ levelId, polygon, kind, name?, rule? }` — added zone.
### zone.modify `{ zoneId, changes }` — updated zone. A `polygon` in `changes` carries what the zone generated with it: the pieces are translated, keeping their ids, when every corner moved by the same offset, and laid out again when the shape itself changed.
### zone.regenerate `{ zoneId }` — deletes generatedItemIds, re-runs the rule; removed and added items, updated zone.
### zone.delete `{ zoneIds, deleteItems?: boolean }` — removed zone and optionally items.
### annotation.add `{ annotation minus id }` / annotation.modify `{ annotationId, changes }` / annotation.delete `{ annotationIds }`.
### project.setMeta `{ changes: Partial<Meta minus createdAt, units> }` — updated meta; `north` change re-labels nothing (compass words are derived).
### catalog.refresh `{ productIds?: ProductId[] }` — updates catalogRefs from the live catalog; changes list items and openings whose product changed dims (they are marked for `validate`).
### project.setProvenance `{ provenance }`.

## 5. Command error codes

`command.unknown`, `command.payload` (zod path in message), `command.precondition` with a specific code from: `wall.join-impossible`, `wall.split-through-opening`, `room.not-enclosed`, `item.anchor-unresolvable` (no free wall segment long enough), `item.parent-cycle`, `level.last`, plus any validation error code from spec 01.

Messages follow the pattern "`<field>` must be `<constraint>`, got `<value>`" and include a `hint` when a corrected call is obvious, for example an `opening.off-wall` error hints the nearest valid `atMm`.

## 6. Transactions and history

```ts
begin(label): TxHandle
commit(tx): HistoryEntry | null           // null when no patches
rollback(tx): void
undo(): ChangeSet | null
redo(): ChangeSet | null
checkpoint(label): CheckpointId           // full snapshot, separate from history
restore(checkpointId): ChangeSet
```

History entries `{ label, forward, inverse, selectionBefore, selectionAfter, at }`; depth 200; not persisted. A transaction with no net patches records nothing (W-086, F-154). Nested begin flattens. All-or-nothing on any error.

## 7. Ledger coverage for this spec

Tests in `packages/commands`, table-driven per reducer:

- Walls: W-013, W-014, W-029, W-030 (fixed), W-031, W-032, W-033 (move
  propagates through the command, never through a model method), W-034,
  W-035, W-036 (flip as reverse plus mirror of coordinates, phase 3),
  W-037, W-038, W-039 (reversed), W-040, W-041, W-043..W-047, W-067..W-071,
  W-086, W-087 (single path), W-088, W-089 (walls around a room: phase 3
  command `wall.createAroundRoom`), W-141..W-152.
- Openings: O-014 (resize keeps the wall part: not applicable, opening
  geometry is explicit), O-040..O-050 (replaced by binding), O-102..O-111
  (change sets include walls).
- Rooms: R-025, R-026 (smallest), R-040, R-041, R-044, R-056 (projected),
  R-057 (refused), R-058, R-138..R-141 (wall split as a command),
  R-101..R-112, R-119..R-122.
- Items: F-041..F-047 (groups replaced by parent links: rotate, translate,
  scale of descendants), F-053..F-061 (grouping replaced by parent links and
  `item.duplicate`), F-069, F-070 (replaced), F-071, F-100..F-106,
  F-145..F-153, F-154..F-163, F-164..F-170, F-171..F-176.
- Levels: R-102 (reversed), R-103..R-105, R-108..R-112, R-119..R-121.

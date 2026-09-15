# ADR-015: Engine invalidation: change sets, dependency graph, dirty set, and flush

Status: Proposed
Date: 2026-09-14
Related: ADR-003 (viewer binding, plan layers), ADR-004 (change sets), ADR-005 (bridge)
Ledger lines this ADR must satisfy: W-009, W-010, W-011, W-119..W-122, O-102..O-111, R-132..R-137, S-004..S-036

## Context

Incremental 3D updates need a dirty set flushed once per tick and a rule for
what each change touches: a wall change refreshes its joined neighbours and
the ground; a door move refreshes the walls it left and joined. Rules encoded
by hand in listeners go missing (S-036) or over-refresh (S-015), and 2D caches
invalidated separately drift (W-010, W-011).

Our command layer already emits change sets (ADR-004 D5). We need one
dependency graph, as data, that both the 3D viewer and the plan layers
consume, with no listeners.

## Decision

### D1. Change sets in, rebuild sets out

`expand(changeSet, project): RebuildSet` is a pure function in `engine`.
`RebuildSet` lists, per kind, the entity ids whose derived geometry must be
rebuilt, plus flags for level-wide artefacts (`ground`, `bounds`) and plan
layers (`static`, `structure`, `items`, `overlay`).

### D2. Dependency rules as a table

The rules are a declarative table, one row per (entity kind, change kind).
First release:

| Change | Rebuild |
|---|---|
| wall added, removed, geometry field changed (endpoints, thickness, height, heightAtEnd, arcExtent, joins) | the wall; walls joined at either end; openings on the wall; rooms on the level with `source: "detected"` that touch the wall (marked stale, not regenerated); `structure` layer; `bounds` |
| wall finish changed | the wall only; `structure` layer |
| wall level changed | as geometry change, on both old and new levels |
| opening added, removed, moved, resized, kind changed | its wall (which rebuilds both sides); `structure` layer |
| opening product or cut-out changed | its wall |
| room polygon changed | the room; rooms on the same level whose polygon intersects the old or the new polygon; `ground` if the level is the lowest; `structure` layer |
| room finish or name changed | the room; `structure` layer (name label) |
| item placed, removed, moved, rotated, resized, mirrored, product changed | the item; items whose `parentId` is this item, recursively; `items` layer; `bounds` |
| item elevation changed | the item and its descendants |
| level elevation, height, floorThickness changed | every wall and room on the level; walls on adjacent levels whose bottoms or tops shift; `ground`; all layers |
| level added or removed | as above for its entities; `static` layer (ghosting) |
| zone regenerated | the items it generated |
| selection changed | `overlay` layer only; the 3D selection outline for old and new ids |
| meta or annotation changed | `overlay` or `static` layer only |

Ceilings follow the level height or the room override, never wall heights
(ADR-001), so a wall height change does not rebuild rooms, and no rule
rebuilds all rooms on the top level (S-009).

### D3. Dirty set and flush

- Rebuild sets from successive changes merge by set union until a flush.
- In the viewer, flush runs once per animation frame before render. In the
  host and in tests, flush runs synchronously after each transaction so
  results are immediate.
- Deleted ids are dropped from the dirty set at deletion, and the flush
  re-checks existence before rebuilding (S-005).
- Rebuild order within a flush: walls, then openings' walls (already
  included), then rooms, then items, then ground, then layers. Each entity
  is rebuilt at most once per flush.
- New geometry is uploaded before old geometry is released, so no frame shows
  a missing entity.

### D4. Caches follow the same graph

Derived caches (wall footprints with joins, room areas, project bounds, plan
wall union, hit-test shapes) are keyed by entity id and version counter. A
rebuild set invalidates the same keys the geometry uses, so the stale
neighbour-shape and baseboard-flag cache defects (W-010, W-011) cannot recur:
there is one invalidation path.

### D5. Observability

The host logs each flush with the number of entities per kind rebuilt and
the time taken. Tests assert on rebuild sets directly:
"moving a door from wall A to wall B rebuilds exactly A and B" is a unit
test over `expand`, no renderer involved.

## Alternatives considered

- **Listeners per entity type in the viewer.** Rejected:
  rules become scattered and drift from the 2D caches.
- **Rebuild everything on every change.** Fine for one room, unusable for a
  floor, and it hides bugs in the graph until scale.
- **Diffing the project snapshot to find changes.** Rejected: the command
  layer already knows what changed.

## Consequences

- `expand` and its table live in `engine` and are the first thing the viewer
  and the plan layers call after a change.
- Adding an entity kind or a dependency means adding a table row and a test,
  not touching the viewer.
- The bridge's `changes` messages (ADR-005) carry change sets; replicas run
  `expand` locally, so the host does not need to know how clients render.

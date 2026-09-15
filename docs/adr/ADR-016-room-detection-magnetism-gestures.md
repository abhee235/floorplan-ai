# ADR-016: Room detection, magnetism, and editor gestures as commands

Status: Proposed
Date: 2026-09-14
Related: ADR-001 (rooms, openings), ADR-004 (transactions), ADR-006 (create_room atPoint), ADR-011 (raster clean-up), ADR-014 (footprints)
Ledger lines this ADR must satisfy: R-021..R-060, W-067..W-091, F-063..F-069, F-075..F-099, F-100..F-118, F-130..F-144

## Context

Rooms are implied by walls on almost every office plan, so detection from
the wall union is the highest-value feature for reading plans. Detection has
to tolerate small gaps, pick nested enclosures deterministically, and close
door thresholds without footprint heuristics. Magnetism and gesture rules are
recorded in the ledger; we adopt them as commands so the mouse, the tools, and
the agent share one path.

## Decision

### D1. Room detection

`detectRooms(level, options)` in `geometry`:

1. Take the footprints of all walls on the level (ADR-014 D2, joins
   resolved) and union them in 2D.
2. **Close gaps**: dilate the union by the tolerance g, then erode by g
   (a morphological close), with g defaulting to 20 mm and settable up to
   100 mm for drafts from raster plans (ADR-011). A detection without it
   fails on any gap (R-024).
3. Take the interior rings of the closed union as candidate enclosures.
   Flatten arcs at 5 mm (R-022) and drop edges shorter than 1 mm (R-023).
4. For `atPoint`: among enclosures containing the point, choose the
   **smallest by area** (R-149 decided). None means no room.
5. **Threshold patching**: for each opening of kind `door` or `passage` on a
   wall bounding the enclosure, with sill 0, extend the polygon across the
   opening width to the wall centreline (R-034). Because openings are bound
   to walls, no footprint heuristics are needed (R-032, R-033, R-035..R-039
   collapse to this rule). A door wider than the wall segment it sits on
   is a validation problem, not a silent skip (R-037).
6. Return polygons in counter-clockwise order with collinear vertices kept
   (R-028), each with `source: "detected"` and the ids of the bounding walls.

A detected room becomes a `room.create` command. Later wall edits mark
detected rooms that touch the wall as stale (ADR-015); `room.detect` can
refresh them, and `recompute` is offered only when the polygon would change
(R-040).

### D2. Room polygon rules

Minimum three points and simple; a self-intersecting polygon is rejected by
validation (R-150 reversed), so area is always the absolute shoelace value
(R-006). Point insertion places the point on the nearest edge, projected onto
it (R-056 improved). Deleting a point below three is refused (R-057
reversed). Label anchor is the polygon's pole of inaccessibility, not the
bounding box centre (R-012 improved), with offsets stored on the room.

### D3. Magnetism

All snapping is computed in model millimetres from the current zoom
(pixel size p in mm):

| Rule | Value |
|---|---|
| Angle steps while drawing walls or rooms | 15 degrees, 24 steps (W-077, R-052); exact horizontal or vertical skips the step |
| Length rounding | precision by 2p: above 1000 mm round to 1000; above 100 to 100; above 50 to 50; above 10 to 10; above 5 to 5; else 1 (W-078 in mm); a positive length never rounds to zero |
| Wall free-end snap while drawing | 2p (W-068, W-069) |
| Wall corner and room vertex snap | 4p, Euclidean, excluding the edited entity's own points (W-080, W-081, R-051) |
| Axis alignment to nearby corners | within 4p on x or y (R-053) |
| Item side-by-side band | 8p (F-093) |
| Item drop onto a surface | all four corners inside the surface within 5 percent of the smaller item dimension (F-063) |
| Handle hit margins | selection 4p, indicators 5p; doubled and tripled for touch (F-130, R-050) |
| Modifier | magnetism is preference XOR held key (F-078); alignment key gives angle steps only (F-079) |

Candidates for snapping are entities on the selected level plus rooms of the
adjacent level (R-055), because ghosted lower floors
are what users align to.

### D4. Item placement pipeline

On drop, in order (F-075): elevate onto a surface below (parent set, F-070
replaced by a real parent link); then snap against the nearest wall, setting
rotation so the item's back faces the wall (F-085) and stopping at the wall
face; then, only if no elevation happened, side-by-side against a neighbour
of overlapping height (F-092..F-096); a placement fully inside a wall is
refused (F-089). On drag, the same pipeline runs with the item restored to
its pre-drag state each move and translated by the total delta, so magnetism
is never cumulative (F-080), and orientation is not changed (F-076). Only a
single-item drag magnetises (F-077). Room-relative anchors from ADR-006
resolve to a point and then run the same pipeline.

### D5. Gestures are transactions

Every gesture opens a transaction on press and commits on release, or rolls
back on Escape (F-162). Gestures and the commands they emit:

| Gesture | Commands |
|---|---|
| Draw wall chain: click points, double-click or return to the first point to close (W-067, W-070) | one `wall.createChain` on commit; a zero-length segment is ignored (W-067) |
| Drag wall endpoint (W-084) | `wall.move` with neighbour propagation |
| Drag wall middle (W-085) | `wall.modify` arcExtent, snapped to whole degrees (W-062) |
| Double-click inside walls in room mode (R-025) | `room.detect` |
| Click-draw room, double-click to finish; fewer than three points cancels (R-041, R-044) | `room.create` |
| Drag room vertex (R-058), add or delete vertex | `room.setPolygon` |
| Drag item, with the placement pipeline | `item.move` |
| Rotate handle, 15 degree steps with magnetism (F-113) | `item.rotate` |
| Resize handle, top-left anchored, proportional when the product is not deformable (F-100..F-104) | `item.resize` |
| Elevation handle, clamped at zero and a sane maximum (F-071) | `item.setElevation` |
| Alt-drag duplicate (F-145, F-146) | `item.duplicate` then `item.move` |
| Arrow keys | one `item.move` or `wall.move` transaction per press (F-192) |
| Paste (F-148, F-149) | one transaction; offset 200 mm when pasting over an identical selection |

Keyboard entry of lengths and angles while drawing (W-072..W-076) is kept as
a phase 3 editor feature, with angles relative to the previous wall.

### D6. Hit testing and selection

Hit priority is annotations, items, openings, walls, rooms (F-131 adapted).
Among items the highest elevation wins, then the last drawn (F-132). Hidden
entities and entities on non-viewable levels are never hit (F-133). A click
without drag on a multi-selection reduces to the clicked item (F-141).
Selection lives in application state (ADR-004 D6).

## Alternatives considered

- **Detection by walking wall graph edges.** Rejected; the union approach
  handles thick walls, arcs, and partial overlaps for free.
- **Choosing the first enclosure found** (R-026). Rejected; smallest
  containing is deterministic and matches user intent.
- **Threshold patching by footprint intersection** (R-035). Not needed with
  bound openings.

## Consequences

- `geometry` gains morphological close, interior-ring extraction, and pole
  of inaccessibility.
- `create_room` with `atPoint` and `import_plan` both use D1, so agents and
  plan reading share detection.
- Phase 3 editor work is mostly wiring D5 to the plan canvas; the commands
  and snapping already exist from phase 0 and 1 tests.

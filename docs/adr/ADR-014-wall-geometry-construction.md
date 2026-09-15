# ADR-014: Wall geometry construction: footprints, joins, arcs, sloped tops, openings, reveals, tolerances

Status: Proposed
Date: 2026-09-14
Refines: ADR-003 D3
Related: ADR-001 (wall and opening entities), ADR-008 (cut-out paths), ADR-015 (what a wall change invalidates)
Ledger lines this ADR must satisfy: W-001..W-012, W-018..W-028, W-048..W-059, W-093, W-097..W-113, W-123, W-125..W-131, O-051..O-083

## Context

This is the algorithm the whole 3D view depends on, and where the most subtle
behaviour lives: vertex welding, clamp rules for near-parallel joins, stacked
openings, reveals for arched doors, and z-fighting nudges. The ledger captures
the cases; this ADR fixes our version, in our units.

## Decision

### D1. Precision

The IR holds integer millimetres. The geometry kernel computes in float64
millimetres and emits float32 metres. Tolerances below are in millimetres.

| Tolerance | Value | Use |
|---|---|---|
| Vertex weld | 0.1 | joined corners closer than this become identical |
| Near-parallel | 0.01 degrees, and slope ratio within 0.4 percent | skip mitre intersection |
| Mitre clamp | 2 times the larger thickness | discard far intersections |
| Degenerate edge | 0.01 | drop |
| Arc flattening | 5 | max chord deviation for rooms and plan |
| Opening parallel test | 1 degree straight, 10 degrees arc | cut inflation applies only when parallel |
| Level shift | 1 | z-fighting nudge at floors and tops |

### D2. Footprint

For a straight wall with centreline from start to end and thickness t, the
footprint is the four points left-start, left-end, right-end, right-start,
offset by t/2 along the left and right normals, where left is the side to
the left when walking from start to end (with y up, that is the counter-
clockwise side). The index contract is fixed: index 0 and the last index are
the start end; the two middle indices are the end end. Arc walls produce
2(n+1) points with the same contract, n from D4.

### D3. Joins, computed symmetrically

Joins are resolved in one pass over all walls of a level, not per wall on
demand, which removes any dependence on the order walls are visited (W-028):

1. For each join `{ wallA, endA, wallB, endB }`, pair side lines: head-to-tail
   pairs left with left and right with right; head-to-head or tail-to-tail
   pairs left with right (W-019, W-020).
2. Intersect each pair. If the lines are near-parallel (D1) or the
   intersection is farther than the clamp from either unmitred corner, both
   walls keep their unmitred corners for that side (W-021..W-025).
3. Otherwise both walls receive the same intersection point for that side,
   welded to identical coordinates (W-027).
4. A wall joined to itself is rejected by validation (W-015). A wall joined
   to one neighbour at both ends is legal and disambiguated by the join
   record, never by coordinates (W-016 simplified).
5. The 180 degree fold-back keeps square butt ends (W-025).

### D4. Arc walls

Given arc extent a in degrees and chord d, the centre and radius are derived
as in the ledger (W-049). Tessellation count n equals the ceiling of the
square root of the outer arc length in millimetres divided by 10, at least
4, adjusted so segments are equal (W-052, W-053). Positive extent puts the
outer arc on the left side (W-055). Interior radius is clamped at zero
(W-056). An extent of exactly zero is normalised to absent on write, so the
centre trap (W-050) cannot occur. Splitting an arc wall halves the extent
(W-039 reversed).

### D5. Vertical extent

Bottom equals the level elevation, minus the floor thickness on levels other
than the lowest, plus 1 mm (W-097). Top equals the wall height or the level
height, plus 1 mm on levels other than the highest (W-098). A sloped top is
a linear function of distance along the wall between height and
height-at-end, evaluated per vertex (W-093). Zero and negative heights are
rejected by validation (W-101 reversed).

### D6. Sides as half slabs

Each side is a polygon from its outline to the centreline (W-106) so left
and right carry separate finishes and UVs. The centreline seam is culled
(W-123). UVs run along the side from its start corner and up the height;
mitre and end faces start at zero (W-108, W-110). Arc sides parametrise U by
arc length (W-111).

### D7. Openings

For each opening on the wall, in order of position:

1. Build the opening footprint from the wall centreline at the fractional
   position, the opening width, and a depth of the wall thickness plus 2 mm
   so both faces are pierced (O-057 simplified: openings always cut both
   faces of their own wall; the both-sides flag is a catalog default).
2. Subtract the footprint from each side polygon in 2D. Extrude the residual
   polygons over the vertical ranges below the sill, above the head, and,
   for windows, both.
3. Emit sill, head, and jamb faces through the thickness. For a cut-out path
   other than a rectangle, map the unit-square path into the opening
   rectangle and emit the reveal as the extrusion of that path through the
   thickness (O-069, O-073).
4. Openings never overlap on one wall (validation), so the stacked-window
   strip logic (O-060..O-064) reduces to sorting by sill.
5. An opening taller than the wall leaves no head geometry (O-054). Sloped
   tops clip the head (O-055).
6. A cut-out path that fails to parse falls back to a rectangle and reports
   a warning (C-050), never the offset fallback of O-079.

### D8. Skirting

Optional per side: a strip of given thickness and height along the outside
of the side, cut by openings, inheriting the side finish when unset
(W-107, W-112, W-113). Not in phase 0.

### D9. Normals

Straight walls: flat shading per face. Arc walls: smooth across tessellation
on sides, flat on caps (W-125).

## Alternatives considered

- **Per-wall lazy join computation with caches.** Rejected;
  the symmetric pass is simpler and deterministic.
- **3D boolean for openings.** Rejected (ADR-003).
- **Deriving cut-out shapes from meshes.** Rejected (ADR-008).

## Consequences

- `geometry` implements D2 to D4 and D7 step 2 as pure functions with
  ledger-numbered tests; `engine` implements extrusion and part emission.
- Validation in `ir` enforces the invariants this algorithm assumes:
  positive thickness, distinct endpoints, reciprocal joins, non-overlapping
  openings, positive heights.
- The six-wall L-shaped fixture (R-131, W-141) is reproduced in millimetres as
  the first golden test.

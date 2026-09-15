# ADR-003: three.js integration, engine output format, and the 2D plan view

Status: Proposed
Date: 2026-09-14
Supersedes: sections 5.2 and 5.3 of 00-brainstorm.md
Related: ADR-001 (coordinates), ADR-002 (package boundaries), ADR-015 (invalidation)
Ledger lines this ADR must satisfy: W-018..W-028, W-052..W-059, W-097..W-113, W-119..W-134, O-051..O-083, O-102..O-111, R-061..R-100, F-119..F-129, S-001..S-055

## Context

A plan editor's 3D view needs some geometry built by hand (wall joins, arc
tessellation, sloped tops, reveals, wall UVs), and a modern renderer gives the
rest for free (triangulation with holes, lighting, picking, glTF).

We also have to decide how the engine hands geometry to the renderer so the
engine stays testable in Node, and how the 2D plan is drawn so a 500-desk
floor stays responsive.

## Decision

### D1. Vanilla three.js with a thin binding, not react-three-fiber

The viewer is a small class in `apps/web` that owns one `THREE.Scene` and a
map from IR entity id to `THREE.Object3D`. It subscribes to change sets from
the command layer (ADR-004), runs the dirty set and dependency graph
(ADR-015), and rebuilds or patches only the affected objects. React is used
for editor chrome (panels, catalog browser, chat) and never touches the scene
graph.

Reason: the update path is the heart of the product and must be explicit and
testable. A declarative wrapper hides exactly the part we need to control.

### D2. Engine output is renderer-neutral buffers

`engine` produces plain data, never three.js objects:

```
GeometryPart {
  entityId: string
  part: "wall-left" | "wall-right" | "wall-top" | "wall-end" | "reveal" | "floor" | "ceiling" | "floor-side" | "item"
  positions: Float32Array      // metres, three.js frame (x, up, -y)
  normals: Float32Array
  uvs: Float32Array
  indices: Uint32Array
  materialKey: string
}
ItemInstance { entityId, assetKey, matrix: number[16], materialOverrides? }
```

Lengths convert from IR millimetres to metres at this boundary, once. The
viewer maps `GeometryPart` to `BufferGeometry` and `ItemInstance` to an
`InstancedMesh` slot or a cloned glTF. Because the engine emits buffers, its
tests assert on vertex coordinates and areas in Node with no WebGL.

### D3. Geometry construction rules

- **Walls.** Footprint from centreline and thickness. Joins by intersecting
  side lines with the clamp at twice the larger thickness and vertex welding
  at 0.1 mm (W-018..W-028). Arc walls tessellated by the square root of the
  outer arc length with the symmetric adjustment (W-052, W-053). Each side is
  built as a half-thickness slab so left and right can carry different
  finishes (W-106). Openings are subtracted in 2D from the side polygon, then
  the residual polygons are extruded; sill, lintel, and reveal faces are
  emitted explicitly (O-051..O-068). Sloped tops evaluate a top line per
  vertex (W-093). The centreline seam is culled (W-123).
- **Rooms.** Floor and ceiling from the polygon and holes through
  `THREE.ShapeUtils.triangulateShape`, which is earcut. No custom triangulator
  and no hole bridging. Upper levels get a floor slab side of the floor
  thickness and no underside on the lowest level (R-062..R-064). Overlapping
  rooms on one level subtract later rooms from earlier ones (R-065).
- **Items.** Two-stage transform. Stage one normalises the asset once to a
  unit cube with the catalog mesh rotation applied and re-centred (F-121..F-127).
  Stage two per item: scale by product size (negative x when mirrored), rotate
  by the item angle, translate to position and elevation (F-129). Non-uniform
  scale is allowed only when the product is deformable.
- **Instancing.** Items sharing an asset key and material go into one
  `InstancedMesh`. Walls and floors are separate `Mesh` objects per entity so
  the dirty set stays cheap. A later optimisation may merge static walls per
  level per material when a level is not being edited.
- **No lighting-driven subdivision.** Physically based materials make quad
  splitting unnecessary (W-124, R-081 are deliberately not implemented).
- **z-fighting.** Wall bottoms on upper levels are raised by 1 mm, wall tops
  on non-last levels by 1 mm (W-097, W-098).

### D4. Rendering defaults

- `WebGLRenderer` with `antialias`, sRGB output, ACES tone mapping off (flat
  office visuals read better), `MeshStandardMaterial` for surfaces.
- One `DirectionalLight` with shadow map plus one `HemisphereLight`. Shadows
  on for walls and items, off for floors receiving only.
- `OrbitControls` for orbit, a top-down orthographic camera for plan-like
  views, and `Raycaster` picking against the id map. No colour-id picking.
- Selection outline via `EdgesGeometry` overlay on the selected entity.
- Frustum near and far computed from the project bounds each frame the bounds
  cache is invalidated (S-050 simplified: near = max(0.05 m, distance/1000),
  far = distance + bounds diagonal times 4).

### D5. Assets

- glTF only at runtime, loaded with `GLTFLoader`, cached by asset key, cloned
  per item with shared geometry and cloned materials. Loading placeholder is
  a neutral box at the product size; a failed load shows a red box and logs
  the asset key (S-042, S-043). Assets are normalised offline to metres and
  origin at the footprint centre, so stage one is a bounding-box check only.
- Primitive recipes (box, cylinder, extruded profile, display panel, table
  with legs) are generated by the engine in `assets` and treated like any
  other asset key.

### D6. The 2D plan view

- Canvas 2D, not SVG, because a floor with hundreds of items and thousands of
  edges must pan and zoom at 60 frames per second.
- Four stacked canvases: static (grid, background image, other levels
  ghosted), structure (walls as a fused union per kind, rooms, openings with
  swing arcs), items (plan icons or footprints), and overlay (selection,
  handles, snapping feedback, dimension feedback). Each layer invalidates
  independently through the same dependency graph as 3D.
- Coordinates: the canvas applies one transform (scale, translate, y flip)
  and all drawing uses IR millimetres. Hit testing runs against IR geometry in
  model units, never against the DOM.
- The plan view emits the same commands as the MCP tools (ADR-004). Drawing a
  wall is a gesture that produces one transaction.

## Alternatives considered

- **react-three-fiber.** Good for declarative scenes; wrong fit for an
  incremental, dependency-driven update loop that we need to test directly.
- **Engine emits three.js objects.** Rejected: ties the engine to the DOM
  build and blocks Node tests and worker execution.
- **SVG plan view.** Simple hit testing and styling, but DOM cost at scale is
  prohibitive for open-plan floors.
- **3D CSG for openings.** Rejected; 2D subtraction then extrusion is simpler
  and robust, and it is what our ledger describes.
- **Merging all static geometry into one mesh from the start.** Rejected
  until measured; it fights the dirty set.

## Consequences

- The `geometry` package needs: offset polygon, line intersection with clamp,
  arc tessellation, polygon boolean wrapper, room detection from a wall
  union, and an earcut adapter. All with ledger-numbered tests.
- The engine needs a clear part naming so the viewer can style wall sides,
  reveals, and floors differently.
- A worker build of the engine is possible later because it has no DOM
  dependency.
- The plan view and the 3D view share one invalidation mechanism, defined in
  ADR-015.

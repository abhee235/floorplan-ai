# ADR-013: Export formats, ordering, and where each export runs

Status: Proposed
Date: 2026-09-14
Supersedes: section 5.11 of 00-brainstorm.md
Related: ADR-003 (engine buffers, plan layers), ADR-005 (host and viewer), ADR-009 (BOM), ADR-012 (file format)

## Context

The user selected all four export families: BOM spreadsheets, glTF scenes,
2D layout drawings, and IFC. Consumers are internal estimation first and
other tools second. Exports must be deterministic, refuse invalid projects
by default, and carry provenance.

## Decision

### D1. Order and phase

| Order | Format | Phase | Runs in |
|---|---|---|---|
| 1 | CSV and XLSX bill of materials | 1 | host |
| 2 | glTF binary scene (`.glb`) | 2 | host, from engine buffers |
| 3 | 2D layout drawing, PDF and DXF | 3 | host, from the plan layer model |
| 4 | IFC | 4 | host, via a permissively licensed IFC writer, scoped to walls, openings, spaces and furniture placements |

### D2. Common rules

- `export` (ADR-006) refuses when `validate` reports errors, unless `force`
  is passed, in which case the output carries a visible "draft" marker.
- Every export embeds provenance: project name, app version, export time,
  catalog snapshot date, rules pack version, and for BOMs the verification
  status per line.
- Units in exports are metres for geometry files and millimetres in
  drawings and spreadsheets, stated in headers.
- Exports are pure functions of the IR, the catalog snapshot, and the rules
  pack; the same inputs produce byte-identical output except for the
  timestamp field.

### D3. BOM spreadsheets

- CSV: one flat table, UTF-8 with BOM for spreadsheet compatibility, columns
  `scope, room, category, make, model, description, quantity, unit, unit
  price, currency, total, price type, price captured, status, reason, rule,
  source URLs`.
- XLSX: a `Summary` sheet (totals by status and by room), one sheet per room,
  a `Project` sheet for project-scope rules, a `Products` sheet with the
  catalog snapshot and sources, and a `Provenance` sheet. Unverified and
  placeholder lines are highlighted. Built with a maintained MIT spreadsheet
  library.

  Amended in phase 1: the workbook is written by our own small SpreadsheetML
  writer (`packages/exporters/src/xlsx.ts`) with a stored, uncompressed ZIP
  whose entries carry a fixed 1980-01-01 time. The libraries considered stamp
  creation dates into the package and its properties, which breaks D2's
  byte-identical rule, and a BOM workbook needs only inline strings, numbers,
  a few fills, column widths, a frozen header and an autofilter. The CSV also
  gains a `product id` column after `model`, and carries provenance as
  leading `# key: value` lines before the header.
- Export refuses two things by default: validation errors (override with
  `force`, which marks every sheet DRAFT) and unverified or placeholder lines
  (override with `includeUnverified`, which states it in the file and
  highlights them), following ADR-008 D3. Replacing an existing file needs
  `overwrite`. The exporters are pure and return bytes; the host resolves
  relative paths against the project directory, or the data directory's
  `exports` folder for an unsaved project, and writes atomically.

### D4. glTF

The host runs the engine to produce geometry buffers (ADR-003 D2) and writes
a glTF binary with one node per entity, named by entity id, grouped by level
and by room, with item nodes referencing the instanced asset meshes. Materials
are simple physically based colours per finish. No renderer is involved, so
this export works headless.

Implementation (phase 2): `projectToGlb` in `@fpv/exporters` writes the binary from `@fpv/engine`
parts, with the flat palette shared with the viewer (`@fpv/engine` `materialColour`), converted to linear
factors. Nodes are named by entity id and carry `extras.kind` and a few entity facts. The boardroom
fixture keeps a golden node list (`glb-nodes.json`), and a web test loads the file with the three.js
glTF loader.

### D5. 2D drawing

The plan layer model (ADR-003 D6) is rendered to vector primitives by a
drawing backend interface with two implementations: PDF (page size, scale
bar, title block, north arrow, room names and areas, item labels, mount
heights for wall and ceiling items as callouts) and DXF (layers per entity
kind: `WALL`, `OPENING`, `ROOM`, `ITEM`, `TEXT`, `DIM`, in millimetres, y up).
Because both come from the same primitives, the PDF and the DXF agree.

### D6. IFC

Scoped to `IfcWall`, `IfcOpeningElement`, `IfcDoor`, `IfcWindow`, `IfcSpace`
with the room purpose and area, and `IfcFurnishingElement` placements with
product names. Geometry as extruded footprints. Anything beyond that waits
for a real BIM consumer.

## Alternatives considered

- **Exporting glTF from the browser with the renderer's exporter.** Rejected:
  it would require an open viewer and would export view state.
- **DXF first for installers.** Deferred behind glTF because glTF is nearly
  free from engine buffers while a drawing export needs the layer model.
- **Full IFC coverage.** Out of scope until a consumer exists.

## Consequences

- `exporters` depends on `ir`, `engine`, `catalog` and third-party writers;
  it has no logic about what to export beyond formatting.
- The drawing backend interface is designed together with the plan view so
  the on-screen plan and the PDF share primitives.
- A fixture project with a golden CSV, XLSX cell set, and GLB node list is
  part of the test suite.

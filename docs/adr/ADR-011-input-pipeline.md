# ADR-011: Input pipeline per plan type; the PlanDraft contract; scale confirmation

Status: Proposed
Date: 2026-09-14
Supersedes: section 5.10 of 00-brainstorm.md
Related: ADR-001 (IR), ADR-004 (transactions), ADR-007 (Plan Reader role), ADR-016 (room detection)

## Context

Inputs are architect CAD and PDF, raster images and screenshots, hand
sketches, and sometimes only a brief. The previous attempt failed because
pixels went straight to geometry. Every path must end in the same
correctable intermediate, with confidence and questions, and must never
leak pixels or CAD units past the reader.

## Decision

### D1. One contract: PlanDraft

```
PlanDraft {
  source: { kind: "dxf" | "pdf-vector" | "pdf-raster" | "image" | "sketch" | "brief", file?, page? }
  units: { detected: "mm" | "cm" | "m" | "in" | "ft" | "unknown", scale: number | null, scaleSource: "dimension-text" | "scale-bar" | "block" | "user" | "guess" }
  levelName?: string
  walls: DraftWall[]          // centreline points in draft units, thickness, confidence
  openings: DraftOpening[]    // on which wall (by draft index) or at a point, kind, width
  rooms: DraftRoom[]          // polygon or label point, name text, purpose guess
  labels: DraftText[]         // text with position, for names and dimensions
  confidence: number
  questions: string[]         // what a human must confirm, scale first
}
```

Draft coordinates are floats in draft units; conversion to integer
millimetres and the y flip happen once when the draft is committed. Committing
a draft is one transaction of commands (ADR-004): `wall.createChain` per
connected chain, `opening.add`, `room.create`, `annotation.*`. Nothing writes
IR directly.

### D2. Paths by input kind

| Input | Extraction | Interpretation |
|---|---|---|
| DXF | Parse entities and layers with a permissive DXF library; polylines, lines, arcs, inserts, text, hatches, dimensions. Units from `$INSUNITS` when present. | Deterministic pass: pair parallel line pairs into wall centrelines with thickness, arcs into openings by layer name, closed polylines and hatches into rooms, text into labels. Then the reader model classifies layers and resolves ambiguities (which layer is walls, which text are room names) from a compact summary, not the raw file. |
| PDF vector | Extract paths and text per page with a PDF library. | Treated as DXF-like geometry once paths are grouped by stroke width and colour. Scale from dimension text or a scale bar. |
| PDF raster, image, screenshot | Rasterise to at most 2048 pixels on the long side. | Vision reader model outputs a PlanDraft in a normalised 0 to 1000 coordinate box, with a scale hint if any text or scale bar is visible. Then classical clean-up: orthogonalise lines within 5 degrees of an axis, merge collinear segments, snap endpoints within 1 percent of the image diagonal, close gaps below the room-detection tolerance. |
| Hand sketch, whiteboard photo | Same as raster, plus perspective correction when four corners are found. | Same reader, all dimensions marked estimated, confidence capped at 0.5, and a mandatory question for one known dimension. |
| Brief only | None. | Skips the reader; `create_room_from_brief` (ADR-006) handles it. |
| DWG | Not parsed. | The app explains that DWG must be saved as DXF or PDF first. Revisit when a permissively licensed converter is available. |

### D3. Scale is always confirmed

No draft is committed with `scaleSource` other than `user` unless the
detected scale came from dimension text that cross-checks against at least
two measured segments within 2 percent. The app shows a dimension overlay on
the image and asks the user to confirm or type one known length. This is the
single biggest guard against a silently wrong model.

Amendment 2026-09-16 (P2-2): for image, raster PDF and sketch drafts the
dimension-text cross-check is not enough, because the model reads the
measured end points from pixels a few percent off; two strings agreed within
2 percent while the scale was 10 percent wrong. Those drafts always need a
person to confirm the scale.

### D4. Reader prompts and validation

The reader model is asked for JSON matching the PlanDraft schema with a
short system prompt describing conventions (walls as centrelines, openings
with the wall they cut, rooms as closed polygons or a label point) and one
worked example. Output is validated and retried (ADR-007 D2). The draft is
then run through `validate` after commit; problems become questions.

### D5. Human review before commit

The app renders the draft over the source image or drawing with toggles per
entity type, lets the user delete, move, and re-thickness walls, and only
then commits. In the MCP path, `import_plan` returns the draft and its
questions and commits only when called again with `confirm: true` and the
answers.

### D6. Fixtures

`tools/fixtures/plans` holds sample DXF, PDF and raster plans with
hand-labelled expected drafts. Reader quality is measured as wall recall,
opening recall, room recall and scale error, per provider, and reported
with the evaluation table (ADR-007 D5).

Amendment 2026-09-16: real drawings live in `tools/fixtures/plans-real` with
their sources and licences, scored against their own wall line work and hand
counts rather than hand-labelled walls (spec 06 A4). Generated plans stay in
`tools/fixtures/plans`.

### Amendment 2026-09-15 (P2-1)

The DXF path uses an own ASCII DXF parser in `packages/importers` instead of
a library. Floor plans need only a dozen entity types, the permissively
licensed parsers either drop DIMENSION text overrides and block nesting or
pull in rendering code, and an own reader keeps the package pure and the
output deterministic. Binary DXF is refused with a message to save as
ASCII. The deterministic pass is specified in spec 06 A5; hatches are not
read yet, and layer classification by a reader model stays for drafts whose
layers the name rules cannot place (an `ambiguity` question marks them).

## Alternatives considered

- **Detection models (YOLO, segmentation).** Rejected on the record of the
  previous attempt; they classify but do not reason about scale bars, labels
  and conventions.
- **Vision model straight to IR commands.** Rejected: the draft stage is
  where correction and confidence live.
- **Vectorising rasters with classical CV before the model.** Kept as
  clean-up after the model, not as the primary parser.

## Consequences

- `importers` provides DXF and PDF extraction and raster clean-up with no
  model dependency; `agents` provides the reader role that turns extraction
  summaries or images into drafts.
- The room-detection tolerance in ADR-016 must accept the gaps raster
  clean-up leaves.
- Phase 2 starts with DXF and raster because they cover the most real inputs
  with the least ambiguity.

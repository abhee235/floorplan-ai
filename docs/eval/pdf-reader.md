# Vector PDF reader on a real drawing (PRD P2-7)

`tools/fixtures/plans-pdf-real` holds one page of a PDF drawn by someone else,
extracted by `tools/build-pdf-real-fixture.ts` so the test runs offline; the
licence is in that directory's `SOURCES.md`. `tools/score-pdf.ts` reads it with
`pdfPageToDraft` and compares against a hand-made expectation. No model is
involved: the PDF reader is deterministic.

The generated fixture (`tools/fixtures/plans/office-mm.pdf`, drawn by
`tools/build-plan-fixtures.ts`) still reaches the DXF metrics, and
`apps/host/test/pdf.test.ts` holds it there.

## nist-tn1838-first-floor (2026-09-16)

A dimensioned CAD floor plan of a house in metres, from a NIST technical note
(public domain). Measured from the drawing: the outer walls form a 287.2 by
102.96 pt rectangle and the report gives the footprint as 17.15 by 6.15 m, so
one page point is 59.72 mm in both directions.

| What | Expected | Read |
|---|---|---|
| Walls | at least 10 | 3 |
| Openings | some | 0 |
| Millimetres per point | 59.72 | 35.83 (40 percent out) |
| Scale source | dimension text | dimension text |
| Room names | none on the drawing | 19 labels from the legend and notes |

The reader is wrong on this drawing, and the fixture records it. What the
measurements say:

- **The wall layer is picked badly.** Grouped by stroke width and colour, the
  page holds a 0.85 pt black group of 91 lines (2864 pt) whose pairs sit 1 to 4
  pt apart: those are the walls, and at 59.72 mm per point that is 60 to 240 mm,
  matching the drawing's own note that walls are 0.11, 0.15 or 0.17 m thick. The
  reader instead chose the 1.17 pt group, which is the sheet border: two nested
  rectangles pair perfectly, and the rule preferred the heaviest stroke.
- **Hatching and furniture pair too.** The 0.43 pt black group is the largest by
  length (15503 pt) and pairs at 4 to 16 pt, which is 240 to 955 mm: too thick
  for a wall. Preferring the group with the most paired line work picks it.
- **The scale is read from the wrong line.** The dimension labels are matched to
  the nearest parallel line, and one of them lands on a line that is not its
  dimension, giving 35.83 instead of 59.72.
- **Legend and note text becomes room names.** The plan names no rooms, so every
  short label in the legend and title block is read as one.

The fix these point to, in order: read the scale from the dimension text first
and check it against the drawing's extent, then keep only groups whose pair
spacing is a plausible wall thickness at that scale (the DXF reader's 60 to 500
mm test), exclude sheet borders by their shape rather than their line count, and
treat text away from the wall line work as a note. Three quick heuristic changes
tried before that (prefer paired length, exclude borders by line count, require a
repeated pair spacing) moved the wall count between 3 and 51 without ever
choosing the right group, which is why the fix is written down here first.

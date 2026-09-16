# Vector PDF reader on a real drawing (PRD P2-7)

`tools/fixtures/plans-pdf-real` holds one page of a PDF drawn by someone else,
extracted by `tools/build-pdf-real-fixture.ts` so the test runs offline; the
licence is in that directory's `SOURCES.md`. `tools/score-pdf.ts` reads it with
`pdfPageToDraft` and compares against a hand-made expectation, and
`packages/importers/test/pdf.real.test.ts` holds the reader to it. No model is
involved: the PDF reader is deterministic.

The generated fixture (`tools/fixtures/plans/office-mm.pdf`, drawn by
`tools/build-plan-fixtures.ts`) still reaches the DXF metrics, and
`apps/host/test/pdf.test.ts` holds it there. That test is the gate on every
change here: a drawing that dimensions itself properly must keep being read from
its dimension text, which a person can confirm.

## nist-tn1838-first-floor (2026-09-16)

A dimensioned CAD floor plan of a house in metres, from a NIST technical note
(public domain). Measured from the drawing: the outer walls are the 0.85 pt
strokes forming a 287.2 by 102.96 pt rectangle, and the report gives the
footprint as 17.15 by 6.15 m, so one page point is 59.72 mm in both directions.

| What | Expected | Before | After |
|---|---|---|---|
| Wall layer | the 0.85 pt strokes | the 1.17 pt sheet frame | the 0.85 pt strokes |
| Walls | at least 10 | 3 | 28 |
| Openings | some | 0 | 15 |
| Millimetres per point | 59.72 | 35.83 (40 percent out) | 59.72 (exact) |
| Room names | none on the drawing | 19, from the legend and notes | 6 note fragments |

What the page taught us, and what changed in `packages/importers/src/pdf.ts`:

- **Walls are long parallel pairs.** Hatching, furniture and door and window
  symbols pair as readily as wall faces do, and the busiest group here is the
  0.43 pt line work of the fixtures (15503 pt against the walls' 2864). What
  separates them is line length: the walls average 31 pt per paired line, the
  fixtures 10. A group now has to carry long paired lines to be considered, and
  a second group joins the walls only if it carries nearly as much paired line
  work, so a thin detail group cannot creep in beside unmistakable walls.
- **The scale comes from the plan's extent when the dimension lines cannot give
  it.** The dimension lines on this sheet are broken around their text, so no
  single line is as long as the length beside it, and matching a label to the
  nearest parallel line picks the frame or a piece of the plan. The longest
  length a drawing states is its overall dimension, and that is measured across
  the wall line work, which gives 59.72 mm per point exactly. It stands in only
  when fewer than two labels sit beside a line of their own length, so a drawing
  that dimensions itself is still read from its dimension text.
- **A label that disagrees with the extent is not a dimension.** A match is
  accepted only when the scale it implies is within 10 percent of the extent
  reading, which keeps stray matches from becoming dimension checks.
- **Text away from the wall line work is a note.** The legend, the title block
  and the notes sat on the room layer and became room names; they are now
  ignored. Six fragments of the multi-line notes still land inside the plan's
  box and are read as labels; on import they are dropped as labels no walls
  enclose, but tightening that is still open.

Still open on this page: doors are not told apart from windows (all 15 openings
are read as windows, because the drawing marks them by a legend and a written
size rather than a swing), and the six note fragments above.

An earlier attempt tuned the wall-group rule by trial: preferring the heaviest
stroke, then the most paired line work, then a repeated pair spacing. Each moved
the wall count (3, then 51, then 8) without choosing the right group, and one of
them quietly halved the generated fixture's opening recall. The rules above come
from measuring the page's groups instead, and the generated fixture is asserted
alongside the real one on every change.

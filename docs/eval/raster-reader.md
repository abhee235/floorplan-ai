# Raster reader evaluation (PRD P2-2)

Fixture images: `tools/fixtures/plans-raster` (the generated office and L-shaped
plans drawn as 1600 pixel PNGs). Scale confirmed from the fixture, then scored
per spec 06 A4: wall recall and precision by centreline within 150 mm, opening
recall within 300 mm, room recall by name. Recorded 2026-09-16 with prompt
`reader-v1`: the Qwen rows on a local Ollama (`reasoning_effort: none`), the
gpt-5.6-luna row on OpenAI. The Qwen replies are kept in
`tools/fixtures/plans-raster/replies` and replayed by
`tools/test/raster-replay.test.ts`.

| Model | Plan | Seconds | Wall recall, model only | Wall recall, refined | Wall precision, refined | Opening recall | Rooms made on commit |
|---|---|---|---|---|---|---|---|
| qwen3.6:35b | office | 41 | 0.25 | 1.00 | 1.00 | 0.25 | 3 of 3 |
| qwen3.6:35b | L-shape | 73 | 0.00 | 1.00 | 1.00 | 0.29 | 3 of 3 |
| qwen3.8:27b | office | 119 | 0.96 | 1.00 | 1.00 | 0.88 | 3 of 3 |
| qwen3.8:27b | L-shape | 203 | 0.81 | 1.00 | 1.00 | 0.86 | 3 of 3 |
| gpt-5.6-luna | office | 18 | 1.00 | 1.00 | 1.00 | 1.00 | not run |
| gpt-5.6-luna | L-shape | 23 | 0.77 | 1.00 | 1.00 | 0.86 | not run |

Findings:

- Qwen vision models give coordinates as 0 to 1000 on each axis; an
  aspect-correct box in the prompt was ignored, so the contract follows the
  models (spec 06 A1 raster note).
- Model positions are 3 to 5 percent of the image off. Snapping walls to the
  drawn lines (refinement) is what brings recall above the PRD's 0.8.
- Models draw walls as separate pieces at doorways and sometimes miss a piece
  or invent one where text is. Refinement joins pieces across door-sized gaps
  (recording passages), recovers a missed piece where the drawn face lines
  resume, and drops walls with no continuous ink when most walls are confirmed;
  with that, every labelled room is enclosed when the draft is committed.
- The larger qwen3.8:27b finds openings far better (0.71 to 0.75 against 0.13)
  but takes two to three times as long.
- Two-line labels ("BOARDROOM" over "12 PAX") keep the first line as the name and the rest
  as capacity; model room outlines are ignored and rooms are detected from the refined walls.
- gpt-5.6-luna (OpenAI) read the office plan exactly: every wall and opening
  found, no false walls, the scale from the dimension text, all three room
  names, in 18 seconds against 41 to 119 for the local models. It needs no
  refinement on that image.
- On the L-shaped plan it drew 17 wall pieces where 8 were wanted (recall 0.77,
  precision 0.72 before refinement) but found 6 of 7 openings. Refinement brings
  the walls to 1.00 recall and precision and leaves the openings and the
  dimension-text scale as they were. It answers in one attempt and gives
  coordinates in the same per-axis 0 to 1000 frame as Qwen.
- **The model varies between runs.** A second live reading of the L-shaped plan
  found fewer openings (0.57) and fell back to a guessed scale. Replaying one
  saved reply with and without refinement (`--replay`, `--no-refine`) shows
  refinement is not the cause: on the same reply it raises walls from 0.77 and
  0.72 to 1.00 and 1.00 and changes neither the openings nor the scale. One
  live reading is therefore not a measurement; the recorded replies are what the
  tests replay.
- Room names and rooms made on commit were not measured for gpt-5.6-luna: this
  run scored the draft only. All three names were read on both images.
- The images are generated; real scanned plans (noise, hatching, furniture,
  skew) are not yet measured.

## A scanned drawing (2026-09-16)

`tools/fixtures/plans-raster-real` holds drawings made by other people, with
their licences in that directory's `SOURCES.md`. They cannot be labelled wall by
wall, so they are scored coarsely: room names, counts, and how far the scale is
from one measured by hand off the image.

| Model | Plan | Seconds | Rooms found | Walls | Doors | Windows | Scale source | Scale error |
|---|---|---|---|---|---|---|---|---|
| gpt-5.6-luna | Putnam House, HABS survey scan | 61 | 5 of 5 | 21 | 22 | 12 | dimension text | 19.3 percent |

The image is the first floor plan of a 1930s Historic American Buildings Survey
sheet: hand lettered, scanned, with dimension chains, a door schedule and
hatched chimney breasts, cropped to 1557 by 1600 pixels.

- **Every room name was read**, including ones the expectation does not ask for
  (NEW BAY, CLO., CLO., CUPB.). Hand lettering did not stop it.
- **The scale was wrong by a fifth.** The model read the dimension text and
  arrived at 13.57 mm per draft unit where the drawing gives 16.81 (measured
  from the image: the long wall runs span 687.5 draft units and the sheet says
  37 ft 11 in across). Two dimension readings agreeing with each other is what
  the reader treats as confirmation, and here they agreed with each other and
  not with the drawing, which is why a raster scale is never confirmed without a
  person (spec 06 A1).
- **It took two attempts** (the first reply did not validate) and 18,220 tokens,
  61 seconds in all. Refinement snapped 27 walls and dropped 3.
- Door and window counts have no truth to compare against on this sheet, so they
  are recorded but not scored.

Reproduce: set `FPV_READER_PROVIDER` (`ollama`, `openai` or `openrouter`) and
`FPV_READER_MODEL` in `.env` (see `.env.example`), then
`corepack pnpm exec tsx tools/score-raster.ts` (add `--no-refine` for the model's
own numbers), or replay a saved run with `--replay docs/eval/raster-<model>.json`.
A local Ollama needs `OLLAMA_CONTEXT_LENGTH` well above its 4,096 default.

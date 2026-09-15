# Raster reader evaluation (PRD P2-2)

Fixture images: `tools/fixtures/plans-raster` (the generated office and L-shaped
plans drawn as 1600 pixel PNGs). Scale confirmed from the fixture, then scored
per spec 06 A4: wall recall and precision by centreline within 150 mm, opening
recall within 300 mm, room recall by name. Recorded 2026-09-16 with prompt
`reader-v1` on a local Ollama (`reasoning_effort: none`); replies are kept in
`tools/fixtures/plans-raster/replies` and replayed by
`tools/test/raster-replay.test.ts`.

| Model | Plan | Seconds | Wall recall, model only | Wall recall, refined | Wall precision, refined | Opening recall | Rooms made on commit |
|---|---|---|---|---|---|---|---|
| qwen3.6:35b | office | 41 | 0.25 | 1.00 | 1.00 | 0.25 | 3 of 3 |
| qwen3.6:35b | L-shape | 73 | 0.00 | 1.00 | 1.00 | 0.29 | 3 of 3 |
| qwen3.8:27b | office | 119 | 0.96 | 1.00 | 1.00 | 0.88 | 3 of 3 |
| qwen3.8:27b | L-shape | 203 | 0.81 | 1.00 | 1.00 | 0.86 | 3 of 3 |

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
- The images are generated; real scanned plans (noise, hatching, furniture,
  skew) are not yet measured.

Reproduce: `FPV_READER_BASE_URL=http://127.0.0.1:11434/v1 FPV_READER_MODEL=<model>
FPV_READER_EXTRA_BODY='{"reasoning_effort":"none"}' corepack pnpm exec tsx tools/score-raster.ts`,
or replay a saved run with `--replay docs/eval/raster-<model>.json`.

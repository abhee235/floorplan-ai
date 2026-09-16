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
| gpt-5.6-luna | L-shape | 23 | 0.77 | 0.97 | 1.00 | 0.57 | not run |

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
  precision 0.72 before refinement) but found 6 of 7 openings. It answers in one
  attempt and gives coordinates in the same per-axis 0 to 1000 frame as Qwen.
- **Refinement regression to look into.** On that L-shaped reading, refinement
  raised walls (recall 0.97, precision 1.00) but dropped opening recall from
  0.86 to 0.57 and left the scale as a guess instead of the dimension text the
  model had read. Snapping walls changes the lengths the dimension checks
  measure against, so the two agreeing checks no longer agree within 2 percent.
  The Qwen readings did not show this because their raw walls were further out.
- Room names and rooms made on commit were not measured for gpt-5.6-luna: this
  run scored the draft only. All three names were read on both images.
- The images are generated; real scanned plans (noise, hatching, furniture,
  skew) are not yet measured.

Reproduce: set `FPV_READER_PROVIDER` (`ollama`, `openai` or `openrouter`) and
`FPV_READER_MODEL` in `.env` (see `.env.example`), then
`corepack pnpm exec tsx tools/score-raster.ts` (add `--no-refine` for the model's
own numbers), or replay a saved run with `--replay docs/eval/raster-<model>.json`.
A local Ollama needs `OLLAMA_CONTEXT_LENGTH` well above its 4,096 default.

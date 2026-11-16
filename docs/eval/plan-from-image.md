# A plan handed over as a picture

The other half of the live loop (ADR-028 D11): instead of a brief, the first message carries a
drawing, and the run has to read it rather than design it. The card is
`tools/eval/cards/plan-from-image-live.json`, driven through a host exactly as a browser tab drives
it:

```
tsx tools/eval/live.ts --host ws://127.0.0.1:4311/bridge --card plan-from-image-live --out <dir>
```

The attachment is `tools/fixtures/plans-raster/office-mm.png`, a 12 by 8 m office: outer shell, one
partition north to south, one east of it running east to west, three rooms named in the drawing, four
windows, three doors, one entrance. Because nobody is watching a card run, the card answers the
questions the run asks -- `"answers": { "*": "yes" }` -- and answering a scale question is the whole
point of the flow: a raster plan only commits when a person confirms its scale (ADR-011 D3).

## The checks

The design checks do not apply to a run that reads, so the loop branches: it checks that
`import_plan` was called, that a draft was committed, that walls, rooms and openings came out of it
in the numbers the card states (`read: { walls: 6, rooms: 3, openings: 8 }`), that the run looked at
what it had read, that nothing was drawn by hand (`create_walls`, `add_opening`, `create_room` never
called), and that `validate` reports no errors.

## The runs

`gpt-5.6-luna` through OpenAI, with vision on, on 2026-09-23.

| Run | Checks | Minutes | What happened |
|---|---|---|---|
| 1 | failed | 0.9 | Committed at 1 mm per unit and built an office 571 mm across. The card's task said "the drawing is in millimetres", the model answered the scale question with "mm", and the reader's own 21 mm per unit was overwritten without a word. |
| 2 | 10 of 10 | 0.9 | Kept the reader's scale. Six walls within 150 mm of the fixture, three rooms with the drawing's names and purposes, eight openings, validate clean. |
| 3 | failed | 0.9 | The same 1 mm per unit again: one sentence in the task was enough to lose the scale twice in three runs. |
| 4 | 10 of 10 | 0.9 | After the refusal below. It confirmed 21.01 mm per unit, committed 12.0 by 8.0 m, and described what it had read back correctly, room by room and area by area. |

## What runs 1 and 3 changed

A scale answer that contradicts the drawing is now refused rather than obeyed
(`packages/tools/src/tools/import.ts`). When a draft's scale came from the plan's own dimension texts
and an answer moves it by more than 5%, `import_plan` throws and says both numbers and what the plan
would become -- "the drawing's own dimension texts imply 21 mm per unit and this sets 1, which would
make the plan 5% of the size it says it is" -- with a hint naming the question id to answer `"yes"`
instead. Giving units or a length is for a drawing that has no dimensions of its own.

A second, weaker guard catches a scale nothing contradicts: a plan committed at under 3 m or over
500 m across is warned about by its extent, because every wall in it is perfectly well formed and
`validate` has nothing to say. The card's misleading sentence was removed as well; a person may write
one like it, so the refusal is what holds.

## Where it stands

The flow works end to end through the product, not in-process: a picture attached to a message, read
by the reader model, its scale asked about as a card, answered, committed, validated, looked at and
described back -- in under a minute. What it does not yet do is compare what it drew against the
picture pixel by pixel (PRD P4-6, `compare_plan_image`); the run's own comparison above is the model
looking at two images and saying they match.

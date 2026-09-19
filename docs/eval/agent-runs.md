# Agent evaluation (PRD P1-7, P1-8)

Task cards live in `tools/eval/cards`: `boardroom` (the phase 1 brief, "10-seat
boardroom, 8 by 5 metres, video conferencing") and `import-office` (import and
confirm `tools/fixtures/plans/office-mm.dxf`). Each run starts from an empty
project with the seed catalog in memory and the core AV rules pack. The model
gets the designer system prompt (the workflow prompt plus the role) and the
registry's tools for its reliability profile as JSON Schema, at temperature 0,
with the card's step budget. A step is one model turn.

A run passes when the model stopped with an answer inside the budget, nothing
the card expects is missing (rooms by name, purpose, capacity and area; item
categories and counts; walls), and validation reports no more errors than the
card allows. BOM verified is the share of product lines (labour excluded) that
are verified in the seed catalog.

Run it with
`corepack pnpm exec tsx tools/eval/run.ts --models ollama:<model>[,...] [--cards <ids>] [--reliability low|medium|high]`.
Every score is appended to `agent-results.jsonl`; transcripts go to
`transcripts/` (not checked in). The table shows the latest run per card, model
and profile.

<!-- runs:start -->
| Card | Model | Profile | Result | Steps | Tool calls (failed) | Tokens in / out | Seconds | Validation errors | Missing | BOM verified | Date |
|---|---|---|---|---|---|---|---|---|---|---|---|
| boardroom | gpt-5.6-luna | medium | pass | 8 of 40 | 7 (1) | 89786 / 366 | 14 | 0 | none | 0% of 14 | 2026-09-15 |
| boardroom | qwen3.6:35b | medium | pass | 17 of 40 | 16 (2) | 304651 / 1413 | 125 | 0 | none | 0% of 14 | 2026-09-16 |
| import-messy-dxf | gpt-5.6-luna | medium | pass | 5 of 25 | 4 (0) | 51270 / 307 | 10 | 0 | none | - | 2026-09-16 |
| import-messy-dxf | qwen3.6:35b | medium | pass | 10 of 25 | 9 (1) | 251778 / 1295 | 68 | 0 | none | - | 2026-09-16 |
| import-office | gpt-5.6-luna | medium | pass | 5 of 20 | 4 (0) | 34360 / 184 | 8 | 0 | none | - | 2026-09-15 |
| import-office | qwen3.6:35b | medium | pass | 5 of 20 | 4 (0) | 50667 / 708 | 20 | 0 | none | - | 2026-09-16 |
<!-- runs:end -->

## Findings (2026-09-16)

- **qwen3.6:35b, local on Ollama, passed all three cards** at the medium
  profile, with no validation errors and nothing missing: the boardroom in 17
  turns, the messy DXF in 10, the office DXF in 5. That is the second provider
  PRD P1-8 asks for, and the phase 1 metrics are now measured for a local model.
- **It costs more turns and far more tokens than the hosted model.** Boardroom:
  17 turns, 304,651 input tokens and 125 seconds against 8 turns, 89,786 tokens
  and 14 seconds for gpt-5.6-luna. The extra turns are exploratory rather than
  corrective: after furnishing the room it called `search_catalog` seven times
  and `verify_product` once, then `render`. Both refusals (no search provider,
  no viewer) were handled and it carried on, which is what the tool surface is
  designed for.
- **Loading the model is the fragile part, not the run.** At a 32,768-token
  context this 24 GB model failed to load twice on this machine, with
  llama-server reporting out of memory allocating a 9.9 GB host buffer, and
  succeeded on the third attempt. A separate preload returned the same 500. The
  runner's retries absorbed it; without them the run would have ended at step 1.
- Both models leave BOM verified at 0 percent, which measures the seed catalog
  rather than the model: its products stay unverified until `verify_product`
  runs with a search provider.

- **gpt-5.6-luna (OpenAI)** passed both cards. Boardroom: 8 turns in 14 s
  (get_scene, a history checkpoint, create_room_from_brief, validate,
  describe_room, render, get_bom, then the answer). Import: 5 turns in 8 s. Its
  one failed call was render, which has no viewer in the evaluation; the model
  carried on as the prompt tells it to. The PRD P1-7 bound of 40 steps is met
  with room to spare.
- **OpenAI parameters.** On `/v1/chat/completions` this model refused
  `max_tokens` (it wants `max_completion_tokens`), refused `temperature: 0`
  unless reasoning is off, and accepts function tools only with
  `reasoning_effort: "none"`. The provider learns these from the 400 replies
  and adapts; the runs above used chat completions with reasoning off.
  Reasoning together with tools needs OpenAI's `/v1/responses` API, which is not
  wired yet; a run with it would show whether reasoning improves results.
- **BOM verified is 0 percent** because the seed catalog's products stay
  unverified until `verify_product` runs with a search provider. It measures
  the catalog, not the model.
- **Ollama context.** The Ollama server loads models with a 4,096-token context
  by default, which cut the first local attempts to about 2,050 tokens (the tool
  list alone is about 9,000). qwen3.6:35b then called a tool that does not exist
  in a loop, and qwen3.8:27b got an HTTP 500. Those runs were discarded. The
  server now runs with `OLLAMA_CONTEXT_LENGTH=32768`, and the runner warns when a
  prompt stops growing.
- **Local speed.** With the full prompt, qwen3.8:27b on this machine keeps 12 of
  19 GB on the GPU and reads prompts at about 20 tokens per second, so one turn
  takes about three minutes. Local rows are added when that run finishes.

## The three-bedroom brief, before and after the prompt (2026-09-20)

One brief, "build a 3 bedroom apartment with hall and lobby", run twice through
the chat agent against gpt-5.6-luna, on either side of the residential
vocabulary and the sectioned system prompt.

| | before | after |
|---|---|---|
| rooms | 5 | 9 |
| bedroom areas | 8 m² each | 11.6, 12.9, 14.9 m² |
| kitchen, bathroom | neither | both, plus a separate toilet |
| items placed | 0 | 20, in every room |
| walls left around nothing | 24 | 0 |
| failed tool calls | many, uncounted | 0 of 53 |
| steps | 40, the budget | 25, finished |
| prompt tokens | about 760,000 | 420,000 |
| summary | claimed a finished flat | named the two warnings it left |

Before, "hall" was read as a corridor, `create_room_from_brief` assumed a
meeting room for every brief, and rooms were deleted and redrawn five times
over. After, the model read the hall as the living room and the lobby as the
foyer without being asked, kept a seven-item plan, and its answer said which
warnings it was leaving behind.

What the run still gets wrong, and what the design phase is for: the plan is a
three-by-three grid with a room in each cell, so the bathroom is 13.4 m² and the
toilet 14.1 m² while the living room is 9.8 m². There is no corridor; rooms open
into one another. Five of the nine rooms have a side with no wall along it,
because the model drew five interior walls where nine rooms need more, and
nothing in `validate` says a room's polygon must be fenced in. Room areas by
purpose, wall enclosure and a reachable route from the entrance are checks a
program can make, and the architect step is where they belong.

### The same flat, refurnished by the fixed placement code

The run's walls, doors and windows are the model's own; only the furniture was
stripped and placed again, so this measures the placement code against the
drawing that exposed it.

| | as the run left it | refurnished |
|---|---|---|
| items standing across a door or window | 12 | 1 |
| beds with no wall behind the head | 1 | 0 |
| items outside their room | 0 | 0 |
| item overlaps | 0 | 0 |

Two faults caused the twelve. A recipe read the whole length of a wall as
somewhere to stand things, so a wardrobe went over the door beside it; it now
places into the free stretches `describe_room` already computes, which have the
openings taken out. And a room only counted a wall as its own when both ends of
the wall touched the room, so the twelve-metre wall dividing this flat into
three rooms belonged to none of them: those rooms had no walls at all as far as
the recipes were concerned. Matching is now edge against edge.

Where nothing fits, the recipe says so instead of placing anyway: six rooms
came back with a line like "no free run on the north wall for the Sofa: it is
2000 mm wide and the longest gap between the openings is 1430 mm".

The one remaining is a true finding, not a miss. Bedroom 2 has doors in three
of its four walls and no wall at all on the fourth, so the only free stretch
long enough for the bed leaves it 140 mm from the east wall, where it crosses
that door. No per-room rule can place furniture well in a room shaped like
that. It is a design fault, and the architect phase is where it gets fixed.

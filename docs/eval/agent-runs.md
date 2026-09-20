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
| four-bed-house | gpt-5.6-luna | high | pass | 12 of 36 | 19 (0) | 208497 / 1188 | 42 | 0 | none | 59% of 22 | 2026-09-20 |
| import-messy-dxf | gpt-5.6-luna | medium | pass | 5 of 25 | 4 (0) | 51270 / 307 | 10 | 0 | none | - | 2026-09-16 |
| import-messy-dxf | qwen3.6:35b | medium | pass | 10 of 25 | 9 (1) | 251778 / 1295 | 68 | 0 | none | - | 2026-09-16 |
| import-office | gpt-5.6-luna | medium | pass | 5 of 20 | 4 (0) | 34360 / 184 | 8 | 0 | none | - | 2026-09-15 |
| import-office | qwen3.6:35b | medium | pass | 5 of 20 | 4 (0) | 50667 / 708 | 20 | 0 | none | - | 2026-09-16 |
| one-bed-flat | gpt-5.6-luna | high | pass | 10 of 26 | 13 (0) | 140040 / 859 | 31 | 0 | none | 67% of 9 | 2026-09-20 |
| one-bed-flat | gpt-oss:20b | medium | fail (provider-error) | 2 of 26 | 1 (0) | 8363 / 413 | 703 | 0 | room bedroom 9-20 m2; room living 12-30 m2; room kitchen 5-16 m2; room bathroom 3-9 m2; bed; sanitary; 1 bed (found 0) | - | 2026-09-20 |
| one-bed-flat | hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS | medium | fail (context-full) | 21 of 26 | 20 (0) | 405847 / 2530 | 372 | 0 | sanitary | 100% of 2 | 2026-09-20 |
| one-bed-flat | qwen3.6-35b-max-speed:latest | medium | fail (done) | 2 of 26 | 0 (0) | 25932 / 38 | 447 | 0 | room bedroom 9-20 m2; room living 12-30 m2; room kitchen 5-16 m2; room bathroom 3-9 m2; bed; sanitary; 1 bed (found 0) | - | 2026-09-20 |
| three-bed-flat | gpt-5.6-luna | high | pass | 13 of 30 | 19 (0) | 202889 / 1272 | 41 | 0 | none | 65% of 17 | 2026-09-20 |
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

### Asking before changing the person's work (ADR-023)

Two runs against gpt-5.6-luna. In both, a person drew a four-by-three metre
room through the editor's own path, so every wall was stamped as theirs; the
agent was then asked to make every wall 250 mm thick.

| | answered "leave them" | answered "change them" |
|---|---|---|
| asked before touching anything | yes | yes |
| calls the registry had to refuse | 0 | 0 |
| walls changed | 0 | 4 |
| steps | 8 | 12 |

The question it wrote itself: "These four walls were created and edited by you.
May I change their thickness from 100 mm to 250 mm?", naming all four ids. Told
to leave them, it inspected them, changed nothing, and said so: "did not change
them because they were user-created/edited and consent was declined". Told to
go ahead, it changed all four and the stamps moved to the agent.

The registry refused nothing in either run, which is the result worth having:
the model read `by` in the views and asked of its own accord, so enforcement
never had to fire. The enforcement is there for the run where it does not.

### The same brief again, with an architect and a layout solver (2026-09-20)

Third run of "build a 3 bedroom apartment with hall and lobby" against
gpt-5.6-luna. This time the builder called `design_layout`, which ran the
architect as a sub-run with six tools and its own context; the architect wrote
a programme and called `plan_rooms`, which packed it and checked it; the
builder took the designId and called `build_design`.

| | first run | prompt only | architect and packer |
|---|---|---|---|
| rooms | 5 | 9 | 9 |
| walls left around nothing | 24 | 0 | 0 |
| rooms with a side no wall runs along | not measured | 5 | 0 |
| items standing across a door or window | 12 | 12 | 1 |
| beds with no wall behind the head | 1 | 1 | 0 |
| steps | 40, the budget | 25 | 10 |
| prompt tokens | ~760,000 | 419,915 | 157,739 |

One round of design, not six. The architect wrote the programme, `plan_rooms`
sized the building at 11.8 by 8.4 m, laid the rooms either side of a hallway
and passed its own check first time. Every room has a door to the hallway, a
wall on the outside of the building, and furniture in it.

Two things this run found, both fixed before it:

- `runArchitect` watched only `check_design` and not `plan_rooms`, so a design
  that passed was reported to the builder as a failure. The builder then
  re-typed the design out of the architect's prose, got 3.6 m² bedrooms and a
  1.9 m² bathroom, and refused to build. The prompt now says never to re-type a
  design: the id names a plan that has been measured and a sentence does not.
- The checker's maximum room sizes were absolute, so a 4.2 m² cloakroom in a
  142 m² house was an error. Largeness is relative to the building, and the
  maxima now are too.

What is still wrong: one basin in the bathroom stands across the door, because
`furnish_room` places fixtures along a wall without knowing the door is in it
when the run of free wall is longer than the fixture. Five windows for six
habitable rooms; one room's window was not placed and nothing said why.

### The first design cards (2026-09-20)

Three briefs run through the architect and the packer against gpt-5.6-luna,
with the card harness holding the drawing to the placement checks as well as to
validation.

| card | rooms | items | steps | prompt tokens | unenclosed | beds adrift | across an opening |
|---|---|---|---|---|---|---|---|
| one-bed-flat | 6 | 7 | 10 | 140,040 | 0 | 0 | 0 |
| three-bed-flat | 9 | 17 | 13 | 202,889 | 0 | 0 | 1 |
| four-bed-house | 12 | 24 | 12 | 208,497 | 0 | 0 | 1 |

The architect sub-run costs about 21,000 tokens of the total in each, takes
five steps and calls `plan_rooms` once.

Both faults the suite found on its first run were real, and neither was the
model's. Two of three bedrooms came back with a wardrobe and no bed: the bed
wants the wall opposite the door, which in a strip layout is the outside wall,
which is where the window goes, and a 1200 window in a 2800 wall leaves two
800 mm runs that no bed fits. Furnishing now lets anything lower than a sill
stand under a window and keeps only doors, and things taller than the sill,
clear.

Fixing that exposed the second: `validate` still called a bed under a window a
blocked opening, so the checker and the thing it checks disagreed. The checker
now applies the same rule, which took the four-bedroom house from four blocked
openings to one.

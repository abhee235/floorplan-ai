# ADR-027: What the model reads before it designs: skills, its own notes, a picture on demand, and the web

Status: Proposed
Date: 2026-09-22
Related: ADR-022 (roles as sub-runs; D8 context is a budget), ADR-025 (compaction;
D3 what is never dropped), ADR-026 (skills: numbers to the pack, judgement to a
document), ADR-024 (the checker is the judge), ADR-008 (search and fetch behind
interfaces), spec 04 (tools), spec 07 (recipes)

## Context

Two runs today, watched step by step, on the same hundred-person office brief.

### Run 1: the layout was right for the first time, and the furnishing was not

The architect ran as its own sub-run, gave no shell, gave every room a capacity,
and the checker passed its first design. The building came out 47.0 by 28.8 m:
one open office of 1,001 m² in a bay of its own and eight rooms in a column
beside it. The comb of sixteen equal rooms that every earlier run produced is
gone.

Then, in order:

| Step | What happened | Why, on our side |
|---|---|---|
| 8–16 | Eight `search_catalog` calls before anything was placed. Desks were never found: both searches said `category: "table"`, and desks are `category: "desk"`. | A wrong filter answers with nothing, not with "no desks under table; three under desk". |
| 19 | `furnish_room` with `recipe: "meeting"` refused: not in the pack. | The pack has `huddle`, `boardroom`, `training`. The commonest word for the commonest room is missing. |
| 22–23 | The cafeteria got `dining` (one table, twelve chairs); the reception got `foyer`, which placed nothing and said ok. | No `cafeteria`, no `reception`, no `open-office` recipe, though spec 07 has named the first and last since it was written. |
| 27–28 | 100 desks as an `arrange` grid, then 100 chairs as a second grid at the same spacing from the same origin: chairs on desks. | `arrange` places one product per zone. Its description promises `boardroom` (one table, chairs around), `u-shape` and `classroom`; the reducer refuses all three with "arrives with the phase 1 rules pack". |
| 29–30 | `batch` refused twice with `payload.levelId: Required; payload.ref: Required`, the second call identical to the first. | `batch` takes raw store commands ("see spec 03"), a format the model has never been shown. It sent `place_item`'s arguments inside `item.place`. |
| 33–35 | The model noticed the overlap itself, checkpointed, then called `get_scene detail: "full"` twice to collect chair ids; both results were cut at 16,000 characters. | No way to redo a zone short of collecting a hundred ids, though `arrange` has `replace: true` on a `zoneId`. |

Stopped at step 36: 35 calls, 5 failed, 1.37 million prompt tokens in, 4,900 out.
The owner's reading of the drawing: the open office is a school classroom, one
straight pattern everywhere. That is exactly what `grid` and `rows` draw. The
model was never short of knowing what an office looks like; it was short of a
tool that could draw one.

### Run 2: a picture, and a plan that would not die

"Can you please read this image and just like this create the office plan",
with `as.png` attached. The attachment was 2,329 bytes. `import_plan` sent it to
the reader, which found 0 walls, 0 rooms and no scale. The model then looked at
the picture itself and said, correctly, that it was a logo, "AS" on green, not
a floor plan. So far, right on both counts.

Then the plan gate fired: "Your own plan still has 8 unfinished items: furnish
open-plan workspace with 100 desks…". Those were run 1's items, carried in the
project's conversation. The model obeyed, found the project empty, announced
"let me start fresh with the full 100-person IT office design", and spent
steps 5 to 7 fighting `plan_work`'s invariant that an unfinished item may not
be dropped. Stopped at step 8 with 3 of 6 calls failed. Nobody had asked for an
office in that message.

### What the model can and cannot read today

- **A picture, once.** An attached image is an image part of the first user
  message when the model can see (`agent-runs.ts` `taskOf`). The architect
  never sees it: `design_layout` hands it `request.brief`, text. And the moment
  a render arrives, `liftImages` replaces every earlier picture in the
  conversation with "[an earlier render, taken away to save room]", the
  attachment included. There is no tool that shows the model a picture on
  request.
- **The web, not at all.** The owner runs a SearXNG instance and asked why the
  agent never searched. Two facts: `.env` sets `FPV_SEARCH_URL` but not
  `FPV_SEARCH=searxng`, so the host started with "no search provider"; and the
  agent has no search tool regardless. The product verifier has the whole
  client (`searxngSearch`, `httpPageFetcher` with its private-address guard,
  `htmlToText`, ADR-008); the designer cannot reach any of it.
- **Skills, not yet.** ADR-026 decided the shape and shipped nothing.
- **Its own notes, nowhere.** The plan is the one thing that rides on the
  system prompt and survives compaction (ADR-025 D3). Whatever the model
  learns from a picture, a page, a skill or the person lives in a tool result
  that compaction is designed to drop.

### The cost side, measured

The prompt is about 15,700 tokens before a word of conversation, 39 per cent
of it tool schemas (ADR-026), re-sent on every step. On the owner's machine a
step of the local model takes one to three minutes. Every tool added here is
paid for on every step of every run; every step spent reading is a step not
spent drawing.

## Decision

### D1. Skills first, as ADR-026 decided; the web is for what a skill cannot hold

The owner's proposal was that the agent search the web for how an office is
laid out before it designs one. Countered, on the evidence above:

- What was missing in run 1 was not knowledge. Ask the model what a modern
  open office looks like and it will say benches of six, neighbourhoods, glass
  meeting rooms along the core. It drew a grid because `grid` is what it had.
- A search is three or four steps and ten to fifteen thousand tokens before a
  wall exists, on every run, at minutes a step, with results that differ from
  one day to the next. An evaluation suite cannot hold still on that.
- What a search would find, for the common building kinds, we can find once,
  write down, and measure.

So: the two skills ADR-026 D5 promised are written and shipped now, `office
layout` and `home layout`, and the `read_skill` tool and the one-line index in
the prompt are built as ADR-026 D3 describes. The architect's prompt says to
read the skill for the kind of building before writing a programme.

Web search is built too, as a tool the model *may* call: for a brief that names
something no skill covers ("like a WeWork", "an ICU ward", "a Scandinavian
cabin"), for a product the catalog lacks, and for pictures to look at (D3).
Not as a step every run takes.

### D2. Notes: a scratchpad that rides on the prompt

A `notes` loop tool beside `plan_work`: the model writes down what it has
learned and decided — what the picture showed, what the skill said mattered
for this brief, what the person clarified, what it assumed. Whole text each
call, capped at 3,000 characters, kept by the loop and never by the project.

The notes are pinned into the system prompt after the plan, so they cost what
they are and survive every compaction layer (ADR-025 D3 gains a line). They
are handed to the architect sub-run as part of its task, which is how what the
designer learned from a picture or a page reaches the role that decides the
rooms. They persist per project beside the plan and are cleared with it.

This is the "read, then work out what to build, then build" loop the owner
described. Claude Code does it with a plan file the model writes before it
edits; Cascade keeps archival memory a curator fills. Ours is smaller: one
text, always in view, written by the model itself, because a note the model
wrote is the one it will act on.

### D3. A look at a picture, on demand

`look_at { attachmentId | url, page?, question? }`: returns the image as
`images: [{ pngBase64 }]`, which the runner already lifts into a user message
for a model that can see. So the model can look at an attachment again after a
render took it away, look at it twice with two questions, and the architect,
told the attachment ids in its brief, can look at it at all. With a `url`, the
picture comes through the same guarded fetcher the verifier uses, capped at
5 MB, so an image search result can be looked at. The lifted message carries
the result's own caption rather than "this is what the editor draws now".

The reader (`import_plan`) is for line drawings at real resolution and stays
so; a 2 KB logo, a photograph or an illustration is for `look_at`. The
designer's prompt says which is which: read a drawing, look at a picture.

### D4. Two web tools, advertised only when search is configured

`web_search { query, kind: "web" | "images", limit? }` returns title, url and
snippet (or image url, thumbnail, source) for at most ten hits;
`read_page { url, maxChars? }` returns the page as text through `htmlToText`,
capped at 8,000 characters, refusing private addresses as the verifier does.
Both live in the registry with `ctx.web`, which the host fills from the same
`loadHostConfig` the verifier uses. When no search is configured the tools are
not advertised, so a session without search pays nothing for them, and the
prompt says nothing about them.

The host's startup line names the search provider or its absence, and the
config note now says which variable is missing; today it took reading
`verifier.ts` to learn that `FPV_SEARCH_URL` without `FPV_SEARCH` is nothing.

### D5. The plan belongs to the run that wrote it

*Amended the same day, after the owner saw it.* The first version kept a run's plan, saved it to the
project's agent folder, read it back after a restart, and showed it as a card the instant the next
message was sent -- "from an earlier run". To the person it read as the agent answering in a
millisecond with a static list; to the model it was a to-do list for a request nobody had made.

So a plan is its run's own. A new run starts with none: nothing is shown before the model has read
the message, nothing is pinned to its prompt, nothing is written to disk. What a "carry on" needs is
in the conversation, which is kept. The loop's rules for a plan passed in by a caller stay (the
gate is quiet until the run writes its own; inherited items may be dropped; a stopped run leaves
nothing "doing"), for the eval harness and any caller that means it.

### D6. Tools say what they do, and take what the model knows

- `arrange` advertises `grid`, `rows` and `bench`, the three that exist, and
  points at `furnish_room` for chairs around a table. `replace: true` on a
  `zoneId` is what the description leads with for redoing a zone.
- `batch` takes `calls: [{ name, args }]` — tool calls, the arguments the model
  already knows — as well as raw `commands`. A batch of calls is atomic through
  a checkpoint taken before the first and restored on the first failure.
- `search_catalog` with a category that matches nothing, when the same query
  matches elsewhere, says so and lists the categories with counts.

### D7. The recipes the pack was always meant to have

Spec 07 named `open-plan-bench` and `cafeteria` in its first draft. They are
written now, with the two the runs asked for by name:

- `open-office`: the recipe engine's `arrange` op gains `pattern: "bench"`
  (rows in back-to-back pairs, chairs on the outside, the aisle between pairs)
  and `perCluster` with `aisleMm`, so a hundred desks become benches of six
  in neighbourhoods with 1,500 mm aisles, each desk with its chair. `sides`
  (1 or 2) says whether chairs go on one side of a row or both.
- `meeting` (4 to 12): a table sized to capacity, chairs around it, a display,
  a video bar; the `boardroom` steps at meeting-room clearances.
- `cafeteria`: rows of four-seat tables with chairs both sides, one table per
  four of capacity.
- `reception`: a desk along the wall facing the door and seating along another.

`furnish_room`'s description lists what the pack has rather than three names.
Numbers these recipes need that the pack lacks (desk 1600 × 800, bench aisle
1,500, cafeteria 1.3 m² a seat) go into the pack facts, as ADR-026 D1 says.

### D8. Small things the runs showed, fixed with them

- The run counter restarted with the host, so today's run was appended to
  yesterday's file. The counter starts from what is on disk.
- A workplace programme for twenty or more people with no restroom is a
  checker error, not a note in a list nobody reads.

## Alternatives considered

**Search on every run, as the owner first proposed.** Rejected as the default
for the reasons in D1; kept as a tool. The condition for revisiting: an
evaluation card whose brief a skill cannot cover and a search demonstrably
does, at a cost in steps the card's budget can carry.

**Generate an inspiration image first and design from it.** Considered and
deferred. It needs an image model, a second provider (ADR-007 D1 allows any
OpenAI-compatible one), and a design that copies from a picture that was
itself invented. D3 gives the model the half that is cheap now: look at a
picture somebody chose. Revisit when `look_at` with a searched image has
shown that looking changes what gets built.

**Let the model see the whole conversation's pictures.** Rejected; ADR-022 D8
still holds. One picture at a time, and a tool to bring one back, costs a call
rather than a window.

**A matcher that reads the right skill for the model.** Deferred, as ADR-026
did; an explicit call shows in the trace and is what a weak model does most
reliably.

**Put the notes in the conversation as a user message.** Rejected: compaction
would have to special-case it, and a message in the middle of the conversation
is what a model stops reading. The plan already showed where a thing that must
be seen every step goes.

**Persist notes as memory across projects.** Not now. What a model learned
about this office is about this office; a memory the product carries between
projects is a bigger decision with a consent question in it (ADR-023).

**Delete the inherited plan instead of D5.** Rejected: a follow-up in the same
conversation ("now the second floor") wants the plan. It is the *gate* that had
no business firing.

## Consequences

- `packages/agents/src/skills.ts`: loader, index, `read_skill`; built-ins in
  `apps/host/skills/`, then `<data>/skills`, then the project's `.fpv/skills`.
  `packages/agents/src/loop-tools.ts`: `notes`. `runner.ts`: notes pinned,
  inherited-plan rule, caption from the result when lifting images.
- `packages/tools/src/tools/look.ts` (`look_at`) and `web.ts` (`web_search`,
  `read_page`); `ToolContext.web`; `batch.calls`; `arrange`'s enum; the
  `search_catalog` note. `packages/tools/src/furnish.ts`: `bench`,
  `perCluster`, `aisleMm`, `sides`. `packages/catalog/src/rules/av-core.ts`:
  four recipes and their facts; `layout.ts`: the restroom rule.
- `apps/host`: `ctx.web` and the startup line; skills directories; notes
  persisted with the plan; attachment ids in the architect's brief; the run
  counter. `.env.example` and the README say how search is switched on.
- The designer and architect prompts: the skills index, the notes section,
  when to `look_at` and when to `import_plan`, and that search exists when it
  does.
- Spec 04 gains the four tools and the tier rows; spec 07 the recipes and the
  `arrange` fields; ADR-025 D3 the notes line; ADR-026 moves to Accepted with
  the skills shipped.
- Evaluation: a `hundred-desk-office` card whose expectation includes benches
  (no two items overlapping; chairs within 100 mm of a desk edge), and a
  `logo-not-a-plan` card that expects `look_at` and no `import_plan`. What is
  deliberately not measured yet: whether reading a skill changes the score;
  that needs the same brief run with and without, and is the first experiment
  after this lands.

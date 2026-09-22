# ADR-022: The agent: one loop, three roles, and a checker that does the arithmetic

Status: Proposed
Date: 2026-09-20
Related: ADR-005 (single deployment), ADR-006 (tool surface), ADR-007 (provider
and runner), ADR-019 (session log), ADR-023 (authorship and consent, whose D7
here is the other half), PRD P4-1 (the agent in the editor), spec 04 (tools),
spec 07 (rules packs)

## Context

### What exists

The agent lives in the editor. A person types a brief in a chat window docked
beside the drawing, and the host runs one loop against one model: the model
calls tools, every tool call is a store command, every command is broadcast to
every tab, so the plan draws itself while the chat fills with what is being
done. The loop streams the model's words as it writes them, keeps a plan the
model writes with `plan_work`, parks on `ask_user` until a person answers,
takes a checkpoint before every run so "Undo this run" is one action, and has
two gates that send the model back to work when it stops with its own plan
unfinished or with changes it never checked. All of this is built, tested, and
recorded in `docs/eval/agent-runs.md`.

### What went wrong

Asked for "a 3 bedroom apartment with hall and lobby", the first version
produced five rooms of which three were 8 m² bedrooms, no kitchen, no
bathroom, twenty-four walls around nothing, forty steps of drawing and
deleting the same rooms, and a summary that called the result a finished flat.
It cost about 760,000 prompt tokens.

The causes were not the model's. The prompt described an office in eight lines
and never said how large a bedroom is. The only recipes were meeting rooms, so
`create_room_from_brief` furnished every brief as one. "Hall" was read as a
corridor; in the owner's briefs it is the living room. Nothing checked a room's
size against its purpose. The plan tool held a task list, not a design.

After a sectioned prompt that carries room sizes, the residential vocabulary
(ADR-009's pack now has a residential overlay), and a rule that a home's rooms
are chosen by purpose and never by seat count, the same brief gave nine rooms
with correct purposes, bedrooms of 11.6 to 14.9 m², a kitchen, a bathroom and
a toilet, twenty pieces of furniture, no orphaned walls, no failed calls, and a
summary that named the warnings it left. Half the tokens.

And it was still not a design. The model divided the rectangle into a
three-by-three grid and put a room in each cell, so the bathroom was 13.4 m²
and the toilet 14.1 m² while the living room was 9.8 m². There was no
corridor. Five interior walls cannot enclose nine rooms, so five rooms had a
side with no wall along it, and a bed stood with nothing behind its head. Every
bedroom's wardrobe stood across the room's door, because the placement code
had ignored openings. A bed blocked a door into another bedroom, which is a
door that should not exist. `validate` had raised some of this as warnings; the
model finished anyway.

### What the owner asked for

An architect: something that designs the whole plan before a wall is drawn. A
validator that "does the math" on that design and feeds the result back so the
orchestrator can fix it. A way for the agent to check what it built, in 2D and
3D, before it says it is done. And above all this: people trust agents
blindly, so the agent must be built never to break that trust.

### What we learned from others

Cascade, the owner's own coding agent, informed the plan tool, the parked
question and the gate-as-reminder pattern; no code was taken from it
(ADR-007). Three published results steered the rest. A 2026 CHI study of a
planner, actor and critic split found that one model with three prompts did as
well as three models, that the actor sometimes ignored the critic, and that
improvement stopped after about three rounds. A 2025 industrial study of
multi-agent systems found that coordination between agents costs more than it
returns on sequential tasks, while a generator paired with a critic helps. A
2026 ACL paper trained floor-plan generation with rewards computed by code:
topology, numeric constraints, overlaps. The last one matters twice: it says
what a checker should check, and it is the reward function the owner's later
reinforcement-learning experiment will need.

### What the two implementations we can read actually do

**Amended 2026-09-20.** The first version of this ADR reasoned from two papers
and from ADR-005's single-deployment rule, and did not look at either agent
sitting on this machine. That was the wrong order, and reading them changed
four of the decisions below. Both were read for their architecture only; no
code was copied from either.

Where Claude Code (`src/query.ts`, `src/tools/AgentTool/`) and Cascade
(`packages/core/src/agent/agentLoop.ts`) agree, they agree closely, and that
agreement is the strongest evidence available here:

- A sub-agent is **the same loop called again with a fresh message array**, not
  a second engine and not a second service. Claude Code's `runAgent` is a
  `query()` call; Cascade's `spawnSubagent` is a nested `runAgentLoop`.
- **Only the last assistant text goes back to the parent.** The child's
  transcript never enters the parent's conversation. Claude Code forwards inner
  events to the UI as progress messages and stores the child transcript as a
  sidechain; Cascade consumes child events internally.
- **One level of nesting.** Both put the spawn tool in the child's own
  disallowed list.
- **The turn ends when there are no tool-use blocks**, never on the model's
  stop reason. Both say in comments that the stop reason is unreliable.
- **A restricted agent's tools are removed, not forbidden in prose.** Cascade's
  `toolGrants.ts` states the reason plainly: a persona prompt does not stop a
  mid-sized model from doing the thing, so take the capability away.
- **Errors are ordinary tool results flagged as errors**, never thrown.
- **Model-facing and user-facing renderings of a result are separate
  functions**, deliberately, with a comment warning against conflating them.

Two mechanisms neither this ADR nor this codebase had, both from Claude Code:
a permission decision may carry a **rewritten input**, so a gate can answer "no,
but here is the corrected value" rather than only refusing; and after compaction
the most recently read files are **re-read from disk** rather than trusted from
the summary.

And one measurement of our own, taken the same day from the nine-room flat run:

| | tokens |
|---|---|
| tool schemas, re-sent every step | 10,389 |
| system prompt, re-sent every step | 2,689 |
| fixed cost per step | 13,078 |
| over 25 steps | ~327,000 |
| conversation content, cumulative | ~105,000 |
| **measured for the run** | **419,915** |

Seventy-eight per cent of that run was re-sending the tool surface. An
architect holding five inspect tools and `check_design` costs 1,468 tokens of
schema instead of 10,389. That is the decisive argument for D1 below, and it is
not the argument the first version made.

## Decision

### D1. One process, one model, three roles, each a sub-run of its own

The agent is three roles in one loop, in one process, against one model:

- **The architect** reads the brief and the project and produces a design. It
  has the inspect tools and `ask_user`, and no tool that draws.
- **The checker** is code. It measures the design and, later, the drawing, and
  reports errors and warnings with the numbers. A bounded critic pass by the
  model reads the same report and adds what code cannot see.
- **The builder** turns an approved design into walls, openings, rooms and
  furniture, and fixes what the checker finds, with the design pinned in its
  prompt.

**Amended 2026-09-20.** This said a role was "a system prompt and a tool subset
chosen for a phase of one run", and that the roles shared one conversation. Two
things say otherwise.

Both implementations we can read make a sub-agent the same loop with a **fresh
message array**, and return **only its last assistant message** to the parent.
And the measurement above says the cost of a phase is dominated by the tool
surface it carries, not by the conversation: an architect that can see all
thirty-one tools pays 10,389 tokens a step for the twenty-six it must not use.

So a role is a **sub-run**: the same `runAgent`, called again, with

- its own `messages`, starting empty but for the task;
- its own system prompt;
- its own advertised tools, and — the part that matters — **only those tools
  reachable**, enforced by the registry rather than asked for in the prompt
  (D1a);
- its own step budget, smaller than the parent's;
- the parent's project, registry, abort signal, event stream and question
  channel, all shared.

What returns to the parent is **the structured design, not prose** — the one
place we depart from both references, and for a reason they do not have: their
sub-agents report on work they did elsewhere, ours hands over an artefact the
next role has to measure and draw. A paragraph could not be checked.

The child's steps do not enter the parent's conversation. They do reach the
chat, labelled with the phase, because a person watching a plan being designed
should see it happening; what they must not do is fill the builder's context
with rejected drafts it can re-open.

**One level of nesting**, as both references enforce: a sub-run may not spawn
one. And ADR-005 is untouched: this is one process, one model, one deployment,
and nothing new listens on a port.

### D1a. A role's tools are removed, not forbidden

The architect must not draw. Saying so in its prompt is not how that is
achieved: `Registry.call` takes the run's grant list and refuses a name outside
it with `tool.not-granted`, the same shape as any other refusal, so the model
reads it and corrects itself.

This is the rule the consent guard already follows (ADR-023 D4) and the reason
Cascade gives for its own `toolGrants`: a persona prompt does not stop a
mid-sized model from doing the thing it was told not to do. Remove the
capability instead. It is also what makes D1's token argument real — a tool the
registry will refuse is a tool not worth advertising.

### D2. The design is an artefact, not a paragraph

*Amended by ADR-028: the architect writes the design itself; `plan_rooms` is an
optional first draft; a room says what encloses it and the shell which sides
are glazed.*

The architect's output is a JSON design the checker can measure:

```ts
Design = {
  brief: string;                       // the words it was designing for
  kind: "dwelling" | "workplace" | "mixed";
  shell: { w: number; d: number; origin: Point; wallMm: number };
  rooms: Array<{
    key: string;                       // "bed1", stable across rounds
    name: string; purpose: RoomPurpose;
    rect: { x: number; y: number; w: number; d: number };   // clear inside, mm
    capacity?: number;
    doorsTo: string[];                 // keys of rooms or "outside" it opens onto
    window?: boolean;                  // wants an outside wall
  }>;
  circulation: string[];               // keys that are corridors or halls
  assumptions: string[];               // what the brief did not say
}
```

Rectangles, because a room a person can name is a rectangle nearly always, a
rectangle is checkable in arithmetic a model can also do, and the drawing of a
set of rectangles is deterministic. An L-shaped room is two keys with a door
between them and no wall, which the builder merges.

The design lives with the conversation, per project, so a follow-up reads the
design that was built rather than re-deriving it from the walls.

**Amended 2026-09-20, after the architect's first live run.** The design above
is still what the checker measures and the builder draws. What changed is who
writes the rectangles.

The architect was given the brief and six rounds. It produced, in order, 12,
11, 14, 14, 14 and 13 problems: not converging, flailing. Its complaints were
real -- checked by hand against its own submission, every one was accurate:

```
bed2 east edge      x = 4400
corridor west edge  x = 5000      a 600 mm gap, so no shared wall
bath                x 9650..11450 nowhere near the corridor it opens onto
lobby/corridor overlap 300 mm, and a door needs 1000
```

It was being asked to solve two-dimensional rectangle packing: nine rooms,
none overlapping, filling a shell, with eight named pairs each sharing at least
a metre of wall. That is the one thing a language model is worst at and the one
thing a program finds easy, and putting it on the model's side of the line
contradicts every other decision in this ADR.

So the line moves:

- **The architect supplies a programme**: which rooms, what each is for, roughly
  how big, which should be near which, which need a window, and how big the
  building should be. That is judgement about how people live, and it did this
  part well in every round.
- **A solver packs it** into rectangles that satisfy the checker by
  construction rather than by being marked: `packProgramme`, deterministic,
  in `packages/catalog`.

The Design stays exactly as it is, because it is the contract between the
checker and the builder and neither cares who wrote it. `check_design` still
takes one, so a model that wants to place rooms itself may; the architect will
not.

The solver lays a flat out the way flats are laid out: a circulation band with
the rooms in strips either side of it, each room running the full depth of its
strip so it touches the corridor along its whole width and the outside wall
behind it. Every room reachable, every door with a wall, every habitable room
on an outside wall, by construction. Where the programme cannot fit, the solver
says which room it could not place, and the architect changes the programme
rather than the coordinates.

**Amended 2026-09-20: the solver may not invent the arrangement.** The owner
asked for an office for a hundred people and got the same plan every time:
fifteen rooms in one comb along the top of the plate, every one 11.2 m deep,
several of them barely a metre wide, ordered by area. That is not a layout. It
is what the paragraph above describes, drawn: one circulation band, two strips,
largest room first.

Two things were conflated here and only one of them belongs to a solver.

**A minimum is a fact and stays in code.** A four-person meeting room cannot be
1.1 m wide, because a 900 mm table with 900 mm to get past it on either side is
2,700 mm. That is arithmetic about tables and bodies. A solver that produced it
was not exercising judgement, it was getting a sum wrong, and the checker
should refuse it.

**An arrangement is judgement and does not.** Which rooms belong together,
what faces the entrance, which side takes the daylight, whether the meeting
rooms line the facade or sit in the core, whether the open office is one field
or several: none of that is constructible and all of it was being decided by a
sort on area.

The conclusion drawn from the six failed rounds was too wide. The architect
could not place rectangles, and the right answer to that was never "the
architect decides nothing about where anything goes". It was that it should not
be handling coordinates. The evidence for how wide the over-correction was is
in the programme itself: it has carried a `nextTo` list since the day it was
written, and the solver does one pass of nudging a room along a strip it had no
say in being in.

So the line moves again, and this time it is drawn between topology and
geometry rather than between judgement and arithmetic:

- **The architect supplies intent**: the rooms as before, and now which of them
  group together, where each group sits, and what must be adjacent. A
  programme without any of that still packs exactly as it does today.
- **The solver resolves coordinates** subject to that intent, and may never
  return a room below its minimum. Where the intent cannot be satisfied it says
  which part it could not honour, the way it already says which room it could
  not place.
- **The checker still decides**, unchanged and unpersuaded.

**One constraint shapes the algorithm and is the reason the comb exists.**
Every room must touch circulation, or it has nowhere to put its door. A single
band with rooms either side guarantees that for nothing, which is why it was
chosen and why the first thing that looks more like a building tends to leave
rooms stranded in the middle of the plate. Any replacement has to keep the
guarantee, not hope for it.

The replacement that keeps it: **as many bands as the rooms need to stay in
proportion, rather than always one.** Fifteen small rooms across one 48 m
frontage is a slice each; across three bands it is five each, and the same
floor produces rooms roughly square instead of roughly corridors. Bands are
chosen from how far a room's proportions would be pushed, not from a constant,
and the model's groups decide which rooms share a band.

What is deliberately left for later, so a reader knows it was considered:
orientation and daylight, a core of stacked services, and an open field broken
up by anything other than walls.

### D3. The checker is code; the critic is a bounded model pass

*Amended by ADR-028 D2 and D8: the checker keeps errors only for what cannot be
built or used, and the model asks its own questions of a design through
`query_design`.*

The checker runs as a tool, `check_design`, and again inside `validate` once
the drawing exists. Its checks, each with a number in the message:

**Programme.** Every purpose the brief named is present with the count asked
for. A dwelling has a kitchen, a bathroom or a toilet, and a living room
whether or not the brief listed them; a workplace has a way out. Each room's
area and shorter side meet the residential pack's minimums, and no room is
absurdly over its purpose: a toilet of 14 m² is an error, not a generous
toilet.

**Geometry.** Rooms lie inside the shell. No two rooms overlap. The rooms plus
walls plus circulation cover the shell within a tolerance, so the plan has no
unexplained void. Every room, once drawn, has a wall along every edge, allowing
for openings.

**Circulation.** From the entrance, every room is reachable through doors
without passing through a bedroom, a bathroom or a toilet. No bedroom opens
into another bedroom. No bathroom opens directly into a kitchen. Corridors are
at least 1050 wide.

**Openings.** A habitable room has an exterior wall for a window. Doors are on
walls that exist and do not collide with each other or with a wall end.

**Furniture**, once placed. Every item's footprint lies inside its room. No two
footprints overlap. Nothing stands in a door's clear square or across a
window a person needs to reach. A bed's head and a wardrobe's back are within a
wall's thickness of a wall. A bed has 700 mm free on the side it is got into; a
wardrobe has 900 in front of its doors.

Errors are what the person would call broken: overlaps, a room with no door, a
blocked door, a bed with no wall. Warnings are what the person would call
poor: a small living room, a long corridor. The builder may not finish with an
error outstanding; it may finish with warnings if it names them.

**Amended 2026-09-20, as the first of these were built.** The severity above is
the *checker's*, not `validate`'s. In the IR, `room.unenclosed`,
`item.blocks-opening` and `item.needs-wall` are warnings, because `apply`
refuses any command that introduces an error (ADR-004 D4) and a person dragging
their own sofa across their own doorway must not be refused. The same
measurement is therefore advice to a person and a gate to an agent, which is
the right asymmetry: the editor belongs to the person, and the agent is the one
that has to earn its result. The checker owns the mapping from problem code to
"you may not finish with this".

The **critic** is one model call per round, at most three rounds, with the
design, the checker's report and no tools. It answers in JSON: what it would
change and why, each note tagged with a room key. Its notes are warnings. It
never overrides the checker, and the loop does not wait on it when the checker
has errors, because a room that overlaps another is not improved by an opinion
about its proportions.

**Deferred 2026-09-20, not rejected.** The critic is not built until a
measurement asks for it. The checker as built covers areas by purpose, sizes,
overlaps, doors that have a wall to sit in, reachability from the front door,
windows and the programme — sixteen kinds of error. The critic was for what is
left: proportion, and whether a plan is pleasant to live in. Whether anything
is left is an empirical question, and the study this pair came from found the
actor often ignores the critic anyway. So: build the architect, run the eval,
look at designs that pass the checker, and add the critic only if they are
still bad. Building it on schedule would be paying a call a round to find out.

**And the gate has a failure mode the first version did not name.** Sixteen
kinds of error, and `build_design` refuses a design with any of them, so a
model that cannot satisfy the checker draws nothing at all — which is worse
than the poor flat it drew before, because the person gets an apology instead
of a plan. Therefore: the architect sub-run has a round budget, and when it is
spent the run does not fail silently. It reports the errors it could not clear,
asks whether to build the best design it reached or to change the brief, and
says which rooms are wrong. A gate that can only say no is not finished.

### D4. The builder draws from the design, and code draws what code can

The churn in the first run came from a model drawing walls one at a time and
then discovering they did not meet. So `build_design` takes an approved design
and, in one transaction, draws the shell, every interior wall with shared edges
merged, a door in each `doorsTo` pair, a window on each room that wants one,
and the rooms with their purposes. It refuses a design the checker has not
passed. What the builder then does with the model is furnishing and fixing:
`furnish_room` per room, `validate`, and corrections to what the checker
reports.

A follow-up that changes the layout ("make the kitchen bigger") goes through
the architect again with the current design as its starting point, and the
checker compares the new design with what stands, so the builder changes only
the rooms that changed.

**Amended 2026-09-20: the check comes back with the change, unasked.** The
builder's job is "furnish, then `validate`, then fix", and the first run showed
what happens when a model is merely asked to check its work: it does, twice,
and then stops doing it. So every mutating tool result carries the validation
state already — the envelope's `problems` field, which exists — and the loop
puts the errors in front of the model rather than waiting for it to ask. Both
references do a version of this; Cascade pushes post-edit diagnostics into the
conversation for exactly the reason that the model never calls the tool that
would have found them.

The verify gate stays, because a gate that rarely fires is cheap and the run
that needs it is the one that matters.

**Amended 2026-09-20: a third gate, for the run where nothing happened.** A
local model was given the one-bedroom-flat brief and answered, on the first
step, "I will design a one-bedroom flat with an open kitchen and a bathroom."
It called no tool. An answer with no tool calls is how a run ends, so the run
ended: one step, no design, no rooms, and a failure report that said the rooms
were missing without saying why.

Neither existing gate covers it. The plan gate needs a plan and the verify gate
needs a change, and this run had neither. So there is an idle gate: the model
answered, no tool has been called in the whole run, and it is told that saying
what it intends to do is not doing it. It fires once, because a model that
answers in prose twice running means it and each turn costs a call, and a
caller that genuinely expects an answer without tools can turn it off.

It is the least specific of the three, so it speaks last: a model with an
unfinished plan hears about the unfinished item instead, which is the more
useful sentence. Making a plan counts as having done something, so a model that
called `plan_work` is never told it called nothing.

This gate is only reachable by a model weak enough to need it, which is the
argument for it rather than against: the frontier model has never once
triggered it, and the local models this project is meant to run on trigger it
on the first step of the first card.

### D5. The rules that keep trust

These are the rules, and each is enforced by code somewhere named, not by the
prompt alone. The prompt says them too, so a model that reads it does the
right thing for the right reason; the enforcement is for the model that did
not.

1. **Nothing moves without a tool call, and every call is logged with who made
   it.** The runner has no path to the project except the registry; the
   registry writes every call and its origin to the session log (ADR-019).
2. **Every run can be undone in one action.** The host takes a checkpoint
   before the first call of a run and the chat offers it as "Undo this run".
   A run that ends by error, cancel or budget offers the same.
3. **The checker is the arbiter.** The model reports the checker's findings
   and may not declare them wrong. A run cannot end with a checker error
   outstanding: the verify gate sends it back, and if it comes back three
   times with the same error, the run ends as "stalled" and says so.
4. **The summary is checked against the facts.** When the model answers, the
   runner appends the checker's final counts to the event the chat shows
   (rooms, items, errors, warnings), so a summary that says "finished" beside
   "3 errors" reads as what it is. The model is told this happens.
5. **It asks about facts, never about permission to continue, and always
   before touching a person's work.** A plot size nobody gave, a word that
   means two rooms, a scale: one question, then build. An entity a person made
   or changed: ask first (ADR-023, enforced by the registry).
6. **It is bounded.** Two hundred steps a run, three checker rounds, and a churn
   breaker: a run that creates and deletes the same kind of thing a third time
   is reminded once and stopped the fourth.
7. **It is visible.** Every event streams to every tab of the project as it
   happens: the design as a card, the checker's report as a card, each tool
   call as a card that can show what it changed. There is no quiet phase.

### D6. The model may look, but the checker decides

A render after furnishing is put in front of a model that can see (the runner
already lifts the newest render into its context), in plan and in 3D room
view. It is the model's second opinion, for what code does not measure: a desk
facing a wall, a sofa with its back to the window, a room that reads badly.
What the model sees never overrules what the checker measured, because a
picture is where a model is least reliable and arithmetic is where it is
least needed.

### D7. A mutation says which version of the world it was decided on

The person is editing the plan while the agent works. That is the premise of
this whole product, and until now the agent had no way to notice.

ADR-023 asks **whose** an entity is. This asks **when** the agent last looked.
They are different failures: the first is an agent moving a sofa that is not
its business, the second is an agent moving a sofa to where something now
stands, having read the room a minute ago.

Claude Code solves this for files by refusing an edit when the file changed
since it was read, and answering with the current content so the model re-reads.
The plan is that case without the pauses, so:

- The store keeps a **revision number**, raised by every command, and each
  entity keeps the revision it was last changed at.
- A read tool returns the revision it read at.
- A mutating tool call may carry `basedOn`, the revision the model is acting
  on. When an entity it touches has changed since, the call is refused with
  `stale.read`, the current value, and the instruction to look again.
- Without `basedOn` the call proceeds, because the editor's own calls and the
  first call of a run have nothing to be stale against.

This is advisory for a person and binding for the agent, like every other rule
here. It is also what makes the agent safe to leave running while somebody
works beside it, which nothing else in this ADR provides.

### D8. Context is a budget, and the tool surface is most of it

Measured, not assumed: 78 per cent of a real nine-room run was the tool schemas
and system prompt, re-sent on all twenty-five steps. The conversation was the
other 22 per cent. Any effort spent compacting the conversation first would
have been spent on the smaller half.

In the order the numbers justify:

1. **Advertise fewer tools per role.** D1's sub-runs do this by construction:
   an architect carrying six tools pays 1,468 tokens a step instead of 10,389.
   This is now the main reason the sub-run shape is right, ahead of the
   contamination argument the first version made.
2. **Read what the provider already caches.** OpenAI-compatible servers report
   cached prompt tokens separately, and a stable prefix — system prompt, then
   tools, then conversation — is what makes the cache hit. We neither order for
   it nor measure it. Measuring comes first: the saving may already be there.
3. **Then compact**, cheapest layer first, as Cascade does: drop superseded
   reads, mask old oversized results, clear compactable results, and only then
   summarise. With the last few results shielded, the task kept verbatim, and a
   circuit breaker after three failures.
4. **Rebuild from the world, not from the summary.** When a conversation is
   compacted, the scene is re-serialised from the store and re-attached. Claude
   Code re-reads files for this reason; our equivalent is cheaper and more
   reliable, because the store is right there.

## Alternatives considered

**Separate agents: an architect agent, a verifier agent, an orchestrator.**
The owner's first framing, and the one most agent products advertise. Rejected,
and the reading confirms it: neither Claude Code nor Cascade has agents that
talk to each other. Both have one loop that can call itself with a fresh
context and hand back one answer, which is what D1 now describes. Splitting the
roles into agents with a protocol between them adds the coordination cost the
2025 study measured and removes nothing, and it would be a second service of
ours, which ADR-005 forbids.

What the first version got wrong was the opposite end: it made the roles too
joined, sharing one conversation. D1 is amended.

**A model as the verifier.** "One agent that checks the rules mathematically
and feeds the orchestrator." Rejected as the gate, kept as the critic. Every
rule in D3 is arithmetic: a distance, an overlap, a graph walk. Code gets
those exactly right every time for nothing; a model estimating them from a
description or a picture gets them roughly right sometimes and costs a call
each. Worse, a model checking a model is precisely the thing people wrongly
trust: it sounds like verification and is another opinion. The critic keeps
what a model is good at, judgement about proportion and use, and is bounded so
it cannot become the loop.

**One loop with a better prompt and nothing else.** Tried, this week, and
measured: it fixed vocabulary, sizes and furniture and left the layout a grid
with rooms unenclosed. A prompt cannot make a model do arithmetic it never
writes down; the design artefact is what makes the arithmetic checkable.

**A design in prose.** Let the model plan in a paragraph, as it did in the
second run's plan card. Rejected: a paragraph cannot be measured, so the
checker would have to read it with another model call, and then we are back to
the alternative above.

**A hard stop or an approval for every call.** Rejected by the owner before the
loop was built: approvals fatigue, and a person who approves forty calls has
stopped reading by the tenth. The checkpoint and one-action undo are the
safety net; approval is reserved for a person's own work (ADR-023).

**Vision as the primary verifier.** "Render it and look." Rejected as primary
for the reason in D6, kept as secondary. The eval in `docs/eval/raster-reader.md`
shows what vision models get wrong about plans; the checker does not.

**Ask the person for the layout.** A wizard: how many bedrooms, which side is
north, where is the door. Rejected: the point of the agent is that it designs.
Questions are for facts only the person has.

**A second model as the critic.** A different vendor for a different opinion.
Deferred, not rejected: the 2026 CHI result says one model with three prompts
does as well, and a second provider is a configuration change when the
evaluation says otherwise.

## Consequences

- New tools in spec 04: `check_design` (both tiers, non-mutating),
  `build_design` (semantic, mutating, one transaction). The architect's role
  is a prompt and the inspect subset; the critic is a `completeJson` call in
  the runner with no tools.
- `validate` gains the drawing-side checks of D3: room enclosure, item inside
  room, item overlap, blocked opening, bed head on a wall, clearances. The
  residential pack's size rules already exist; over-size becomes an error.
- The runner gains phases, the churn breaker, the appended facts of D5.4, and
  the design in its state. `AgentRuns` persists the design beside the
  conversation.
- The chat gains a design card and a checker card. The design card lists rooms
  with sizes so a person can object before a wall exists.
- Eval: a `three-bed-flat` card whose expectations are the checker's own
  (no errors, every purpose present, a route from the door), run per model and
  recorded in `docs/eval/agent-runs.md` beside the two runs above.
- Cost: the design phase adds two or three model calls and removes the churn
  that cost forty. The first measurement decides whether the critic earns its
  call.
- The checker's report, the design, the event stream and the eval cards are
  the environment and the reward for the owner's later reinforcement-learning
  experiment. Nothing here is built for it, and nothing here would have to
  change.
- Built as of 2026-09-20: the drawing-side checks and the placement fixes the
  second run exposed; `Design` (spec 01 section 4.3b); `check_design` and
  `build_design` (spec 04 section 6a); ADR-023's authorship and consent.
- The layout solver of D2's amendment, and the architect answering with a
  programme instead of rectangles, come before anything else: without them the
  architect cannot produce a design that passes, which was measured.
- Not built yet, in the order the amendments put them: sub-runs in the runner
  with their own context and step budget (D1); tool grants in the registry
  (D1a); the architect as the first sub-run; validation pushed back with every
  mutation (D4); the round budget and what happens when it is spent (D3);
  revisions and `basedOn` (D7); the cached-token measurement, then the tool
  surface, then compaction (D8); the design and checker cards in the chat. The
  critic is deferred until the eval asks for it.
- What the amendments cost: `runAgent` gains a sub-run entry point and a grant
  set; `Registry.call` gains a grant check beside the consent check it already
  has; the store gains a revision counter. None of it is a new package, a new
  process or a new port.

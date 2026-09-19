# ADR-022: The agent: one loop, three roles, and a checker that does the arithmetic

Status: Proposed
Date: 2026-09-20
Related: ADR-005 (single deployment), ADR-006 (tool surface), ADR-007 (provider
and runner), ADR-019 (session log), ADR-023 (authorship and consent), PRD P4-1
(the agent in the editor), spec 04 (tools), spec 07 (rules packs)

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

## Decision

### D1. One process, one model, three roles

The agent is three roles in one loop, in one process, against one model:

- **The architect** reads the brief and the project and produces a design. It
  has the inspect tools and `ask_user`, and no tool that draws.
- **The checker** is code. It measures the design and, later, the drawing, and
  reports errors and warnings with the numbers. A bounded critic pass by the
  model reads the same report and adds what code cannot see.
- **The builder** turns an approved design into walls, openings, rooms and
  furniture, and fixes what the checker finds, with the design pinned in its
  prompt.

A role is a system prompt and a tool subset, chosen by the runner for a phase
of one run. It is not a process, a service, or a separate agent with its own
conversation. The roles share the project, the conversation and the event
stream, so a tab watching the run sees the architect's plan, the checker's
report and the builder's walls in one transcript. ADR-005's rule that this
product deploys as one application is kept: nothing new listens on a port.

### D2. The design is an artefact, not a paragraph

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

### D3. The checker is code; the critic is a bounded model pass

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

The **critic** is one model call per round, at most three rounds, with the
design, the checker's report and no tools. It answers in JSON: what it would
change and why, each note tagged with a room key. Its notes are warnings. It
never overrides the checker, and the loop does not wait on it when the checker
has errors, because a room that overlaps another is not improved by an opinion
about its proportions.

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
6. **It is bounded.** Forty steps a run, three checker rounds, and a churn
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

## Alternatives considered

**Separate agents: an architect agent, a verifier agent, an orchestrator.**
The owner's first framing, and the one most agent products advertise. Rejected.
The roles share one project and one conversation; splitting them into agents
adds a protocol between them and removes nothing. The 2025 study found exactly
that cost on sequential work. And it would be a second service of ours, which
ADR-005 forbids. Roles as prompts give the same separation of concerns without
a wire between them.

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
- Not built yet, in order: the drawing-side checks and the placement fixes the
  second run exposed; `Design` and `check_design`; the architect phase;
  `build_design`; the critic; the cards. ADR-023's authorship lands before the
  builder can touch a project a person has worked in.

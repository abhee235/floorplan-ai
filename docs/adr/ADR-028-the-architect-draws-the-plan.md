# ADR-028: The architect draws the plan; code checks how it is built, not what it is

Status: Proposed
Date: 2026-09-22
Amended: 2026-09-22, D11 to D13, after the first drawn run
Related: ADR-022 (D2 the design is an artefact; D3 the checker is code; this amends both),
ADR-027 (skills, notes, reading), ADR-026 (numbers to the pack, judgement to a skill), ADR-024 D5
(best of several), spec 04 section 6a, `docs/eval/layout-quality.md`; Cascade's browser tool
(D11, ideas only)

## Context

### Every office came out the same, and not because of the checker

Five runs of the same hundred-person brief produced one building five times: the open office as a
bay at one end, every other room in a column 4 to 6 m wide with a hallway beside it, a link corridor
along the front. The owner asked whether the checker was forcing it. It was not. The shape is the
packer's (`packProgramme`, behind `plan_rooms`), which has exactly two layouts: strips either side
of one hallway, for homes, and that bay, for anything with one room over 35 per cent of the floor.
The model gives it a list of rooms and areas and nothing else. Its alternatives change areas, never
the shape. `nextTo` is scored after the fact and never used to place a room. The architect's prompt
says, in a line written for this project, "Do not place rectangles yourself."

So the same list gives the same drawing, by construction. The owner's position: the architect
decides the layout; code decides only whether it can be built and used.

### The test: a layout the tool has never produced, put through it

The owner ran the same brief through another assistant, which drew an isometric rendering: enclosed
rooms on all four sides of the building (three glass meeting rooms and an executive suite on one
side, the server room and an open cafeteria on another, a glass breakout room on a third,
reception, lounge, focus pods and restrooms along the front), and a hundred desks in eight benches
of twelve filling the middle, the open floor doubling as the only circulation.

It was written down as a design, room by room in millimetres, as an architect with a free hand
would write it (42 by 32 m, fifteen rooms, no corridor), and given to the real `check_design` and
`build_design`:

| Stage | Result |
|---|---|
| `check_design` | one error: "Open workspace is 566 m² and says it holds 100, which needs at least 800 m² at 8 m² a person". Nothing else: no overlap, no unreachable room, no door without a wall, no objection to a building without corridors. With that rule set aside: buildable, score 1. |
| `build_design`, first attempt | refused: the reception's entrance door and its window were both centred on its outside wall and overlapped. |
| `build_design`, window removed | 22 walls, 15 doors, 7 windows, **0 glass walls**, although seven rooms were marked glazed. |

Each finding has one cause:

1. **The capacity figure is ours and our own recipe contradicts it.** 8 m² a desk was chosen as
   "the floor below which the room is a lie". The `open-office` recipe put a hundred desks in about
   600 m² of a real run's 1,001 m² room. Benched desks with their aisles take about 5.5 to 6 m² each;
   8 to 12 m² is a whole floor's figure, meeting rooms and cafeteria included.
2. **Door and window on one outside stretch collide.** The builder centres both. The packer's
   receptions never asked for a window, so it had never happened.
3. **A shared wall's material depends on list order.** The builder files glass and plain runs on
   the same line separately and keeps whichever room came first. With the packer, hallways are listed
   last, so meeting rooms kept their glass; with the open workspace first, every glass wall became
   plaster.
4. **Every room is walled all round.** The rendering's cafeteria is open to the floor. A design has
   no way to say so.
5. **The outside is punched windows, 1.2 m each.** The rendering's executive suite has a wall of
   glass, and a modern office often has two glazed sides and no windows at all. A design has no way
   to say that either.

Out of scope, noted so a reader knows they were seen: the entrance that projects from the building
line (the shell is one rectangle), the server room's mesh cage (a finish), and the bar counter,
stools and planters (furniture, placed as labelled boxes today).

### The two things that would still resist, besides the builder

- The packer, by construction: it cannot produce this shape at all.
- The prompt, by instruction: it forbids the architect to write rectangles.

The checker, with one number corrected, does not. That is the finding this decision rests on.

### What is counter-argued, and what is not known

- **Daylight.** The rendering puts a hundred desks in the middle, more than 10 m from glass; our
  quality measure gives its daylight 0.73. The other common modern pattern is the opposite: a core
  of enclosed rooms in the middle and the desks on the windows. Both are real. The skill teaches
  both and says when each suits; the architect chooses.
- **Walls.** Not every room can be open or glass. Toilets, the server room, stores and comms stay
  solid, for privacy, security and fire separation.
- **Whether this model can draw.** Twenty rectangles in millimetres that tile a floor without
  overlapping is the part a 35B mixture-of-experts model is likeliest to get wrong. The checker
  catches every overlap, but each fix is a model turn and the architect has six. It has never been
  measured here.

### The first drawn office, seen only as numbers

Run 4 of the office brief made 104 tool calls. Twenty were `check_design` or `revise_design`; none
was `render` or `look_at`. No model at any point saw the plan it drew. The owner, looking at it, saw
what the checker's report had not said:

- meeting rooms along two sides of the building and nothing along the other two;
- no door into the open workspace;
- rooms with several doors, some onto the outside;
- the display in a meeting room on its window wall, most of the time;
- punched windows along an office facade, where a modern office is glass.

The first two are in the design, and a picture of it shows them at a glance. The third came after
`build_design` failed once and the designer drew the building itself, 15 `create_walls` and 15
`add_opening` calls; D10's continue-from route is the fix for that, not a picture. The fourth is a
rule in code: `suggestedDisplayWall` prefers the wall opposite the door, and in a room off a
corridor that is the outside wall; it does not look at windows or glass. The fifth is a default:
every side of the shell is `windows` unless the design says otherwise.

## Decision

### D1. The architect draws

Its prompt says to write the design itself, every room's rectangle, and to check it with
`check_design`. `plan_rooms` stays as a helper it may call for a first draft, never a requirement.
The "do not place rectangles yourself" line goes. The round budget stays at six, and the answer rule
stays: a design that does not pass comes back with its errors, never quietly replaced by the
packer's.

### D2. The checker judges how, not what

Errors stay only for what cannot be built or used: rooms overlapping, outside the shell or
exceeding it, a door with no shared wall or to nowhere, a room nobody can reach, a room too small for
its purpose or its seats, a missing toilet or kitchen, a corridor under the escape width, a window on
an inside wall, a way in from outside through the wrong room, a duplicate key. `too-large` becomes a
warning: a generous room is a choice.

Two rules learn the new vocabulary: `unreachable` walks through open rooms without a door, and
`no-window` counts a glazed side of the building as daylight.

And the score that chooses between alternatives (ADR-024 D5) includes room proportion from the
quality measure. A real run's `plan_rooms` scored its design 0.96 and chose it over two others; the
quality measure gave the same design 0.73, for slivers the checker's score could not see.

### D3. The design says what its walls are made of

- `room.enclosure`: `walled`, `glass` or `open`. Today's `glazed: true` reads as `glass`. Left
  unsaid: `walled`, except the purposes the packer already glazes.
- A wall between two rooms is decided by rule, not by list order: solid if either side is a room
  that must be (restroom, toilet, bathroom, utility, storage, and any room said `walled` whose
  purpose is service); otherwise glass if either side is glass; no wall at all if both are open;
  otherwise solid.
- `shell.facade`: for each side, `windows` (as now) or `glazed`, a glass wall the length of that
  side with no separate windows, counted as daylight for every room on it.

### D4. Two builder faults fixed

A room with an entrance door and a window on the same outside stretch gets them side by side. A
shared wall's kind follows D3.

### D5. One number corrected

`open-office` in `M2_PER_PERSON` goes from 8 to 6 m² a desk: the desk zone, not the floor. The
whole-floor density, 10 to 15 m² a person, is judgement and belongs to the skill (ADR-026 D1).

### D6. The skill teaches drawing

`office-layout` gains a section on drawing it yourself: the two patterns (rooms around an open
centre; a core of rooms with desks on the glass) and when each suits, how to lay bands and columns
out so the rectangles tile, which rooms are open, glass or solid, and when to glaze a side.

### D7. Measured before it is the default

The office brief and the six layout briefs, drawn both ways (architect; packer), scored by the
quality measure and rendered side by side in `docs/eval/layout-quality.md`. Whichever does better
becomes the default the prompt recommends; the other stays available. The transcribed rendering is
kept as a test fixture: it must pass the checker and build with its glass, its open cafeteria and
its entrance.

### D8. The model verifies its own intent with questions, not with code it wrote

The owner asked whether the orchestrating model could write its own
verification programs, as a coding agent does. Two things about that:

- A coding agent's checks work because the final judge is something the model
  did not write: the compiler, the type checker, the project's tests. Its own
  scripts are for looking and measuring. A model that writes its own pass/fail
  test tends to test what it already got right; the one freehand design in the
  logs had overlapping rooms and no doors and would have passed a test written
  by its author. So the "how" rules of D2 stay code, as the compiler stays.
- What was missing is the looking half: asking a design "how far is each desk
  from glass", "which room is narrowest", "is the cafe by the entrance". That
  is `query_design`: a condition and a list of expressions over every room,
  in the rules expression language, which does arithmetic and comparisons and
  nothing else -- no files, no network, nothing to sandbox. A JavaScript or
  Python sandbox would be a new dependency and, on a single host, code the
  model wrote running where the person's projects live. Not for this.

The architect's prompt says to ask its questions after the checker passes,
and the office skill says which questions.

### D9. A picture is copied, not paraphrased

The owner's condition for the whole project: a floor plan handed over as a
screenshot must come out on the drawing as it is. The path, with no stage that
may reshape it:

1. The designer names the attachment in the brief to `design_layout`.
2. The architect, granted `look_at`, looks at it and writes into notes the
   outline, the order of rooms along each side, the entrance, what is open and
   what is glass, and which sides are glass.
3. It estimates sizes from what the rooms hold (a desk is 1.6 by 0.8 m, a bench
   of six about 5 by 3.5) and writes the rooms in that arrangement, with
   `enclosure` and `facade` from what it saw.
4. `check_design` refuses only what cannot be built; the architect fixes by
   moving its rectangles and keeps the arrangement. `plan_rooms` is not called.
5. `build_design` draws it exactly, per D3 and D4.

The rendering the owner brought is the test fixture (D7): transcribed by hand,
it passes the checker and builds with its glass, its open cafe, its glazed side
and its entrance beside its window. What the fixture does not measure is the
model's eye: whether this model's transcription of the same picture comes out
close. That is the live test, and it is the next run.

`import_plan` stays the route for a line drawing at real resolution, where
walls are read from ink; `look_at` is the route for a rendering, a photograph
or a sketch, where they are read by the model.

### D10. A design is revised by patch, never re-sent

The first live run of D1 drew a sound 18-room plan on its first attempt -- no overlaps, bands and
a core, three glazed sides -- with no `doorsTo` on any room. Told so, it said "I need to add doorsTo
for each room" and sent the identical design; six times, until its rounds ran out. A probe of the
same model through the same wire with a two-room design wrote `doorsTo` and `enclosure` correctly.
The failure is length: a page of JSON regenerated from the page already in context comes back as
that page, and the edit that was announced is lost in it.

And a room with no doors at all is given one onto the circulation it touches, with a warning
naming each assumption: which door a meeting room off a corridor has is the obvious one, not a
decision, and twelve failed rounds were spent on it.

So `revise_design { designId, rooms: [{ key, ...fields }], add, remove, shell }` changes a checked
design and checks it again, and the architect's prompt says to fix errors that way and never to
re-send the whole. It counts as a round. The stall breaker now compares calls by content rather
than text, so the same design with its keys in a different order is the same call.

### D11. Every design is looked at before it is called done

The idea is Cascade's browser tool, where a build that compiles is not yet a page that renders: the
model opens what it built, reads a text snapshot, looks at a screenshot, and writes a verdict for
each line of a checklist before it may say it is finished. Here the design is the page and the
checker is the compiler. Ideas only; nothing is taken from its code.

1. **`preview_design { designId }`, for the architect.** A plan drawing of a checked design, made
   in the host by building the design into a scratch copy of the project, with the builder's own
   code, and drawing that level. The picture is what `build_design` will draw, not a second drawing
   that could disagree with it.
   - Walls by kind: outside walls thick black, plaster grey, glass thin blue, no line between two
     open rooms.
   - Doors as red gaps, the entrance green, windows as cyan ticks, open floor lightly tinted,
     corridors pale blue, service rooms grey, and floor inside the building that no room covers
     pink, so a gap is not mistaken for a store.
   - Each room carries a number, and the text result gives the legend (`1 reception, 2 desks-west,
     ...`). Ten digits in a bitmap font are a few hundred bytes; a font for every key is a
     dependency.
   - PNG through the `encodePng` the assets package already has, with node's zlib. No library, no
     browser tab, nothing downloaded.
   - The image rides on the tool result and the runner lifts it for a vision model, as it lifts a
     render. Only the latest picture stays in context; earlier ones are taken away.

2. **The walk, for every model, blind or not.** `check_design` and `revise_design` return, beside
   the errors, what a person walking the plan from the front door would report:
   - the route from the entrance to every room, as the rooms passed through
     (`outside > reception > corridor-n > meeting-3`), and the rooms reached only through a room
     that is not circulation;
   - every room with a door to outside, the entrance first;
   - for each side of the building, what stands along it in order, how much of its length has a
     room against it that is neither open floor nor circulation, and how much has no room against
     it at all, so "two sides blank" is a number;
   - for each room whose recipe has a screen, the wall it will go on and what that wall is: the
     furnishing rule itself, run on the scratch build, not a guess at it.

   Anything drawn over something else is already an error, so the walk does not repeat it.

   These are facts, not rules. D2 stands: the checker does not decide that a blank side is wrong.
   The model decides, with the facts and the picture in front of it.

3. **The look gate.** The architect may not return a design until it has looked at the one it
   returns: with vision, `preview_design` on that designId; without, the walk of its last check.
   Then a verdict, one concrete sentence per line. "Looks good" is not a verdict; a line that names
   nothing it saw was not looked at.

   ```
   LOOK design_12
   - Way in: where the entrance is and what it opens onto
   - Every room reached: the longest route, and any room reached through another
   - Sides: what stands along each side, and any side left blank
   - Doors outside: any door on an outside wall that is not the entrance
   - Drawn over: anything on top of something else
   - Displays: which wall each display goes on
   - Brief: what the person asked for that is there, and what is not
   - Verdict: DONE, or FIX and the fixes
   ```

   The gate is a reminder, not a stop, as the plan gate is. When the architect answers with a
   design that passed and it has not looked at it, or has written no verdict, the runner puts the
   request back in front of it, at most twice. A third answer goes through; `design_layout` then
   returns `looked: false` and warns the designer to look at the design itself before building. A
   FIX verdict is a revise round. The picture comes with the checklist as its caption, so the model
   is asked for the verdict at the moment it sees what it is judging.

4. **Required with vision, optional without.** The architect's prompt says "call preview_design"
   only when the model's profile has vision, as Cascade's tool refuses a screenshot to a model with
   no eyes rather than sending it an image it cannot read. A blind model is told that the walk is
   its eyes. The profile comes from the server: `/api/show` reports `vision` for the model on this
   machine, so for it the look is required.

5. **After `build_design`, the designer looks at what was built.** `preview_design` with no
   designId draws the level as it is, furniture included, displays in magenta, so a screen on a
   window shows. It needs no tab; `render` stays for the 3D views. The designer compares it with the
   architect's verdict. A difference is a builder fault, reported as one, and never mended by
   drawing walls by hand. Its final answer carries the architect's verdict.

6. **Budget.** A picture is real prefill for a local model. Six previews per architect run and four
   pictures per designer run; past the cap the tool refuses and says to use the walk. The architect
   is refused a second look at a design it has already seen: it has to change it first, as
   Cascade's browser skill says. A model without vision is not offered the tool at all.

7. **Measured by a live loop, not a scripted one.** `tools/eval/live.ts` runs a card through a host
   over its bridge, exactly as the editor does, saves every picture the agent looked at and a
   picture of what it built, and checks the result: the run finished, nothing was drawn by hand,
   the architect looked and wrote a verdict, the designer looked after building, every room can be
   walked to, no side is blank, no screen is on glass or a window, the brief's rooms and desks are
   there, and `validate` is clean. The card `office-brief-live` is the owner's own brief, word for
   word.

8. **What the loop found, and what changed for it.** Each run of `office-brief-live` on this
   machine's model, and what it taught:

   | Run | Checks | What went wrong | Changed |
   |---|---|---|---|
   | 1 | 3 of 10 | The architect drew freehand with overlapping rooms, a room past the shell and a band of meeting rooms 5 m from the floor, then sent one design six times word for word, saying each time it would start again; no round passed. It called y = 40,000 "the south". | A design identical to one already checked is refused (`design.unchanged`), which costs no round and is a failure the stall breaker counts. A step that repeats the last one exactly has its next reply sampled at 0.7, Qwen's own advice against greedy decoding; `FPV_AGENT_TEMPERATURE` sets it for every reply. The axes are said in both prompts and in the schema: y grows north. A room touching no shared floor is told the move that would reach it, as a `revise_design` line. When an error comes back twice, the architect is told to look: overlaps are orange, uncovered floor pink, and a design the builder refuses is still drawn as its rooms. |
   | 2 | 6 of 10 | The first architect drafted with `plan_rooms` and went silent; the second fixed its one error, looked twice and wrote a verdict that read the picture correctly. But the design was the packer's comb: a walled open office behind one door, a cafe in the middle with no daylight, the reception far from the entrance, none of which the checklist asked about. The designer then placed a server rack with a room and no anchor four times and stalled. | An open office is open floor by default, in the design and in the packer. The checklist asks whether the reception is the first room reached and whether the desks are open floor and the cafe has daylight. The office skill says to draw an office, not to draft it with `plan_rooms`. An empty reply after work is sent back once, and `design_layout` says how the architect's run ended. A room given alone to `place_item` puts the item in its middle, with a warning. |
   | 3 | 13 of 14 | The architect drew freehand and reached a plan with no corridor at all: an L of open floor, a column of rooms down one side, a row of glass rooms along the glazed south, the reception at the entrance. Every screen landed on plaster, the hundred desks sat centred in the open floor, and validate was clean. It still sent a whole design twice, and revised fields to the values they already had; the designer reached for `render`, which needs a tab, instead of the picture that does not. Two patches of floor belonged to no room. | After the first design, a whole design with the same rooms is refused and the patch is named; a revision whose every field is already what it says is refused too. A room key is read as a key, so "meetA" is not a wasted round. The checklist asks about floor no room covers, and the eval measures it. The designer's prompt names `preview_design` where it used to name `render`. |
   | 4 | 4 of 14 | Three of five architect sub-runs died on their first reply, each after five minutes: the request timeout, which a 35-billion-parameter model writing a whole design outlasts. Told only that no design passed, the designer drew the building itself -- nine walls, ten rooms, by hand. One architect did pass a design and the designer did not build it. | A timed-out request says so, with the seconds, and the loop asks for a shorter reply twice before the run ends; the default timeout is fifteen minutes, because a local model's reply is minutes long. A sub-run that dies says why, in the chat and to the designer. Six faults a review found in the work above were fixed with it: a passing design re-sent gets its id back instead of a false "it has the same errors"; the look gate stops asking for a picture the budget refuses; a verdict written in a bounced answer is kept; the sampled reply is the next one only; a revision that changes the circulation list is a revision; a service room in the corner of a glazed side no longer leaves a stub of glass. |
   | 5 | 11 of 15 | With the timeout raised the architect reached a passing plan on its third try and looked at it, and the designer built and furnished it: a hundred and sixty desks, screens on plaster, validate clean. But a seventh of the floor belonged to no room and one side was four fifths empty, and the verdict said neither; the designer reached for `render` again and answered without ever seeing what it built; one wall was drawn by hand. | `tidy_design`: the arithmetic done on request, every room moved the least it can be so nothing overlaps and everything is inside, each move reported, the arrangement untouched. A verdict that skips checklist lines is sent back once, naming them. The designer is asked once, after building, to look at what it built. A bare compass word is read as an anchor, which cost a live batch of eleven placements. |
   | 6 | 10 of 15 | The architect passed, looked three times and wrote the whole checklist; the designer built and furnished with nothing drawn by hand, and validate was clean. What the verdict still missed: a chain of rooms reached only through the server room, one side half empty, and two glass rooms with no wall for a screen. The run itself died at the end on a reply the server could not read. | Nothing yet: what is left is the model's judgement of its own plan, not a tool that is missing. |

What is not known is whether this model reads a plan drawing well. Cascade's probe had a model of
the same family read titles and colours off a web page; lines, gaps and room numbers are a
different picture. So, before the gate is on by default: the transcribed rendering (D7) with one
fault put in, a room with no door and one blank side, previewed to this model. The gate is worth
its prefill if the verdict names both faults.

### D12. A display does not go on glass, and an office is glazed unless it says otherwise

1. **The display wall.** `suggestedDisplayWall` leaves out every wall that is glass or has a window
   in it, and prefers a plaster wall to an outside one. "Opposite the door" stays, as the
   tie-break. A display against a window is backlit, so the far end of the table reads it against
   daylight; a glass wall cannot take a wall mount. Where no wall qualifies, as in a glass room on a
   glazed side, it returns none with the reason. Furnishing then says so and stands the display on
   the floor rather than mounting it on glass. A room with no screen, a reception, keeps the old
   rule under its own name: its desk faces the door with its back to the window, which for a desk is
   right.

2. **The facade by kind of building.** A side left unsaid is `glazed` in a workplace and `windows`
   in a dwelling or a mixed building. It is resolved in one place in `design.ts`, so the checker,
   the builder and the preview agree. `Facade` gains `solid`, for a side against a neighbouring
   building, which has neither windows nor glass; the architect can say `windows` or `solid` for any
   side.

3. **Service rooms stay walled on a glazed side.** A room that must be walled keeps a solid outside
   wall even on a glazed side: a toilet, a store, a server room. Today the builder draws the whole
   side as one glass wall, whatever is behind it. The side is split by the rooms against it, as an
   inside edge already is under D3.

4. **The tool for a fault is named where the fault is reported.** An overlap's hint carries the exact
   rectangle to move to and now also says `tidy_design` will do it; and after two rounds whose errors
   are rooms overlapping or outside the building, the architect is told plainly to stop moving them
   by hand and call it. Three live architects, ten rounds each, pushed rectangles around by hand with
   that tool sitting unused in their prompt; one of them reached for it once, late.

5. **Glass faces the shared floor; between two rooms it is plaster.** This amends D3's rule. A glass
   room's wall onto open floor or a corridor is glass; its wall onto another enclosed room, glass or
   walled, is plaster. D3 made a row of glass meeting rooms glass on every side, so none of them had
   a wall a screen could hang on, and no meeting room is private from the next through a sheet of
   glass. Glass is for being seen from the floor.

6. **Found by looking, and fixed with it.** The first preview of the transcribed rendering,
   furnished, had its ninety desks in the west two thirds of the open floor and a band of empty
   floor to the east. A room with no screen now has its furniture centred along it as well as
   across.

### D13. A skill per kind of building, and a kind of building only with its rooms

1. **What exists.** The office skill says it is for "an office, a studio, a clinic, a school wing,
   a hotel floor". Only the first two are offices. A clinic's consulting rooms, a school's
   classrooms and a hotel's guest rooms have no purpose in the room list, so they are `other`: no
   area per person, no daylight rule, no recipe. A skill for a clinic alone would teach sizes that
   nothing checks and a furnishing that nothing does.

2. **So a kind of building is added as three things together:** its purposes, with their area per
   person in the pack; its recipes; and its skill. Never a skill alone. The office skill's scope is
   narrowed to offices now, and the others are added in the order the owner needs them. The
   stakeholder's work is equipment forecasting for events, so an event venue is the likely next
   one: a ballroom, breakout rooms, a pre-function foyer, a green room, a control room.

3. **One skill per kind of building, with a section per variant.** An open-plan tech floor, a call
   centre, a practice of cellular offices and a co-working floor share their rooms and differ in
   density and enclosure. They are sections of the office skill, under a first section that says
   which is which, rather than four skills repeating most of the same text. A separate skill is
   written where the rooms differ, not where the proportions do.

4. **The index says which kind each skill is for,** from a `kind` line in the skill's front matter,
   and the architect's prompt says to read the one for the brief's kind before drawing.

As built: the office skill is narrowed to offices, with a first section on which kind of office the
brief is, its screen advice moved to plaster walls, its glazing advice to "glazed unless you say
otherwise", and a line on using every side. No new kind of building is added yet.

## Alternatives considered

**Remove the packer.** Rejected for now. It is the only layout anything here has measured, homes are
laid out with it, and D7 needs it as the other arm.

**Give the packer more shapes: core, perimeter, wings.** The previous proposal. Deferred: it trades
one fixed shape for four, and the owner's point is that the model decides. Revisit if D7 shows the
model cannot draw a passing plan within its rounds.

**Draw from a generated picture, as the other assistant did.** Deferred, as ADR-027 deferred it: it
needs an image model, and a plan traced from an invented picture is only as sound as the picture.
`look_at` already lets a person hand one to the architect.

**Leave the checker alone.** Rejected: three of its rules would refuse an ordinary open plan.

**Look at a 3D render instead of a plan drawing.** Rejected for the architect: a design has no 3D
until it is built, and a plan view is what shows doors, sides and routes. The 3D views stay for the
furnished result.

**Only `render` through the tab.** Rejected as the only route. The architect's design is not built
yet, and with no tab connected there would be no look at all. Kept for after `build_design`, when a
tab is there.

**Let the model write code that draws its plan.** Rejected, as D8 rejected model-written checks.

**Make a blank side an error.** Rejected: whether a side should be blank is what the building is,
and D2 leaves that with the model.

## Consequences

- `packages/agents/src/roles/architect.ts`: the drawing prompt; `plan_rooms` described as optional.
- `packages/ir/src/design.ts`: `enclosure` per room, `facade` per side of the shell.
- `packages/catalog/src/rules/layout.ts`: `too-large` a warning, reachability through open rooms,
  glazed sides as daylight, `open-office` at 6; the choosing score includes proportion.
- `packages/tools/src/build-design.ts`: the wall rule of D3, glazed façades, door and window side by
  side. `packages/catalog/src/rules/pack.ts` writes `enclosure` where it wrote `glazed`;
  `quality.ts` counts a glazed side as daylight.
- `apps/host/skills/office-layout/SKILL.md`: the drawing section.
- Spec 04 section 6a: the design's new fields; ADR-022 D2 and D3 amended to point here.
- Tests: the transcribed rendering as a fixture through checker and builder; the wall rule; the
  façade; the collision; `query_design`.
- `packages/tools/src/tools/design.ts`: `query_design` (D8); the architect is granted it.
- What D7 leaves to a live run: the model drawing the office brief and copying the rendering,
  scored against the packer's drawing of the same brief.
- D11: `preview_design`, the scratch build and the walk in `packages/tools/src/tools/design.ts`;
  the drawing in `packages/tools/src/plan-picture.ts`; the walk's routes and sides in
  `packages/catalog/src/rules/walk.ts`, over the checker's own door graph. The runner gains a
  `beforeFinish` hook, and the architect's look gate is built on it. The architect's prompt gains
  the look section, with vision and without; the designer's says to look after furnishing. The
  host offers `preview_design` only to a model with vision. `tools/eval/live.ts` and the card
  `office-brief-live` are the loop that measures it, and `docs/eval/office-live.md` keeps the runs.
- D12: `suggestedDisplayWall` and `wallFacingTheDoor` in `packages/tools/src/views.ts`; the facade
  default by kind and `solid` in `packages/ir/src/design.ts`; a glazed side split by the rooms
  against it, and glass only onto the shared floor, in `build-design.ts`; the checker's
  `window-solid` warning; furniture centred along a room with no screen.
- D13: the office skill narrowed; the skill index names each skill's kind of building.
- Tests: the preview's pixels at known points (red where `openingsWanted` puts a door, blue along a
  glazed side); the walk on the transcribed rendering; the gate fires, re-arms and gives up after
  two; no display on glass or a window in the fixture office; the facade default by kind; a toilet
  on a glazed side behind a solid wall.
- Measured before the gate is the default: the fixture with a fault put in, previewed to this
  model, and whether its verdict names the fault.

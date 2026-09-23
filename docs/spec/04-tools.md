# Spec 04: Tool catalogue and workflow prompt

Status: Draft
Date: 2026-09-14
Implements: ADR-005 D1, ADR-006
Package: `packages/tools`
Ledger coverage: section 6

Every tool is a registry entry `{ name, description, tier, input: ZodSchema,
output: ZodSchema, run(args, ctx) }`. Descriptions below are the exact text
shown to models and are part of this spec. Arguments are flat; lengths are
integer millimetres; angles degrees; compass words are computed from
`meta.north`.

## 1. Envelope

```ts
ToolOk    = { ok: true, result: unknown, warnings: string[], problems: Problem[], changed: ChangeSet | null }
ToolError = { ok: false, error: { code: string, message: string, entityId: string | null, hint: string | null }, warnings: string[] }
```

Unknown argument keys never fail a call; they produce the warning
`Unknown arguments ignored: a, b`. Results above 256 KB paginate with
`cursor` and `truncated: true`.

Common result fragments:

```ts
WallView    = { id, levelId, start, end, lengthMm, angleDeg, thickness, height, kind, pattern?, compass: { left, right }, joins, openingIds, faces? }   // pattern only when not "solid"
OpeningView = { id, wallId, kind, atMm, position, width, height, sill, hinge: compass | null, productId }
RoomView    = { id, levelId, name, purpose, capacity, areaM2, perimeterMm, bounds, walls: { wallId, compass, fromMm, toMm }[], openingIds, itemIds, ceilingHeight, source, stale }
ItemView    = { id, levelId, productId | recipe, name, category, position, rotation, elevation, size, footprint: Point[], bounds3, roomId, parentId, mount, verified }
```

## 1a. Consent: whose work the agent may change

A call made with `origin: "agent"` that updates or removes an entity whose `by`
says a person made or touched it, or that an import brought in, is refused and
taken back (ADR-023 D4):

```json
{ "ok": false, "error": {
  "code": "consent.needed",
  "message": "item_000031 was made or changed by the person; ask before changing it",
  "entityId": "item_000031",
  "hint": "call ask_user with kind 'consent' and these ids, then make this call again" } }
```

After the call rather than before it, because a tool does not know what it will
touch until it has, and the store already knows how to take a call back.

`CallOptions.released` carries the ids this run may change anyway: what the
person had selected when they asked, plus whatever a consent question has since
released. The agent loop keeps that set and grows it; the registry enforces it.

Changes nobody chose do not count. Moving one wall re-mitres the walls it joins
and creating a room adopts the items standing in it, so an entity whose only
difference is `joins`, `boundingWallIds`, `roomId` or the stamp itself is not a
change to ask about. A call from the editor is never refused: the editor is the
person's.

Views carry `by` only when the answer is "ask first", so a model reading back
its own work sees nothing extra.

## 2. Inspect tools (tier: both)

### get_scene
Description: "Read the project. Call with detail 'summary' first; it returns levels, rooms with names, purposes, areas and item counts, and the bounding box in under 2 KB. Use detail 'full' with types and levelId to page through entities (100 per page, follow cursor). All lengths are mm, angles degrees, north is +y unless meta.north says otherwise."
Input: `{ detail: "summary" | "full", levelId?: string, types?: ("wall" | "opening" | "room" | "item" | "zone" | "annotation")[], bbox?: { minX, minY, maxX, maxY }, cursor?: string }`
Output summary: `{ meta, levels: [{ id, name, elevation, height }], rooms: [{ id, name, purpose, areaM2, itemCount }], counts: { walls, openings, rooms, items, zones }, bounds, problems: { errors: number, warnings: number } }`
Output full: `{ walls?: WallView[], openings?: OpeningView[], rooms?: RoomView[], items?: ItemView[], zones?, annotations?, cursor: string | null, truncated: boolean }`

### describe_room
Description: "Describe one room for placing things: its walls named north/south/east/west with free wall lengths (segments not blocked by openings or items), openings with hinge sides, items with positions, and clearances. Use this before place_item with an anchor."
Input: `{ roomId: string }`
Output: `RoomView & { freeSegments: { wallId, compass, fromMm, toMm, lengthMm }[], items: ItemView[], openings: OpeningView[], suggestedDisplayWall: compass | null }`

### measure
Description: "Distance between two entities (nearest edges) or two points, in mm."
Input: `{ fromId?: string, toId?: string, from?: Point, to?: Point }`
Output: `{ mm: number, dx: number, dy: number }`

### validate
Description: "Check the project for problems. Fix errors before continuing; warnings are advice. Each problem names the entity and, where possible, a hint."
Input: `{ levelId?: string }`
Output: `{ errors: Problem[], warnings: Problem[] }`

### search_catalog
Description: "Find products or parametric recipes. Returns at most 20 with id, category and dimensions in mm. If several match, pick by id in the next call. Never invent a productId."
Input: `{ kind: "product" | "recipe", query: string, category?: Category, limit?: number, cursor?: string }`
Output: `{ hits: [{ id, name, make, model, category, dims, verified: boolean, price?, status?, matchedBy? }], total: number, cursor: string | null }`
An empty query browses: a category's products by name, or with no category every product by category and name, a page at a time. The editor's catalog tab (P3-5) searches through this tool.

A category that matches nothing, when the same query matches elsewhere, is answered with a warning
naming the categories that do and how many each (ADR-027 D6): a real run searched "desk" under
`table` twice and never found the three desks filed under `desk`.

## 2a. Reading tools (ADR-027; tier: both, non-mutating)

### look_at
Description: a picture on demand: an attachment by id, or a picture on the web by url. For a line
drawing to be traced into walls, `import_plan`; for a photograph, an illustration, a sketch or a logo,
this.
Input: `{ attachmentId?: string, url?: string, question?: string }` (one of the first two)
Output: `{ name, mime, bytes, width, height, caption, images: [{ name, mime, pngBase64, width, height }] }`
The runner lifts `images` into the conversation for a model that can see, introduced by `caption`;
the chat shows it on the card. A url comes through the verifier's guarded fetcher (private addresses
refused, 8 MB cap). Advertised only to a model that can see, and only when something is attached or
the session has the web; the architect is granted it too.

### web_search
Description: pages (title, url, snippet) or, with `kind: "images"`, pictures to `look_at`. For what
no skill covers; not on every run.
Input: `{ query: string, kind?: "web" | "images", limit?: number (≤ 10, default 5) }`
Output: `{ kind, hits: [{ title, url, snippet?, source?, thumbnail? }] }`

### read_page
Description: a page as text, up to `maxChars` (default 8,000), through `htmlToText`; private
addresses refused.
Input: `{ url: string, maxChars?: number }`
Output: `{ url, status, title: string | null, text, truncated }`

Both web tools live behind `ToolContext.web`, which the host fills from the same search
configuration the product verifier uses (`FPV_SEARCH`, `FPV_SEARCH_URL`; a URL alone means
SearXNG). Without it they are not advertised and refuse with the variables to set.

### read_skill and notes (the loop's own)
`read_skill { name, file? }` returns a skill's body, or a reference document inside it, from the
skills the host loaded (`apps/host/skills/`, then `<data>/skills`); a wrong name answers with the
names that exist. `notes { text }` replaces the model's notes, up to 3,000 characters; they ride on
the system prompt after the plan and are handed to the architect. Neither reaches the registry;
both are answered inside the loop like `plan_work` and `ask_user` (spec 06 B2, ADR-027 D2).

## 3. Render (tier: both)

### render
Description: "Render images through the connected viewer. 'plan' is a fast top-down drawing; 'overhead' returns four angled views with walls hidden so furniture is visible; 'room' focuses a room; 'eye' is a standing viewpoint inside a room. Fails with a clear message if no viewer is connected; then rely on get_scene and validate."
Input: `{ view: "plan" | "overhead" | "room" | "eye", focusId?: string, hideWalls?: boolean, width?: number }`
Output: MCP image content plus `{ views: [{ name, width, height }] }`

## 4. Structure tools (tier: primitive)

### create_walls
Description: "Create walls along a polyline in mm. closed=true joins the last point to the first. Endpoints within snapMm of an existing free wall end are joined to it. Returns the new walls with lengths and compass sides. Default thickness 120 (partition 100, exterior 300), height from the level."
Input: `{ levelId: string, points: Point[], closed: boolean, thickness?: number, height?: number, kind?: WallKind, snapMm?: number }`
Output: `{ walls: WallView[] }`

### modify_wall
Input: `{ wallId: string, start?: Point, end?: Point, thickness?, height?, heightAtEnd?, arcExtent?, kind?, pattern?: "solid" | "hatch" | "cross-hatch" | "outline" }`
Output: `{ wall: WallView, affected: WallView[] }`

### finish_wall (phase 3)
Description: "Paint a wall face and set its baseboard. face is the compass direction the face looks toward (get_scene lists them under compass) or 'both'. colour is hex (#RRGGBB or #RGB) or null for the default; finish is matt, satin or gloss. baseboardHeight in mm, null removes the baseboard; baseboardDepth in mm (default 12); baseboardColour is hex or null to follow the face. Only the fields you give change."
Input: `{ wallId: string, face: "north" | "south" | "east" | "west" | "both", colour?: Hex | null, finish?: "matt" | "satin" | "gloss", baseboardHeight?: number | null, baseboardDepth?: number, baseboardColour?: Hex | null }`
Output: `{ wall: WallView }`. One `wall.modify`, so one history entry. Faces are named by compass because a model cannot see which side of a wall is its left (ADR-006 D3). Errors: `wall.face` naming the faces the wall has; `args.invalid` for a baseboard taller than the wall (W-100), a depth outside 1 to 200, or depth or colour for a face with no baseboard. `WallView` gains `faces` (facing, colour, finish, baseboard) only for walls where a face carries something.

### delete
Description: "Delete any entities by id. Deleting a wall deletes its openings and detaches neighbours; deleting an item deletes items stacked on it."
Input: `{ ids: string[] }`
Output: `{ removed: Ref[], updated: Ref[] }`

### add_opening
Description: "Add a door, window or passage to a wall. Give either position (0..1 along the wall from its start) or atMm from the start. hingeSide is a compass word; the door swings into the room on that side's opposite. Defaults: door 900x2100, window 1200x1200 sill 900, passage 1000x2100."
Input: `{ wallId: string, kind: "door" | "window" | "passage", position?: number, atMm?: number, width?: number, height?: number, sill?: number, hingeSide?: "north" | "south" | "east" | "west", swingDirection?: "left" | "right", productId?: string }`
Output: `{ opening: OpeningView, wall: WallView }`

### create_room
Description: "Create a room by polygon, by rect {x,y,w,d}, or by atPoint (detect the enclosure around a point from the walls; smallest enclosure wins). Set purpose and capacity; furnish_room uses them."
Input: `{ levelId: string, polygon?: Point[], rect?: { x, y, w, d }, atPoint?: Point, name?: string, purpose?: RoomPurpose, capacity?: number }`
Output: `{ room: RoomView }`

### modify_room
Input: `{ roomId, name?, purpose?, capacity?, ceilingHeight?, polygon? }`
Output: `{ room: RoomView }`

## 5. Item tools (tier: primitive unless noted)

### place_item (tier: both)
Given a `roomId` and no position, anchor or mount, the item stands in the middle
of that room, with a warning saying so: a live run placed a server rack with a
room and nothing else four times and the run ended stalled (ADR-028 D11).
Description: "Place a product or recipe. Either give x, y, or give roomId plus an anchor: 'center', 'against-north-wall' (also south/east/west), 'north-east-corner' (and the other corners), 'along-wall:<wallId>@<mm>', or 'on:<itemId>' to stack on another item. Anchors set rotation for you. Returns the final position after snapping and any warnings about overlaps or blocked door swings."
Input: `{ productId?: string, recipe?: PrimitiveRecipe, x?: number, y?: number, roomId?: string, anchor?: string, rotation?: number, elevation?: number, mount?: { kind, targetId?, height? }, tags?: string[] }`
Output: `{ item: ItemView, adjusted: boolean }`

### modify_item
Input: `{ itemId: string, x?, y?, rotation?, elevation?, size?: Size3 | null, parentId?: string | null, productId?: string, mirrored?: boolean, mount?, tags? }`
Output: `{ item: ItemView, descendants: ItemView[] }`

### arrange (tier: both)
Patterns are `grid`, `rows` and `bench` (rows in back-to-back pairs), each placing ONE product;
the description says so and points at `furnish_room` for desks with their chairs (`open-office`)
or chairs around a table (`meeting`, `boardroom`, `huddle`), and at `replace: true` with a
`zoneId` for redoing a zone. The `boardroom`, `u-shape` and `classroom` patterns the first draft
promised were never implemented and are no longer advertised (ADR-027 D6).
Description: "Fill a room or zone with a pattern: 'grid', 'rows', 'bench' (desks back to back), 'boardroom' (one table, chairs around), 'u-shape', 'classroom'. count is the number of items requested; the result says how many fit."
Input: `{ roomId?: string, zoneId?: string, pattern: string, productId?: string, recipe?: PrimitiveRecipe, count: number, spacingMm?: number, facing?: "north" | "south" | "east" | "west", replace?: boolean }`
Output: `{ zoneId: string, placed: number, requested: number, items: ItemView[] }`

## 6. Semantic tools (tier: both)

### create_room_from_brief
Description: "Create and furnish a room from a sentence such as '10-seat boardroom 8 by 5 m with video conferencing'. Parses size, seats, purpose and AV needs; creates walls, a door on the corridor side, the room, then calls furnish_room. Returns what it understood so you can correct it."
Input: `{ brief: string, levelId?: string, origin?: Point, corridorSide?: "north" | "south" | "east" | "west" }`
Output: `{ understood: { purpose, capacity, widthMm, depthMm, av: string[], corridorSide }, room: RoomView, recipe, displayWall, counts, items: ItemView[], unresolved }` with warnings in the envelope

As implemented: the brief is read by rules, not a model (`parseBrief`): sizes such as `8 by 5
metres`, `3x2.5m`, `12000 x 10000 mm` or `20 ft by 12 ft`; seats as `10-seat`, `24 people` or `for
four`; purpose from boardroom, huddle, training or classroom, meeting or conference words; AV words
for video conferencing, display, audio, whiteboard and scheduler. Anything missing is assumed from
the other values and reported as a warning. The size is the clear inside; walls are 100 mm and
centred outside it. `origin` defaults to 2 m east of the project's bounds. `corridorSide` defaults to
west when the room is at least as wide as deep, otherwise south, so the display lands on a short
wall and the table runs toward it. Without video conferencing in the brief, no video bar or ceiling
microphones are placed. Walls, then door and room, then furnishing are three history entries; if
any step fails, all of them are undone.

### furnish_room
Description: "Apply a room recipe from the rules pack to an existing room: table and chairs sized to capacity, display on the best wall, video bar, ceiling mics and speakers by area, scheduler by the door. Products are chosen from the catalog by constraint; missing ones are verified or placed as recipes. Existing items are kept unless replace=true."
Input: `{ roomId: string, recipe?: string, replace?: boolean, preferences?: { make?: string[], budget?: "low" | "mid" | "high" } }`
Output: `{ recipe, displayWall, counts: Record<category, number>, items: ItemView[], unresolved: { category, constraint, placedAs }[] }` with warnings in the envelope

As implemented: the plan is deterministic (`planFurnishing`) and applied as one transaction, so one
undo removes it. A category the room already has is skipped with a warning unless `replace` is
true, which deletes the room's items in the same transaction. A product that no catalog entry
satisfies is placed as a primitive recipe and listed in `unresolved`. `preferences.make` orders
candidates; `preferences.budget` is accepted and not applied yet.

## 6a. Design tools (ADR-022)

### plan_rooms (tier: both, non-mutating)
Input: `{ brief, kind, shell?, rooms: ProgrammeRoom[], assumptions?, alternatives?: { note, shell?, rooms }[] }`
Output: `{ designId, buildable, score, tried, chosen, rejected, totals, shell, rooms, decided, unplaced, errors, warnings }`

A programme into a plan (ADR-022 D2 amended, `packProgramme`). The caller says
which rooms the building needs, what each is for and roughly how many square
metres it wants; the packer sizes the building, lays the rooms in strips either
side of a hallway, and checks its own work. Every room runs the full depth of
its strip, which gives one long side on the hallway for the door and the other
on the outside of the building for the window.

**Optional since ADR-028 D1.** It is a helper for a quick first draft and it
makes one shape only; it cannot make an open floor, rooms around a courtyard or
a copy of a picture. The architect is told to write the design itself and give
it to `check_design`, and to use `plan_rooms` only for a start it then moves.
Its output carries `quality` beside `score`, and alternatives are ranked on
the mean of the two, so a sliver the checker cannot see still loses.

`alternatives` (ADR-024 D5) are other ways of arranging the same brief, each
with a `note` saying what is different. All of them are packed and checked, and
the best is kept: fewest errors, then the higher score, then fewer unplaced
rooms. The others come back in `rejected` with their scores, and the envelope
warns which was chosen. Packing and checking cost nothing, so three
alternatives cost one answer's worth of extra words and no extra tool calls.

`unplaced` names a room the packer could not fit and says what it needed. The
answer is to change the programme, never to place the room by hand.

### check_design (tier: both, non-mutating)
Input: `{ design: Design }` — the artefact of spec 01 section 4.3b: a shell
rectangle, a list of room rectangles with purposes and `doorsTo`, circulation
keys and assumptions. Since ADR-028 D3 a room also carries `enclosure`
(`walled`, `glass` or `open`; the older `glazed: true` reads as `glass`) and the
shell a `facade` per side: `glazed`, `windows` or `solid` (ADR-028 D12), a
side left unsaid being glazed in a workplace and windows in a home. An open room needs no door
and is circulation for every open room it touches; a room on a glazed side has
daylight without a window; restrooms, toilets, bathrooms, utility, storage,
laundry and garages are walled whatever the design says, and keep a solid
outside wall on a glazed side.

The checker judges whether a plan can be built and used, never its shape
(ADR-028 D2): errors are rooms overlapping or outside the shell, a door with no
shared wall or to nowhere, a room nobody can reach, a room too small for its
purpose or its seats, a missing toilet or kitchen, a corridor under the escape
width, a window on an inside wall, a way in through the wrong room, a duplicate
key. `too-large` is a warning. An open office is held to 6 m² a desk.

### revise_design (tier: both, non-mutating; ADR-028 D10)
Input: `{ designId, rooms?: [{ key, ...fields }], add?: DesignRoom[], remove?: string[], shell?: Partial<shell>, circulation? }`
A room's `rect` may be given in part: what is left out stays as it was, so moving
a room is `rect: { y }`. A key is matched as it is read -- "openoffice" finds
`open_office` -- and the reading is reported.
Output: as `check_design`.

A checked design changed a little and checked again. The whole design is never
sent back: a real run re-sent an 18-room design six times, each time saying it
was adding `doorsTo`, and each time the JSON came back without it -- a page
regenerated from context loses the edit that was meant, while a patch of a few
lines carries it. Counts as a round for the architect, like `check_design`.

A design already checked in this session, word for word, is refused with
`design.unchanged` rather than checked again, and so is a revision whose every
field is already what it says: both are a model re-sending what it has, and a
refusal costs no round and is a failed call the loop's stall breaker counts
(ADR-028 D10). The architect refuses more than that: after its first design, a
whole design whose rooms are mostly the ones it has already checked is refused
with `design.send-the-change`, naming the `revise_design` call to send instead.
A room key that is not a key ("meetA") is read as one, with a warning, and the
doors that name it are read with it.

Both `check_design` and `revise_design` give an enclosed room that lists no
doors at all a door onto the corridor, foyer or open room it shares the longest
wall with (at least a metre), and say which in a warning. Which door a meeting
room off a corridor has is not a design decision; a room that touches no
circulation is left for the checker to name.

### tidy_design (tier: both, non-mutating; ADR-028 D10)
Input: `{ designId }`
Output: as `check_design`.

The arithmetic of a design whose arrangement is already decided: every room
moved the least it can be so that none overlaps another and all are inside the
building, each move reported as a warning ("cafe moved 1500 mm north"). It never
changes which room is where, what it is, or what it opens onto. It is there
because a local model's rounds went on overlaps of a few hundred millimetres
that it could not compute its way out of, and it counts as a round like any
other check.

### query_design (tier: both, non-mutating; ADR-028 D8)
Input: `{ designId, where?: string, select?: string[], limit?: number }`
Output: `{ count, rows: [{ key, name, values }], errors: string[] }`

The architect's own questions of a checked design, in the rules expression
language (spec 07 section 2): `where` is a condition over each room, `select`
the values to report. Names: `key, name, purpose, area, w, d, x, y, capacity,
window, enclosure, onOutside, gapNorth, gapSouth, gapEast, gapWest, touches,
doors, shellW, shellD, rooms`. `touches` and `doors` are comma-separated keys
for `has(...)`. An unknown name is an error naming the names. This is the
dynamic half of verification: the checker knows what cannot be built, the model
knows what it meant, and a query is how it compares the two.

### preview_design (tier: both, non-mutating; ADR-028 D11)
Input: `{ designId?, levelId? }`
Output: `{ caption, ask, legend: string[], images: [{ name, width, height, pngBase64 }] }`

A plan drawing, north up, for a model to look at. With a `designId`, the checked
design built into a scratch copy of the project by the builder's own code and
drawn: what `build_design` will draw. Without one, the level as it is built,
furniture included. Black outside walls, grey plaster, blue glass, red doors, a
green entrance, cyan windows; open floor pale yellow, corridors pale blue,
service rooms grey, floor no room covers pink, displays magenta; the rooms
numbered, with the legend in `legend` and the caption. `ask` is what to do with
it: for a design, the LOOK checklist; for a built level, the comparison. The
runner lifts the picture for a model that can see, and the host offers the tool
to no other. A design the builder refuses is `design.not-drawable`.
Output: `{ designId, buildable, score, totals: { shellM2, roomsM2,
unaccountedM2, rooms, byPurpose }, errors: Problem[], warnings: Problem[] }`

`score` is one minus what the problems cost, in [0, 1], errors weighing six
times a warning and saturating at zero (ADR-024 D4). It exists to rank two
designs and to notice a change between runs; the problems themselves are what a
model should read to fix anything.

Measures the design before anything is drawn (`checkLayout`,
`packages/catalog/src/rules/layout.ts`). Every error also appears in the
envelope's `warnings`, so a chat card shows what is wrong without unpacking the
result. Checking changes nothing and may be repeated; each call returns a
`designId` the session keeps (eight at a time, per store, like import drafts).

Errors, all prefixed `design.`: `duplicate-key`, `door-to-nowhere`,
`outside-shell`, `rooms-overlap`, `rooms-exceed-shell`, `too-small`,
`too-large`, `corridor-narrow`, `missing-room`, `no-way-in`,
`door-without-wall`, `private-to-private`, `wet-into-kitchen`,
`door-outside-inside`, `unreachable`, `window-inside`. Warnings:
`unexplained-space`, `no-window`, `window-solid`.

Every report from `check_design`, `revise_design` and `plan_rooms` also carries
`walk` (ADR-028 D11): `{ entrances, routes, through, unreached, sides, displays }`.
`routes` is each room's way in from the entrance, as the rooms walked through;
`through` the rooms reached only by walking through a room that is not shared
floor; `sides` per side of the building its facade, what stands along it, the
share of it with an enclosed room against it (`enclosed`) and the share with no
room at all (`empty`); `displays` the wall each screen would go on, by the
furnishing rule, run on the design built into a scratch copy. Facts for the
model to judge, never errors.

The size limits come from the rules pack's facts (`bedroomMinM2`,
`bedroomMinSideMm` and so on, spec 07 section 3.2), so a user's own pack moves
them without touching code. The maxima — a toilet over 4 m², a bathroom over
9 — are the checker's own, because a room far larger than its purpose is a
mistake in the design rather than a matter of local standards.

### build_design (tier: semantic, mutating)
Since ADR-028 D3 and D4 the builder draws the design exactly as it is: a glazed
side is one glass wall the length of it with no windows punched in; the wall
between two rooms is decided by rule, not by list order (solid if either must
be, else glass if either is glass, none if both are open, else solid), and an
edge facing several rooms is several walls, each of its own kind. Since D12 the
rule is: solid if either must be; none if both are open; glass where a glass
room faces open floor or circulation; plaster otherwise, so two glass rooms side
by side are parted by plaster. A glazed side is glass except behind a room that
must be walled; a solid side takes no window. A room with an
entrance and a window on one side gets them side by side, and a side too short
for both keeps the door and says so.
Input: `{ designId, levelId? }`
Output: `{ walls, doors, windows, rooms: RoomView[], unplaced: string[] }`

Draws a design that passed, and refuses one that did not with
`design.not-checked` naming the first error. Three transactions — walls, then
openings, then rooms — so the whole building is three history entries and a
failure part-way undoes what it had done.

Walls are worked out from the rectangles, not drawn one by one: each room's
four edges become wall centrelines, an edge facing another room lands on the
line between them so both rooms compute the same wall, edges on the outside of
the building land on the shell, and collinear runs merge, so one wall serves a
whole row of rooms. Doors go in the middle of the wall two rooms share (750 mm
to a bathroom or toilet, 1000 at the front door, 900 elsewhere); windows go in
the middle of a room's longest outside wall. An opening with no wall to sit in
is returned in `unplaced` and warned about rather than dropped quietly.

## 7. Catalog and BOM (tier: both)

### verify_product
Description: "Verify that a make and model exist and capture dimensions, specs and price from the web. Returns the productId to use, or 'unverified' with what was found, or 'rejected' when no page names the model. Values count only when a fetched page states them. If you can search the web yourself, pass sources (product or spec page URLs) and optionally proposal (the fields you read, with fieldSources). Unavailable if no search provider is configured and no sources are given."
Input: `{ make: string, model: string, category?: Category, sources?: url[] (max 5), proposal?: ProductProposal, force?: boolean }`
Output: `{ productId: string | null, status: "verified" | "unverified" | "rejected" | "manual", confidence: number, product: ProductSnapshot | null, sources: string[], notes: string[], cached: boolean, runId: string | null, proposal: ProductProposal | null }`

`sources` and `proposal` are the development path of ADR-008 D3: an agent with its own web search
(Claude Code) names the pages and what it read; the host fetches those pages itself and scores the
proposal against them, so a caller cannot verify a value no page states. The tool does not change the
project (`mutating: false`); it writes the catalog and one verification run.

### get_bom
Description: "Bill of materials for the project, a level, or a room, computed from placed items, openings and the rules pack. Lines carry the reason (item id or rule id). Unverified products are flagged."
Input: `{ scope: "project" | string, includeUnverified?: boolean, explain?: boolean }`   (scope is "project", "level:<id>" or "room:<id>")
Output: `Bom` (spec 07)

## 8. History, batch, session, export (tier: both)

### history
Input: `{ op: "checkpoint" | "undo" | "redo" | "list" | "restore", label?: string, checkpointId?: string }`
Output: `{ position: number, entries?: [{ label, at }], checkpointId?: string, changed?: ChangeSet }`

### batch
Description: "Run several tool calls as one step: calls is a list of { name, args } with the same arguments you would give each tool, up to 200. If one fails, everything the earlier ones did is undone and the error names which."
Input: `{ label?: string, calls?: [{ name, args }], commands?: Command[] }` (one of the two)
Output: `{ applied: number, changed: ChangeSet | null, results?: unknown[] }`

`calls` is what a model sends: the arguments it already knows, run through the registry as the
batch itself was called (same origin, consent and grant), atomic by undoing back to where the
history stood when the first call fails (ADR-027 D6). `commands` stays for callers that speak spec
03, in one store transaction. A batch inside a batch is refused.

### project
Input: `{ op: "new" | "open" | "save" | "info", path?: string, name?: string }`
Output: `{ path, name, modified, schemaVersion, lastSavedAt }`

### export
Description: "Write the bill of materials to a file: csv or xlsx, with provenance and the verification status of every line. Refuses when validate reports errors unless force is true (the file is then marked DRAFT), and refuses while lines are unverified or placeholders unless includeUnverified is true (the file then says so and highlights them). Relative paths go into the project directory. glb writes the 3D scene as a glTF binary (metres, y up) with one node per level, wall, opening, room and item, named by entity id; it needs no rules pack. pdf and dxf arrive in phase 3. Returns the path and size."
Input: `{ format: "csv" | "xlsx" | "glb" | "pdf" | "dxf", scope?: string, path: string, force?: boolean, includeUnverified?: boolean, overwrite?: boolean }`
Output: `{ path, bytes, format, lines, nodes?, triangles?, draft, includesUnverified, warnings }`

`force` means "export despite validation errors" (ADR-013 D2), not "overwrite"; replacing an
existing file needs `overwrite`. Errors: `export.invalid` (validation errors, first three named),
`export.unverified` (unverified or placeholder lines, first three named), `file.exists`,
`file.write`, and `unavailable` for pdf and dxf until phase 3, for csv and xlsx in sessions without
a rules pack, and for any format in sessions without a file writer.

`glb` (phase 2, ADR-013 D4) checks validation errors only (not design rules or verification) and
reports `nodes` and `triangles`; `lines` is 0. The node tree is project, then level, then walls (openings as
child nodes) and rooms (their items as child nodes); items without a room sit under the level. Items that
share an asset share one mesh; items without a size are left out with a warning. A `room:` scope keeps the
room, its items and its bounding walls. `asset.extras` records the export time, scope and draft flag, and
the bytes are otherwise identical for the same project.

### import_plan (phase 2)
Input: `{ path?: string, content?: string, fileName?: string, page?: number, draftId?: string, draft?: PlanDraft, scale?: { mmPerUnit } | { units: "mm"|"cm"|"m"|"in"|"ft" } | { measuredUnits, lengthMm }, answers?: Record<questionId, string>, confirm?: boolean, levelId?: string, detail?: "summary" | "full" }`
Output: `{ status: "review" | "committed", draftId, fileName, scale: { mmPerUnit, detected, source, confirmed, reason }, counts: { walls, openings, rooms, texts }, questions: DraftQuestion[], draft?: PlanDraft, committed?: { levelId, wallIds, openingIds, roomIds, labelIds, skipped: { what, idx, reason }[], openQuestions: string[] }, next: string }`

Tier both, mutating, slow timeout (120 s), result cap 8 MB. Behaviour (ADR-011 D3, D5; spec 06 A2):

- Without `confirm` the tool reads the plan through the host's plan reader (a
  `path`, or `content` with `fileName` from the app's file picker), keeps the
  draft in the session under a content-derived `draftId` (the eight most
  recent), shows it in connected viewers with a `draft` bridge message, and
  changes nothing. The returned draft omits `texts` unless `detail` is
  `full`.
- `answers` record answers by question id. An answer to a `scale` question
  sets the scale when it reads as a unit word, a number of millimetres per
  drawing unit (`25.4`, `25.4 mm per unit`), or a yes that keeps the shown
  scale; other answers leave the scale unchanged with a warning. `scale` sets
  it directly; both make the scale source `user`.
- `draft` replaces the kept draft with an edited one (the app's review sends
  it after deleting walls or changing thickness).
- With `confirm: true` the draft (by `draftId`, or read again from `path`)
  commits as one transaction on `levelId` (default the lowest level) and
  the viewers' review closes. A level that already has walls gets a warning,
  not a refusal.

Errors: `import.scale-unconfirmed` (the scale is neither set by a person nor
cross-checked by two dimension texts), `import.draft-unknown`,
`import.format` (DWG, or a file that is not DXF), `import.unsupported` (PDF
and images until P2-2 and P2-7), `import.parse`, `import.too-large` (64 MB),
`file.missing`, `args.invalid`, and `unavailable` in a session without a
plan reader.

## 9. Tiers by profile

| Profile toolReliability | Advertised |
|---|---|
| high | all |
| medium | all except `modify_wall`, `delete` of walls (still callable) |
| low | `get_scene`, `describe_room`, `validate`, `render`, `search_catalog`, `create_room_from_brief`, `furnish_room`, `place_item` (anchor form only), `arrange`, `get_bom`, `history`, `batch`, `project`, `export`, `add_level`, `import_plan`, `finish_opening`, `finish_wall`, the design tools, `preview_design`, `look_at`, `web_search`, `read_page` |

The three reading tools are in every profile (ADR-027): simple, non-mutating, and a weak model with a
picture attached needs `look_at` as much as a strong one. Whatever the profile, the host leaves out
what the session cannot use: the web tools without a search provider, `look_at` for a model that
cannot see or a conversation with nothing attached, and `preview_design` for a model that cannot see.

A weak model is offered fewer ways to do a thing, never fewer things it can say. `add_level`,
`import_plan` and the two finish tools were added to the low profile in phase 4: a storey, a plan to
read and the colour of a pane of glass are parts of an ordinary brief, and a profile that hid them
made "three storeys with tinted windows" unanswerable rather than merely harder.

## 10. Workflow prompt

Name: `floorplan_workflow`. Text:

> You are designing an office space in a floor plan tool. Units are millimetres and degrees; north is +y. Work in this order: 1) call get_scene with detail summary; 2) create structure (walls, then openings) before rooms, and rooms before items; prefer create_room_from_brief and furnish_room, use primitive tools to correct; 3) after each group of changes call validate and fix every error before continuing; 4) call describe_room before placing items by hand and use anchors instead of coordinates; 5) never invent product ids: use search_catalog, and verify_product for anything not found; 6) call history with op checkpoint before a large batch; 7) when a viewer is connected, render overhead after furnishing a room and look for blocked doors and crowded walls; 8) finish with get_bom and report unverified lines.

## 11. Ledger coverage for this spec

- Envelope and errors: `_warnings` and disambiguation become tests:
  unknown argument warning,
  ambiguous catalog error with candidates, range errors with hints.
- Compass naming and anchors: R-060 and the "left is your left walking
  start to end" frame are internalised; tests assert compass labels for
  rectangular and rotated rooms.
- `render` unavailable without a viewer; `verify_product` unavailable
  without a search provider.
- Transcript replay: every tool call is recorded with arguments and result
  for cross-provider regression (ADR-007 D4).

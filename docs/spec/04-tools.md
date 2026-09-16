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
Description: "Place a product or recipe. Either give x, y, or give roomId plus an anchor: 'center', 'against-north-wall' (also south/east/west), 'north-east-corner' (and the other corners), 'along-wall:<wallId>@<mm>', or 'on:<itemId>' to stack on another item. Anchors set rotation for you. Returns the final position after snapping and any warnings about overlaps or blocked door swings."
Input: `{ productId?: string, recipe?: PrimitiveRecipe, x?: number, y?: number, roomId?: string, anchor?: string, rotation?: number, elevation?: number, mount?: { kind, targetId?, height? }, tags?: string[] }`
Output: `{ item: ItemView, adjusted: boolean }`

### modify_item
Input: `{ itemId: string, x?, y?, rotation?, elevation?, size?: Size3 | null, parentId?: string | null, productId?: string, mirrored?: boolean, mount?, tags? }`
Output: `{ item: ItemView, descendants: ItemView[] }`

### arrange (tier: both)
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
Description: "Apply several commands atomically; if any fails, none apply. Use for a whole room's items. Max 50."
Input: `{ label?: string, commands: Command[] }`
Output: `{ applied: number, changed: ChangeSet }`

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
| low | `get_scene`, `describe_room`, `validate`, `render`, `search_catalog`, `create_room_from_brief`, `furnish_room`, `place_item` (anchor form only), `arrange`, `get_bom`, `history`, `batch`, `project`, `export` |

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

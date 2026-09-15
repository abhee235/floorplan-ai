# ADR-006: Two-tier tool surface for mixed-capability models; conventions for arguments, results, and errors

Status: Proposed
Date: 2026-09-14
Supersedes: section 5.4 (tool tiers) of the brainstorm
Related: ADR-004 (commands), ADR-005 (host), ADR-007 (providers), ADR-016 (room detection)

## Context

The shipped agent will run on local Qwen, OpenAI, or OpenRouter models, not
only on Claude. Models struggle with closing wall loops, reasoning about
camera angles, naming catalog items, and left-versus-right frames. Blender MCP
shows what happens when the only powerful tool is "run code". Our tools must
be few, flat, strict, and forgiving in exactly those places.

## Decision

### D1. Two tiers, one registry

- **Primitive tools** map one to one onto commands (ADR-004) and reads. They
  give precision when the model is strong.
- **Semantic tools** do a whole job in one call by composing commands inside
  one atomic transaction. They exist so a mid-sized model can furnish a room
  in three calls instead of thirty.

Both tiers are entries in the one in-process registry (`tools` package,
ADR-005 D1). The in-app agent calls them as functions; the optional MCP
adapter exposes the same entries to external agents. Tool descriptors for
primitive tools are generated from command payload schemas; semantic tools
have hand-written schemas in the same style. A tool is defined exactly once.

### D2. The surface, first release (23 tools)

| Group | Tool | Arguments (all lengths mm, angles degrees) |
|---|---|---|
| Inspect | `get_scene` | `detail: "summary" \| "full"`, `levelId?`, `types?: string[]`, `bbox?`, `cursor?` |
| | `describe_room` | `roomId` (returns walls named by compass side, openings, items, free wall lengths, clearances) |
| | `measure` | `fromId`, `toId` (or two points) |
| | `validate` | `levelId?` (returns problems with ids, codes, hints) |
| | `search_catalog` | `kind: "product" \| "recipe"`, `query`, `category?`, `limit` (max 20) |
| Render | `render` | `view: "plan" \| "overhead" \| "room" \| "eye"`, `focusId?`, `hideWalls?` (overhead returns four angles) |
| Structure | `create_walls` | `points: Point[]`, `closed: boolean`, `thickness?`, `height?`, `kind?` (auto-joins, snaps endpoints to existing free ends within 20 mm) |
| | `modify_wall` | `wallId`, partial fields |
| | `delete` | `ids: string[]` (any entity type; cascades per ADR-004) |
| | `add_opening` | `wallId`, `kind`, `position` as fraction or `atMm`, `width`, `height?`, `sill?`, `hingeSide?: "north"\|"south"\|"east"\|"west"`, `productId?` |
| | `create_room` | one of `polygon`, `rect {x, y, w, d}`, or `atPoint` (detect from walls, ADR-016); plus `name`, `purpose`, `capacity?` |
| | `modify_room` | `roomId`, partial fields |
| Items | `place_item` | `productId` or `recipe`, and either `x, y` or `roomId` plus `anchor` (`center`, `against-north-wall`, `north-east-corner`, `along-wall:<wallId>`, `on:<itemId>`), `rotation?`, `elevation?`, `mount?` |
| | `modify_item` | `itemId`, partial fields including `parentId` |
| | `arrange` | `roomId` or `zoneId`, `pattern: "grid" \| "rows" \| "u-shape" \| "boardroom" \| "classroom" \| "bench"`, `productId`, `count`, `spacing?`, `facing?` |
| Semantic | `create_room_from_brief` | `brief: string`, `levelId?`, `origin?` (parses size, seats, purpose, AV needs; creates walls, room, openings) |
| | `furnish_room` | `roomId`, `recipe: string`, `preferences?` (applies a room recipe from the rules pack; verifies products as needed) |
| Catalog and BOM | `verify_product` | `make`, `model`, `category?` (ADR-008 pipeline; returns status and productId) |
| | `get_bom` | `scope: "project" \| "level:<id>" \| "room:<id>"`, `includeUnverified?` |
| History | `history` | `op: "checkpoint" \| "undo" \| "redo" \| "list" \| "restore"`, `label?`, `checkpointId?` |
| | `batch` | `commands: Command[]` (max 50, atomic) |
| Session | `project` | `op: "open" \| "save" \| "new" \| "info"`, `path?` |
| Export | `export` | `format: "csv" \| "xlsx" \| "glb" \| "pdf" \| "dxf"`, `scope?`, `path` |

`import_plan` (ADR-011) joins in phase 2. Tools needing an unconfigured
service (`verify_product` without a search provider, `render` without a
viewer) are still listed but return a clear "unavailable because" error, so
the model does not hallucinate them and the workflow prompt can say why.

### D3. Argument conventions

- Flat objects. No nesting deeper than one level except `points` arrays.
- Every field description states its unit and gives one worked example
  (`"height in mm, e.g. 2700"`). Enumerations are closed and listed.
- Ids only for references; never names or indices. Product references by
  `productId` from `search_catalog` or `verify_product`.
- Compass words replace start-end and left-right frames wherever a model
  must reason spatially: `describe_room` names walls north, south, east,
  west (by outward normal, +y is north per ADR-001); `add_opening.hingeSide`
  and `place_item.anchor` use the same words. Start-end semantics stay
  internal.
- Unknown arguments do not fail the call; they are reported in `warnings`.

### D4. Result conventions

Every tool returns one envelope:

```
{ ok: true, result, warnings: string[], problems: Problem[], changed: { added, updated, removed } }
{ ok: false, error: { code, message, entityId?, hint? }, warnings: string[] }
```

- Mutations echo the resolved geometry and bounding box of what they created
  or changed, plus derived numbers a model would otherwise compute (wall
  lengths, room area, free wall segments).
- `problems` after any mutation is the validation state, so a model sees
  consequences immediately.
- `get_scene` with `detail: "summary"` returns counts, level list, rooms with
  names, purposes, areas and item counts, and the project bounding box, in
  under 2 KB. `"full"` returns entities paginated by `cursor`, 100 per page,
  with `truncated` set when more remain.
- Ambiguous catalog lookups return every candidate with `productId`,
  category, and dimensions in one error so the retry is one call.
- Error messages state the field, the valid range, and the value received,
  and where obvious a `hint` containing a corrected call.

### D5. Workflow prompt

The server exposes one MCP prompt, `floorplan_workflow`, stating: read
`get_scene` summary first; structure before rooms before items; call
`validate` after each group of changes and fix problems before continuing;
prefer semantic tools, use primitives for corrections; use `describe_room`
before placing items; `render` overhead after furnishing; never guess a
product, use `search_catalog` or `verify_product`; use `history` checkpoint
before large batches. Guidance also rides on results: a `place_item` that
lands within 600 mm of a door swing returns a warning saying so.

### D6. Tool tiers by model profile

The agent runner (ADR-007) reads a capability profile per provider. Profiles
with `toolReliability: "low"` are offered semantic tools plus `get_scene`,
`describe_room`, `validate`, `render`, `history`, `batch`, and `place_item`
with anchors only; primitives remain callable but are not advertised. This
keeps the schema token cost and the failure surface small for weak models.

## Alternatives considered

- **A code-execution tool.** Rejected as the primary path: a model given
  only "run code" writes code instead of using the scene. May appear later as a sandboxed `evaluate`
  for power users, off by default.
- **Separate list tools per catalog kind.** Merged into `search_catalog`.
- **Non-atomic batch with auto-checkpoint.** Rejected; batch
  inherits transaction atomicity from ADR-004.
- **Absolute-only placement.** Rejected; room-relative anchors are the
  single biggest win for small models.

## Consequences

- `describe_room` and `place_item` anchors need room geometry helpers in
  `ir` (wall side classification by outward normal, free segments, corners).
- The tool registry must support advertising a subset per session.
- Every tool description is a prompt and is reviewed like one; a
  `tools.md` generated from the registry is checked into `docs/spec`.
- Transcripts of tool calls are recorded per session for replay tests
  across providers (ADR-007).

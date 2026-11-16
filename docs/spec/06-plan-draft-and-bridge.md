# Spec 06: PlanDraft contract and viewer bridge protocol

Status: Draft
Date: 2026-09-14
Implements: ADR-005 D4, ADR-011
Packages: `packages/importers`, `packages/agents`, `apps/host`, `apps/web`

## Part A. PlanDraft

### A1. Schema

```ts
export const DraftUnits = z.enum(["mm", "cm", "m", "in", "ft", "unknown"]);

export const DraftWall = z.object({
  idx: z.number().int(),                 // draft-local index for cross references
  points: z.array(z.object({ x: z.number(), y: z.number() })).min(2),   // centreline polyline in draft units, y up
  thickness: z.number().positive().nullable(),
  kind: WallKind.nullable(),
  confidence: Fraction,
  sourceRef: z.string().nullable(),      // DXF handle, PDF path index, or image region
});

export const DraftOpening = z.object({
  idx: z.number().int(),
  wallIdx: z.number().int().nullable(),
  at: z.object({ x: z.number(), y: z.number() }),   // centre in draft units
  kind: OpeningKind,
  width: z.number().positive().nullable(),
  height: z.number().positive().nullable(),
  hinge: z.enum(["start", "end"]).nullable(),       // the wall end nearer the hinge jamb, relative to the draft wall's direction
  swing: z.enum(["left", "right"]).nullable(),       // the side the leaf opens to, looking along the draft wall
  confidence: Fraction,
});

export const DraftRoom = z.object({
  idx: z.number().int(),
  polygon: z.array(z.object({ x: z.number(), y: z.number() })).min(3).nullable(),
  labelAt: z.object({ x: z.number(), y: z.number() }).nullable(),
  name: z.string().nullable(),
  purpose: RoomPurpose.nullable(),
  capacity: z.number().int().nullable(),
  confidence: Fraction,
});

export const DraftText = z.object({ at: z.object({ x: z.number(), y: z.number() }), text: z.string(), kind: z.enum(["room-name", "dimension", "scale", "other"]) });

export const PlanDraft = z.object({
  source: z.object({ kind: z.enum(["dxf", "pdf-vector", "pdf-raster", "image", "sketch", "brief"]), file: z.string().nullable(), page: z.number().int().nullable(), pixelSize: z.object({ w: z.number(), h: z.number() }).nullable() }),
  units: z.object({
    detected: DraftUnits,
    mmPerUnit: z.number().positive().nullable(),   // scale to millimetres; null until confirmed
    scaleSource: z.enum(["dimension-text", "scale-bar", "header", "user", "guess"]),
    checks: z.array(z.object({ text: z.string(), measuredUnits: z.number(), impliedMmPerUnit: z.number() })),
  }),
  levelName: z.string().nullable(),
  walls: z.array(DraftWall),
  openings: z.array(DraftOpening),
  rooms: z.array(DraftRoom),
  texts: z.array(DraftText),
  confidence: Fraction,
  questions: z.array(z.object({ id: z.string(), text: z.string(), kind: z.enum(["scale", "dimension", "ambiguity", "missing"]), answer: z.string().nullable() })),
  reader: z.object({ providerId: z.string(), model: z.string(), promptVersion: z.string() }).nullable(),
});
```

Raster readers emit coordinates in a normalised box 0 to 1000 on the long
side with `detected: "unknown"`; `pixelSize` lets the app overlay the draft.

### A2. Commit rules

`commitDraft(draft, levelId, ctx): Command[]` produces one transaction:

1. Refuse unless `units.mmPerUnit` is set and `scaleSource` is `user`, or
   `dimension-text` with at least two `checks` within 2 percent of each
   other (ADR-011 D3).
2. Convert every coordinate to integer millimetres, rounding to the nearest
   millimetre; no y flip is needed because drafts are y up; raster readers
   flip once when producing the draft.
3. Clean-up (raster and sketch only): orthogonalise segments within 5
   degrees of an axis; merge collinear consecutive segments; snap endpoints
   within 1 percent of the image diagonal; drop walls shorter than 100 mm.
4. Emit `wall.createChain` per wall polyline, then `wall.join` for endpoints
   within 20 mm that the chain snapping did not catch.
5. Emit `opening.add` for each opening whose `at` lies within 100 mm of a
   created wall centreline; others become questions of kind `missing`.
6. Emit `room.create` with the draft polygon when present, else
   `room.create` with `atPoint = labelAt` for detection; name and purpose
   from the draft; unmatched labels become annotations of kind `label`.
7. Emit `project.setProvenance` with source, reader, confidence, and the
   remaining questions.

Implementation (P2-3, `packages/tools/src/import.ts` `commitDraft`,
amended 2026-09-15):

- Rule 1 is `scaleStatus` in `packages/importers/src/review.ts`, shared by the
  tool and the app's review panel.
- Rule 4: draft walls whose ends lie within 20 mm are first moved to one
  point. Where exactly two ends meet and the walls share thickness (within
  1 mm) and kind, the walls become one chain, closed when it loops; each chain
  is one `wall.createChain` with `snapMm` 20. Remaining free ends within
  20 mm are joined, preferring a wall of the same thickness; joins the command
  refuses (parallel, not collinear) are not made. Curved draft walls become a
  chain of straight segments.
- Rule 5: an opening goes to the nearest imported straight wall within 100 mm,
  preferring the wall made from its own `wallIdx`; `atMm` is its projection.
  A door's `hinge` and `swing` are flipped when the created wall runs
  against the draft wall. Openings the command refuses (overlap, off the
  wall) are skipped and reported.
- Rule 6 (P2-4, amended 2026-09-16): a room with an outline is created
  from it. Every other room comes from the enclosures of the level's walls
  (spec 05 section 4) with a gap tolerance of 20 mm for CAD drafts and
  100 mm for raster and sketch drafts, settable on `import_plan`. Each
  enclosure not covered by an outlined room becomes one detected room,
  named, with purpose and capacity, by the label nearest its pole of
  inaccessibility; the purpose falls back to the first label in the space
  that has one. Other labels in the same enclosure become label annotations
  and a note that walls between them may be missing. Enclosures with no
  label and at least 1.5 m² become unnamed rooms. Labels in no enclosure
  become label annotations and are reported as not enclosed.
- Rule 7: `reader` is `provider:model:promptVersion` for model readers and
  `<source kind>:deterministic` otherwise; `questions` lists unanswered
  questions and every skipped entity.
- A failed `wall.createChain` or provenance command rolls the whole
  transaction back; nothing is half imported.

Raster implementation (P2-2, 2026-09-16): `packages/importers/src/raster.ts`
reads image sizes from PNG, JPEG, GIF, WebP and BMP headers without decoding.
The model replies with coordinates of 0 to 1000 on each axis of the image, y
downward (the grounding convention vision models are trained on; an
aspect-correct box was tried first and the model ignored it), scaled on
reading to the long-side box of A1, with walls as centreline
segments, openings at their gap centres, room labels with a point, dimension
strings with the two points they measure, an optional scale bar and notes
(`RasterReply`). `rasterReplyToDraft` flips y once and applies rule 3 when
the image is read, not at commit, so the review shows the cleaned geometry:
segments within 5 degrees of an axis are made axis-aligned; collinear axis
segments merge when they touch within 1 percent of the image diagonal or an
opening lies in the gap; endpoints within 1 percent meet, and free ends reach a
wall within 1 percent; walls shorter than 0.5 percent of the diagonal are
dropped (the millimetre threshold needs a scale the draft does not have yet);
openings attach to the nearest wall within half its thickness plus 1.5 percent.
Room outlines from the model are not used (they are several percent off);
rooms keep their label point and are detected from the walls when the draft is
committed (rule 6). Two dimension strings agreeing within 2 percent set `dimension-text` as a
suggestion only: a scale read from an image is never confirmed without a
person (amended 2026-09-16, after qwen3.6 read two agreeing dimensions whose
end points put the scale 10 percent off); `scaleStatus` refuses image,
raster PDF and sketch drafts unless the source is `user`, and the draft always
asks the scale question. One
string or a scale bar sets a scale that still needs confirming; with neither,
`mmPerUnit` stays null. Model notes become `ambiguity` questions. The
`planReader` role in `packages/agents` sends the image as a data URL and
retries invalid JSON three times. When the image's pixels are available (PNG,
decoded by `decodePngGray` in the importers package with inflate supplied by
the host), `refineRasterDraft` corrects the model's positions, which are
roughly 3 to 5 percent of the image off: for each axis-aligned wall it searches
4 percent of the image plus one wall thickness for ink, ranks a pair of face
lines or a solid band above a single thin line, favours candidates that are
well inked, near the model's position and bridged by ink at both ends (the
walls they meet, which a dimension line beside a wall is not), snaps the
centreline and thickness to it, lets wall ends follow the drawn lines and join
the perpendicular wall they meet, and drops short walls with no ink. Evidence
must include one unbroken ink run over 20 percent of the wall, so text and
hatching strokes do not count. Where a wall's face lines resume within 12
percent of the image past its end and the model reported nothing there, the
missing piece is added, clipped at the next reported wall on that line.
Collinear pieces across a gap of up to 12 percent become one wall, with a
passage recorded when the gap is at least one wall thickness and the model put
no opening there. When 70 percent or more of the model's walls are confirmed,
unconfirmed walls of any length are dropped; otherwise only short ones are. JPEG and
other formats are read without refinement. The host picks the model from
`roles.reader` or `FPV_READER_*`.

### A3. Reader prompt contract

System prompt version `reader-v1` asks for exactly the PlanDraft JSON with
these conventions: walls as centrelines, thickness estimated from the
drawing, openings with the wall they cut, rooms as closed polygons where
visible else a label point, texts classified, and a `questions` list that
always includes a `scale` question unless a scale bar or dimension text was
read. The reply is parsed by zod and retried up to three times with the
validation error.

### A4. Quality metrics

Per fixture plan: wall recall and precision by centreline overlap within
150 mm, opening recall within 300 mm, room recall by label match and area
within 10 percent, scale error percent. Reported per provider in
`docs/eval`.

Implementation (P2-1, `packages/importers/src/metrics.ts` `scoreDraft`):
coordinates are converted with the draft's own `mmPerUnit`; a wall sample
every 50 mm counts as covered when a draft segment within 15 degrees lies
within 150 mm; an expected `passage` matches any opening kind, a door or
window only its own kind; room area is compared only when the expectation
has an outline. Fixture plans and their `*.expected.json` files live in
`tools/fixtures/plans` and are regenerated by
`tools/build-plan-fixtures.ts`.

Real drawings (2026-09-16): `tools/fixtures/plans-real` holds DXF plans made
by other people, each with its licence in `SOURCES.md` and a
`<name>.expected.json` of hand counts taken from the drawing: millimetres per
unit, the layers that hold the walls, door and window counts (null when the
drawing does not allow an honest count), and room names as written. They are
not labelled wall by wall. `scoreRealPlan` measures wall face coverage, the
share of the drawing's own wall-layer line work lying within half a draft
wall's thickness plus 30 mm of its centreline and within 10 degrees of it;
scale error; door and window recall by count; and room recall by name.
`tools/score-plans.ts` prints one table for the generated and real plans, and
`tools/fixtures/plans-real/baseline.json` records a floor per plan that
`tools/test/score-plans.test.ts` enforces. A floor is raised when the reader
improves and never lowered without a reason in the commit.

### A5. DXF reader (P2-1)

`dxfToDraft(text, { file })` returns `{ draft, report }`. It is pure and
deterministic; no model is involved.

1. **Parsing.** ASCII DXF only; binary DXF is refused with a message.
   Read: header `$ACADVER`, `$INSUNITS`, `$MEASUREMENT`; layers with
   frozen and off flags; blocks; LINE, ARC, CIRCLE, LWPOLYLINE, POLYLINE with
   VERTEX, TEXT, MTEXT, INSERT, DIMENSION. Other entity types are counted in
   `report.skipped`. TEXT control codes and MTEXT formatting are removed. An
   extrusion of (0, 0, -1) mirrors x.
2. **Flattening.** Inserts are replaced by their block's entities in world
   coordinates (base point, scale, rotation, mirroring, nesting up to 8
   levels). Entities on layer 0 inside a block take the insert's layer.
   Missing or self-referencing blocks become warnings. Frozen and off
   layers are ignored.
3. **Layer roles.** From the words of the layer name: wall, door, window,
   room, text, dimension, furniture, ignore, unknown (English, French,
   German and Spanish words). A final qualifier such as `IDEN`, `NAME` or
   `TEXT` makes the layer a text layer (`A-AREA-IDEN`). A block name with
   door or window words overrides the layer role. When no layer is a wall
   layer, unknown layers are read as walls and an `ambiguity` question asks
   which layers hold the walls.
4. **Scale.** Dimension text overrides (not `<>`) are parsed as lengths
   (`3600`, `3.60` as metres, `360 cm`, `12'-6"`) and compared with the
   measured distance. Two or more checks within 2 percent give
   `dimension-text`; a disagreeing header becomes a `scale` question.
   Otherwise the header unit is used with a `scale` question; with neither,
   the unit that makes the drawing 5 m to 200 m across is guessed with a
   `scale` question. All thresholds below are in millimetres converted with
   that scale.
5. **Walls.** Lines and polyline edges on wall layers pair when parallel
   within 1.5 degrees, 40 to 700 mm apart and overlapping at least 150 mm;
   closest pairs first, and each stretch of a line is used once. A
   polyline with a constant width of 40 to 700 mm is a centreline. Concentric
   arcs 40 to 700 mm apart become a curved wall. Collinear pieces within a
   quarter thickness and a thickness ratio of 0.7 to 1.43 merge; gaps up to
   450 mm are bridged (junctions) and gaps up to 2600 mm are kept as
   opening candidates. Ends are extended to another wall's centreline within
   0.75 of the thicker wall. Kind: 200 mm or more exterior, 110 mm or less
   partition, else interior.
6. **Openings.** Door arcs of radius 400 to 1500 mm centred within half a
   thickness plus 150 mm of a wall; the opening spans the matching gap, or
   the hinge to the latch end, with the hinge side recorded. Door and window
   blocks without a usable arc span their extent along the nearest wall.
   Window-layer lines lying in a wall, 300 mm or longer, are windows. Gaps
   of 600 to 2600 mm with no symbol are passages at confidence 0.5. One
   opening is kept within 300 mm on the same wall, the most confident.
7. **Rooms and texts.** Closed polylines on room layers larger than 1 m²
   are room outlines named by the label inside nearest the centre. Labels on
   room or text layers without an outline become rooms with `polygon: null`
   and `labelAt` for detection at commit. Purpose comes from name words and
   capacity from `12 PAX`, `8 seats` or `(20)`. Texts are classified as
   room-name, dimension, scale or other; texts inside blocks are not read.
8. **Report.** Layers with role, entity counts and frozen flag; skipped
   entity types; warnings; the layers read as walls.

Amended 2026-09-16 after the real-drawing diagnostics: gaps up to 3600 mm
stay inside a wall and may be passages; door swings of 400 to 2100 mm are
read; straight lines on door or window layers lying in a wall gap classify
it, as a window when two or more run along 80 percent of the gap and as a
sliding door when leaves of 30 to 70 percent each together cover 90 percent;
a room-name text directly over another of the same height, 1.1 to 2.2
heights higher and within one height sideways, is joined with it into one
name of at most four words. Wall face coverage leaves out source lines
shorter than 400 mm (end caps and jambs).

### A6. Vector PDF reader (P2-7)

The host (`apps/host/src/pdf.ts`) reads the bytes with pdfjs-dist, one page
or up to 50 pages, and hands each page's operator list to
`interpretPdfOperators` and its text runs to the importers package; no worker
thread or service is involved. `readPlanPdf(fileName, pages, page?)` reads the
requested page, or the one with the most line work, and refuses a page with
fewer than 20 path segments (`import.unsupported`, with a hint to import a
scanned page as an image). `pdfPageToDraft` then:

1. **Paths.** Transforms, save and restore, form XObjects, line width (scaled
   by the transform), dash and colour are tracked; only stroked or filled
   paths are kept. White fills and fills covering a quarter of the sheet are
   dropped.
2. **Groups as layers.** Strokes group by width (to 0.01 pt) and colour
   (`pdf-stroke-0.70-000000`), fills by colour, dashed strokes go to
   `pdf-dashed` (ignored).
3. **Arcs.** A cubic whose control points sit on the end tangents at
   4/3 tan(sweep/4) of a common radius (2 percent) and whose midpoint lies on
   the circle is an arc of at most 100 degrees; consecutive pieces of one
   circle merge, full circles are dropped. Arcs go to `pdf-arcs` (door role).
   Other curves are flattened to eight lines.
4. **Text.** Runs on one baseline join; a short line with digits 1.0 to 1.8
   heights under a label becomes its second line. Length labels go to
   `pdf-dimensions` with the nearest parallel stroke line within three text
   heights (the dimension line); other labels to `pdf-text`. A note matching
   `1:N` states N x 25.4 / 72 mm per point.
5. **Walls.** A group is wall-like when at least half of its length has a
   parallel overlapping partner 0.3 to 72 pt away and it holds at least 5
   percent of the largest group's length. Wall layers are the wall-like stroke
   groups at least 0.75 of the heaviest wall-like width, and dark wall-like
   fills. Other groups get the window role; with no wall-like group every
   group is unknown and the reader asks which lines are walls.
6. **Interpretation.** `documentToDraft` runs the DXF pass with those roles,
   the sheet note as the stated units, and paper scales 1:1 to 1:5000 as the
   candidates when nothing states the scale. The draft is in page points with
   `source.kind` `pdf-vector` and the page number; its scale is confirmed by
   two agreeing dimension labels as for DXF.

`tools/fixtures/plans/office-mm.pdf` is the office plan printed at 1:100 by
`tools/build-plan-fixtures.ts`, with `office-mm.pdf.expected.json` in sheet
millimetres at full size; `apps/host/test/pdf.test.ts` holds it to the DXF
fixture metrics and imports it end to end.

## Part B. Viewer bridge

### B1. Transport

WebSocket at `ws://127.0.0.1:<port>/bridge`, one JSON message per text
frame, UTF-8. `protocolVersion` 1. Both sides close with code 4000 and a
reason on version mismatch.

### B2. Messages

```ts
// client -> host
Hello        = { id, type: "hello", clientVersion: string, capabilities: ("render" | "plan")[] }
CommandMsg   = { id, type: "command", command: Command }
TransactionMsg = { id, type: "transaction", label: string, commands: Command[] }
UndoMsg      = { id, type: "undo" } ; RedoMsg = { id, type: "redo" }
GetMsg       = { id, type: "get", what: "snapshot" | "history" | "selection" | "problems" | "textures" }   // textures: { textures: { id, name, widthMm, heightMm, tags }[] } (P3-5)
SelectMsg    = { id, type: "select", ids: string[] }
RenderResult = { id, type: "render.result", requestId: string, images: [{ view: string, pngBase64: string, width, height }] }
ToolMsg      = { id, type: "tool", name: string, args: object }        // the in-app UI may call registry tools too
AgentMsg     = { id, type: "agent", op: "start" | "cancel", brief?: string, roomId?: string }

// host -> client
Welcome      = { id, type: "welcome", hostVersion, protocolVersion: 1, projectId, path }
ResultMsg    = { id, type: "result", ok: boolean, result?: unknown, error?: { code, message, hint } }
Snapshot     = { type: "snapshot", project: Project, historyPosition: number, savedPosition: number }
Changes      = { type: "changes", changeSet: ChangeSet, historyPosition: number, origin: "agent" | "editor" | "import" | "undo" | "redo" | "restore", patches: Patch[] }
Problems     = { type: "problems", problems: Problem[] }
RenderRequest = { type: "render.request", requestId: string, views: [{ name, camera?: object }], hideWalls: boolean, focusId: string | null, width: number }
SelectionMsg = { type: "selection", ids: string[] }
AgentEvent   = { type: "agent.event", event: "step" | "tool" | "message" | "done" | "error", payload: object }
Draft        = { type: "draft", draftId: string | null, draft: PlanDraft | null, preview: { segments: [x1, y1, x2, y2][], truncated: boolean } | null, warnings: string[] }
Progress     = { type: "progress", requestId: string, percent: number, text: string }
```

### B3. Rules

- The host replies to every message that carries an `id` with exactly one
  `result`. Unsolicited messages have no `id`.
- After `hello`, the host sends `welcome` then `snapshot`.
- `changes` carries Immer patches so a replica applies them without
  re-fetching; a replica whose `historyPosition` falls out of sync requests
  `get snapshot`.
- The replica may apply a gesture's commands optimistically to its local
  copy; on `result` with `ok: false` it reverts to the last confirmed state
  and shows the error.
- Only clients with capability `render` receive `render.request`. The host
  picks the first connected renderer and times out after 30 s.
- `draft` is broadcast when `import_plan` reviews a draft and again with
  `draftId: null` when it commits. A client that says `hello` while a
  review is open receives the open `draft` after `selection`. The preview is
  the source line work in draft units, at most 20 000 segments.
- Selection is shared through `select` and `selection` so an agent's
  `describe_room` can highlight the room it inspected.

### B4. Session discovery file

`.fpviz/session.json`: `{ pid, port, startedAt, projectPath, protocolVersion }`.
Removed on close; considered stale when `pid` is not alive.

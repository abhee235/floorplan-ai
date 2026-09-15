# Floorplan-Viz: Product Requirements

Status: Draft
Date: 2026-09-15
Inputs: 00-brainstorm.md, the edge-case ledger, adr/, spec/

## 1. Product statement

Floorplan-Viz turns a floor plan, or just a written brief, into an editable
3D model of an office and a bill of materials that an estimator can cost.
It is built for meeting and business spaces: boardrooms, huddle rooms,
training rooms, open-plan desking, reception, cafeteria. It runs on a laptop
without a graphics card, keeps every project as files, and can be driven by
a person in the app, by an agent inside the app, or by an external agent
such as Claude Code during development.

## 2. Users and jobs

| User | Job to be done | Success looks like |
|---|---|---|
| Pre-sales estimator (primary) | Turn a customer's plan or brief into a priced bill of materials with a picture to back it | A BOM in a spreadsheet with every line traceable and every product verified, in under an hour for a typical office |
| AV designer | Lay out rooms to standards: display size, mic and speaker coverage, camera field of view, clearances | Warnings when a layout breaks a design rule; recipes that produce a compliant room from capacity and size |
| Installer or integrator | Know where things go and at what height | A plan drawing with positions, mount heights and cable runs |
| Developer of the product | Drive and test the engine through tools | Claude Code can build a room end to end through the tool registry with no browser open |

## 3. Non-goals

- Home decor and residential design.
- Photorealistic rendering, ray tracing, or interior visualisation quality.
- Structural, MEP or code-compliance modelling beyond room and clearance
  checks.
- Parsing DWG directly; editing existing BIM models.
- Multi-user editing of one project at the same time (until phase 4).
- Any component deployed as a separate service; the product is one process.

## 4. Principles that bind requirements

From the brainstorm and ADRs: the Scene IR is the only state; agents produce
IR through tools, never geometry; every BOM line is traceable; unverified
products are visible, never silent; units are millimetres and degrees; the
product deploys as one unit; no copyleft code enters the repository.

## 5. Requirements by phase

Each requirement has an id, a statement, and its acceptance test. "Must"
requirements gate the phase.

### Phase 0: Foundation (developer-facing)

Outcome: Claude Code, through the tool registry, builds a room with walls,
a door, a table and chairs, and a viewer shows it.

| Id | Requirement | Acceptance |
|---|---|---|
| P0-1 must | Monorepo scaffold per ADR-002 with boundary lint and ledger coverage script | `pnpm lint`, `pnpm test`, `pnpm ledger:coverage` run green on an empty ledger map |
| P0-2 must | Scene IR package: schema, validation, normalisation, derive, serialise | spec 01 tests; six-wall fixture round-trips byte-identical |
| P0-3 must | Geometry package: footprints, symmetric joins, arcs, booleans, detection | spec 05 sections 2 and 4 tests; ledger W and R ranges marked adopt for geometry |
| P0-4 must | Engine: walls with openings, rooms, primitive recipes, invalidation table | spec 05 sections 3 and 7 tests; a wall change rebuilds exactly the set in the table |
| P0-5 must | Command layer with transactions, undo, redo, checkpoints | spec 03 tests; drag-like transaction records one entry; failed batch applies nothing |
| P0-6 must | Tool registry with the primitive and inspect tools, MCP adapter over stdio | Claude Code lists the tools and builds the fixture room by calls alone |
| P0-7 must | Viewer: three.js binding with dirty set; plan canvas with structure layer; bridge client | Editing through Claude Code updates an open browser tab within one frame of the change message |
| P0-8 should | Project file save and open with recovery | spec 01 section 8 and ADR-012 tests; kill the host mid-edit and recover |
| P0-9 should | `render` tool through the viewer, four-angle overhead | Images return to Claude Code; error message without a viewer |

### Phase 1: Brief to a furnished room with a verified BOM

Outcome: "10-seat boardroom, 8 by 5 metres, video conferencing" becomes a
3D room with table, chairs, display, video bar, ceiling mics and speakers,
scheduler, and a CSV BOM whose lines are verified or clearly flagged.

| Id | Requirement | Acceptance |
|---|---|---|
| P1-1 must | Catalog store with seed products and primitive recipes; `search_catalog` | spec 02 tests; search returns at most 20 with disambiguation |
| P1-2 must | Product verification pipeline with a configurable search provider | `verify_product` on three known displays returns verified with dimensions within 2 percent of the spec sheet and a source URL; an invented model returns rejected |
| P1-3 must | Rules pack with the nine core BOM rules and design rules | spec 07 tests; boardroom fixture BOM equals the golden CSV |
| P1-4 must | Room recipes for boardroom, huddle, training; `furnish_room`; `create_room_from_brief` | The task card above yields zero validation errors, all recipe items placed, display on the wall opposite the door, mics and speakers by area |
| P1-5 must | `get_bom` and CSV, XLSX export with verification status and provenance | Export refuses on validation errors unless forced; unverified lines highlighted |
| P1-6 must | Placement pipeline and room anchors | spec 05 section 5 tests; an item placed against the north wall touches the wall face with its back and does not block the door swing |
| P1-7 should | Agent runner in the host with one configured provider; transcripts recorded | The task card runs end to end on a configured OpenAI-compatible model with fewer than 40 steps |
| P1-8 should | Evaluation harness with the boardroom task card | `docs/eval` table produced for at least two providers |

Deferred on 2026-09-15: P1-7 and P1-8 move to after phase 2 and before phase
4. Development drives the tools through Claude Code over MCP, nothing in phase
2 depends on the agent loop (the raster reader uses the provider and JSON
retry layer built for P1-2), and the evaluation harness is more useful once it
can score plan-import tasks as well as the boardroom card. Until then the
phase 1 metrics for a local model are not measured.

Picked up on 2026-09-16 after phase 2: the runner, the `host --agent` command
and the evaluation harness are in place (ADR-007 implementation note); results
per card and model are in `docs/eval/agent-runs.md`.

### Phase 2: Plan reading and exports

Outcome: a DXF or a raster image becomes walls, openings and rooms after a
scale confirmation and a review; the scene exports to glTF.

| Id | Requirement | Acceptance |
|---|---|---|
| P2-1 must | DXF importer to PlanDraft | Three fixture DXFs reach wall recall 0.9 and opening recall 0.8 per spec 06 A4 |
| P2-2 must | Raster reader with a vision provider to PlanDraft, with clean-up | Two fixture images reach wall recall 0.8 after scale confirmation |
| P2-3 must | Draft review in the app with scale overlay; `import_plan` tool | No draft commits without a confirmed scale |
| P2-4 must | Room detection with gap tolerance on imported plans | Every enclosed room in the fixtures is detected with the expected purpose from labels |
| P2-5 must | glTF export from engine buffers | The exported file opens in a standard viewer with one node per entity |
| P2-6 should | Reveals for non-rectangular openings; ground slab | spec 05 reveal tests |
| P2-7 should | PDF vector importer | One fixture PDF reaches the DXF metrics |

### Phase 3: Editor

Outcome: a person can draw and edit a whole floor without an agent, and
export a layout drawing.

| Id | Requirement | Acceptance |
|---|---|---|
| P3-1 must | Wall drawing with chaining, snapping, magnetism; wall handles | ledger W-067..W-091 tests adopted in the app |
| P3-2 must | Room drawing and vertex editing; double-click detection | ledger R-041..R-060 |
| P3-3 must | Item drag, rotate, resize, elevation, duplicate, align, distribute with the placement pipeline | ledger F-100..F-118, F-145..F-170 |
| P3-4 must | Selection, hit testing, multi-level ghosting, undo in the UI | ledger F-130..F-144 |
| P3-5 must | Catalog browser, product properties, finishes and per-part materials | Changing a chair's fabric slot updates the 3D view only for that item |
| P3-6 must | Open-plan desk clusters via `arrange` with regenerable zones | 200 desks arranged in under a second; plan and 3D stay responsive |
| P3-7 must | Layout drawing export to PDF and DXF with mount heights | Drawing matches the plan view primitives |
| P3-8 should | Library install and user model or texture import | spec 02 section 4 and ADR-010 D10 |
| P3-9 should | Keyboard entry of lengths and angles while drawing | ledger W-072..W-076 |

### Phase 4: In-app agent and hosting

Outcome: the shipped product, with the agent inside the app on a local or
hosted model, deployable as one server.

| Id | Requirement | Acceptance |
|---|---|---|
| P4-1 must | In-app chat driving the agent runner with the tiered tool list | A medium-reliability profile completes the boardroom card; a low profile completes it with semantic tools only |
| P4-2 must | Hosted deployment of `apps/host` as one server with login and multiple projects | Smoke tests; the MCP adapter is off by default |
| P4-3 must | Hand sketch reading with mandatory dimension question | Fixture sketches reach wall recall 0.7 after answers |
| P4-4 should | IFC export scoped per ADR-013 | Opens in a BIM viewer with spaces and furniture placements |
| P4-5 should | Multi-project catalog sharing and library distribution | Import and export of the catalog as JSON |

## 6. Quality requirements

- Performance: a 500-desk floor with 60 rooms pans and zooms at 60 frames
  per second on integrated graphics; a single wall edit rebuilds in under
  16 ms; `get_scene` summary returns in under 50 ms.
- Determinism: same IR, catalog snapshot and rules pack give byte-identical
  exports except timestamps.
- Reliability: a failed command or tool call never leaves a partially
  applied change; a crash never loses more than 60 seconds of work.
- Privacy: plans and briefs go only to the configured provider; a local
  provider is offered by default for vision.
- Portability: Windows, macOS and Linux for the local tool; Node 22.
- Accessibility of the editor UI is a phase 3 requirement: keyboard
  operation of every command and readable contrast in light and dark.

## 7. Success measures

| Measure | Target by end of phase |
|---|---|
| Time from brief to reviewed BOM for a boardroom | under 10 minutes (phase 1) |
| Share of BOM lines verified on the boardroom card | above 80 percent (phase 1) |
| Wall recall on fixture DXFs and images | 0.9 and 0.8 (phase 2) |
| Ledger coverage for adopt, reverse, reject ids in the phase's packages | 100 percent at each phase gate |
| Agent steps to complete the boardroom card | under 40 on a high profile, under 25 with semantic tools (phase 4) |

## 8. Risks and mitigations

Carried from the brainstorm with status:

| Risk | Mitigation in place |
|---|---|
| Local models call tools unreliably | Tiered tools, anchors, validation loop, transcripts and evaluation table |
| Hallucinated products and prices | Verification pipeline, expiry, flagged lines, export refusal |
| Wrong scale on raster plans | Mandatory confirmation with overlay |
| Geometry edge cases | 780-line ledger as tests before code |
| Scope creep | Phase gates with must requirements |
| Licence exposure | No copyleft code; CC-BY and CC0 assets from original authors with a manifest |

## 9. Open questions for the owner

Unchanged from the brainstorm and still open: pricing currency and typical
vendors; existing written AV design rules; partition walls as BOM lines;
list versus negotiated prices; which local vision model and hardware;
labour and commissioning lines. The first four are needed before the
phase 1 rules pack is finalised; the rest can wait.

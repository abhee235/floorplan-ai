# Floorplan-AI: Brainstorm

Status: brainstorm complete, feeds ADRs (next step)
Date: 2026-09-14
Workflow: brainstorm -> ADRs -> spec -> PRD -> implementation

---

## 1. Problem statement

Given a floor plan in any form (architect CAD/PDF, raster image, screenshot,
hand sketch, or only a text brief), produce:

1. A complete, editable 3D model of the space: walls, doors, windows, rooms,
   and everything inside them. Meeting rooms with tables, chairs, displays,
   video bars, ceiling mics and speakers. Open office desk clusters.
   Cafeterias. Reception areas.
2. A bill of materials (BOM) for the whole build: every item, by make and
   model, with quantity, unit price and source, per room and for the whole
   project, including the invisible items (mounts, cables, connectors, DSPs,
   amplifiers, network ports).

Primary consumers are internal estimation and costing, plus exports to other
tools. The domain is meeting and business spaces.

## 2. What the previous attempt taught us

The earlier pipeline was OpenCV plus detection models (YOLO, a Meta
segmentation model) feeding three.js directly. It failed for reasons that are
structural, not tuning problems:

- **Pixels went straight to geometry.** Any detail the parser missed had
  nowhere to be corrected. A missed wall endpoint became a broken mesh with no
  intermediate place to fix it.
- **Detection models do not reason.** A scale bar, a room label, a door swing
  arc, a dashed line for a glass partition: each needs interpretation, not
  classification. Every new symbol meant retraining.
- **No semantic model existed.** There was nothing that said "this is a
  meeting room for 10 people", so furnishing and BOM had no foundation.
- **Blender was considered and rejected.** It gives a great MCP-driven
  workflow, but it is heavy, needs a GPU for a decent experience, and is not
  embeddable in a product. Blender may still be useful offline for asset
  preparation, never at runtime.

## 3. The core idea

The architecture rests on one idea: **a small 2D semantic model is the single
source of truth and the 3D view is a pure function of it.** Walls are line segments with thickness
and height. Rooms are polygons. Doors and windows are objects that cut
openings in the wall they belong to. Furniture is a catalog item placed at
(x, y, rotation, elevation) with real dimensions. Change the model and the 3D
regenerates.

We name this model the **Scene IR** (intermediate representation). Everything
in the system either produces the IR, edits the IR, or derives something from
it:

```
  inputs                    agents / tools               derived outputs
  ------                    --------------               ---------------
  DXF/DWG  --\                                          /--> 3D view (three.js)
  PDF       --+--> Plan Reader --\                      |--> 2D plan view
  image     --+                   +--> [ Scene IR ] <---+--> BOM (CSV/XLSX)
  sketch   --/                    |         ^          |--> GLB export
  text brief ----> Space Designer +         |          |--> DXF / PDF drawing
                                            |          \--> IFC (later)
  human editor (drag, drop, edit) ----------+
  MCP tools (Claude Code today, in-app agent later) ---+
```

Nothing ever writes three.js geometry directly. Not the agents, not the
editor, not the importers.

## 4. Design principles

- **P1. IR is the source of truth. 3D is derived.** No state lives in the
  three.js scene that is not in the IR.
- **P2. Agents produce IR, never geometry.** A vision model outputs walls and
  rooms in metres, not meshes. A design agent places catalog items, not boxes.
- **P3. Tools are few, flat, and strict.** The shipped agent will run on local
  Qwen, OpenAI, or OpenRouter, not only on Claude. Tool count around 15,
  arguments flat, enums explicit, every error message tells the model how to
  fix the call. If a tool is hard for a mid-sized model to call, it is
  designed wrong.
- **P4. Every BOM line is traceable.** Either to a placed item in the IR or to
  a named rule (for example "1 HDMI cable per display, length from wall run").
  No line item without a reason.
- **P5. Verified beats plausible.** A product enters the catalog only after
  its existence, dimensions and price are confirmed against a source URL. The
  LLM proposes, the verifier confirms, the catalog persists.
- **P6. Real-world units everywhere.** Metres and millimetres in the IR.
  Pixels and CAD units never leak past the Plan Reader.
- **P7. Local-first, no GPU.** Runs on a laptop with integrated graphics.
  Projects are files on disk. Hosting is a later phase.
- **P8. Human in the loop by design.** Every agent output carries confidence
  and a list of questions. Low-confidence results are shown, not hidden.

## 5. System concept

### 5.1 Scene IR (sketch, to be formalised in the spec)

```
Project
  meta: name, units (m), currency, created, schemaVersion
  catalogRefs: products referenced by this project (snapshotted)
  levels[]                       # floors of the building
    name, elevation, defaultCeilingHeight
    walls[]      id, start(x,y), end(x,y), thickness, height, kind(exterior|interior|partition|glass)
    openings[]   id, wallId, kind(door|window|passage), offsetAlongWall, width, height, sill, swing
    rooms[]      id, name, polygon[], purpose(meeting|open-office|cafeteria|reception|...), capacity, ceilingHeight, finishes
    items[]      id, productId | primitiveRecipe, position(x,y), rotation, elevation, roomId, mountedOn(wall|ceiling|floor|table|itemId), tags
    zones[]      id, polygon[], kind(desk-cluster|circulation|...)   # areas without walls
    annotations[] scale bar, north, notes from the Plan Reader
  provenance: source file, plan-reader confidence, questions for the human
  history: command log for undo/redo
```

Key modelling decisions to settle in ADRs:

- Walls as centreline segments with thickness, joined at shared endpoints.
  Wall geometry is built in 2D (offset, mitre, subtract openings with polygon
  booleans) and then extruded. Avoids 3D CSG entirely.
- Rooms are explicit polygons, not inferred from walls. The Plan Reader may
  propose them from walls; the human or agent confirms.
- Items reference a **product** (a verified catalog entry) or a **primitive
  recipe** (a parametric placeholder like `table(l, w, h)`). Both carry
  real-world dimensions so BOM and clearances work before nice 3D assets
  exist.
- A product maps to a 3D asset by **category and dimensions**, not by SKU.
  A Samsung 75" and an LG 75" share the same display mesh scaled to their
  actual dimensions. This keeps the asset library small.

### 5.2 Engine: IR to geometry

Pure functions, no side effects, unit-testable without a browser:

- `buildWalls(level)` -> wall meshes with openings cut
- `buildFloors(level)` -> room floor slabs and ceilings
- `buildItems(level, assets)` -> instanced meshes or primitives
- `validate(project)` -> geometric problems: overlapping items, items outside
  rooms, door swing blocked, clearance violations, display too small for room

Validation is what lets a weaker model self-correct: it calls a tool, gets a
list of concrete problems, fixes them.

### 5.3 Viewer and editor

- three.js for 3D. Decision pending in ADR: vanilla three.js with a thin
  state binding versus react-three-fiber. Either way the scene is rebuilt or
  patched from the IR, never edited in place.
- A 2D plan view (SVG or canvas) bound to the same IR. Drawing a wall in 2D
  updates the IR; the 3D view follows. This is the workflow users know.
- Editor operations are **commands** (AddWall, MoveItem, SetProduct...) with
  undo/redo from a command log. The MCP tools, the editor UI, and the in-app
  agent all emit the same commands. One code path.

### 5.4 MCP tool server

Node process exposing the command layer as MCP tools. Two transports:

- stdio for Claude Code during development
- streamable HTTP or WebSocket so the browser viewer can follow changes live
  and so the in-app agent (MCP client) can call the same tools

Two tiers of tools, because model capability varies:

- **Primitive tools**: `add_wall`, `add_opening`, `add_room`, `place_item`,
  `move_item`, `remove`, `set_product`, `get_scene`, `validate`,
  `screenshot`
- **Semantic tools**: `create_room_from_brief`, `furnish_room`,
  `arrange_desks`, `get_bom`, `verify_product`, `import_plan`

Semantic tools do more per call, so a local model can achieve a result in 3
calls instead of 30. Primitive tools give precision when the model is strong.

### 5.5 Agents

| Agent | Input | Output | Notes |
|---|---|---|---|
| Plan Reader | DXF/PDF/image/sketch | IR walls, openings, rooms, scale, confidence, questions | Vision LLM plus classical geometry snapping. DXF goes through a vector parser first. |
| Space Designer | Brief or unfurnished IR, rules pack | Furnished IR | Applies room recipes and layout rules. Calls `validate` and iterates. |
| Catalog Verifier | Proposed product (make, model) | Verified catalog entry with source URL, or rejection | Web search plus page read. Persists to local catalog. |
| BOM Composer | Furnished IR, BOM rules | BOM per room and total | Mostly deterministic. LLM only for edge reasoning. |
| Reviewer | IR, validation report | Fix list or approval | Optional. Second opinion before export. |

Agents are **not** separate services. They are prompt plus tool-set
configurations over the same provider interface. During development, Claude
Code plays every role by hand through MCP. That is how we discover which
tools and prompts actually work before writing the in-app agent.

### 5.6 Provider strategy

- Development and agent testing: Claude Code over MCP stdio.
- Shipped in-app agent: OpenAI-compatible chat completions with tool calling
  and image input. This covers OpenRouter, OpenAI, and local Qwen served by
  Ollama or vLLM. Vision for the Plan Reader on local hardware means a
  Qwen-VL class model.
- A thin provider interface: `complete(messages, tools, images) -> tool calls
  or text`. No provider-specific features in agent code. Structured output is
  enforced by our own JSON schema validation and retry, not by provider
  features that differ between vendors.

### 5.7 Catalog and BOM

Product entity (sketch):

```
Product
  id, make, model, category (display|video-bar|ceiling-mic|ceiling-speaker|
    table|chair|desk|amplifier|dsp|mount|cable|...), variant
  dimensions (w, d, h in mm), weight, mountType
  specs: category-specific (display diagonal, speaker coverage, ports)
  price: amount, currency, priceType(list|street|quote), sourceUrl, capturedAt
  verification: status(verified|unverified|rejected), sourceUrls[], verifiedAt, confidence
  assetKey: which 3D mesh or primitive recipe to render
  lifecycle: active|discontinued|unknown
```

BOM rules engine, deterministic and readable:

- Item rules: one line per placed item, grouped by product.
- Dependency rules: display needs a mount matched to VESA and weight; ceiling
  speakers need an amplifier sized to count and impedance; ceiling mics need
  a DSP with enough channels; each networked device needs a PoE port.
- Distance rules: cable lengths from wall and ceiling runs in the IR, rounded
  up to stock lengths.
- Room-level rules: labour and commissioning as optional lines.

Every BOM line has `reason: item | rule:<name>` so it is auditable.

Verification pipeline: agent proposes -> search vendor page -> extract specs
and price -> human sees confidence -> persist. Verified entries expire for
price after a configurable window so costing stays honest.

### 5.8 Knowledge the Space Designer needs

Not left to prompt intuition. Encoded as a **rules pack** (data, versioned):

- Display size versus farthest viewer distance, by content type (industry
  viewing distance guidance).
- Camera field of view versus room width and table shape.
- Ceiling mic coverage radius and count per room area.
- Speaker count per area and ceiling height.
- Table sizes per seat count, chair spacing, clearances around tables and
  along walls, door swing clearance.
- Desk cluster layouts (bench of 4, 6, 8), aisle widths.
- Cafeteria: seat density, counter depth, queue space.

Room **recipes** combine rules into a starting layout: "boardroom 10 seats",
"huddle 4 seats", "training room 20", "open-plan cluster". The agent adapts a
recipe to the actual room polygon.

### 5.9 3D assets

Order of preference, all coexisting through `assetKey`:

1. **Primitive recipes.** Parametric boxes, cylinders, extrusions with correct
   dimensions and a label. Ships in phase 1. Always the fallback.
2. **Curated free packs.** CC0 or CC-BY furniture and AV models converted to
   glTF, normalised to origin and metre scale. A licence manifest per asset is
   mandatory.
3. **AI-generated meshes.** For missing categories. Normalised to the product
   bounding box on import so scale is never trusted from the generator.

Vendor-supplied CAD models are out for now (conversion pipeline cost). Blender
may be used offline to convert and clean assets.

### 5.10 Input pipeline by plan type

| Input | Path | Confidence |
|---|---|---|
| DXF | Vector parse (layers, lines, polylines, blocks) -> geometry in real units -> LLM interprets layers and labels into walls/rooms | High |
| DWG | Convert to DXF first with an external converter, then as DXF. Licensing of converters to be decided. | High after conversion |
| PDF, vector | Extract paths, treat as DXF-like. Scale from dimension text or a scale bar. | Medium-high |
| PDF, raster or image | Vision LLM proposes walls, openings, rooms, scale. Classical CV snaps lines to straight and orthogonal. Human confirms scale. | Medium |
| Hand sketch, whiteboard photo | Vision LLM, orthogonal snapping, all dimensions flagged as estimates. Always asks for at least one known dimension. | Low, human-in-loop |
| Text brief only | Skips Plan Reader. Space Designer creates the room from the brief. | N/A |

All paths end in the same IR with `provenance.confidence` and
`provenance.questions`.

### 5.11 Exports, in priority order

1. CSV and XLSX BOM: per room sheet and a total sheet, with source URLs.
2. GLB scene: three.js exporter, near free.
3. 2D layout drawing as PDF and DXF: top-down plan with furniture, AV positions,
   mounting heights. Needs its own 2D renderer, shared with the plan view.
4. IFC: later phase. Needs a proper mapping from IR to IFC entities.

### 5.12 Proposed repository shape (TypeScript monorepo)

```
packages/
  ir/          schema (zod), types, commands, validation, migrations
  engine/      IR -> geometry, pure, tested in Node
  assets/      primitive recipes, glTF registry, licence manifest
  catalog/     product store (SQLite or JSON), verifier, BOM rules
  mcp-server/  tools over the command layer, stdio + HTTP transports
  agents/      provider interface, prompts, Plan Reader, Space Designer
  exporters/   csv, xlsx, glb, dxf, pdf
apps/
  web/         plan view + 3D view + editor, Vite
docs/
  00-brainstorm.md, adr/, spec/, prd/
```

## 6. Phases

Phase 1 is the milestone chosen for "real": a text brief becomes one furnished
meeting room with a verified BOM. Phase 0 is the foundation it needs.

| Phase | Outcome | Proves |
|---|---|---|
| 0. Foundation | IR schema, engine, viewer, MCP primitive tools. Claude Code can build a room with walls, a door, a table and chairs, and see it in the browser. | The IR-first architecture and the MCP workflow. |
| 1. Brief to room plus BOM | "10-seat boardroom, 8 by 5 m, video conferencing" -> furnished 3D room, verified products, CSV BOM. Semantic tools, rules pack, catalog verifier. | Design knowledge, catalog trust, BOM traceability. |
| 2. Plan Reader | DXF and raster image import to walls, openings, rooms. Multi-room floors. GLB export. | Vision to IR is viable and correctable. |
| 3. Editor | Full 2D and 3D editing, undo/redo, open-plan desks, cafeteria, 2D drawing export. | Product usable without an agent. |
| 4. In-app agent and hosting | Agent on OpenRouter or local Qwen inside the app. Hand sketches. Multi-project hosting. IFC. | The shipped product. |

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Local models call tools unreliably | In-app agent fails outside Claude | P3 tool design, semantic tools, validate-and-retry loop, test suite that replays tool transcripts against each provider |
| Hallucinated products and prices | Wrong costing, loss of trust | P5 verification, expiry, confidence shown in BOM, never export unverified as final |
| Scale wrong on raster plans | Everything downstream wrong | Always confirm scale with the human, show a dimension overlay, require one known dimension |
| Asset licensing | Legal exposure | Licence manifest per asset, CC0 preferred, no vendor CAD without terms |
| Scope creep from "everything" | Another stalled attempt | Phase gates, phase 1 is one room |
| Wall geometry edge cases | Ugly or broken 3D | 2D polygon booleans then extrude, fuzz tests on wall networks |
| DWG conversion licensing | Cannot support DWG | Offer DXF and PDF first, evaluate converters in an ADR |
| Third-party code licences | Legal exposure | Own IR design and own code; no copyleft code in the repository. |

## 8. Open questions

To resolve in ADRs or the spec. None blocks phase 0.

1. Currency and region for pricing. Which vendors and distributors are typical
   for your quotes?
2. Which AV standards or vendor design guides should the rules pack encode?
   Any internal design rules already written down?
3. Multi-level buildings in phase 2 or later?
4. Do structural versus partition walls matter for the BOM (partition walls
   are themselves a line item)?
5. How much of the price is list versus negotiated? Should the catalog hold
   both?
6. Which local Qwen variant and serving stack will be used, and on what
   hardware? This bounds the Plan Reader's vision quality.
7. Should the BOM include labour, commissioning, and margin lines?

## 9. ADRs to write next

| ADR | Decision |
|---|---|
| 001 | Scene IR as single source of truth, 3D derived |
| 002 | TypeScript monorepo and package boundaries |
| 003 | three.js integration approach (vanilla versus react-three-fiber) and 2D plan view technology |
| 004 | Command layer with undo/redo as the only mutation path |
| 005 | MCP as the tool layer, transports, viewer sync |
| 006 | Two-tier tool design for mixed-capability models |
| 007 | Provider abstraction over OpenAI-compatible APIs, Claude Code for development |
| 008 | Catalog verification and persistence |
| 009 | BOM rules engine and traceability |
| 010 | 3D asset strategy and licensing |
| 011 | Input pipeline strategy per plan type |
| 012 | Local-first project file format |
| 013 | Export formats and ordering |
| 014 | Wall geometry construction (2D boolean then extrude) |

## 10. Revisions after design review (2026-09-14)

The decisions below were made after this brainstorm was written. They
supersede the corresponding text above; ADRs settle each one.

1. Units: propose integer millimetres and degrees everywhere in the IR and
   tools, replacing metres in section 5.1.
2. Wall joins are stored by id, `{ wallId, end }`, and join geometry is
   computed by intersecting side lines with a clamp at twice the larger
   thickness plus vertex welding.
3. Openings are bound to a wall id with a fractional position along it, and
   carry embed fractions and a unit-square cut-out path from the catalog.
   The hole is computed by footprint intersection so wall moves re-derive it.
4. Room auto-detection from the union of wall footprints is a first-class
   engine function and a mode of the room creation tool.
5. The engine uses a coalescing dirty set with an explicit dependency graph
   for incremental 3D updates (new ADR-015).
6. The tool surface is about twenty tools, tabled in ADR-006.
   Batch is atomic. Scene reads take a detail level and filters. Render
   returns a four-angle overhead with walls hidden by default.
7. MCP process to viewer transport is WebSocket with request ids and tiered
   timeouts.
8. Catalog records gain cut-out shape, embed fractions, mesh rotation, a
   deformable flag, named mount points and clearance polygons.
9. Assets are glTF converted offline. Repeated items are instanced. Static
   geometry is merged per material per level while editable walls stay
   separate objects.
10. Licence rule: no GPL or other copyleft code, translated or otherwise,
    enters this repository.
11. The model layer is hand-written TypeScript.
12. Two ADRs added: 015 engine invalidation and dependency graph; 016 room
    detection, magnetism and editing commands.

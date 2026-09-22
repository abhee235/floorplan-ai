# Architecture decision records

One decision per file. Status is Proposed until reviewed, then Accepted.
Superseded decisions are kept and marked. Each ADR lists the ledger lines
from the edge-case ledger it must satisfy so the spec can turn them into
tests.

| ADR | Decision | Status |
|---|---|---|
| [001](ADR-001-scene-ir-source-of-truth.md) | Scene IR as single source of truth; millimetres and degrees; y-up plan coordinates; entity model; ids; invariants | Proposed |
| [002](ADR-002-typescript-monorepo.md) | TypeScript monorepo, package boundaries, dependency direction, toolchain, ledger-numbered tests | Proposed |
| [003](ADR-003-three-js-and-plan-view.md) | Vanilla three.js with a thin binding; renderer-neutral engine buffers; geometry rules; canvas 2D plan view in layers | Proposed |
| [004](ADR-004-command-layer.md) | Commands as data over pure reducers; atomic transactions; Immer-patch undo; change sets | Proposed |
| [005](ADR-005-mcp-tool-layer-and-transports.md) | One session host process; in-process tool registry; MCP as an optional adapter (stdio or one route), off in production; WebSocket viewer bridge; single deployment | Proposed |
| [006](ADR-006-tool-surface-for-mixed-models.md) | Two-tier tool surface of 23 tools; flat arguments; compass frames and room anchors; result envelope; workflow prompt; tiers by model profile | Proposed |
| [007](ADR-007-provider-abstraction-and-agent-runner.md) | One OpenAI-compatible provider interface; structured output validated by us; agent runner calls the registry in-process; Claude Code for development via the adapter; evaluation table | Proposed |
| [008](ADR-008-catalog-and-verification.md) | Product record with embed fractions and cut-out paths; propose, verify, persist pipeline; SQLite catalog; project snapshots | Proposed |
| [009](ADR-009-bom-rules-engine.md) | BOM computed by a deterministic rules engine; four rule kinds; traceable lines; rules packs as data | Proposed |
| [010](ADR-010-asset-strategy.md) | Asset keys by category and size class; primitives, CC-BY and CC0 packs from original authors, generated meshes; offline glTF conversion; licence manifest; textures with real-world size; per-part material overrides; articulated poses; library interchange and user import | Proposed |
| [011](ADR-011-input-pipeline.md) | PlanDraft contract; paths for DXF, PDF, raster, sketch, brief; scale always confirmed; human review before commit | Proposed |
| [012](ADR-012-project-file-format.md) | Project directory with project.json and manifest; atomic rename save; explicit fields; forward-only migrations; recovery | Proposed |
| [013](ADR-013-exports.md) | CSV and XLSX first, then glTF, then PDF and DXF drawings, then scoped IFC; all headless in the host | Proposed |
| [014](ADR-014-wall-geometry-construction.md) | Wall footprints, symmetric join pass, arc tessellation, sloped tops, openings and reveals, tolerance table | Proposed |
| [015](ADR-015-engine-invalidation.md) | Change sets expanded by a dependency table into rebuild sets; one dirty set for 3D and plan layers; caches on the same path | Proposed |
| [016](ADR-016-room-detection-magnetism-gestures.md) | Room detection from the closed wall union with gap tolerance; magnetism table; gestures as transactions | Proposed |
| [017](ADR-017-editor-shell-and-accessibility.md) | Editor shell: plan-led layout with panels always open; tools as modes; properties panel is the selection; a keyboard equal for every gesture | Proposed |
| [018](ADR-018-react-chrome-vanilla-canvas.md) | React and shadcn/ui for the chrome, plain DOM and canvas for the drawing surface | Accepted |
| [019](ADR-019-session-event-log.md) | A session event log: one JSONL line per command, tool call, refusal and gesture, with the values that changed | Proposed |
| [020](ADR-020-project-addressing-and-storage.md) | A project is addressed by an opaque string carried in the URL; the document is stored whole and a database holds facts about it, never its entities; a session per open project when hosting needs one | Proposed |
| [021](ADR-021-web-product-and-the-project-library.md) | This is a web product: projects live in a library the app owns, addressed by id, with no path ever sent to a browser; the person's own disk is reached by import and export | Proposed |
| [022](ADR-022-agent-roles-and-the-checker.md) | The agent is one loop and one model, with roles as sub-runs holding their own context and only the tools the registry grants them: an architect that produces a measurable design, a checker that is code, a builder that draws from an approved design; a mutation says which revision it was decided on; the tool surface is most of the token budget | Proposed |
| [023](ADR-023-authorship-and-consent.md) | Every entity records who made it and who last changed it, stamped by the command layer; the agent asks before changing a person's work, and the registry refuses when it does not | Proposed |
| [024](ADR-024-how-the-agent-gets-better.md) | The verifier is code and a person writes it; no reinforcement learning and no self-editing harness, with the condition for revisiting each; instead a score, best of several chosen by the checker, and a regression suite of briefs | Proposed |
| [025](ADR-025-compaction.md) | The loop keeps the conversation inside the window itself, in four layers cheapest first, late and then all the way to a floor; the task, the plan, every call and every failure are never dropped; re-reading the world is the recovery | Proposed |
| [026](ADR-026-skills.md) | A skill is two things for two readers: numbers go to the rules pack the packer and checker obey, judgement goes to a document the model reads through `read_skill` from a one-line index; skills are advice and never authority | Proposed |
| [027](ADR-027-what-the-model-reads-before-it-designs.md) | Skills first and the web only for what a skill cannot hold; a notes scratchpad pinned to the prompt; a picture on demand with `look_at`; search and page tools advertised only when configured; the plan gate belongs to the run that wrote the plan; tools say what they do; the recipes the pack was meant to have | Proposed |
| [028](ADR-028-the-architect-draws-the-plan.md) | The architect draws the plan and the packer becomes an optional helper; the checker keeps errors only for what cannot be built or used; rooms say whether they are walled, glass or open and the building's sides whether they are glazed; the model asks its own questions of a design with `query_design`; a picture is copied, not paraphrased; two builder faults fixed; both routes measured before either is the default; every design is looked at before it is called done, from a drawing with vision and a walk from the entrance without; a display never goes on glass or a window, and an office is glazed unless it says otherwise; a kind of building is added with its rooms, recipes and skill together | Proposed |

Deliberate departures from common practice, collected for review:
millimetres and y-up (001); openings bound to walls by id (001); rejected
rather than tolerated degenerate walls and rooms (001, 014, 016); atomic
batches (004, 006); browser as replica, host as authority (005); ceilings
follow level height, not walls (001, 015); smallest enclosure wins (016);
gap tolerance in room detection (016); explicit fields in files, no omitted
defaults (012); duplicate catalog ids are errors (008).

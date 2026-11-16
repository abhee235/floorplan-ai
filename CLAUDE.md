# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Floorplan-AI turns floor plans (DXF, PDF, raster images) and written briefs into editable 3D office and home
models with a traceable bill of materials. It is a pnpm TypeScript workspace (Node 22+, pnpm 10; prefix with
`corepack` when pnpm is not on the path).

## Commands

```sh
pnpm install
pnpm check                 # biome + package boundaries + tsc + vitest + ledger coverage: run before calling work done
pnpm test                  # vitest run (whole suite)
pnpm test packages/ir/test/validate.test.ts         # one file
pnpm exec vitest run packages/ir -t "F-001"          # tests whose name matches, e.g. a ledger id
pnpm typecheck             # tsc -p tsconfig.json --noEmit
pnpm lint                  # biome check + tools/check-boundaries.ts
pnpm format                # biome format --write .

pnpm host:dev              # host with --serve --mcp: web app + bridge on http://127.0.0.1:4310, MCP on stdio
pnpm web:dev               # Vite on :5173, proxies /bridge to a host on :4310
pnpm web:build             # builds apps/web/dist, which the host serves
```

Host CLI (`tsx apps/host/src/cli.ts`, see `parseArgs` in [apps/host/src/cli.ts](apps/host/src/cli.ts)) also
takes `--agent "<task>" [--steps n]` to run one in-app agent task headless, `--port`, `--data <dir>`,
`--project <project.json>`, `--profile high|medium|low`, and `--logs [last|<name>] [--follow] [--find text]` to
read the session logs back. Stdout may be the MCP transport, so the host writes all diagnostics to stderr.

Evaluation and scoring scripts are run with `pnpm exec tsx <script>`; each file's header documents its flags:
- `tools/eval/run.ts --models ollama:qwen3.8:27b --cards boardroom`: headless task cards from
  `tools/eval/cards/` in a fresh in-process session; appends to `docs/eval/agent-results.jsonl` and rebuilds
  `docs/eval/agent-runs.md`.
- `tools/eval/live.ts --host ws://127.0.0.1:<port>/bridge --card office-brief-live --out <dir>`: drives an
  already running host over its bridge, as a browser tab does, and writes pictures plus a PASS/FAIL report.
- `tools/eval/smoke-wire.ts <provider> <model> [reasoning]`: a two-turn live check of one LLM adapter.
- `tools/score-plans.ts` (DXF/PDF reader), `tools/score-raster.ts` (vision reader, `--replay` avoids model
  calls), `tools/score-layouts.ts` (layout packer).

Model-backed paths read configuration from the nearest `.env` (template: `.env.example`); shell variables win.
`FPV_AGENT_*` configures the in-app designer, `FPV_READER_*` the vision plan reader, `FPV_VERIFIER_*` and
`FPV_SEARCH*` the product verifier and web tools. Unit tests never need a model.

## Architecture

### Package graph

Workspace packages are consumed as TypeScript source (`main: ./src/index.ts`, no build step). `@fpv/<name>`
resolves to `packages/<name>/src` through matching aliases in `tsconfig.json`, `vitest.config.ts` and
`apps/web/vite.config.ts`; `@/` resolves to `apps/web/src`. Allowed dependencies are enforced by
[tools/check-boundaries.ts](tools/check-boundaries.ts) and fail `pnpm lint`:

```
ir ← geometry ← commands ← engine ← exporters
ir ← assets ← catalog ──────┘
ir, geometry ← importers
tools    → everything above (the tool registry)
agents   → ir, catalog, tools, importers
host     → everything (Node process)
web      → ir, engine, commands, geometry, assets, importers, catalog (browser; never tools or agents)
```

`ir`, `geometry`, `engine`, `commands` and `catalog` must run in both Node and the browser: no `three`,
`react`, `vite`, and no `node:` imports. The one exception is `@fpv/catalog/store` (SQLite store, installer,
fetcher), a Node-only subpath that only the host may import. A new package needs an entry in `ALLOWED`.

### Data flow

1. **IR** (`packages/ir`, ADR-001): the project is one zod-validated JSON document and the only state.
   Lengths are integer millimetres, angles degrees counter-clockwise from +x, plan coordinates y-up (the
   engine maps plan (x, y) to three.js (x, elevation, -y)). Ids are `<type>_<6 base36>` from an injectable
   generator. Derived values (lengths, areas, bounds) are computed by functions in `ir` and never stored.
   `validate(project)` returns problems; schema changes need a forward-only migration.
2. **Commands** (`packages/commands`, ADR-004): every mutation is a command applied by a pure reducer on an
   Immer draft, then normalised and validated. A store groups commands into atomic transactions, keeps undo
   as Immer patches, stamps authorship by `Origin` (`editor`, `agent`, `import`...), and emits a `ChangeSet`.
   `bridge.ts` here defines the host–browser WebSocket protocol, shared by both sides.
3. **Engine** (`packages/engine`, ADR-003/015): renderer-neutral mesh buffers for walls, rooms and items,
   rebuilt from change sets through a dependency table. `geometry` holds the polygon booleans, wall joins,
   room detection and magnetism it relies on. `drawing.ts` (`planStructure`, `planItems`, `planZones`) is
   the 2D plan as shapes: the web plan view paints them and the PDF/DXF layout drawings print them
   (ADR-013 D5), so a change to what the plan shows belongs there, not in `apps/web/src/plan/plan.ts`.
4. **Tools** (`packages/tools`, ADR-005/006, spec 04): one registry of zod-schema'd tools with a uniform result
   envelope. Tools are filtered by reliability profile (high, medium, low), by a per-role `granted` set, and
   by consent: entities a person made are refused to the agent unless released (ADR-023). `run_code` executes
   model-written JavaScript in a QuickJS sandbox whose only reach is pictures and this registry (ADR-030).
5. **Host** (`apps/host`): one process, no sidecar services (ADR-005). A `Workspace` holds one `Session` per
   open project (store + registry + transcript + event log). Three callers share that registry in-process: the
   MCP stdio adapter (`--mcp`), the `/bridge` WebSocket that the browser uses, and `AgentRuns` (the in-app
   agent). It also owns the catalog database, the project library and the JSONL session log (ADR-019).
6. **Web** (`apps/web`, ADR-017/018): React + shadcn/ui for the chrome, with the 2D plan canvases and three.js
   viewport kept imperative. The browser is a replica: `replica.ts` applies the host's snapshots and patch
   streams and sends commands back; the host is the authority. `main.tsx` deliberately avoids StrictMode
   because `startApp` must run once.

### Agents (`packages/agents`)

- `runner.ts` is the single conversation loop: model turn → tool calls run in order against the registry →
  results back. Malformed calls become tool errors the model can correct, never exceptions. Loop-only tools
  (`plan_work`, `notes`, `ask_user`, `read_skill`) live in `loop-tools.ts`; `gates.ts` nudges a run that stops
  planning, verifying or acting.
- `llm/` holds one adapter per wire behind a provider-neutral `Message`/`Block` model (ADR-029):
  `openai-responses`, `anthropic`, `ollama` (native API, the only one that can set the context size) and
  `openai-chat` for compatible servers. `factory.ts` is the only file that picks among them. Reasoning blocks
  are stripped from every assistant message except the newest.
- `context/` is window-derived compaction, applied cheapest layer first (ADR-031, superseding parts of 025).
- `roles/`: `designer` is the main run; `architect` is a sub-run with its own context, prompt and a few
  design tools, returning only the settled design (ADR-022/028); `reader` turns a plan image into a
  `PlanDraft` via a vision model; `verifier` extracts product records from fetched spec pages, which the
  catalog then re-scores against the same pages. `sections.ts` builds the system prompt from sections that
  drop out when a model cannot use them.
- Skills are `SKILL.md` documents the model reads through `read_skill`: built-ins in `apps/host/skills/`,
  overridden by name from `<data>/skills/` (ADR-026).

### Catalog and BOM (`packages/catalog`)

Product records, a SQLite store (Node-only subpath), a propose → verify → persist pipeline (ADR-008), and rules
packs under `rules/` that drive both the deterministic BOM (ADR-009) and the design/layout checks the checker
and packer enforce. Exporters turn the engine's output and BOM into XLSX, CSV and GLB.

### Imports

`packages/importers` reads DXF, vector PDF and raster plans into a `PlanDraft` (ADR-011, spec 06). Scale is
always confirmed, never trusted from a model alone, and a person reviews the draft before it is committed.

## Conventions

- Code comments cite decisions as `ADR-0NN Dn`, spec sections, or ledger ids. Before changing a subsystem,
  read its ADR in `docs/adr/` (index: `docs/adr/README.md`) and the matching spec in `docs/spec/`. A change
  that alters a decision should amend or supersede the ADR, not silently diverge from it.
- TypeScript is strict with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and
  `verbatimModuleSyntax` (use `import type` for types). Relative imports carry a `.js` extension.
- Biome formats with two spaces, double quotes, semicolons and a 110-character line width; its lint preset is
  off, so `pnpm lint` failures are mostly formatting or boundaries.
- Tests live in each package's or app's `test/` folder as `*.test.ts(x)` and run in Node. A React chrome test
  opts into jsdom with a `// @vitest-environment jsdom` docblock. Tests assert on model values, geometry and
  derived measurements, not rendered pixels; canvas and WebGL wiring has to be checked in a real browser.
- Edge-case ledger: ids such as `W-031` refer to a private ledger kept outside this repository
  (`../floorplan-ai-private/02-edge-case-ledger.md`, or `FPV_LEDGER_FILE`). A test covering a ledger rule puts
  the id in its name; `tools/ledger/dispositions.json` maps ids to packages and phases, and
  `tools/ledger/current-phase.json` turns on the gate that fails `pnpm ledger:coverage`. Without the ledger
  file the report is skipped. Never commit the ledger or research notes (`.gitignore` blocks them).
- Fixtures live in `tools/fixtures/`. The synthetic ones (plans, raster, boardroom) are generated by the
  `tools/build-*.ts` scripts, each with an `.expected.json` beside it. The `*-real` folders hold third-party
  drawings with their own licences, recorded in the `SOURCES.md` beside them.
- No GPL or other copyleft code, translated or otherwise, may enter this repository (Apache-2.0).
- Commit subjects are short, outcome-focused sentences with no type prefix (see `git log`).

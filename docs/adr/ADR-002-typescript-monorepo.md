# ADR-002: TypeScript monorepo, package boundaries, and toolchain

Status: Proposed
Date: 2026-09-14
Supersedes: section 5.12 of 00-brainstorm.md
Related: ADR-001 (IR), ADR-003 (rendering), ADR-004 (commands), ADR-005 (MCP)

## Context

The brainstorm chose TypeScript end to end so that the IR schema, the engine,
the tools, and the viewer share one type system. We need package boundaries that
keep the engine testable in Node without a browser, keep three.js out of the
model layer, and let the MCP server and the web app consume the same code.

## Decision

### D1. Layout

```
floorplan-ai/
  package.json            # pnpm workspace root, scripts only
  pnpm-workspace.yaml
  tsconfig.base.json
  packages/
    ir/                   # zod schema, types, ids, validation, derived-value functions, migrations
    commands/             # command definitions, reducers, history, transactions (ADR-004)
    geometry/             # 2D kernel: polygon booleans, offsets, joins, triangulation adapters. No three.js.
    engine/               # IR -> geometry buffers (walls, floors, items), dependency graph, dirty set. No three.js.
    catalog/              # product schema, store, verifier interface, asset registry, BOM rules
    assets/               # primitive recipes, glTF manifest, licence manifest, offline conversion scripts
    agents/               # provider interface, prompts, plan reader, space designer, rules pack loader
    tools/                # the tool registry: zod schemas, descriptions, functions over commands and engine. The only tool definitions.
    exporters/            # csv, xlsx, glb, dxf, pdf
    importers/            # dxf, pdf, image pre-processing (feeds the plan reader)
  apps/
    host/                 # Node session host: project state, file system, catalog db, in-app agent runner, viewer bridge, optional MCP adapter, serves web
    web/                  # Vite app: plan canvas, three.js viewer, editor chrome, agent chat UI (a replica of the host)
  docs/
  tools/                  # dev scripts, fixture generators
```

### D2. Dependency direction

Arrows mean "may import". Anything not listed is forbidden and enforced by an
ESLint boundary rule.

```
ir          <- commands <- engine <- tools <- agents <- apps/host
ir          <- geometry <- engine
ir, catalog <- commands   (catalog for product dimensions in validation)
ir, assets  <- catalog    (asset manifest schema and key resolution)
engine, commands         <- apps/web   (the replica renders and emits commands; it never imports tools or agents)
exporters, importers     <- apps/host
ir, engine  <- exporters
ir          <- importers <- agents
assets      <- engine (manifest only), apps/web (files)
```

`ir`, `geometry`, `engine`, `commands`, and `catalog` never import three.js,
the DOM, or Node-only APIs. They run in Node tests, in the browser, and in a
worker. The one exception is the `@fpv/catalog/store` subpath entry, which
holds the SQLite store (Node's built-in `node:sqlite`, no native module) and
on-disk library installation; only the host imports it, and the boundary
checker fails any `node:` import elsewhere in those packages.

Amendment 2026-09-15 (P2-3): `apps/web` may also import `importers`. The
package is pure (no Node or DOM APIs) and the app's draft review uses its
PlanDraft schema and scale helpers, so the tool and the panel apply one
rule for when a scale counts as confirmed. The app does not parse files; the
host reads them.

Amendment 2026-09-17 (P3-5): `apps/web` may also import `catalog`, its pure
entry only (never `@fpv/catalog/store`). The catalog tab narrows a search by
the catalog's own category list rather than a copy of it. Searching stays the
host's, through the same search_catalog tool an agent calls.

### D3. Toolchain

| Concern | Choice | Reason |
|---|---|---|
| Package manager | pnpm workspaces | Strict node_modules, fast, standard for monorepos |
| Node | 22 LTS | Current LTS at the time of writing |
| Language | TypeScript 5.x, `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` | Catches the undefined-level and stale-cache class of bugs the ledger is full of |
| Modules | ESM only | One module system across Node and browser |
| Schema | zod | One source for runtime validation, TS types, and JSON Schema for tools |
| Tests | vitest | Fast, ESM native, same runner in packages and app |
| Lint and format | Biome | One tool, one config, fast |
| Package build | tsup | Simple ESM builds for packages consumed by the app and the MCP server |
| App build | Vite | Dev server with HMR for the viewer |
| 3D | three.js, pinned minor version | Chosen in ADR-003 |
| Polygon booleans | polygon-clipping (MIT) | Martinez algorithm, robust, integer-friendly |
| Triangulation | earcut (via three.js ShapeUtils) | Handles holes, already bundled |
| MCP | @modelcontextprotocol/sdk | Reference implementation, stdio and streamable HTTP |

### D4. Testing rules

- Every ledger line that applies to a package becomes a test in that package,
  named by its ledger id, for example `W-021 mitre clamp`. A test file may
  cover many ids. A script lists ledger ids with no matching test so coverage
  of the ledger is visible.
- `engine` tests assert on geometry buffers and on derived numbers (areas,
  corner coordinates), never on rendered pixels.
- Golden fixtures are JSON projects under `tools/fixtures`, including the
  reference test scenes rebuilt in our units (for example the six-wall L-shaped room
  that must yield a six-point room and a known area, R-131).

### D5. Versioning

One version for the whole workspace, tagged from the root. Packages are not
published to a registry in phases 0 to 3.

## Alternatives considered

- **Python for agents and importers, TypeScript for the rest.** Rejected:
  the IR schema would live in two languages, and the agents call the same
  tools the app does.
- **Single package, no workspace.** Rejected: the dependency-direction rule
  is the mechanism that keeps three.js and the DOM out of the engine. It needs
  package boundaries to be enforceable.
- **ESLint plus Prettier instead of Biome.** Viable. Biome chosen for one
  config and speed; switching later is mechanical.
- **Turborepo or Nx.** Not needed at this size. pnpm scripts with
  `-r` are enough. Revisit if build times matter.

## Consequences

- Phase 0 starts by scaffolding this layout with empty packages and the
  boundary lint rule, before any feature.
- The `geometry` package is where the wall join, arc tessellation, and room
  detection algorithms live, so they are testable without the engine.
- The `tools` package is the single definition of every tool. The in-app
  agent calls its functions directly; the MCP adapter in `apps/host` only
  forwards. There is no separate MCP service, and the whole product deploys
  as the one `apps/host` process (ADR-005 D3).

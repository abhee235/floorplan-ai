# @fpv/host

The session host: one Node process that owns the open project, applies every command through the
command layer, exposes the tool registry, serves the web viewer and its bridge. Nothing else is
deployed alongside it (ADR-005).

Phase 0 is complete in this app: session factory, tool registry wiring, MCP adapter over stdio,
HTTP static server for the built web app, viewer bridge over WebSocket, project files with atomic
save and recovery, and the render tool through a connected tab. The catalog database and the in-app
agent runner arrive with phase 1.

## Run it

| Command (from the repo root) | What it does |
|---|---|
| `corepack pnpm web:build` | builds the web app into `apps/web/dist` (the host serves it) |
| `corepack pnpm host:serve` | serves the viewer and bridge on http://127.0.0.1:4310/ |
| `corepack pnpm host:dev` | the same, plus the MCP adapter on stdio (for an MCP client) |
| `corepack pnpm web:dev` | Vite dev server with HMR on port 5173; proxies `/bridge` to a running host |

Flags after the script name (pass them with `--`): `--project <file.json>` starts from a project
file; `--port <n>` changes the port; `--profile high|medium|low` picks which tools are advertised
over MCP (all stay callable); `--data <dir>` (or `FPV_DATA_DIR`) moves the catalog database and
installed libraries away from the platform data directory.

## Configuration: `.env`

Model providers, keys and which model plays each role live in a `.env` file. The host, `tools/eval/run.ts` and
`tools/score-raster.ts` read the nearest `.env` walking up from where they run (or `FPV_ENV_FILE`); variables
already set in the shell win and empty values are ignored. Copy `.env.example` at the repository root, which lists
every setting with model suggestions. git ignores `.env`.

Each model role (agent, reader, verifier) is set with a provider and a model:

```
OPENAI_API_KEY=sk-...
FPV_AGENT_PROVIDER=openai        # ollama, openai or openrouter
FPV_AGENT_MODEL=gpt-4.1-mini
FPV_READER_PROVIDER=ollama
FPV_READER_MODEL=qwen3.8:27b
```

The provider fills in `FPV_<ROLE>_BASE_URL` (`OLLAMA_BASE_URL`, `OPENAI_BASE_URL`, `OPENROUTER_BASE_URL` when
set), `FPV_<ROLE>_API_KEY` from `OPENAI_API_KEY` or `OPENROUTER_API_KEY`, and for Ollama
`FPV_<ROLE>_EXTRA_BODY={"reasoning_effort":"none"}`; each of those can still be set explicitly. Roles not set in
the environment fall back to `roles` in `<data>/config.json`.

Run one task with the configured agent: `corepack pnpm exec tsx apps/host/src/cli.ts --agent "10-seat boardroom,
8 by 5 m, video conferencing"` (add `--serve` to watch it in the browser). The transcript is written to
`<data>/transcripts`.

## The catalog

`catalog.db` in the data directory is a SQLite file opened through Node's built-in binding, so there
is no native module and nothing else to install (ADR-008 D5). On first run the built-in seed library
is installed: common displays, video bars, ceiling microphones and speakers, schedulers, tables,
chairs, a whiteboard, a credenza, and a generic door and window. Every real seed product is
`unverified` until `verify_product` confirms it against a source. `search_catalog` matches the exact
id first, then the model number, then every query word in the name, then tags and aliases with a
synonym table (tv, screen, couch), then full-text ranking, and returns at most 20 with a cursor.

## Product verification

`verify_product` checks a make and model against web pages and saves what the pages state (ADR-008
D3). It needs pages and a reader for them, and each can come from the host or from the caller:

| Pages from | Read by | Configure |
|---|---|---|
| a search provider | the verifier model | both below |
| `sources` in the call | the verifier model | the model only |
| `sources` in the call | `proposal` in the call | nothing: the Claude Code development path |

The host always fetches the pages itself and scores every value against them, so a proposal whose
numbers no page states stays unverified.

Reading pages is extraction, not reasoning. With a local reasoning model such as Qwen 3.6 on Ollama,
set `"extraBody": { "reasoning_effort": "none" }` on the verifier provider: measured on this machine,
a trivial reply fell from 177 tokens to 6, and a three-page verification with reasoning on took four
to five minutes, far past the tool's two-minute limit. Settings live in `config.json` in the data directory, and
environment variables override them:

```json
{
  "providers": {
    "local": { "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen3.6:35b", "extraBody": { "reasoning_effort": "none" } },
    "router": { "baseUrl": "https://openrouter.ai/api/v1", "model": "qwen/qwen3-235b-a22b", "apiKeyEnv": "OPENROUTER_API_KEY" }
  },
  "roles": { "verifier": "local" },
  "search": { "kind": "brave", "apiKeyEnv": "BRAVE_SEARCH_API_KEY" },
  "verifier": { "maxPages": 3, "allowPrivatePages": false }
}
```

| Variable | Meaning |
|---|---|
| `FPV_SEARCH` | `brave` or `searxng` |
| `FPV_SEARCH_API_KEY` or `BRAVE_SEARCH_API_KEY` | Brave Search API key |
| `FPV_SEARCH_URL` | SearXNG base URL with the JSON format enabled |
| `FPV_VERIFIER_BASE_URL`, `FPV_VERIFIER_MODEL`, `FPV_VERIFIER_API_KEY` | an OpenAI-compatible model for reading pages |

The host prints one line on start saying what the verifier can do. Every attempt is stored as a
verification run in the catalog database.

## Bill of materials and design checks

The host loads the core AV rules pack (spec 07). `get_bom` with `scope` `project`, `level:<id>` or
`room:<id>` returns every placed product, every door or window with a product, and the lines the
rules add: wall mounts, HDMI and USB cables sized by the run through the ceiling, amplifier, DSP,
PoE switch ports, a scheduling panel, and table power modules. Each line names the items or room
that caused it and the rule id; pass `explain: true` to see the expression and its value. A rule
that finds no verified product in the catalog leaves a placeholder line describing what is needed.
The same pack's design rules (display size for the farthest seat, camera coverage, microphones and
speakers per area, 900 mm behind chairs, door swing, display height) appear as `design.*` warnings
in `validate` and in every editing tool's result.

## Exporting the bill of materials

`export` with `format: "csv"` or `"xlsx"` writes the BOM for the project, a level or a room. Relative
paths go into the open project's directory, or `<data>/exports` before the project is saved. The
XLSX has a Summary sheet (totals by status and by room), one sheet per room, a Project sheet for
level and project lines, a Products sheet with prices and verification sources, and a Provenance
sheet (project, scope, export time, app version, rules pack, catalog snapshot). Unverified lines are
yellow and placeholders orange. The CSV carries the same provenance as leading `#` lines and is
UTF-8 with a byte order mark so spreadsheet applications read it correctly.

Export refuses while `validate` reports errors (pass `force: true` for a file marked DRAFT) and while
lines are unverified or placeholders (pass `includeUnverified: true` for a file that highlights
them). It never replaces an existing file unless `overwrite: true`.

## Furnishing from a brief

`create_room_from_brief` with `"10-seat boardroom, 8 by 5 metres, video conferencing"` builds the
walls, a door, the room, and furnishes it in one call: table, ten chairs, a display on the wall
opposite the door with a video bar below it, ceiling microphones and speakers by area, and a
scheduling panel beside the door. `furnish_room` does the furnishing part for an existing room, with
the huddle, boardroom or training recipe from the rules pack. Products come from the catalog; what
the catalog cannot supply is placed as a simple shape and listed as unresolved, ready for
`verify_product`.

## Importing a plan

`import_plan` turns a DXF floor plan into walls, openings and rooms in two
steps. The first call reads the file and changes nothing:

```json
{ "path": "C:/plans/level1.dxf" }
```

It returns a `draftId`, the detected scale, counts and questions, and opens
the draft in any connected viewer: the source drawing in grey, walls in
orange, openings as dots, wall lengths at the current scale and a scale bar.
Relative paths resolve against the directory the host was started in. In the
viewer, **Import plan…** does the same with a file from your machine.

A draft commits only when its scale is confirmed: either two dimension texts
in the drawing agree with it within 2 percent, or a person confirms it. From
Claude Code, answer the scale question or give the scale:

```json
{ "draftId": "draft_…", "confirm": true, "answers": { "q1": "mm" } }
{ "draftId": "draft_…", "confirm": true, "scale": { "measuredUnits": 14, "lengthMm": 14000 } }
```

In the viewer's review panel, use **Use units**, **Confirm scale**, or click
a wall and type its real length; a wall can also be deleted or given a new
thickness before **Import into the project**. The import is one undo step and
records the source file and any open questions in the project provenance.
DWG files are refused (save as DXF); PDF and image plans arrive in later
releases.

## Importing an image plan

PNG, JPEG, GIF, WebP and BMP plans (scans, exports, screenshots) are read by a
vision model you configure; nothing else in the host needs a model. Without one,
`import_plan` refuses images with a message saying how to set one up; DXF keeps
working.

Point the reader at any OpenAI-compatible server, for example a local Ollama:

```sh
FPV_READER_BASE_URL=http://127.0.0.1:11434/v1
FPV_READER_MODEL=qwen3.6:35b
FPV_READER_EXTRA_BODY={"reasoning_effort":"none"}
```

or in `<data>/config.json`:

```json
{
  "providers": {
    "local-vision": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "model": "qwen3.6:35b",
      "profile": { "vision": true },
      "extraBody": { "reasoning_effort": "none" }
    }
  },
  "roles": { "reader": "local-vision" }
}
```

The host prints `floorplan-ai reader: ...` at start. The import works like a
DXF: the first call returns a draft (walls squared up, collinear pieces merged,
ends snapped, openings attached to walls) and shows it over the image in the
viewer; the second call with `confirm: true` commits it. The scale is taken
from two agreeing dimension strings when the model reads them; otherwise the
draft asks for one known length, and it does not commit until it has one.
Readers work best at 2048 pixels or less on the long side; a local model can
take several minutes per image on a laptop, so `import_plan` allows up to
15 minutes. PNG plans are placed more accurately than JPEG: the host decodes a
PNG's pixels and snaps the model's walls to the lines actually drawn. Score a model on the fixture images with `tools/score-raster.ts`.

## Driving the tools from Claude Code while watching the viewer

```
claude mcp add floorplan -- corepack pnpm --dir C:/path/to/floorplan-ai host:dev
```

Then open http://127.0.0.1:4310/ in a browser. Every tool call Claude Code makes reaches the tab as
one `changes` message with patches, applied on the next animation frame. The `floorplan_workflow`
prompt explains the order of operations. A minimal session:

1. `get_scene` with `detail: "summary"`.
2. `create_walls` with a closed polyline, then `add_opening` for the door.
3. `create_room` with `atPoint` inside the walls.
4. `describe_room`, then `place_item` with anchors such as `against-north-wall`, or `arrange`.
5. `validate`, and `history` with `op: "checkpoint"` before a big `batch`.

Every call is recorded in the session transcript so a session driven by hand can be replayed as a test.

## The bridge

WebSocket at `/bridge`, JSON frames, protocol version 1 (spec 06 part B). A tab sends `hello`, gets
`welcome` and a `snapshot`, then a stream of `changes` (with Immer patches and a sequence number) and
`problems`. Commands, transactions, undo, redo, selection and tool calls all go through the same
store as the MCP tools, so there is one writer and one history.

## Project files

A project is a directory (ADR-012): `project.json` (the IR, pretty-printed, stable key order) and
`manifest.json` (format version, app version, sha256 of project.json). `--project` accepts the
directory or its `project.json`.

- **Save** writes each file to a temporary next to it, flushes it, then renames it over the target.
  A failed or cancelled save leaves the previous files intact and no temporary behind. The
  destination must be writable and have room for the growth before anything is written.
- **Open** never repairs. A manifest hash mismatch opens the project with a "modified outside the
  app" warning; a missing manifest is written on the next save; a newer format or schema version is
  refused, naming both versions.
- **Recovery**: while the project is modified the host writes `recovery.json` every 60 seconds. On
  open, a newer recovery file is reported; `project` with `op: "open", recover: true` loads it. A
  successful save removes it.
- **Session discovery**: `.fpviz/session.json` in the project directory names the host's pid and port
  while it has the project open; a stale file names a dead pid.

## Rendering

The host has no GPU. `render` sends a `render.request` to the first connected tab that advertised
the `render` capability and waits up to 30 seconds for its `render.result`. The tab flushes pending
changes into the scene, places the cameras, captures each view as PNG, and restores the viewport:

| view | what comes back |
|---|---|
| `plan` | the 2D plan drawing, fitted to the project |
| `overhead` | four views from the corners with walls and ceilings hidden |
| `room` | a three-quarter view of the focused room (or the project) |
| `eye` | a standing viewpoint at 1.6 m inside the focused room |

Over MCP the images arrive as image content blocks after the JSON envelope. Without a tab the tool
returns an `unavailable` error that says so.


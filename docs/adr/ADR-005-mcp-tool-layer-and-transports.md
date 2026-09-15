# ADR-005: Session host, in-process tool registry, and MCP as an optional adapter

Status: Proposed
Date: 2026-09-14
Supersedes: section 5.4 of 00-brainstorm.md
Related: ADR-002 (packages), ADR-004 (commands), ADR-006 (tools), ADR-007 (providers), ADR-015 (invalidation)
Ledger lines this ADR must satisfy: S-004, S-005, S-037, S-038, S-041, S-046, S-055
Constraint: the product deploys as one unit on one infrastructure. No separate services, no sidecar processes.

## Context

Blender MCP proxies a raw TCP socket into a running application with no
framing, no request ids, a global lock and 180-second timeouts, and it makes
the application process the authority, so the agent cannot work when the
window is closed.

We need: Claude Code driving tools during development; the web app's editor
and later its in-app agent using the same tools; one authority for project
state; a live viewer; headless operation in tests and scripted imports; and
all of it inside one deployable process.

## Decision

### D1. Tools are in-process functions; MCP is an adapter

The `tools` package defines every tool once: a zod argument schema, a zod
result schema, a description written as a prompt, and a function that runs
against the host's project through the command layer (ADR-004). This
registry is the tool layer. There is no protocol between the in-app agent
and the tools: the agent imports the registry and calls functions.

The MCP adapter is a small module inside the host that reads the registry,
emits the MCP tool list, and forwards calls. It exists so external agents,
first Claude Code, can drive the same tools. It is enabled by a flag or by
launching the host in stdio mode, and it is off by default in production.
Removing MCP would delete the adapter and nothing else.

### D2. One session host process

`apps/host` is a Node process that owns the open project (IR plus history),
applies every command through the command layer, persists the project file
(ADR-012), holds the catalog database (ADR-008), runs the in-app agent
(ADR-007) in-process, serves the web app's static files, and exposes:

- the **viewer bridge**, a WebSocket for the browser (D4);
- the **MCP adapter**, over stdio when launched by an MCP client, or as one
  HTTP route on the same port when enabled (D7).

The browser is a replica, not the authority. It renders from snapshots and
change sets and sends commands to the host. The agent works with no browser
open, headless tests exercise the identical path, and two viewers can watch
one project.

### D3. Deployment topology

| Setting | What runs |
|---|---|
| Local tool (phases 0 to 3) | one host process, one browser tab; the host is started by the app launcher or by Claude Code |
| Hosted (phase 4) | one server process per instance: same host code serving the web app, the bridge, the in-app agent and the API; the MCP adapter stays off unless an operator enables it for an integration |
| Tests | the host in-process with a fake bridge; tools called as functions |

Scaling the hosted version means scaling this one server. MCP never carries
production traffic, so it has no scaling story of its own.

### D4. Viewer bridge protocol

JSON messages with explicit ids, one per WebSocket frame, so framing and
correlation come from the transport.

```
client -> host
  { id, type: "hello", clientVersion, capabilities: ["render", "plan"] }
  { id, type: "command", command } | { id, type: "transaction", label, commands }
  { id, type: "undo" } | { id, type: "redo" }
  { id, type: "get", what: "snapshot" | "history" | "selection" }
  { id, type: "render.result", requestId, images: [{ view, pngBase64 }] }

host -> client
  { id, type: "welcome", hostVersion, protocolVersion, projectId }
  { id, type: "result", ok, result | error }
  { type: "snapshot", project, historyPosition }
  { type: "changes", changeSet, historyPosition, origin: "agent" | "editor" | "import" }
  { type: "render.request", requestId, views: [...], hideWalls, focusId }
  { type: "problems", problems }
```

`protocolVersion` is an integer; a mismatch is refused with a message that
says which side to update.

### D5. Single writer, serialised commands

All commands from all callers, in-process agent, bridge, or MCP adapter, go
through one queue in the host and are applied strictly in order. Reads are
served from the current snapshot without queueing.

### D6. Rendering flows through the viewer

The host has no GPU. The `render` tool sends a `render.request` to a
connected viewer with the `render` capability, waits for `render.result`,
and returns the images. With no viewer connected the tool returns an error
that says so, and the agent continues with `get_scene` and `validate`. A
headless browser fallback inside the same process is a phase 2 option.

### D7. MCP adapter transports and security

- stdio: when the host is launched by an MCP client such as Claude Code.
- HTTP: `POST /mcp` on the host's port, loopback only unless an explicit
  flag and a token are set. The port and process id are written to
  `.fpviz/session.json` in the project directory for discovery (ADR-012).
- The adapter serves the registry filtered by the caller's profile
  (ADR-006 D6) and honours the same timeouts as in-process calls.

### D8. Timeouts and limits

| Operation | Timeout |
|---|---|
| Reads | 5 s |
| Commands and transactions | 10 s |
| `render` | 30 s |
| `verify_product`, `import_plan` | 120 s, with progress |

Results are capped at 256 KB; larger results paginate with a cursor and an
explicit `truncated` flag.

### D9. Session lifecycle

`open`, `save`, `close`, `checkpoint`, `restore` are host operations exposed
as registry tools and as bridge messages. A host serves one project at a
time in phases 0 to 3. Autosave writes a recovery file every 60 seconds when
modified (ADR-012).

## Alternatives considered

- **MCP as the primary interface with the in-app agent as an MCP client.**
  Rejected: it would put a protocol between two parts of one process and
  make MCP look like a service to deploy.
- **A separate MCP server process.** Rejected by the single-deployment
  constraint.
- **Browser-authoritative, MCP proxies to the tab.** Rejected: no headless
  operation and state lost when the tab closes.
- **Engine entirely in the browser with no host.** Rejected: verification,
  the catalog database and the file system need Node anyway.

## Consequences

- `tools` replaces the `mcp-server` package in ADR-002; the adapter and the
  bridge live in `apps/host`.
- The in-app agent (ADR-007) calls tools as functions and shares the
  transcript recorder with the adapter, so a Claude Code session and an
  in-app session produce identical transcripts for replay tests.
- The web app is written as a replica: optimistic gestures, reconciliation
  on `changes` and `snapshot`.
- The single-deployment constraint is recorded here and in ADR-002 so no
  later ADR introduces a sidecar.

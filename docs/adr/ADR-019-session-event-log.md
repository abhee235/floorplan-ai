# ADR-019: A session event log

Status: Proposed
Date: 2026-09-18
Related: ADR-004 (command layer), ADR-005 (MCP and transports), ADR-007
(provider abstraction and agent runner), ADR-012 (project file format),
ADR-017 (editor shell)

## Context

The application keeps no record of what it did. There are four `stderr` lines
at startup and nothing else: no `console` call exists anywhere in `apps/host`
or in any package. The tools transcript is in memory, for replaying a session
as a regression test; only an agent run writes anything to disk.

The cost showed itself on 2026-09-18. "The cluster's outline moves but the
tables stay behind" took an hour to explain, and the only way to explain it was
to rebuild the scenario in a headless browser and read the host's state over a
second socket. The answer — a host process older than the reducers it was
running — was one line of history that nobody had written down. Three separate
false diagnoses came out of the same hole in the same day.

What makes this cheap to fix is that the architecture already funnels every
change through one place. `store.apply` and `store.transaction` are the only
ways the project changes, whoever asks: the editor, the agent, a tool, an
import. Both already emit `{ changes, origin, historyPosition, patches }`, and
the Immer patches are an exact diff — `item_7f position 3000,2500 -> 4500,1800`
is already in memory. Nobody is listening. This is a subscriber, not a
re-architecture.

## Decision

### D1. One line per event, JSONL, one file per host run

`<data>/logs/<started-at>.jsonl`, one JSON object per line, appended and
flushed as it happens so a crash keeps what came before it. A run is a file:
the question is almost always "what happened in this session", and a file per
run answers it without a date filter. Old files are pruned by count, not by
size, so the machine cannot fill up.

`tail -f` follows it; `grep item_7f` answers "everything that happened to this
object" without a tool.

### D2. Every event carries when, who and what changed

Common fields: `ts` (ISO), `seq` (per run), `kind`, `source` (the store's
`Origin`: editor, agent, import, undo, redo, restore, or `host` for the
process itself), and `ms` where something was timed.

Kinds:

- `command` and `transaction`: the command types, whether they were taken, the
  refusal code and message when they were not, the entities added, updated and
  removed, and the history position afterwards.
- `undo`, `redo`: what came back, by entity.
- `tool`: the name, whether it succeeded, its refusal, and how long it took.
- `bridge`: a tab connecting or leaving, its protocol version, and whether the
  host was behind its own source when it connected (ADR-019 is what makes that
  answerable after the fact).
- `file`: open, save, recover, and what was on disk.
- `problem`: a validation error or warning appearing or clearing, in words.
- `gesture`: what the person did — see D4.

### D3. Values, not codes

A move is logged as before and after: `{ id, path: "position", from, to }`.
The point of the log is that "where did this object go" is readable rather than
deduced, so patches are written out rather than counted. They are truncated
past a size and the count is kept, because a 200-desk arrangement is a
thousand patches and no one reads those; a project snapshot is never written at
all, and neither is any provider key.

### D4. The person's gestures are part of the log

The browser sends what it did over the bridge — the tool picked, the selection,
a drag beginning and ending, a value committed in the panel, the view mode —
and the host writes those lines into the same file, in order, beside the
commands they caused. A list of commands says what changed; a list of gestures
says what was being attempted. Reading "drew a cluster, dragged its edge,
released, zone.modify refused" is a story, and the story is what debugging
needs. A gesture is never trusted as an instruction: it is a line in a file.

### D5. On by default, and cheap

`FPV_LOG=off` turns it off, `verbose` keeps whole patch lists. Writing is
append-only, batched per tick, and never blocks a command: a log that slows the
editor would be turned off and then it would not be there on the day it was
wanted.

### D6. The host writes it, the packages stay pure

`packages/commands` gains nothing but a `commands` field on the event it
already emits, so a subscriber can say what was asked as well as what changed.
Everything else — files, rotation, formatting — is `apps/host`, which is where
I/O belongs (ADR-002).

## Alternatives considered

- **A logging library.** Rejected: one writer of one shape needs no levels,
  transports or plugins, and a dependency here would be larger than the code.
- **Logging at each call site.** Rejected: that is how logs drift from
  behaviour. The store is the only way the project changes, so the store's
  event is the only place that cannot be forgotten.
- **Keeping only the tools transcript.** It records tool calls, not the
  editor's commands, and only in memory. It stays what it is: a replayable
  regression test (ADR-007 D4).
- **Logging in the browser.** The tab is a replica; it can be reloaded, and its
  console is gone when it is. The host outlives it and owns the truth.

## Consequences

- Reporting a defect starts with a log file, not a reconstruction. The first
  question becomes "what does the log say", which is answerable by the person
  who saw it.
- The log is a support surface: it names file paths, project names and entity
  ids. It stays local, is never sent anywhere, and never holds a key.
- A hosted deployment (P4-2) will want one log per session and a retention
  rule; the file-per-run shape is already that, and the pruning rule is the
  only thing to revisit.

# ADR-004: The command layer is the only mutation path; transactions, undo, and change sets

Status: Proposed
Date: 2026-09-14
Supersedes: section 5.3 (commands) of 00-brainstorm.md
Related: ADR-001 (IR), ADR-005 (MCP), ADR-006 (tools), ADR-015 (invalidation)
Ledger lines this ADR must satisfy: W-029..W-047, W-084..W-090, O-040..O-050, R-040, R-041, R-108..R-112, F-053..F-061, F-145..F-163, F-192

## Context

Hand-written undo, one class per edit with old and new value snapshots, grows
into dozens of classes plus special cases for drags, wall joins and door
bindings, and bugs cluster where those mutation paths diverge (W-030, W-033,
W-087, W-152).

We have three mutation sources from day one: MCP tools driven by Claude Code,
the human editor, and later the in-app agent. They must share one path.

## Decision

### D1. Commands are data, applied by pure reducers

```
Command = { type: string, payload: object }        // discriminated union, zod-validated
apply(project, command, ctx) -> Result
Result = { ok: true, project, changes: ChangeSet, inverse: Patch[] }
       | { ok: false, error: CommandError }
ChangeSet = { added: EntityRef[], updated: EntityRef[], removed: EntityRef[] }
CommandError = { code: string, message: string, entityId?: string, hint?: string }
```

- Reducers are pure functions of the project and the command. Side effects
  (id generation, clock) come through `ctx`, injected for tests.
- Reducers run on an Immer draft; Immer produces forward and inverse patches.
  Undo applies inverse patches; redo applies forward patches. No hand-written
  undo classes.
- A command either applies completely or returns an error and leaves the
  project untouched. Validation (ADR-001 D6) runs on the result; a command
  that would violate an invariant fails with the validation problem as its
  error.
- Error messages are written for a model to act on: they name the field, the
  valid range, and the value received, and
  carry a `hint` with the closest valid call when one is obvious.

### D2. Command catalogue, first cut

Structure: `wall.create`, `wall.createChain` (polyline, closed flag, auto-join),
`wall.modify`, `wall.move` (with neighbour propagation, W-031, W-032),
`wall.split` (W-037, W-038), `wall.join`, `wall.reverse` (W-034, W-035),
`wall.delete` (cascades openings, detaches both neighbour ends, W-029, W-030
fixed), `opening.add`, `opening.modify`, `opening.delete`, `room.create`,
`room.detect` (from wall union at a point), `room.modify`, `room.setPolygon`,
`room.delete`, `level.add`, `level.modify`, `level.delete` (cascades, R-108),
`zone.create`, `zone.regenerate`.

Items: `item.place`, `item.move`, `item.rotate`, `item.resize`, `item.setElevation`,
`item.setProduct`, `item.setParent`, `item.mirror`, `item.duplicate`,
`item.delete`, `item.arrange` (pattern over a zone), `item.align`,
`item.distribute`.

Project: `project.setMeta`, `annotation.*`, `catalog.snapshot`.

Each command has a zod payload schema. The same schema becomes the tool
schema in ADR-006 after flattening.

### D3. Transactions

- `begin(label)`, `commit()`, `rollback()`. Commands applied inside a
  transaction accumulate into one history entry with one label. A drag is
  one transaction (F-154); a keyboard nudge is one transaction per press
  (F-192); a paste is one transaction (F-159); grouping is one (F-160).
- Transactions are **atomic**: if any command fails, the whole transaction is
  rolled back and the error returned. This is the batch semantics the MCP
  batch tool inherits (ADR-006).
- Nested `begin` calls are flattened into the outer transaction.

### D4. History

- History is a list of entries `{ label, forward: Patch[], inverse: Patch[],
  selectionBefore: string[], selectionAfter: string[], at: timestamp }`.
- Undo restores `selectionBefore`; redo restores `selectionAfter` (F-157).
- A new entry after undo discards the redo stack (F-161).
- A transaction that produced no patches is not recorded (W-086, F-154).
- A cancelled gesture (Escape) rolls back its transaction and records nothing
  (F-162).
- History is capped at a configurable depth, default 200 entries, and is not
  persisted with the project (P-052). A checkpoint tool (ADR-006) snapshots
  the whole project separately for agent rollbacks.
- Modified state is `history position != saved position`, so undoing back to
  the saved point clears the modified flag.

### D5. Change sets drive everything downstream

Every successful apply emits a `ChangeSet` with entity refs
`{ type, id }`. The dependency graph (ADR-015) expands it into the set of
entities whose derived geometry must be rebuilt. The plan view, the 3D
viewer, the BOM, and tool results all consume change sets; nobody diffs the
project.

For walls, `changes.updated` always includes the joined neighbours and the
openings on the wall, because the reducer knows it touched them (W-119,
O-102). For rooms, `room.setPolygon` includes rooms that overlapped the old or
new polygon on the same level (S-026).

### D6. Selection is application state, not IR

Selection lives beside history in the editor store, is included in history
entries for restoration, and never enters the IR or the tool results except
where a tool explicitly asks for it.

### D7. Determinism and replay

Because commands are data and reducers are pure, a command log can be
replayed to rebuild a project. Tests use this: a fixture is a project plus a
command list plus the expected project. The MCP server can record the
commands an agent issued as a transcript for later regression tests across
providers (00-brainstorm.md, risks).

## Alternatives considered

- **Hand-written undo per operation.** Rejected; it multiplies mutation paths
  and classes, and the paths diverge.
- **Event sourcing as the persisted format.** Rejected for the project file;
  the IR snapshot is the file, and the command log is optional tooling.
- **Mutable model with listeners.** Rejected; it forces every consumer to diff
  or to trust listeners, and cache invalidation spread across listeners ends
  up incomplete (W-010, W-011).
- **Non-atomic batches with a checkpoint before.** Rejected;
  half-applied batches from a weak model are worse than failures.

## Consequences

- `commands` is the largest package in phase 0 and where most ledger tests
  land. Each reducer is a pure function with a table-driven test.
- Immer is a dependency of `commands`; the IR objects must stay plain data
  (no classes), which ADR-001 already requires.
- The editor must express every gesture as a transaction of commands. This
  is more code than mutating in place but is the only way the three mutation
  sources stay identical.
- ADR-006 tool descriptors are generated from command schemas, so a new
  command becomes a tool with no extra schema work.

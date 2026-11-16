# ADR-023: Who made this: authorship on every entity, and consent before the agent changes a person's work

Status: Proposed
Date: 2026-09-20
Related: ADR-001 (entity model), ADR-004 (commands and patches), ADR-012
(project file format), ADR-019 (session log), ADR-022 (agent roles), spec 01,
spec 03, spec 04

## Context

A person and an agent now work on the same drawing, sometimes at the same
time. The agent builds a flat; the person does not like where the sofa went
and drags it round to face the window; the person asks the agent to add a
dining table; the agent, tidying, notices the sofa is not where its recipe put
it and moves it back. Nothing in that sequence is a bug. Every step is a
sensible thing for its actor to do. The result is a person who has learned
that the agent undoes their work, which is the last thing they will learn
about it.

The owner put it as a rule: the agent must be able to tell that an object was
placed, designed or changed by the person, and when it wants to change such an
object it must ask first, or leave it alone.

What the system knows today: the store is told, on every command, who asked
for it. The `Origin` type has `editor`, `agent`, `import`, `undo`, `redo` and
`restore`, the session log writes it on every line (ADR-019), and the tool
transcript carries it. But the *document* knows nothing. A wall is a wall.
Once the session log is gone, and it is per session, nobody can say who drew
it, and no tool can ask.

## Decision

### D1. Every entity records who made it and who last changed it

Walls, openings, rooms, items, zones, annotations and levels gain one field:

```ts
export const Author = z.enum(["person", "agent", "import", "unknown"]);
export const Authorship = z.object({
  createdBy: Author,
  editedBy: Author,            // whoever wrote it last
  editedAt: Timestamp,
  /** A person has created or changed this at some point. Never cleared by an edit. */
  touchedByPerson: z.boolean(),
});
// on every entity:
  by: Authorship,
```

`Author` is not `Origin`. `editor` becomes `person`, because that is what it
means and what the rule is about. `undo`, `redo` and `restore` are not authors:
they replay patches, and the patches carry the stamps of whoever made the
change being undone, so undoing an agent's move of a person's sofa restores
`editedBy: "person"` by itself. That is the reason the stamp is part of the
document and not kept beside it.

`touchedByPerson` is the sticky bit the owner's scenario needs. `editedBy`
alone would flip back to `agent` the moment the agent changed the sofa with
permission, and the next run would treat the sofa as its own. A person who has
touched a thing keeps it until they delete it.

Existing documents migrate to schema version 5 with `createdBy: "unknown"`,
`editedBy: "unknown"`, `touchedByPerson: true`. When nobody knows, it is the
person's. That is the safe direction for trust and the wrong direction for
nothing.

### D2. The command layer stamps; nothing else may

The stamp is written in `apply`, in the same Immer pass that runs the reducer,
from the origin the store was given, over the entities the change set names as
added or updated. Reducers do not know about it. Tools cannot set it: the
payload schemas do not accept a `by` field, and a payload that carries one is
refused like any unknown field. So a stamp says who actually held the store's
handle when the command ran, which is the one thing a stamp is for, and no
role can say it is another.

Who holds the handle is settled where it always was: the bridge passes
`editor` for a tab's own commands and tool calls, the agent loop passes
`agent`, `import_plan`'s commit passes `import`, and the MCP adapter passes
`agent` because an external model is an agent whatever it is called.

### D3. A person's work is theirs; the agent asks before changing it

The rule, for the agent:

- It may freely change, move or delete what it made and nobody touched.
- It must ask before changing, moving or deleting anything with
  `touchedByPerson` or `createdBy: "import"`. An imported plan is the
  person's material: they chose it and confirmed its scale.
- Selection is consent. The message that starts a run carries the editor's
  selection; those entities are released for that run, because a person who
  selects the sofa and types "turn this round" has said what they meant.
- An answer is consent for that run only. A person who says "yes, move it"
  has not said "and anything else, ever". Authorisation stands for the scope
  given, not beyond it.

The question is asked with `ask_user`, kind `consent`, naming the entities and
what the agent wants to do with them and why, with three answers: change them,
leave them, leave everything of mine alone for this run. The last one exists
because the second question is the one that makes a person stop reading.

### D4. Enforced by the registry, not by the prompt

The prompt states the rule, and a model that reads it asks for the right
reason. The registry makes it true for the model that did not. A mutating tool
call carries the set of entity ids released for this run. After the tool has
run, if its change set updated or removed an entity that is protected and not
released, the registry undoes the entries the call recorded and answers:

```
{ ok: false, error: { code: "consent.needed",
  message: "wall_000012 and item_000031 were changed by the person; ask before changing them",
  entityId: "item_000031",
  hint: "call ask_user with kind consent and the ids, then repeat the call" } }
```

After, not before, because a tool does not know what it will touch until it
has, and the store already knows how to take a call back. The cost is one
extra look at the change set on mutating calls, which the registry already
makes for `problems`.

This is where trust is kept. A rule that lives only in a prompt is a rule the
model keeps most of the time, and "most of the time" is the failure mode the
owner named.

### D5. The person can see it

- The properties panel says who made the selected thing and when: "Placed by
  the agent, run 3, 14:02" or "Drawn by you". Nothing is hidden behind a
  hover.
- The plan can show the agent's work as a layer, so after a run the person
  sees at a glance what changed without reading the chat.
- The consent question is a card in the chat that names the entities, selects
  them on the plan when it appears, and offers the three answers of D3.
- The session log (ADR-019) keeps recording origin per event as before; the
  document stamp is the durable form, and it travels with export (ADR-012:
  explicit fields, nothing omitted).

### D6. Undo and the run checkpoint

"Undo this run" restores the checkpoint taken before the run. If the person
edited during the run, those edits go too; the chat says so on the undo card
when the log shows editor commands between the checkpoint and now, and offers
the finer undo of the history panel instead. The stamps make that sentence
possible: the log can count the person's commands, and the history can show
which entries are theirs.

### D7. Whose it is, and when it was read, are two questions

**Added 2026-09-20.** Everything above answers "whose is this?" and refuses an
agent that changes a person's work without leave. It says nothing about an
agent whose information is out of date — one that read a room a minute ago, and
moves a sofa to where something now stands, having every right to move it.

That second failure is ADR-022 D7: a revision on the store, a revision on each
entity, `basedOn` on a mutating call, and `stale.read` with the current value
when they disagree. The two guards sit side by side in `Registry.call` and
neither replaces the other. A consent refusal says "ask them"; a staleness
refusal says "look again".

## Alternatives considered

**A lock the person sets.** A padlock on an entity meaning "agent, hands off".
Rejected as the mechanism, kept as a possible nicety. Nobody locks the sofa
before dragging it; the drag is the statement. Authorship records the
statement they already made.

**Origin at creation only.** One field, `createdBy`. Rejected: the scenario is
an agent-placed sofa the person tweaked, and creation says nothing about that.

**The rule in the prompt only.** Rejected for the reason in D4. The owner's
concern is trust, and trust cannot rest on the model having read a sentence.

**Keep provenance in the session log and query it.** Rejected: the log is per
session and per machine, the document is forever and travels; and a tool
asking "who touched this" should read the entity in front of it, not search a
file.

**Ask before every change to anything.** Rejected by the owner when the loop
was designed: approvals fatigue. The line is drawn at a person's work, which
is the one place a wrong change costs something that undo cannot give back:
the person's confidence.

**Stamp in the reducers.** Each of the forty reducers writing the field.
Rejected: forty places to forget, against one place that already knows every
entity a command touched.

## Consequences

- Schema version 5; a migration with fixture pairs as ADR-012 requires; every
  entity default in `defaults.ts` gains `by`; spec 01 documents it.
- `apply` takes the origin in its context; the store passes it. The `Author`
  mapping from `Origin` lives in one function.
- The registry's `CallOptions` gains `released: ReadonlySet<string>`; the
  runner keeps the set per run from selection and consent answers; the loop
  tool `ask_user` gains kind `consent`.
- Views (`get_scene`, `describe_room`, the item and wall views) show `by`, so
  a model can see what it must ask about before it tries.
- The editor: properties panel line, the agent-work layer, the consent card.
- Tests: a person moves an agent-placed item and the next run's attempt to
  move it is refused and answered; undo restores the stamp; selection
  releases; migration of a version-4 document; MCP calls are stamped `agent`.
- Cost: one field on every entity, about forty bytes; nothing measurable.
- Not decided here: whether a person can hand an entity back to the agent for
  good ("you may always move this"). A per-entity release would be the lock of
  the first alternative in reverse, and it can wait until somebody asks for it.

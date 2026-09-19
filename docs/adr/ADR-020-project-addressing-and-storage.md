# ADR-020: How a project is addressed and where it is stored

Status: Proposed
Date: 2026-09-19
Related: ADR-005 (transports and the single deployment), ADR-012 (project file
format), PRD P3-10 (managing projects from the editor), PRD P4-2 (hosted
deployment with login and multiple projects)

## Context

ADR-012 settled what a project *is*: a directory holding `project.json` and
`manifest.json`, written atomically, with a manifest hash, migrations and a
recovery file. P3-10 gave the editor a way to open and save those directories.

Two questions were left open, and they turn out to be the same question.

**Where the bytes live when nobody owns the machine.** P4-2 wants the host
deployed as one server with login and several projects. A directory on a disk
is not an answer there, and "put it in a database" is not one either until it
says *what* goes in the database.

**How a project is named from outside itself.** The editor serves one URL,
`http://127.0.0.1:<port>/`, and it shows whatever project the command line
opened. Open a second tab and it is identical. Bookmark it and you have
bookmarked "whatever that host happens to hold". Nothing in the address bar,
the page title or the browser history says which floor plan is on screen, and
nothing can ask for a different one. For a tool started from a terminal with
`--project` that was tolerable; for something served over HTTP it is a hole,
and it was reported as one.

These are the same question because a URL needs a way to name a project, and
so does a database row. Answering one answers the other.

A confusion worth recording, because it steered an earlier answer wrong: the
project's standing rule is that it deploys as **one application on one
infrastructure**. That rule is about *our* services — no MCP server, no render
worker, no sync daemon. A managed database sitting beside the application is
normal hosting and was never excluded by it.

## Decision

### D1. A project is addressed by an opaque string, not by a path

Everything above `ProjectFiles` treats a project's address as a string it does
not interpret. Today that string is a directory path, because that is what a
project is. When a project lives in a hosted store it will be an identifier.
Nothing that holds an address — the editor, the URL, the recent list, the menu
— is allowed to parse one, join one, or assume a separator is in it.

`ProjectFiles` is already the seam: `open`, `save`, `path`, `recoveryAt`,
`forget`, `watch`. The tools call it and know nothing about files. A hosted
store is an implementation of that interface, not a rewrite.

The project's own `meta` has no id, and none is added here. An id that lives
*inside* the document is a claim about identity that copying a folder would
duplicate; identity belongs to whatever holds the document.

### D2. The address goes in the URL, and the project's name in the title

The URL carries the open project as one query parameter:

```
http://127.0.0.1:4360/?project=<the address, percent-encoded>
```

- Arriving with a `project` that is not what the host holds **opens it**, with
  the same unsaved-work prompt the File menu uses.
- When the open project changes for any reason, the URL is rewritten with
  `history.replaceState`, so the address bar always names what is on screen.
- `replaceState`, deliberately, not `pushState`: Back would otherwise reopen a
  previous project and discard unsaved work on a keystroke nobody aimed.
- A project with no file yet carries no parameter, because it has no address.
- `document.title` becomes the project's name, with the unsaved mark, so a row
  of browser tabs can be told apart without opening them.

**One host holds one project at a time, and the URL does not change that.**
Two tabs on one host are two replicas of one store: today, File ▸ Open in one
already changes the other. Giving the URL the power to open makes that visible
rather than worse. A tab per project is a *session* question, answered in D4,
not an addressing one.

### D3. The document is a document; the database holds facts about it

When a hosted store arrives:

- The project is stored **whole**, as one JSON object — a file, an object in a
  bucket, or a single column. It is never decomposed into rows for walls,
  rooms and items.
- A relational table holds what is true *about* projects: who owns one, what
  it is called, when it changed, its schema version, who may open it.

Three reasons this is not taste. Our changes are JSON Patches whose paths
address a document (`items/17/transform/x`); against tables each one needs
translating into an UPDATE, for ever. We always load the whole project and
never query across them — there is no "every wall thicker than 100mm in every
project" — so decomposition buys nothing and costs joins, transactions and a
migration for every schema change. And the document is small: the six-wall
fixture is 4KB, the boardroom with its catalog snapshot 26KB, two hundred
desks a few hundred KB. Size decides nothing here, so it must not be used to
argue for a shape.

This is what the drawing industry converged on. Document-management systems
put metadata, versions and permissions in a relational database and leave the
documents as files; the cloud-native exceptions that dissolved documents into
a database did it as a product bet against ever working offline.

### D4. A session per open project, when hosting needs it

P4-2's "multiple projects" is a session question. Today one host process is
one session holding one store, and the bridge broadcasts to every tab. A
hosted deployment gives each open project its own session, and a tab attaches
to one; the address in D2 is how a tab says which.

Nothing in D1–D3 changes when that happens, which is the point of doing them
first.

### D5. The change stream stays unpersisted, for now

Every change already exists as a command and an immer patch, and both are
already sent to replicas. They are not stored: a save writes the whole
document, and the session event log (ADR-019) deliberately truncates values,
so it records what happened for a reader and cannot be replayed.

Persisting that stream would give recovery to the last action instead of the
last sixty seconds, an undo history that outlives the process, and the
foundation for several people editing at once. It is not done here because it
changes what undo *means* — whose action does an undo take back — and that is
a decision about editing, not about storage.

Revisit when any of these becomes true: two people must edit one project;
version history becomes a feature rather than a file in a folder; or the
sixty-second recovery window in the quality requirements is judged too wide.

## Alternatives considered

- **A table per entity kind.** Rejected: see D3. It is the shape that looks
  most like "using a database properly" and serves this document model worst.
- **The project as a `jsonb` column.** Not rejected, and the likely first step:
  it is simple and easy to walk back from. Noted only because every save
  rewrites the whole row, which stops being free with concurrent editors —
  object storage is the better default once there are any.
- **SQLite as the project file format.** Already rejected in ADR-012, for
  readability and diffs, and that still holds: a JSON directory can go into
  git, be reviewed in a pull request, and be read by a person in ten years.
  Worth revisiting only if a project ever grows past the point where writing
  it whole is affordable.
- **No files at all, documents only in a hosted database.** Rejected: it
  removes the user's ownership of their own work, which is a product property
  worth more than the architecture it costs. Keep the file as the portable,
  backed-up, mailable form.
- **The path in the URL as a route** (`/p/C:/Users/...`). Rejected: a path is
  not a route, it needs escaping that breaks on every platform differently,
  and it hard-codes into the URL shape the assumption D1 exists to prevent.
- **`pushState` so Back walks through projects.** Rejected: see D2. Losing
  unsaved work to a Back button is not a trade worth the convenience.

## Consequences

- The URL, the recent list and the menu all carry the same opaque address, so
  a hosted store changes what an address *is* without changing anything that
  passes one around.
- A link to a running host names a project. On a local host, following one
  switches what that host has open — including for another tab already on it.
  That is the single-session model being honest, and it is what D4 resolves.
- `welcome.projectId` currently carries the project's *name*. It is misnamed
  and nothing should read it as an identifier.
- The quality requirement "a crash never loses more than 60 seconds" stays as
  it is, resting on the recovery file, until D5 is revisited.

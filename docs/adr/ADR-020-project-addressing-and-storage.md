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

### D1. A project has an id of its own, and it lives in the document

**Amended 2026-09-19.** The first version of this said the opposite: that a
project's address is an opaque string, that today it is a directory path, and
that no id belongs inside the document because copying a folder would duplicate
it. Identity, it said, belongs to whatever holds the document.

That was wrong as soon as a link had to survive being moved. A registry keyed
by location orphans every link the moment a folder is dragged somewhere else,
and a path in a URL is not opaque in any useful sense: it leaks the machine's
layout into browser history, it cannot be sent to anyone, and it breaks on a
rename. Identity has to travel WITH the project.

So `meta.id` is twelve base36 characters, in the document, schema version 4.

- A **new** project draws its id at random. Two blank projects made in the same
  millisecond are not the same project, and a new one has no content to be told
  apart by.
- A project written **before ids** gets one derived from what it already says:
  when it was made, what it is called, the ids of the first few things it
  holds. Migrations are pure functions with fixture-pair tests, so a random id
  could not be one — and derived is the better answer anyway, because the same
  file migrated on two machines comes out with the same id and a link made on
  one works on the other.
- A **copy** of a project keeps the original's id. That is the truthful answer:
  it is the same project. The registry points an id at wherever it was last
  seen.

Where a project LIVES is still an opaque string, and nothing above
`ProjectFiles` may parse, join or split one. That part stands.

### D1a. What knows where a project is

A SQLite table in the data directory — `projects(id, address, name, created_at,
last_opened_at)` — written by the file store itself, because a project is
opened and saved from four places and a list only some of them updated would be
worse than none. SQLite because it is a library and not a service: no port, no
connection string, no second process, and the catalog has used the same one
since ADR-008 D5. It is the "facts about projects" row of D3, so a hosted
deployment turns it into a Postgres table without changing anything above it.

A consequence worth stating plainly: **a link to a project this installation
has never opened cannot be followed.** Nothing here knows where that project
is. The editor says so and says what to do about it, rather than failing as
though the project were missing.

### D2. The address goes in the URL, and the project's name in the title

The URL names the open project by id:

```
http://127.0.0.1:4360/p/g0z9i3cvo7qx
```

**Amended 2026-09-19**: this was a query parameter holding the project's
directory, which is what D1's amendment is about. A path in the address bar
writes the machine's layout into browser history and bookmarks, breaks when the
folder moves, and cannot be sent to anyone.

A project's URL is a route, not a file, so the server answers any path without
an extension with the app. A path WITH one stays a 404, so a mistyped script
fails loudly instead of being handed a page.

- Arriving with a project id **attaches this tab to it**, opening it if this
  host is not already holding it.
- When the open project changes for any reason, the URL is rewritten with
  `history.replaceState`, so the address bar always names what is on screen.
- `replaceState`, deliberately, not `pushState`: Back would otherwise reopen a
  previous project and discard unsaved work on a keystroke nobody aimed.
- A project with no file yet carries no parameter, because it has no address.
- `document.title` becomes the project's name, with the unsaved mark, so a row
  of browser tabs can be told apart without opening them.

**Superseded 2026-09-19.** This paragraph said one host holds one project at a
time, and that two tabs were two replicas of one store, so opening in one
changed the other. D4 is built, so that is no longer true: a tab attaches to
one project and the others are left alone.

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

### D4. A session per open project

**Built 2026-09-19**, rather than deferred to hosting: one host was one
session holding one store, so two tabs were two views of one document and
opening a project in one changed it under the other.

A workspace holds a session per project, keyed by the project's id. A tab says
which one it wants in its hello and sees only that one. Opening, making,
attaching to and closing are workspace operations, so File ▸ Open gives a
project a session of its own and moves only the tab that asked.

Four things follow, and each was a defect waiting to happen:

- **The change sequence is counted per project.** A replica refuses any change
  that does not follow the one it holds and asks for a fresh snapshot, so a
  single counter would have made every edit in one project look like a gap to
  every tab on another, throwing away sessions over changes they were never
  sent.
- **Each project gets its own view of the session log**, stamped with the
  project a line is about, carrying its own copy of what the project was before
  the change. One shared copy would diff a change to one project against the
  state of another and name the wrong thing as having changed.
- **A render goes to a tab looking at the project that asked for it.** Any
  other tab would have returned a good picture of the wrong building.
- **The unsaved-work prompt became unreachable and was replaced.** Opening no
  longer discards anything, because the project a tab leaves stays open with
  its work in it. Closing does discard, so that is where the question moved:
  File ▸ Close project. Closing the last project leaves an empty one, so a tab
  always has something to draw.

What is open is pushed to every tab, not asked for, because the set changes
when another tab opens or closes something. View ▸ Switch project shows it.

**What this does not do.** Every open project is held in memory until it is
closed, with no eviction and no bound. That is right for a person with a few
projects open and wrong for a shared host, where it is the first thing that
must change — together with identity, since everything here still assumes one
trusted local user.

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
- **Keeping identity out of the document** (D1, as first written). Reversed: a
  link that does not survive the project being moved is not much of a link.
- **A random id in the 3-to-4 migration.** Rejected: migrations are pure and
  fixture-tested, and a derived id makes the same file come out with the same
  id on every machine, which is what makes a link portable.
- **Closing a project when the last tab on it goes away.** Not done: a tab is
  closed by accident far more often than a project is finished with, and the
  work is unsaved. Projects are let go of deliberately, through File ▸ Close.

## Consequences

- The URL, the recent list and the menu all carry the same opaque address, so
  a hosted store changes what an address *is* without changing anything that
  passes one around.
- A link to a running host names a project. On a local host, following one
  switches what that host has open — including for another tab already on it.
  That is the single-session model being honest, and it is what D4 resolves.
- `welcome.projectId` carried the project's *name* until ids existed. It
  carries the id now.
- Memory grows with the number of open projects and nothing reclaims it. A
  long-running shared host needs eviction before anything else.
- The quality requirement "a crash never loses more than 60 seconds" stays as
  it is, resting on the recovery file, until D5 is revisited.

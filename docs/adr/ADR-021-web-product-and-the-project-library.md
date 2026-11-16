# ADR-021: This is a web product, and projects live in a library the app owns

Status: Proposed
Date: 2026-09-19
Related: ADR-005 (one host process, single deployment), ADR-012 (project file
format), ADR-020 (project addressing and storage), PRD P4-2 (hosted deployment
with login and multiple projects)

## Context

The delivery model was never decided. It was assumed, differently, in two
places, and nobody noticed until the editor tried to satisfy both.

**ADR-012** says a project is a directory, and P3-10 gave the editor a way to
pick one: the host listed the machine's folders and the browser drew them, with
a path box and a Places sidebar. **PRD P4-2** says the product is a hosted
deployment with login and several projects. A hosted product cannot let a
browser choose a folder on the server, so those two cannot both be true.

The folder browser only worked because the server and the person were the same
machine. Two things should have stopped it being built:

- A browser will not hand a server a local path. A file input returns files the
  *browser* chose, with no path the host could open. The File System Access API
  hands out directory handles that belong to the tab, which the host process
  can never read. This is not a gap to work around; it is the boundary between
  a page and a machine, and it is there on purpose.
- ADR-020 already recorded that the browse message would have to be switched
  off before the host was exposed to anyone else, because listing arbitrary
  directories to whoever connects is a remote file read. **A feature that must
  be disabled to ship the product is the wrong feature**, and writing that down
  as a "blocker" rather than as a design error was the mistake.

## Decision

### D1. The product is a web application

One host, served over HTTP, reached in a browser. Everything the editor can do
must make sense when the host is not the person's own machine.

This does not rule out a desktop build later. A Tauri or Electron shell would
be a *different front end* over the same host, and native Open and Save would
be features of that shell. What is ruled out is asking a browser user to name a
path on a server.

### D2. Projects live in a library the app owns

A project's folder is its id (ADR-020 D1), under one library directory — by
default `<data>/projects`, which an installation may point elsewhere as an
administrator's decision made once, not a question put to whoever is drawing a
floor plan.

Nothing above the library module knows this. The editor addresses projects by
id, and **no path is ever sent to a browser**: not in a listing, not in a
result, not in the URL. A tab that is never told a path cannot put one in a
bookmark, a screenshot or a bug report, and cannot be used to read the disk.

**The file format does not change.** A project is still the ADR-012 directory —
`project.json`, the manifest, atomic writes, recovery — so it can still be
copied, backed up, committed to git and read in ten years. What changed is who
chooses the location: nobody.

### D3. Open is a list; New writes at once; Save is only save

- **Open** shows the library: name, when it was last opened, which one this tab
  has. Not a folder tree.
- **New** creates the project on disk immediately. That removes the "not saved
  anywhere yet" state entirely, and with it Save as, the path box, and any way
  to lose a new project by closing a tab.
- **Save** writes the project where it already is. There is no second kind of
  save.
- A new project is numbered when the library already holds that name —
  `Untitled 2` — because six things called Untitled is a list of nothing. Names
  need not be unique, but the app must not be what makes them collide.

### D4. The person's own disk is reached by import and export

This is the only crossing, and the browser makes it:

- **Export** gathers a project and sends it as one file the browser downloads,
  to wherever that person keeps things.
- **Import** takes such a file back and puts a project in the library.

Both work identically whether the host is on the same machine or in another
country, which is the test every feature here has to pass.

### D5. The host may still be told to open a directory; the editor may not

`--project <path>` and the `project` tool's path-based open stay, for the
command line, for tests and fixtures, and for an agent driven over MCP on a
developer's own machine. They are how an operator starts a host, in the same
class as a config file.

The rule is the boundary, not the capability: **anything reachable from a
browser addresses projects by id and by nothing else.** When the host is
hosted, the path-based entry points are the operator's, and identity is what
decides who may ask — which is still to be built and is named in ADR-020 D4 as
the first thing a shared host needs.

## Alternatives considered

- **Commit to a desktop application** (Tauri or Electron), keep real file
  ownership and native dialogs. Coherent, and rejected because it means
  dropping P4-2. Still available later as a shell over the same host.
- **Keep both, with the folder browser behind a local-only flag.** Rejected:
  the gate becomes the only thing standing between a listening socket and the
  disk, and it has to be right for ever. Removing the feature is simpler than
  defending it.
- **Let the person choose a folder inside the library.** Rejected: a folder
  they can name is a path they have to remember, which is the problem this
  removes. Organising by name, and later by tags or search, needs no
  directories.
- **Keep Save as, writing a copy into the library.** Not kept as "Save as",
  which means "put this somewhere". Duplicate is the honest name for it and
  belongs with rename, which is not built yet.

## Consequences

- The folder browser, the places sidebar, the path box, the Documents projects
  folder and Save as are all gone; the change removed more code than it added.
- `recent` becomes the library listing. It stops being "paths I have visited"
  and becomes "the projects that exist here".
- Deleting a project is now possible and necessary, since New always writes
  one. It is in the list, behind a second press.
- Renaming, duplicating, import and export are not built. Until export exists
  there is no supported way to get a project out of the library, which is the
  next thing to do.

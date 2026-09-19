# ADR-012: Local-first project file format, atomic save, migrations, and recovery

Status: Proposed
Date: 2026-09-14
Supersedes: "Local-first project file format" in 00-brainstorm.md section 9
Related: ADR-001 (schemaVersion, catalogRefs), ADR-005 (host), ADR-010 (assets)
Ledger lines this ADR must satisfy: P-001..P-021, P-024..P-039, P-050..P-054, P-058, P-059, P-061

## Context

Projects are files on disk with no database in phases 0 to 3. A zip holding
a serialised object and every referenced asset is opaque to diff and needs
repair logic when content entries go missing, and saving by copying a
temporary file over the destination can leave a half-written file. We want a
format that is human-readable, diffable, self-contained for products, and safe
to write.

## Decision

### D1. A project is a directory, optionally zipped

```
<name>.fpviz/                 # directory form, used while editing
  project.json                # the IR (ADR-001), pretty-printed, stable key order
  manifest.json               # format version, app version, sha256 of project.json, asset list
  assets/                     # only custom assets not in the shared registry, named by sha256
  thumbnail.png               # last overhead render, optional
  history.jsonl               # optional command log for replay, off by default
<name>.fpviz.zip              # the same tree zipped for sharing; opened by extracting to a temp directory
```

Custom assets are referenced from the IR by asset key; the manifest maps keys
present in `assets/` to files. Shared registry assets (ADR-010) are not
copied into projects.

### D2. JSON conventions

- Pretty-printed with two spaces and keys in a fixed order per entity type,
  so diffs are meaningful and save-load-save is byte-stable (P-054).
- No omitted defaults. Every field the schema defines is written, which keeps
  the file explicit for agents and avoids the default-mismatch class of bug
  (C-011). Unknown fields are preserved on load and written back (P-037).
- Numbers are integers for lengths and plain decimals for degrees and
  fractions. NaN and Infinity are rejected on load (P-024 reversed).
- Colours are `#RRGGBB` strings. Timestamps are ISO 8601 with time zone.
- Ids are strings; forward references are allowed anywhere because the
  whole document is loaded before validation (P-032). Dangling references
  are validation problems, not silent nulls (P-033, P-035 reversed).

### D3. Atomic save

Write `project.json.tmp` and `manifest.json.tmp` in the project directory,
flush to disk, then rename each over its target. On Windows the rename uses
replace semantics. A copy-over save preserves file permissions; a rename
within the same directory preserves the directory's permissions, which is what
matters for us. A save failure leaves the previous
files intact and removes temporaries (P-020 fixed). Free space is checked
before writing.

### D4. Integrity and repair

`manifest.json` holds the sha256 of `project.json` and of each custom asset.
On load, a mismatch is reported; the project still opens with a "modified
outside the app" flag. A missing custom asset degrades to the placeholder box
(ADR-010 D5) and a validation problem; it never blocks opening.

### D5. Versioning and migrations

`manifest.formatVersion` and `project.schemaVersion` are integers. Loading
runs forward-only migrations in `ir/migrations`, each a pure function with a
fixture test from the old shape to the new one. Saving always writes the
current versions (P-050). Opening a file with a newer version than the app
supports is refused with a message naming both versions, rather than a
warning and a downgrade on save (P-051 tightened).

### D6. Recovery

While a project is modified, the host writes `recovery.json` beside
`project.json` every 60 seconds and removes it on a successful save. On open,
a newer recovery file is offered. Selection, undo history and view state are
never in the file (P-052).

### D7. Session discovery

`.fpviz/session.json` in the project directory records the host's port and
process id while a host has the project open (ADR-005 D6), and is removed on
close. A stale file is detected by the process id.

### D8. Managing projects from the editor

Every one of D1..D7 is driven by the `project` tool — `new`, `open`, `save`,
`info` — and until now nothing in the editor could call it, so a session could
only ever hold the project the command line named. The editor's File menu
offers New, Open, Open recent, Save and Save as, and each is that tool.

**Choosing a project.** A browser cannot show a native picker for a directory
on the machine running the host: its file input returns files the *browser*
chose, with no path the host could open, and File System Access handles belong
to the tab, not to the host process. So the host lists directories over the
bridge (`files` with `browse` and `recent`) and the editor draws the listing.
This adds no reach — `project open` and `project save` already take any path
the caller names — but it is the difference between choosing and guessing. The
path is editable outright for a place the listing cannot show.

**Recently opened.** Kept in `recent.json` in the data directory and written by
the file store itself, because a project is opened and saved from four places
(the command line, the editor, the MCP adapter, the in-app agent) and a list
that only some of them updated would be worse than none. Entries whose
directory has gone are dropped when the list is read, not when it is written:
a project on a drive that is not plugged in today is still worth remembering.

**Saying whether it is saved.** A save writes the file without moving the
store's history, so it emits no change and nothing in the change stream says
it happened. `project.state` carries the history position and the saved
position, and both sides call it modified when they differ.

**A new project has no file.** `project new` lets go of the open directory.
Without that the new project inherits the previous one's path and the next
save writes a blank project over it; that is not a hypothetical, it destroyed
a project during the first check of this feature. Save on a project with no
file asks where rather than failing.

**Recovery is a question for the person, not for stderr.** D6's newer-recovery
detection was reported only on the host's standard error, where nobody editing
in a browser will see it; work survived a crash and then sat unmentioned. The
editor asks. What this session's own autosave writes is never offered back:
`recoveryAt` means unsaved work from an *earlier* session, and nothing else.
Setting it from the autosave asked the question every sixty seconds and, being
a modal, tore down whatever menu was open at the time.

## Alternatives considered

- **Single zip as the working format.** Rejected: zips are not diffable and
  cannot be edited atomically per file; the zip form is for sharing only.
- **Omitting defaults to shrink files** (P-027). Rejected: explicit files are
  easier for agents and humans, and size is not a concern at this scale.
- **Digest-based de-duplication of embedded assets** (P-013..P-018). Not
  needed: shared assets live in the registry and custom ones are named by
  hash already.
- **SQLite project files.** Rejected for now: readability and diffs matter
  more than query speed for one project.
- **A typed path instead of a picker** (D8). Rejected: it puts the whole
  burden of remembering where things are on the person, and it cannot show
  what is there. The typed path is kept as the escape hatch beside the
  listing, not as the only way in.
- **Letting the browser pick, with the File System Access API** (D8).
  Rejected: the handle belongs to the tab, the host cannot open it, and the
  host is the only thing that can write a project.

## Consequences

- `ir` exports `serialize` and `deserialize` with the key-order rules and
  migrations; the host owns the file operations.
- A project directory can be committed to git by the user; that is a
  feature.
- The zip form uses the same manifest, so export and import are thin.

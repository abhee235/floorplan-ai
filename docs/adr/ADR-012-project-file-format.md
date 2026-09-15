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

## Consequences

- `ir` exports `serialize` and `deserialize` with the key-order rules and
  migrations; the host owns the file operations.
- A project directory can be committed to git by the user; that is a
  feature.
- The zip form uses the same manifest, so export and import are thin.

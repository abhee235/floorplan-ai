// Forward-only migrations (ADR-012 D5, spec 01 section 8). Each entry maps a raw document
// at version N to version N+1. Pure functions; every migration ships with a fixture pair test (P-047).
import { derivedProjectId } from "./project-id.js";
import { SCHEMA_VERSION } from "./schema.js";

export type RawDocument = Record<string, unknown> & { schemaVersion?: unknown };
export type Migration = (raw: RawDocument) => RawDocument;

/** Registry keyed by the version a migration upgrades FROM. */
export const MIGRATIONS: Map<number, Migration> = new Map();

export class MigrationError extends Error {
  constructor(
    readonly code: "file.version" | "file.newer" | "file.migration",
    message: string,
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

export function migrate(
  raw: RawDocument,
  registry: Map<number, Migration> = MIGRATIONS,
  target: number = SCHEMA_VERSION,
): { raw: RawDocument; migrated: boolean } {
  const from = raw.schemaVersion;
  if (typeof from !== "number" || !Number.isInteger(from) || from < 1) {
    throw new MigrationError("file.version", `schemaVersion must be a positive integer, got ${String(from)}`);
  }
  if (from > target) {
    throw new MigrationError(
      "file.newer",
      `file is schema version ${from}; this build supports up to ${target}`,
    );
  }
  let current = raw;
  let version = from;
  while (version < target) {
    const step = registry.get(version);
    if (!step) throw new MigrationError("file.migration", `no migration from schema version ${version}`);
    current = { ...step(current), schemaVersion: version + 1 };
    version += 1;
  }
  return { raw: current, migrated: version !== from };
}

/**
 * Version 1 to 2: a baseboard carries a colour of its own. Every baseboard a version 1 file has gets the
 * field as null, which takes its side's colour, exactly as those baseboards were drawn before.
 *
 * Only what is there is touched. A document without walls, or with walls that are not objects, is passed
 * on unchanged, so the schema check that follows reports it as the malformed file it is.
 */
export function addSkirtingColour(raw: RawDocument): RawDocument {
  if (!Array.isArray(raw.walls)) return raw;
  const withColour = (board: unknown): unknown =>
    board && typeof board === "object" && !("color" in board) ? { ...board, color: null } : board;
  return {
    ...raw,
    walls: raw.walls.map((wall: unknown) => {
      if (!wall || typeof wall !== "object") return wall;
      const skirting = (wall as { skirting?: unknown }).skirting;
      if (!skirting || typeof skirting !== "object") return wall;
      const { left, right } = skirting as { left?: unknown; right?: unknown };
      return { ...wall, skirting: { ...skirting, left: withColour(left), right: withColour(right) } };
    }),
  };
}

/**
 * Version 2 to 3: a wall carries the pattern the plan fills it with. Every wall a version 2 file has is
 * given "solid", which is how the plan drew every wall before; one that already names a pattern keeps it.
 * As above, anything that is not a wall object is left for the schema check.
 */
export function addWallPattern(raw: RawDocument): RawDocument {
  if (!Array.isArray(raw.walls)) return raw;
  return {
    ...raw,
    walls: raw.walls.map((wall: unknown) =>
      wall && typeof wall === "object" && !("pattern" in wall)
        ? withKeyAfter(wall, "kind", "pattern", "solid")
        : wall,
    ),
  };
}

/** `object` with `key` set to `value`, placed after `after` when that is present, so a migrated file lists
 *  its fields in the order a saved one does. */
function withKeyAfter(object: object, after: string, key: string, value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(object)) {
    out[k] = v;
    if (k === after) out[key] = value;
  }
  if (!(key in out)) out[key] = value;
  return out;
}

/**
 * Version 3 to 4: the project carries its own id (ADR-020 D1).
 *
 * The id is DERIVED from what the document already says rather than drawn at random, for two reasons.
 * Migrations are pure functions with fixture-pair tests, and a random one could not be tested that way.
 * And a derived id is the better answer: the same file migrated on two machines comes out with the same
 * id, so a link made on one works on the other, and a project restored from a backup is still itself.
 *
 * The seed is the fields that were already there to identify it — when it was made, what it is called,
 * and the ids of whatever it holds. Two genuinely different projects agreeing on all of that is not a
 * case worth defending against; two copies of ONE project agreeing is the point.
 */
export function addProjectId(raw: RawDocument): RawDocument {
  const meta = raw.meta;
  if (!meta || typeof meta !== "object" || "id" in meta) return raw;
  const m = meta as Record<string, unknown>;
  const parts = [String(m.createdAt ?? ""), String(m.name ?? "")];
  for (const coll of ["levels", "walls", "rooms", "items"]) {
    const list = raw[coll];
    if (!Array.isArray(list)) continue;
    for (const entity of list.slice(0, 8))
      if (entity && typeof entity === "object") parts.push(String((entity as { id?: unknown }).id ?? ""));
  }
  // `id` first, because a saved file lists it first and a migrated one should read the same.
  return { ...raw, meta: { id: derivedProjectId(parts.join("|")), ...m } };
}

MIGRATIONS.set(1, addSkirtingColour);
MIGRATIONS.set(2, addWallPattern);
MIGRATIONS.set(3, addProjectId);

/**
 * Version 4 to 5: every entity records who made it and who changed it last (ADR-023 D1).
 *
 * Everything already in a file is marked as the person's: `createdBy` and `editedBy` "unknown", and
 * `touchedByPerson` true. That is a deliberate lie in one direction and the right one. Nobody can
 * know now who drew a wall six months ago, and the field exists so the agent asks before changing a
 * person's work. Marked as the person's, the agent asks about everything in an old file once;
 * marked as its own, it would quietly rearrange a drawing somebody spent a week on. Only one of
 * those two mistakes is recoverable.
 *
 * The timestamp is the project's own creation time where the document has one, so a migrated file
 * carries a date that is at least true of the project rather than of the migration.
 */
export function addAuthorship(raw: RawDocument): RawDocument {
  const meta = raw.meta as { createdAt?: unknown } | undefined;
  const at =
    typeof meta?.createdAt === "string" && meta.createdAt ? meta.createdAt : "1970-01-01T00:00:00.000Z";
  const by = { createdBy: "unknown", editedBy: "unknown", editedAt: at, touchedByPerson: true };
  const stamp = (entity: unknown): unknown =>
    entity && typeof entity === "object" && !("by" in entity) ? { ...entity, by: { ...by } } : entity;
  const out: RawDocument = { ...raw };
  for (const coll of ["levels", "walls", "openings", "rooms", "items", "zones", "annotations"]) {
    const list = raw[coll];
    if (Array.isArray(list)) out[coll] = list.map(stamp);
  }
  return out;
}

MIGRATIONS.set(4, addAuthorship);

// Forward-only migrations (ADR-012 D5, spec 01 section 8). Each entry maps a raw document
// at version N to version N+1. Pure functions; every migration ships with a fixture pair test (P-047).
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

MIGRATIONS.set(1, addSkirtingColour);
MIGRATIONS.set(2, addWallPattern);

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

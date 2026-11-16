import { defaultLevel, newProjectId, type Project, SCHEMA_VERSION } from "@fpv/ir";

/**
 * A blank project for `project new` and for sessions started without a file.
 *
 * The id is drawn at random rather than derived, unlike the one a migration gives an older file: two
 * blank projects made in the same millisecond would otherwise be the same project, and a new project
 * has no content to tell it apart by (ADR-020 D1).
 */
export function blankProject(name: string, now: string, id: string = newProjectId()): Project {
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: { id, name, createdAt: now, updatedAt: now, currency: "USD", north: 90, units: "mm" },
    levels: [defaultLevel("level_000000", { name: "Ground" })],
    walls: [],
    openings: [],
    rooms: [],
    items: [],
    zones: [],
    annotations: [],
    catalogRefs: {},
    textures: {},
    provenance: null,
    properties: {},
  };
}

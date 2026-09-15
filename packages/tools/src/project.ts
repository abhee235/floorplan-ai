// A blank project for `project new` and for sessions started without a file.
import { defaultLevel, type Project, SCHEMA_VERSION } from "@fpv/ir";

export function blankProject(name: string, now: string): Project {
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: { name, createdAt: now, updatedAt: now, currency: "USD", north: 90, units: "mm" },
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

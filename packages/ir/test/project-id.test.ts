// A project's own identity (ADR-020 D1) and the migration that gives one to a file written before ids.
import { describe, expect, it } from "vitest";
import {
  addProjectId,
  derivedProjectId,
  isProjectId,
  migrate,
  newProjectId,
  PROJECT_ID_LENGTH,
  type RawDocument,
  SCHEMA_VERSION,
} from "../src/index.js";

/** A version 3 document, as every project file was until ids arrived. */
function v3(over: Partial<Record<string, unknown>> = {}): RawDocument {
  return {
    schemaVersion: 3,
    meta: { name: "Boardroom", createdAt: "2026-01-02T03:04:05.000Z", currency: "USD" },
    levels: [{ id: "level_000000" }],
    walls: [{ id: "wall_000001" }, { id: "wall_000002" }],
    ...over,
  };
}

describe("a project id", () => {
  it("is twelve URL-safe characters", () => {
    const id = newProjectId();
    expect(id).toHaveLength(PROJECT_ID_LENGTH);
    expect(isProjectId(id)).toBe(true);
    expect(encodeURIComponent(id)).toBe(id);
  });

  it("refuses anything that is not one, rather than guessing", () => {
    for (const bad of ["", "too-short", "UPPERCASE123", "twelve chars", 12, null, undefined, {}])
      expect(isProjectId(bad), String(bad)).toBe(false);
  });

  it("is different every time for a new project", () => {
    // Two blank projects made in the same millisecond must not be the same project, which is why a new
    // id is drawn rather than derived.
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(newProjectId());
    expect(seen.size).toBe(500);
  });

  it("is spread over the alphabet rather than clustered", () => {
    // A generator that wrote "000000000000" would satisfy every test above.
    const chars = new Set<string>();
    for (let i = 0; i < 200; i += 1) for (const c of newProjectId()) chars.add(c);
    expect(chars.size).toBeGreaterThan(30);
  });
});

describe("the id a migration gives an older file (ADR-020 D1)", () => {
  it("is the same on every machine, so a link made on one works on another", () => {
    const a = addProjectId(v3());
    const b = addProjectId(v3());
    expect((a.meta as { id: string }).id).toBe((b.meta as { id: string }).id);
    expect(isProjectId((a.meta as { id: string }).id)).toBe(true);
  });

  it("tells two different projects apart", () => {
    const ids = new Set<string>();
    for (const meta of [
      { name: "Boardroom", createdAt: "2026-01-02T03:04:05.000Z" },
      { name: "Boardroom", createdAt: "2026-01-02T03:04:05.001Z" },
      { name: "Boardroom 2", createdAt: "2026-01-02T03:04:05.000Z" },
      { name: "Studio East", createdAt: "2026-01-02T03:04:05.000Z" },
    ])
      ids.add(String((addProjectId(v3({ meta })).meta as { id: string }).id));
    expect(ids.size).toBe(4);
  });

  it("takes the entities into account, not just the name and the date", () => {
    const one = addProjectId(v3({ walls: [{ id: "wall_aaaaaa" }] }));
    const two = addProjectId(v3({ walls: [{ id: "wall_bbbbbb" }] }));
    expect((one.meta as { id: string }).id).not.toBe((two.meta as { id: string }).id);
  });

  it("leaves a document that already has one alone", () => {
    const already = v3({ meta: { id: "keepthisone", name: "x", createdAt: "2026-01-01T00:00:00.000Z" } });
    expect(addProjectId(already)).toBe(already);
  });

  it("lists the id first, so a migrated file reads like a saved one", () => {
    expect(Object.keys(addProjectId(v3()).meta as object)[0]).toBe("id");
  });

  it("passes a document with no meta through rather than inventing one", () => {
    const noMeta: RawDocument = { schemaVersion: 3, walls: [] };
    expect(addProjectId(noMeta)).toBe(noMeta);
  });

  it("runs as part of the ordinary migration chain", () => {
    const out = migrate(v3());
    expect(out.migrated).toBe(true);
    expect(out.raw.schemaVersion).toBe(SCHEMA_VERSION);
    expect(isProjectId((out.raw.meta as { id: string }).id)).toBe(true);
  });

  it("derives from the seed and nothing else", () => {
    expect(derivedProjectId("a")).toBe(derivedProjectId("a"));
    expect(derivedProjectId("a")).not.toBe(derivedProjectId("b"));
    expect(isProjectId(derivedProjectId(""))).toBe(true);
  });
});

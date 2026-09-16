import { describe, expect, it } from "vitest";
import {
  addSkirtingColour,
  addWallPattern,
  deserialize,
  type Migration,
  MigrationError,
  migrate,
  Project,
  type RawDocument,
  SCHEMA_VERSION,
  serialize,
} from "../src/index.js";
import { FIXTURE_TEXT, fixture } from "./helpers.js";

describe("serialize", () => {
  it("P-054 save-load-save is byte-stable and elements keep schema order", () => {
    const first = serialize(fixture());
    const back = deserialize(first);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const second = serialize(back.project);
    expect(second).toBe(first);
    const keys = Object.keys(JSON.parse(first) as object);
    expect(keys.slice(0, 4)).toEqual(["schemaVersion", "meta", "levels", "walls"]);
  });

  it("P-022 two-space indentation, one trailing newline", () => {
    const text = serialize(fixture());
    expect(text.startsWith(`{\n  "schemaVersion": ${SCHEMA_VERSION},\n`)).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("P-027 P-028 P-029 P-030 optional fields are written explicitly as null (reversed: nothing omitted)", () => {
    const text = serialize(fixture());
    const doc = JSON.parse(text) as { walls: Record<string, unknown>[]; openings: Record<string, unknown>[] };
    const wall = doc.walls[0] as Record<string, unknown>;
    expect(wall).toHaveProperty("height", null);
    expect(wall).toHaveProperty("arcExtent", null);
    expect(wall).toHaveProperty("skirting");
    const opening = doc.openings[0] as Record<string, unknown>;
    expect(opening).toHaveProperty("productId", null);
  });

  it("P-050 the schema version is stamped on save", () => {
    const p = fixture();
    const doc = JSON.parse(serialize({ ...p, schemaVersion: SCHEMA_VERSION })) as { schemaVersion: number };
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("P-053 record keys are written sorted", () => {
    const p = fixture();
    p.properties = { zeta: "1", alpha: "2" };
    const doc = JSON.parse(serialize(p)) as { properties: Record<string, string> };
    expect(Object.keys(doc.properties)).toEqual(["alpha", "zeta"]);
  });

  it("P-023 text with angle brackets, ampersands and newlines round-trips", () => {
    const p = fixture();
    p.meta.name = 'a<b&c\nd "quoted"';
    const back = deserialize(serialize(p));
    expect(back.ok && back.project.meta.name).toBe('a<b&c\nd "quoted"');
  });

  it("P-026 colours are #RRGGBB uppercase and rejected otherwise", () => {
    const p = fixture();
    const w = p.walls[0] as (typeof p.walls)[number];
    w.finishes.left = {
      color: "#FF0000",
      textureId: null,
      placement: null,
      mirrorForLeftSide: false,
      shininess: null,
    };
    expect(deserialize(serialize(p)).ok).toBe(true);
    const bad = serialize(p).replace("#FF0000", "#ff0000");
    expect(deserialize(bad).ok).toBe(false);
  });
});

describe("deserialize", () => {
  it("parses the fixture and reports no migration", () => {
    const r = deserialize(FIXTURE_TEXT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.migrated).toBe(false);
      expect(r.unknownFieldCount).toBe(0);
    }
  });

  it("P-037 unknown fields on the root and on entities survive a round trip", () => {
    const raw = JSON.parse(FIXTURE_TEXT) as Record<string, unknown> & { walls: Record<string, unknown>[] };
    raw.futureThing = { a: 1 };
    (raw.walls[0] as Record<string, unknown>).futureFlag = true;
    const r = deserialize(JSON.stringify(raw));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.unknownFieldCount).toBe(2);
    expect(r.project.walls[0]?.properties.__unknown).toBe('{"futureFlag":true}');
    const again = JSON.parse(serialize(r.project)) as Record<string, unknown> & {
      walls: Record<string, unknown>[];
    };
    expect(again.futureThing).toEqual({ a: 1 });
    expect((again.walls[0] as Record<string, unknown>).futureFlag).toBe(true);
    expect((again.walls[0] as { properties: Record<string, string> }).properties.__unknown).toBeUndefined();
  });

  it("P-038 P-039 a malformed enum or a missing required field fails the load with file.shape (reversed: not ignored)", () => {
    const raw = JSON.parse(FIXTURE_TEXT) as { walls: Record<string, unknown>[] };
    (raw.walls[0] as Record<string, unknown>).kind = "BOGUS";
    const r = deserialize(JSON.stringify(raw));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]?.code).toBe("file.shape");
    const raw2 = JSON.parse(FIXTURE_TEXT) as { walls: Record<string, unknown>[] };
    delete (raw2.walls[0] as Record<string, unknown>).thickness;
    expect(deserialize(JSON.stringify(raw2)).ok).toBe(false);
  });

  it("P-024 non-finite numbers cannot enter (JSON has none; strings are rejected by the schema)", () => {
    const raw = JSON.parse(FIXTURE_TEXT) as { walls: Record<string, unknown>[] };
    (raw.walls[0] as Record<string, unknown>).thickness = "NaN";
    expect(deserialize(JSON.stringify(raw)).ok).toBe(false);
  });

  it("P-052 selection and history are never persisted", () => {
    const text = serialize(fixture());
    expect(text).not.toContain('"selection"');
    expect(text).not.toContain('"history"');
  });

  it("P-051 a newer schema version is refused with file.newer", () => {
    const raw = JSON.parse(FIXTURE_TEXT) as { schemaVersion: number };
    raw.schemaVersion = SCHEMA_VERSION + 5;
    const r = deserialize(JSON.stringify(raw));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]?.code).toBe("file.newer");
  });

  it("file.json for invalid JSON and file.shape for a non-object root", () => {
    expect(deserialize("{not json").ok).toBe(false);
    const r = deserialize("[]");
    expect(!r.ok && r.problems[0]?.code).toBe("file.shape");
  });
});

describe("migrations", () => {
  it("P-047 migrations run forward in order from an older version, each stamping the next version", () => {
    const registry = new Map<number, Migration>();
    // Simulate: version 1 -> 2 renames meta.name to meta.title; version 2 -> 3 adds a flag.
    registry.set(1, (raw) => {
      const meta = raw.meta as Record<string, unknown>;
      return { ...raw, meta: { ...meta, title: meta.name } };
    });
    registry.set(2, (raw) => ({ ...raw, flag: true }));
    const out = migrate({ schemaVersion: 1, meta: { name: "x" } }, registry, 3);
    expect(out.migrated).toBe(true);
    expect(out.raw.schemaVersion).toBe(3);
    expect((out.raw.meta as { title: string }).title).toBe("x");
    expect(out.raw.flag).toBe(true);
  });

  it("a missing migration step is a file.migration error", () => {
    expect(() => migrate({ schemaVersion: 1 }, new Map(), 2)).toThrow(MigrationError);
    try {
      migrate({ schemaVersion: 1 }, new Map(), 2);
    } catch (e) {
      expect((e as MigrationError).code).toBe("file.migration");
    }
  });

  it("file.version for a missing or invalid schemaVersion", () => {
    expect(() => migrate({}, new Map(), 1)).toThrow(/schemaVersion/);
  });

  it("P-047 version 1 to 2 gives every baseboard a colour of its own, null, and touches nothing else", () => {
    const v2 = JSON.parse(FIXTURE_TEXT) as RawDocument & { walls: Record<string, unknown>[] };
    const walls = v2.walls.map((w, i) =>
      i === 0 ? { ...w, skirting: { left: { thickness: 12, height: 100 }, right: null } } : w,
    );
    const v1 = { ...v2, schemaVersion: 1, walls };
    const out = migrate(v1);
    expect(out.migrated).toBe(true);
    expect(out.raw.schemaVersion).toBe(SCHEMA_VERSION);
    const migratedWalls = out.raw.walls as { skirting: unknown }[];
    expect(migratedWalls[0]?.skirting).toEqual({
      left: { thickness: 12, height: 100, color: null },
      right: null,
    });
    expect(migratedWalls.slice(1)).toEqual(walls.slice(1));
    expect(Project.parse(out.raw).walls[0]?.skirting.left?.color).toBeNull();
    // a document with no walls is left for the schema check to refuse
    expect(addSkirtingColour({ schemaVersion: 1, meta: {} })).toEqual({ schemaVersion: 1, meta: {} });
  });

  it("P-047 version 2 to 3 draws every wall solid, as before, keeping the file's field order", () => {
    const v3 = JSON.parse(FIXTURE_TEXT) as RawDocument & { walls: Record<string, unknown>[] };
    const walls = v3.walls.map(({ pattern: _, ...w }) => w);
    const v2 = { ...v3, schemaVersion: 2, walls };
    const out = migrate(v2);
    expect(out.migrated).toBe(true);
    expect(out.raw.schemaVersion).toBe(SCHEMA_VERSION);
    const migrated = out.raw.walls as Record<string, unknown>[];
    expect(migrated.map((w) => w.pattern)).toEqual(walls.map(() => "solid"));
    const keys = Object.keys(migrated[0] as object);
    expect(keys[keys.indexOf("kind") + 1]).toBe("pattern");
    expect(Project.parse(out.raw).walls.every((w) => w.pattern === "solid")).toBe(true);
    // a wall that already names one keeps it, and a document without walls is left alone
    const named = addWallPattern({ schemaVersion: 2, walls: [{ ...walls[0], pattern: "hatch" }] });
    expect((named.walls as { pattern: string }[])[0]?.pattern).toBe("hatch");
    expect(addWallPattern({ schemaVersion: 2, meta: {} })).toEqual({ schemaVersion: 2, meta: {} });
  });
});

// describeEntity against a real project, not a hand-built stub.
//
// This is the function that carries every schema assumption in selection.ts — which field names exist,
// which are nullable, what a thing is called. A stub would only assert the shape I already believed, and
// that belief was wrong once already: Item has no `name` field, and the first version of itemTitle read
// one. The six-wall fixture is the same project the render tests use.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apply, type Ctx } from "@fpv/commands";
import { Project, type Project as ProjectT, sequentialIdGenerator } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { describeEntity } from "../../src/editor/selection.js";

const fixtureDir = fileURLToPath(new URL("../../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const fixture = (): ProjectT => Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));
const ctx: Ctx = { ids: sequentialIdGenerator(700), now: () => "2026-09-15T00:00:00.000Z" };
const L = "level_000000";

function withRoom(): ProjectT {
  const r = apply(
    fixture(),
    { type: "room.create", payload: { levelId: L, atPoint: { x: 2000, y: 2000 } } },
    ctx,
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}

describe("describing a selected entity", () => {
  it("describes a wall by its length, thickness and kind", () => {
    const p = fixture();
    const wall = p.walls[0];
    expect(wall).toBeDefined();
    const d = describeEntity(p, (wall as { id: string }).id);
    expect(d?.kind).toBe("wall");
    expect(d?.title).toBe("Wall");
    const labels = d?.facts.map((f) => f.label);
    expect(labels).toEqual(["Length", "Thickness", "Kind"]);
    // a real length in whole millimetres, not a placeholder
    expect(d?.facts[0]?.value).toMatch(/^\d+ mm$/);
  });

  it("describes a room by its corners, area and purpose", () => {
    const p = withRoom();
    const room = p.rooms[0];
    expect(room).toBeDefined();
    const d = describeEntity(p, (room as { id: string }).id);
    expect(d?.kind).toBe("room");
    expect(d?.facts.map((f) => f.label)).toEqual(["Corners", "Area", "Purpose"]);
    // square metres, and a detected room of a six-wall plan is not zero
    const area = Number(d?.facts[1]?.value.replace(" m²", ""));
    expect(area).toBeGreaterThan(0);
  });

  it("returns null for an id that is not in the project", () => {
    expect(describeEntity(fixture(), "wall_zzzzzz")).toBeNull();
  });

  it("returns null for a kind the editor does not handle", () => {
    expect(describeEntity(fixture(), "zone_000001")).toBeNull();
  });
});

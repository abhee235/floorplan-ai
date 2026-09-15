import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeDeg, Project } from "../src/index.js";

const fixtureDir = fileURLToPath(new URL("../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const project = Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));
const expected = JSON.parse(readFileSync(`${fixtureDir}expected.json`, "utf8")) as {
  wallCount: number;
  joinCount: number;
};

describe("six-wall fixture", () => {
  it("parses against the Scene IR schema", () => {
    expect(project.schemaVersion).toBe(1);
    expect(project.walls).toHaveLength(expected.wallCount);
    expect(project.levels).toHaveLength(1);
  });

  it("has reciprocal joins on every wall end (W-013)", () => {
    const byId = new Map(project.walls.map((w) => [w.id, w]));
    let joins = 0;
    for (const wall of project.walls) {
      for (const end of ["start", "end"] as const) {
        const join = wall.joins[end];
        if (!join) continue;
        joins += 1;
        const other = byId.get(join.wallId);
        expect(other, `${wall.id}.${end} references ${join.wallId}`).toBeDefined();
        const back = other?.joins[join.end];
        expect(back?.wallId).toBe(wall.id);
        expect(back?.end).toBe(end);
        const a = wall[end];
        const b = other?.[join.end];
        expect(b).toEqual(a);
      }
    }
    // every physical join is referenced from both of its walls
    expect(joins).toBe(expected.joinCount * 2);
  });
});

describe("normalizeDeg (F-001, R-020)", () => {
  it("maps any angle into [0, 360)", () => {
    expect(normalizeDeg(-90)).toBe(270);
    expect(normalizeDeg(360)).toBe(0);
    expect(normalizeDeg(725)).toBe(5);
    expect(normalizeDeg(0)).toBe(0);
  });
});

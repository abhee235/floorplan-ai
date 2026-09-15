import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Project, type Project as ProjectT, sequentialIdGenerator } from "@fpv/ir";
import { type ApplyOk, type ApplyResult, apply, type Ctx, createStore } from "../src/index.js";

const fixtureDir = fileURLToPath(new URL("../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
export const FIXTURE_TEXT = readFileSync(`${fixtureDir}project.json`, "utf8");

export const LEVEL = "level_000000";

export function fixture(): ProjectT {
  return Project.parse(JSON.parse(FIXTURE_TEXT));
}

export function ctx(start = 100): Ctx {
  return {
    ids: sequentialIdGenerator(start),
    now: () => "2026-09-15T00:00:00.000Z",
    catalog: {
      product(id) {
        if (id === "acme-chair")
          return {
            dims: { w: 600, d: 600, h: 900 },
            deformable: false,
            verification: { status: "verified" },
            materialSlots: ["fabric", "legs"],
          };
        if (id === "acme-table")
          return {
            dims: { w: 2400, d: 1200, h: 750 },
            deformable: true,
            verification: { status: "verified" },
            mountPoints: [{ name: "top", kind: "surface", dropRatio: 1 }],
          };
        return null;
      },
    },
  };
}

/** One generator per test file so ids never repeat across sequential commands. */
const shared = ctx();

/** Apply and assert success, returning the ok result. */
export function ok(p: ProjectT, command: unknown, c: Ctx = shared): ApplyOk {
  const r = apply(p, command, c);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r;
}

export function fail(p: ProjectT, command: unknown, c: Ctx = shared): Extract<ApplyResult, { ok: false }> {
  const r = apply(p, command, c);
  if (r.ok) throw new Error("expected the command to fail");
  return r;
}

export function store(p: ProjectT = fixture(), c: Ctx = ctx(500)) {
  return createStore(p, c);
}

export const BOX = {
  kind: "recipe" as const,
  recipe: { kind: "box" as const, size: { w: 600, d: 400, h: 500 }, label: "box" },
};

// A wall's plan pattern through the agent's tools (spec 04): modify_wall sets it, get_scene reports it.
import { describe, expect, it } from "vitest";
import type { WallView } from "../src/index.js";
import { buildFixtureRoom, harness } from "./helpers.js";

const SOUTH = "wall_000001";

describe("a wall's plan pattern (W-121)", () => {
  it("is set by modify_wall, and only a pattern other than solid is reported", async () => {
    const h = harness();
    await buildFixtureRoom(h);
    const scene = async () =>
      (await h.ok<{ walls: WallView[] }>("get_scene", { detail: "full", types: ["wall"] })).result.walls;
    expect((await scene()).every((w) => w.pattern === undefined)).toBe(true);

    const r = await h.ok<{ wall: WallView; affected: WallView[] }>("modify_wall", {
      wallId: SOUTH,
      pattern: "hatch",
    });
    expect(r.result.wall.pattern).toBe("hatch");
    // a pattern moves nothing, so no other wall changed with it
    expect(r.result.affected).toEqual([]);
    expect((await scene()).find((w) => w.id === SOUTH)?.pattern).toBe("hatch");

    await h.ok("modify_wall", { wallId: SOUTH, pattern: "solid" });
    expect((await scene()).find((w) => w.id === SOUTH)?.pattern).toBeUndefined();
    const bad = await h.call("modify_wall", { wallId: SOUTH, pattern: "dotted" });
    expect(bad.ok).toBe(false);
  });
});

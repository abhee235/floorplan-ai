// add_level (spec 03 section 2; ledger R-103..R-105): a building with more than one storey.
//
// The command has existed since phase 0 and no tool offered it, so "three storeys" was not a thing a
// model could ask for: every wall it drew landed on the one level a blank project has.

import { describe, expect, it } from "vitest";
import { harness } from "./helpers.js";

interface Levels {
  levels: { id: string; name: string; elevation: number; height: number; floorThickness: number }[];
}

describe("add_level", () => {
  it("stacks a storey on the one above, slab included", async () => {
    const h = harness();
    const ground = h.ctx.store.project.levels[0];
    const r = await h.ok<Levels>("add_level", {});
    const [first] = r.result.levels;
    expect(h.ctx.store.project.levels).toHaveLength(2);
    // 2700 of room plus a 300 slab is where the next floor starts
    expect(first?.elevation).toBe((ground?.elevation ?? 0) + (ground?.height ?? 0) + 300);
  });

  it("adds several at once, each above the last, as one thing in the history", async () => {
    const h = harness();
    const before = h.ctx.store.historyPosition;
    const r = await h.ok<Levels>("add_level", { count: 3, name: "Floor" });
    expect(r.result.levels).toHaveLength(3);
    expect(h.ctx.store.project.levels).toHaveLength(4);
    // one undo takes the whole building back down
    expect(h.ctx.store.historyPosition).toBe(before + 1);
    const elevations = r.result.levels.map((l) => l.elevation);
    expect([...elevations].sort((a, b) => a - b)).toEqual(elevations);
    expect(new Set(elevations).size).toBe(3);
    // named from what was asked, numbered so a list of levels can be read
    expect(r.result.levels.map((l) => l.name)).toEqual(["Floor 1", "Floor 2", "Floor 3"]);
  });

  it("takes a height and a slab, and sits beside a level when told to", async () => {
    const h = harness();
    const ground = h.ctx.store.project.levels[0];
    const tall = await h.ok<Levels>("add_level", { height: 4000, floorThickness: 200 });
    expect(tall.result.levels[0]?.height).toBe(4000);
    expect(tall.result.levels[0]?.elevation).toBe((ground?.height ?? 0) + 200);

    // a mezzanine shares the storey it belongs to rather than standing above everything
    const mezz = await h.ok<Levels>("add_level", { sameAs: ground?.id as string, name: "Mezzanine" });
    expect(mezz.result.levels[0]?.elevation).toBe(ground?.elevation);
  });

  it("gives a level walls can be drawn on, and get_scene lists it", async () => {
    const h = harness();
    const added = await h.ok<Levels>("add_level", { name: "First floor" });
    const levelId = added.result.levels[0]?.id as string;
    await h.ok("create_walls", {
      levelId,
      points: [
        { x: 0, y: 0 },
        { x: 4000, y: 0 },
      ],
      closed: false,
    });
    expect(h.ctx.store.project.walls.filter((w) => w.levelId === levelId)).toHaveLength(1);
    const scene = await h.ok<{ levels: { id: string; name: string }[] }>("get_scene", { detail: "summary" });
    expect(scene.result.levels.map((l) => l.name)).toContain("First floor");
  });

  it("refuses more than twenty at a time, rather than building a tower by mistake", async () => {
    const h = harness();
    const r = await h.call("add_level", { count: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("args.invalid");
  });
});

// finish_wall (spec 04): a model paints faces and sets baseboards by compass, never by left and right.
import { describe, expect, it } from "vitest";
import type { WallView } from "../src/index.js";
import { buildFixtureRoom, type Harness, harness } from "./helpers.js";

const SOUTH = "wall_000001"; // (0,0) to (8000,0), with the door

async function room(): Promise<{ h: Harness; faces: { left: string; right: string } }> {
  const h = harness();
  await buildFixtureRoom(h);
  const scene = await h.ok<{ walls: WallView[] }>("get_scene", { detail: "full", types: ["wall"] });
  const wall = scene.result.walls.find((w) => w.id === SOUTH) as WallView;
  return { h, faces: wall.compass };
}

const wallOf = (h: Harness) => h.ctx.store.project.walls.find((w) => w.id === SOUTH);

describe("finish_wall (spec 04, ADR-006 D3)", () => {
  it("paints the face named by the way it looks, and leaves the other face alone", async () => {
    const { h, faces } = await room();
    const r = await h.ok<{ wall: WallView }>("finish_wall", {
      wallId: SOUTH,
      face: faces.left,
      colour: "e8e6e1",
    });
    expect(wallOf(h)?.finishes.left?.color).toBe("#E8E6E1");
    expect(wallOf(h)?.finishes.right).toBeNull();
    expect(r.result.wall.faces).toEqual([
      { facing: faces.left, colour: "#E8E6E1", finish: "matt", baseboard: null },
    ]);
  });

  it("gives both faces a glossy finish and a baseboard of the usual depth in one step", async () => {
    const { h } = await room();
    const before = h.ctx.store.historyPosition;
    await h.ok("finish_wall", { wallId: SOUTH, face: "both", finish: "gloss", baseboardHeight: 100 });
    expect(h.ctx.store.historyPosition).toBe(before + 1);
    const w = wallOf(h);
    expect([w?.finishes.left?.shininess, w?.finishes.right?.shininess]).toEqual([0.6, 0.6]);
    expect(w?.skirting).toEqual({
      left: { height: 100, thickness: 12, color: null },
      right: { height: 100, thickness: 12, color: null },
    });
  });

  it("changes only the fields it is given, and removes a baseboard with a null height", async () => {
    const { h, faces } = await room();
    await h.ok("finish_wall", {
      wallId: SOUTH,
      face: faces.left,
      baseboardHeight: 100,
      baseboardColour: "#ffffff",
    });
    await h.ok("finish_wall", { wallId: SOUTH, face: faces.left, baseboardDepth: 18 });
    expect(wallOf(h)?.skirting.left).toEqual({ height: 100, thickness: 18, color: "#FFFFFF" });
    await h.ok("finish_wall", { wallId: SOUTH, face: faces.left, baseboardHeight: null });
    expect(wallOf(h)?.skirting.left).toBeNull();
  });

  it("stores nothing for a face set back to its defaults", async () => {
    const { h, faces } = await room();
    await h.ok("finish_wall", { wallId: SOUTH, face: faces.right, colour: "#123456", finish: "satin" });
    await h.ok("finish_wall", { wallId: SOUTH, face: faces.right, colour: null, finish: "matt" });
    expect(wallOf(h)?.finishes.right).toBeNull();
    const scene = await h.ok<{ walls: WallView[] }>("get_scene", { detail: "full", types: ["wall"] });
    expect(scene.result.walls.find((w) => w.id === SOUTH)?.faces).toBeUndefined();
  });

  it("refuses a face the wall does not have, and says which faces it has", async () => {
    const { h, faces } = await room();
    const wrong = (["north", "south", "east", "west"] as const).find(
      (c) => c !== faces.left && c !== faces.right,
    );
    const r = await h.call("finish_wall", { wallId: SOUTH, face: wrong, colour: "#000000" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("wall.face");
    expect(r.error.hint).toContain(faces.left);
    expect(r.error.hint).toContain(faces.right);
  });

  it("W-100 refuses a baseboard taller than the wall, and depth or colour on a face without one", async () => {
    const { h, faces } = await room();
    const tall = await h.call("finish_wall", { wallId: SOUTH, face: faces.left, baseboardHeight: 5000 });
    expect(tall.ok).toBe(false);
    if (!tall.ok) expect(tall.error.message).toContain("2700");
    const bare = await h.call("finish_wall", { wallId: SOUTH, face: faces.left, baseboardDepth: 18 });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error.message).toContain("give its height");
    const nothing = await h.call("finish_wall", { wallId: SOUTH, face: faces.left });
    expect(nothing.ok).toBe(false);
    const badColour = await h.call("finish_wall", { wallId: SOUTH, face: faces.left, colour: "red" });
    // a short hex is a colour, though; the refusals above are about height and depth
    expect((await h.call("finish_wall", { wallId: SOUTH, face: faces.left, colour: "#abc" })).ok).toBe(true);
    await h.ok("finish_wall", { wallId: SOUTH, face: faces.left, colour: null });
    expect(badColour.ok).toBe(false);
    // nothing was changed by any of them
    expect(wallOf(h)?.finishes.left).toBeNull();
    expect(wallOf(h)?.skirting.left).toBeNull();
  });
});

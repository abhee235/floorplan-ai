// What stands in an opening: a pane in a window, a leaf in a door, nothing in a passage.
//
// Before this, an opening was only the surfaces around the hole, so a window was a gap and a closed
// door was a doorway. The schema had carried finishes.frame and finishes.leaf all along with nothing
// to put them on.
import { defaultLevel, defaultOpening, defaultWall, type Level, type Opening } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { buildWalls, materialLook, partArea, partBounds } from "../src/index.js";

const level: Level = defaultLevel("level_000000", { name: "Ground", height: 2700 });
const ctx = { level, isLowest: true, isHighest: true };

/** One 5 m wall running east, with whatever opening is asked for in the middle of it. */
function walled(over: Partial<Opening> & { kind: Opening["kind"] }) {
  const wall = defaultWall("wall_000001", level.id, { x: 0, y: 0 }, { x: 5000, y: 0 }, { thickness: 200 });
  const { kind, ...rest } = over;
  const opening = defaultOpening("opening_000001", level.id, wall.id, kind, rest);
  return { wall, opening, parts: buildWalls([wall], [opening], ctx) };
}

/** A plain painted finish, as the panel sends one. */
const finish = (color: string) => ({
  color,
  textureId: null,
  placement: null,
  mirrorForLeftSide: false,
  shininess: null,
});

const partsOf = (parts: ReturnType<typeof buildWalls>, kind: string) => parts.filter((p) => p.part === kind);

describe("what fills an opening", () => {
  it("glazes a window and leaves a passage open", () => {
    const window = walled({ kind: "window" });
    expect(partsOf(window.parts, "opening-glass")).toHaveLength(1);
    expect(partsOf(window.parts, "opening-leaf")).toHaveLength(0);

    // A passage is a hole you walk through; filling it would be the one thing it is not.
    const passage = walled({ kind: "passage" });
    expect(partsOf(passage.parts, "opening-glass")).toHaveLength(0);
    expect(partsOf(passage.parts, "opening-leaf")).toHaveLength(0);
  });

  it("leaves a doorway open until the door is given a leaf", () => {
    // A flat panel across a doorway reads as a flaw, not as a door, and the model does not say whether
    // the door is shut. So a leaf appears only when one is asked for.
    const bare = walled({ kind: "door" });
    expect(partsOf(bare.parts, "opening-leaf")).toHaveLength(0);
    expect(partsOf(bare.parts, "opening-glass")).toHaveLength(0);

    const painted = walled({ kind: "door", finishes: { leaf: finish("#6B4A2F"), frame: null } });
    expect(partsOf(painted.parts, "opening-leaf")).toHaveLength(1);
    expect(materialLook(partsOf(painted.parts, "opening-leaf")[0]?.materialKey ?? "").plainColour).toBe(
      0x6b4a2f,
    );
  });

  it("glazes a window whether or not it has been given a finish", () => {
    // The other way round from a door: a window with no glass is a hole, and nobody means that.
    expect(partsOf(walled({ kind: "window" }).parts, "opening-glass")).toHaveLength(1);
  });

  it("fills exactly the hole, and no more", () => {
    const { opening, parts } = walled({ kind: "window", width: 1200, height: 1100, sill: 900 });
    const pane = partsOf(parts, "opening-glass")[0];
    if (!pane) throw new Error("no pane");
    const { min, max } = partBounds(pane);
    // Buffers are in metres in the renderer's axes: [0] along the wall, [1] up, [2] across it.
    expect((max[0] as number) - (min[0] as number)).toBeCloseTo(opening.width / 1000, 3);
    expect((max[1] as number) - (min[1] as number)).toBeCloseTo(opening.height / 1000, 3);
    expect(min[1]).toBeCloseTo(opening.sill / 1000, 3);
  });

  it("stands in the middle of the wall, not on one of its faces", () => {
    const { parts } = walled({ kind: "window" });
    const pane = partsOf(parts, "opening-glass")[0];
    if (!pane) throw new Error("no pane");
    const { min, max } = partBounds(pane);
    // the wall runs along x through y = 0, so the pane sits on the wall's own centreline
    expect(((min[2] as number) + (max[2] as number)) / 2).toBeCloseTo(0, 6);
  });

  it("is faced both ways, so it is not invisible from half the room", () => {
    const { parts } = walled({ kind: "window", width: 1200, height: 1100 });
    const pane = partsOf(parts, "opening-glass")[0];
    if (!pane) throw new Error("no pane");
    // two quads of the same size: one area would mean one face
    expect(partArea(pane)).toBeCloseTo(2 * 1.2 * 1.1, 3);
  });

  it("looks like glass: see-through, smooth and reflective", () => {
    const { parts } = walled({ kind: "window" });
    const pane = partsOf(parts, "opening-glass")[0];
    if (!pane) throw new Error("no pane");
    const look = materialLook(pane.materialKey);
    expect(look.opacity).toBeLessThan(1);
    expect(look.reflective).toBe(true);
    // and a door leaf, once it has one, does not
    const leaf = partsOf(
      walled({ kind: "door", finishes: { leaf: finish("#6B4A2F"), frame: null } }).parts,
      "opening-leaf",
    )[0];
    if (!leaf) throw new Error("no leaf");
    expect(materialLook(leaf.materialKey).opacity).toBe(1);
  });

  it("wears the finish it is given, on the fill and on the frame separately", () => {
    const wall = defaultWall("wall_000001", level.id, { x: 0, y: 0 }, { x: 5000, y: 0 }, { thickness: 200 });
    const opening = defaultOpening("opening_000001", level.id, wall.id, "window", {
      finishes: { leaf: finish("#224466"), frame: finish("#112233") },
    });
    const parts = buildWalls([wall], [opening], ctx);
    const pane = partsOf(parts, "opening-glass")[0];
    const jamb = partsOf(parts, "opening-jamb")[0];
    if (!pane || !jamb) throw new Error("missing parts");
    // the leaf finish dresses what fills the hole; the frame finish dresses what surrounds it
    expect(materialLook(pane.materialKey).plainColour).toBe(0x224466);
    expect(materialLook(jamb.materialKey).plainColour).toBe(0x112233);
  });

  it("leaves an opening with no room for a fill alone", () => {
    // sill at the head: there is no hole, so there is nothing to glaze
    const { parts } = walled({ kind: "window", sill: 2000, height: 1 });
    const pane = partsOf(parts, "opening-glass");
    expect(pane.length).toBeLessThanOrEqual(1);
  });
});

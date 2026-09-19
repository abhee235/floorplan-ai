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

// finish_opening (ADR-021): the agent dresses a door or a window, as the properties panel can.
//
// Every capability the UI has and the tools do not is a thing the hosted agent cannot do, however good
// its loop is. The panel could dress an opening from the day openings had finishes; this could not.
describe("finish_opening (ADR-021)", () => {
  const DOOR = "opening_000001";
  const openingOf = (h: Harness) => h.ctx.store.project.openings.find((o) => o.id === DOOR);

  async function withDoor(): Promise<Harness> {
    const h = harness();
    await buildFixtureRoom(h);
    return h;
  }

  it("dresses the leaf and the frame separately", async () => {
    const h = await withDoor();
    await h.ok("finish_opening", { openingId: DOOR, part: "leaf", colour: "6B4A2F" });
    expect(openingOf(h)?.finishes.leaf?.color).toBe("#6B4A2F");
    expect(openingOf(h)?.finishes.frame).toBeNull();

    await h.ok("finish_opening", { openingId: DOOR, part: "frame", colour: "222222" });
    expect(openingOf(h)?.finishes.frame?.color).toBe("#222222");
    // the leaf is still what it was: dressing one does not touch the other
    expect(openingOf(h)?.finishes.leaf?.color).toBe("#6B4A2F");
  });

  it("dresses both at once when asked", async () => {
    const h = await withDoor();
    await h.ok("finish_opening", { openingId: DOOR, part: "both", colour: "445566" });
    expect(openingOf(h)?.finishes.leaf?.color).toBe("#445566");
    expect(openingOf(h)?.finishes.frame?.color).toBe("#445566");
  });

  it("refuses a texture the catalog does not have, rather than storing a name that means nothing", async () => {
    const h = await withDoor();
    const bad = await h.call("finish_opening", {
      openingId: DOOR,
      part: "leaf",
      texture: "generated/not-a-texture",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("catalog.missing-texture");
    // and nothing was written on the way to refusing
    expect(openingOf(h)?.finishes.leaf).toBeNull();
  });

  it("sets the sheen without disturbing the colour", async () => {
    const h = await withDoor();
    await h.ok("finish_opening", { openingId: DOOR, part: "leaf", colour: "6B4A2F" });
    await h.ok("finish_opening", { openingId: DOOR, part: "leaf", finish: "gloss" });
    expect(openingOf(h)?.finishes.leaf?.color).toBe("#6B4A2F");
    expect(openingOf(h)?.finishes.leaf?.shininess).toBeGreaterThan(0);
  });

  it("refuses to dress the inside of a passage, which has nothing in it", async () => {
    const h = await withDoor();
    await h.ok("modify_opening", { openingId: DOOR, kind: "passage" });
    const bad = await h.call("finish_opening", { openingId: DOOR, part: "leaf", colour: "445566" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.hint).toContain("frame");
    // but its frame is fine
    await h.ok("finish_opening", { openingId: DOOR, part: "frame", colour: "445566" });
    expect(openingOf(h)?.finishes.frame?.color).toBe("#445566");
  });

  it("says so when the opening does not exist, and when nothing was asked for", async () => {
    const h = await withDoor();
    const missing = await h.call("finish_opening", {
      openingId: "opening_zzzzzz",
      part: "leaf",
      colour: "445566",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("ref.missing");
    const empty = await h.call("finish_opening", { openingId: DOOR, part: "leaf" });
    expect(empty.ok).toBe(false);
  });
});

// modify_opening (ADR-021): the agent could add a door and then never change it.
//
// The properties panel has edited an opening's kind, size, sill and swing since it was written. The
// tool surface had add_opening and nothing else, so an agent that placed a door 100 mm too narrow had
// to delete it and place another.
describe("modify_opening (ADR-021)", () => {
  const DOOR = "opening_000001";
  const openingOf = (h: Harness) => h.ctx.store.project.openings.find((o) => o.id === DOOR);

  async function withDoor(): Promise<Harness> {
    const h = harness();
    await buildFixtureRoom(h);
    return h;
  }

  it("changes the size without touching anything else", async () => {
    const h = await withDoor();
    const before = openingOf(h);
    await h.ok("modify_opening", { openingId: DOOR, width: 1200, height: 2200 });
    expect(openingOf(h)?.width).toBe(1200);
    expect(openingOf(h)?.height).toBe(2200);
    expect(openingOf(h)?.position).toBe(before?.position);
  });

  it("takes a distance along the wall as well as a fraction", async () => {
    const h = await withDoor();
    // the fixture's south wall runs 8000 mm, so 2000 mm along is a quarter of the way
    await h.ok("modify_opening", { openingId: DOOR, atMm: 2000 });
    expect(openingOf(h)?.position).toBeCloseTo(0.25, 9);
    await h.ok("modify_opening", { openingId: DOOR, position: 0.5 });
    expect(openingOf(h)?.position).toBeCloseTo(0.5, 9);
  });

  it("refuses a distance past the end of the wall, and says how long it is", async () => {
    const h = await withDoor();
    const bad = await h.call("modify_opening", { openingId: DOOR, atMm: 99999 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toContain("8000");
  });

  it("turns a door into a window and back, which drops the swing and then gives one", async () => {
    const h = await withDoor();
    await h.ok("modify_opening", { openingId: DOOR, kind: "window" });
    expect(openingOf(h)?.kind).toBe("window");
    expect(openingOf(h)?.swing).toBeNull();
    await h.ok("modify_opening", { openingId: DOOR, kind: "door" });
    expect(openingOf(h)?.swing).not.toBeNull();
  });

  it("hinges a door at either end, or at neither", async () => {
    const h = await withDoor();
    await h.ok("modify_opening", { openingId: DOOR, swing: { hinge: "end", direction: "right" } });
    expect(openingOf(h)?.swing).toEqual({ hinge: "end", direction: "right" });
    // null is a sliding or pocket door: nothing sweeps the floor
    await h.ok("modify_opening", { openingId: DOOR, swing: null });
    expect(openingOf(h)?.swing).toBeNull();
  });

  it("says so when nothing was asked for, and when the opening does not exist", async () => {
    const h = await withDoor();
    const empty = await h.call("modify_opening", { openingId: DOOR });
    expect(empty.ok).toBe(false);
    const missing = await h.call("modify_opening", { openingId: "opening_zzzzzz", width: 900 });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("ref.missing");
  });
});
// finish_item (ADR-021): the agent dresses an item, or one part of it, as the properties panel can.
//
// The panel has painted a chair's fabric and a table's legs since P3-5. No tool could, so a hosted agent
// asked for "the same chairs but in grey" had to delete them and place them again — and could not have,
// because place_item takes no finish either.
describe("finish_item (ADR-021)", () => {
  interface Placed {
    item: { id: string };
  }
  interface Dressed {
    items: { id: string }[];
    parts: {
      itemId: string;
      part: string;
      colour: string | null;
      texture: string | null;
      finish: string;
      own: boolean;
    }[];
  }

  async function withChair(): Promise<{ h: Harness; chair: string; table: string }> {
    const h = harness();
    const { roomId } = await buildFixtureRoom(h);
    const table = await h.ok<Placed>("place_item", {
      productId: "acme-boardroom-3600",
      roomId,
      anchor: "center",
    });
    const chair = await h.ok<Placed>("place_item", {
      productId: "acme-task-chair",
      roomId,
      anchor: "north-west-corner",
    });
    return { h, chair: chair.result.item.id, table: table.result.item.id };
  }

  const itemOf = (h: Harness, id: string) => h.ctx.store.project.items.find((i) => i.id === id);

  it("paints one part and leaves the others alone", async () => {
    const { h, chair } = await withChair();
    const r = await h.ok<Dressed>("finish_item", { itemIds: [chair], part: "fabric", colour: "#4A6D8C" });
    expect(itemOf(h, chair)?.materials.fabric?.color).toBe("#4A6D8C");
    expect(itemOf(h, chair)?.materials.frame).toBeUndefined();
    expect(itemOf(h, chair)?.finish).toBeNull();
    // and the answer names every part, which is the only way the part names can be learnt
    expect(r.result.parts.map((p) => p.part)).toEqual(["fabric", "frame"]);
    expect(r.result.parts.find((p) => p.part === "fabric")).toMatchObject({
      itemId: chair,
      colour: "#4A6D8C",
      own: true,
    });
    expect(r.result.parts.find((p) => p.part === "frame")).toMatchObject({ colour: null, own: false });
  });

  it("dresses the whole item when no part is named, and a part still wins over it", async () => {
    const { h, chair } = await withChair();
    await h.ok("finish_item", { itemIds: [chair], colour: "#222222" });
    expect(itemOf(h, chair)?.finish?.color).toBe("#222222");
    expect(itemOf(h, chair)?.materials.fabric).toBeUndefined();
    // every part follows the item until one is given a finish of its own
    const all = await h.ok<Dressed>("finish_item", { itemIds: [chair], finish: "satin" });
    expect(all.result.parts.every((p) => p.colour === "#222222" && !p.own)).toBe(true);

    await h.ok("finish_item", { itemIds: [chair], part: "fabric", colour: "#4A6D8C" });
    expect(itemOf(h, chair)?.materials.fabric?.color).toBe("#4A6D8C");
    expect(itemOf(h, chair)?.finish?.color).toBe("#222222");
  });

  it("stops a part following the item the moment the part is given anything of its own", async () => {
    // The IR's fallback is the whole finish, not field by field: materials[slot] ?? item.finish. So a
    // part given only a sheen keeps no colour from the item — it goes back to its plain material and
    // wears the sheen. The properties panel writes exactly this, and the answer says `own` so the
    // caller can see which parts still follow. Per-field inheritance would be a change to the IR.
    const { h, chair } = await withChair();
    await h.ok("finish_item", { itemIds: [chair], colour: "#222222" });
    const after = await h.ok<Dressed>("finish_item", { itemIds: [chair], part: "frame", finish: "gloss" });
    expect(after.result.parts.find((p) => p.part === "frame")).toMatchObject({
      colour: null,
      finish: "gloss",
      own: true,
    });
    // the fabric was given nothing, so it still follows the item
    expect(after.result.parts.find((p) => p.part === "fabric")).toMatchObject({
      colour: "#222222",
      own: false,
    });
  });

  it("dresses several items in one step, each from its own finish", async () => {
    const { h, chair, table } = await withChair();
    await h.ok("finish_item", { itemIds: [chair], part: "frame", finish: "gloss" });
    const before = h.ctx.store.historyPosition;
    const r = await h.ok<Dressed>("finish_item", { itemIds: [chair, table], colour: "#E8E6E1" });
    // one entry in the history: "make them all cream" is one thing a person did, so one undo
    expect(h.ctx.store.historyPosition).toBe(before + 1);
    expect(itemOf(h, chair)?.finish?.color).toBe("#E8E6E1");
    expect(itemOf(h, table)?.finish?.color).toBe("#E8E6E1");
    // the chair's own frame sheen survived, because each item was dressed from what it already wore
    expect(itemOf(h, chair)?.materials.frame?.shininess).toBeGreaterThan(0);
    expect(r.result.items.map((i) => i.id)).toEqual([chair, table]);
    expect(r.result.parts.map((p) => p.part)).toEqual(["fabric", "frame", "top", "legs"]);
  });

  it("refuses a part the item does not have, and says which parts it has", async () => {
    const { h, chair } = await withChair();
    const bad = await h.call("finish_item", { itemIds: [chair], part: "legs", colour: "#000000" });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.code).toBe("item.material-slot");
    expect(bad.error.hint).toContain("fabric");
    expect(bad.error.hint).toContain("frame");
    // nothing was written on the way to refusing
    expect(itemOf(h, chair)?.materials).toEqual({});
  });

  it("refuses the whole call when one of several items cannot take the part", async () => {
    const { h, chair, table } = await withChair();
    const bad = await h.call("finish_item", { itemIds: [chair, table], part: "fabric", colour: "#000000" });
    expect(bad.ok).toBe(false);
    // a transaction, so the chair was not left dressed while the table was refused
    expect(itemOf(h, chair)?.materials.fabric).toBeUndefined();
  });

  it("swaps paint for a texture and back, never holding both", async () => {
    const { h, chair } = await withChair();
    await h.ok("finish_item", { itemIds: [chair], part: "fabric", colour: "#4A6D8C" });
    const bad = await h.call("finish_item", {
      itemIds: [chair],
      part: "fabric",
      texture: "generated/not-a-texture",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("catalog.missing-texture");
    expect(itemOf(h, chair)?.materials.fabric?.color).toBe("#4A6D8C");
  });

  it("takes a part back to the default, which stores nothing at all", async () => {
    const { h, chair } = await withChair();
    await h.ok("finish_item", { itemIds: [chair], part: "fabric", colour: "#4A6D8C", finish: "gloss" });
    await h.ok("finish_item", { itemIds: [chair], part: "fabric", colour: null, finish: "matt" });
    expect(itemOf(h, chair)?.materials.fabric).toBeUndefined();
  });

  it("says so when the item does not exist, and when nothing was asked for", async () => {
    const { h, chair } = await withChair();
    const missing = await h.call("finish_item", { itemIds: ["item_zzzzzz"], colour: "#000000" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("ref.missing");
    const empty = await h.call("finish_item", { itemIds: [chair], part: "fabric" });
    expect(empty.ok).toBe(false);
  });
});

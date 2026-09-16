// Placing a piece from the catalog (P3-5): the ghost stands where item.place will put the piece, and the
// command carries only what was asked for.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apply, type Ctx } from "@fpv/commands";
import { Project, type Project as ProjectT, sequentialIdGenerator } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { ItemPlacer, type Placeable, placeableOf, turned } from "../../src/editor/item-tool.js";

const fixtureDir = fileURLToPath(new URL("../../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const fixture = (): ProjectT => Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));
const L = "level_000000";

const DESK: Placeable = {
  id: "acme-desk",
  name: "Acme desk",
  category: "desk",
  size: { w: 1600, d: 800, h: 740 },
  ref: { kind: "product", productId: "acme-desk" },
};
const ctx: Ctx = {
  ids: sequentialIdGenerator(900),
  now: () => "2026-09-17T00:00:00.000Z",
  catalog: {
    product: (id) =>
      id === "acme-desk"
        ? { id, name: "Acme desk", category: "desk", dims: DESK.size, deformable: true }
        : null,
  },
};
const place = (p: ProjectT, command: unknown) => {
  const r = apply(p, command, ctx);
  if (!r.ok) throw new Error(r.error.message);
  return r.project.items.at(-1) as ProjectT["items"][number];
};
const on = { magnetism: true, rotation: 0 };

describe("placing a piece from the catalog (P3-5)", () => {
  it("F-075 shows the piece where item.place puts it: against a wall, its back to it", () => {
    const p = fixture();
    // an 800 mm deep desk centred 430 mm from the south wall's centre line (y = 0): its near edge overlaps
    // the wall, so it is pulled against it
    const placer = new ItemPlacer(DESK, L, { x: 2000, y: 430 });
    const aim = placer.aim(p, on);
    expect(aim.note).toBe("against the wall");
    const item = place(p, placer.command(on));
    expect(aim.position).toEqual(item.position);
    expect(aim.rotation).toBe(item.rotation);
    // its back (local +y) to the south wall: the desk faces north, into the room
    expect(item.rotation).toBe(180);
    expect(aim.footprint).toHaveLength(4);
  });

  it("stands a piece free where it was put, square unless turned", () => {
    const p = fixture();
    const placer = new ItemPlacer(DESK, L, { x: 3000.4, y: 2500.6 });
    const aim = placer.aim(p, on);
    expect(aim).toMatchObject({ position: { x: 3000, y: 2501 }, rotation: 0, note: "" });
    expect(placer.command(on).payload).toEqual({
      levelId: L,
      ref: DESK.ref,
      position: { x: 3000, y: 2501 },
    });
    const item = place(p, placer.command(on));
    expect(item.position).toEqual(aim.position);
    const turnedCommand = placer.command({ magnetism: true, rotation: 45 });
    expect(turnedCommand.payload.rotation).toBe(45);
    expect(placer.aim(p, { magnetism: true, rotation: 45 }).rotation).toBe(45);
  });

  it("W-082 keeps the exact point and rotation when snapping is off", () => {
    const p = fixture();
    const placer = new ItemPlacer(DESK, L, { x: 2000, y: 500 });
    const off = { magnetism: false, rotation: 30 };
    expect(placer.aim(p, off)).toMatchObject({ position: { x: 2000, y: 500 }, rotation: 30, note: "" });
    const command = placer.command(off);
    expect(command.payload).toMatchObject({ magnetism: false, rotation: 30 });
    expect(place(p, command)).toMatchObject({ position: { x: 2000, y: 500 }, rotation: 30 });
  });

  it("moves by the arrows' steps and turns by brackets, a full turn still counting as asked", () => {
    const placer = new ItemPlacer(DESK, L, { x: 0, y: 0 });
    placer.nudge(100, 0);
    placer.nudge(0, -10);
    expect(placer.point).toEqual({ x: 100, y: -10 });
    // from "as placed", a bracket turns from where the piece stands now
    expect(turned(0, 180, 15)).toBe(195);
    expect(turned(345, 0, 15)).toBe(360);
    expect(turned(360, 0, 15)).toBe(15);
    expect(turned(15, 0, -15)).toBe(360);
    expect(
      new ItemPlacer(DESK, L, { x: 0, y: 0 }).command({ magnetism: true, rotation: 360 }).payload.rotation,
    ).toBe(0);
  });

  it("turns a search hit into something to place: a product by id, a generic shape by its recipe", () => {
    const hit = { id: "acme-desk", name: "Acme desk", category: "desk", dims: { w: 1600, d: 800, h: 740 } };
    expect(placeableOf(hit)).toEqual({ ...DESK });
    const recipe = { kind: "table", size: { w: 2400, d: 1200, h: 750 }, shape: "rect" };
    expect(placeableOf({ ...hit, id: "recipe:table:rect:2400x1200x750", recipe })?.ref).toEqual({
      kind: "recipe",
      recipe,
    });
    expect(placeableOf({ ...hit, dims: { w: 0, d: 800, h: 740 } })).toBeNull();
  });
});

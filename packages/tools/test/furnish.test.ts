import { AV_CORE, type Bom, ensureSeed, validatePack } from "@fpv/catalog";
import { CatalogStore } from "@fpv/catalog/store";
import type { Item, Project } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { type CatalogSearch, pickRecipe } from "../src/index.js";
import { harness, NOW } from "./helpers.js";

const L = "level_000000";
type H = ReturnType<typeof harness>;

function seeded(): CatalogStore {
  const store = CatalogStore.open(":memory:");
  ensureSeed(store, NOW);
  return store;
}

function categoryOf(catalog: CatalogSearch, i: Item): string {
  if (i.ref.kind === "recipe") return i.ref.recipe.kind === "box" ? "other" : i.ref.recipe.kind;
  return catalog.product(i.ref.productId)?.category ?? "unknown";
}

function countItems(p: Project, catalog: CatalogSearch): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of p.items) {
    const c = categoryOf(catalog, i);
    out[c] = (out[c] ?? 0) + 1;
  }
  return out;
}

function itemsOf(p: Project, catalog: CatalogSearch, category: string): Item[] {
  return p.items.filter((i) => categoryOf(catalog, i) === category);
}

/** A rectangular room with 100 mm walls whose inside is w by d, and one door in the middle of the named wall. */
async function rectRoom(
  h: H,
  w: number,
  d: number,
  doorOn: "south" | "east" | "north" | "west",
  purpose: string,
  capacity: number,
) {
  const walls = await h.ok<{ walls: { id: string }[] }>("create_walls", {
    levelId: L,
    points: [
      { x: -50, y: -50 },
      { x: w + 50, y: -50 },
      { x: w + 50, y: d + 50 },
      { x: -50, y: d + 50 },
    ],
    closed: true,
    thickness: 100,
    kind: "interior",
  });
  const index = { south: 0, east: 1, north: 2, west: 3 }[doorOn];
  await h.ok("add_opening", {
    wallId: walls.result.walls[index]?.id,
    kind: "door",
    position: 0.5,
    width: 900,
  });
  const r = await h.ok<{ room: { id: string } }>("create_room", {
    levelId: L,
    polygon: [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: d },
      { x: 0, y: d },
    ],
    name: "Room",
    purpose,
    capacity,
  });
  return r.result.room.id;
}

async function checks(h: H) {
  return (
    await h.ok<{
      errors: { code: string; message: string }[];
      warnings: { code: string; message: string }[];
    }>("validate", {})
  ).result;
}

describe("room recipes (spec 07 section 4)", () => {
  it("the core pack's recipes are valid and chosen by purpose and capacity", () => {
    expect(validatePack(AV_CORE).problems).toEqual([]);
    expect(AV_CORE.recipes.map((r) => r.id).slice(0, 3)).toEqual(["huddle", "boardroom", "training"]);
    const room = (purpose: string, capacity: number | null) =>
      ({
        purpose,
        capacity,
        polygon: [
          { x: 0, y: 0 },
          { x: 6000, y: 0 },
          { x: 6000, y: 5000 },
          { x: 0, y: 5000 },
        ],
        holes: [],
      }) as never;
    expect(pickRecipe(AV_CORE, room("boardroom", 10)).id).toBe("boardroom");
    // a meeting room has a recipe of its own now (ADR-027 D7); a two-seat one is a huddle
    expect(pickRecipe(AV_CORE, room("meeting", 4)).id).toBe("meeting");
    expect(pickRecipe(AV_CORE, room("meeting", 2)).id).toBe("huddle");
    expect(pickRecipe(AV_CORE, room("other", 30)).id).toBe("training");
    expect(pickRecipe(AV_CORE, room("boardroom", 80)).id).toBe("training");
    // no capacity: 30 m² at 3 m² a seat is 10 seats, in the meeting range
    expect(pickRecipe(AV_CORE, room("meeting", null)).id).toBe("meeting");
    expect(pickRecipe(AV_CORE, room("meeting", 4), "training").id).toBe("training");
    expect(() => pickRecipe(AV_CORE, room("meeting", 4), "cafe")).toThrow(
      'recipe "cafe" is not in the rules pack',
    );
  });
});

describe("furnish_room (spec 04 section 6)", () => {
  it("spec 07 test: boardroom for 10 in 8000 by 5000 places table, 10 chairs, display, bar, 2 mics, 2 speakers, scheduler; no errors or design warnings", async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: AV_CORE });
    const roomId = await rectRoom(h, 8000, 5000, "west", "boardroom", 10);
    const r = await h.ok<{
      recipe: string;
      displayWall: string;
      counts: Record<string, number>;
      items: unknown[];
      unresolved: unknown[];
    }>("furnish_room", { roomId });
    expect(r.result.recipe).toBe("boardroom");
    expect(r.result.counts).toEqual({
      table: 1,
      chair: 10,
      display: 1,
      "video-bar": 1,
      "ceiling-mic": 2,
      "ceiling-speaker": 2,
      scheduler: 1,
    });
    expect(r.result.items).toHaveLength(18);
    expect(r.result.unresolved).toEqual([]);
    expect(countItems(h.ctx.store.project, catalog)).toEqual(r.result.counts);
    // the display is on the wall opposite the door
    expect(r.result.displayWall).toBe("east");
    const [display] = itemsOf(h.ctx.store.project, catalog, "display");
    expect(display?.position.x).toBeGreaterThan(7900);
    expect(display?.mount.kind).toBe("wall");
    const v = await checks(h);
    expect(v.errors).toEqual([]);
    expect(v.warnings.filter((w) => w.code.startsWith("design."))).toEqual([]);
    // one history entry: undo removes everything furnish placed
    h.ctx.store.undo();
    expect(h.ctx.store.project.items).toEqual([]);
    catalog.close();
  });

  it("the door on a long wall still puts the display opposite it", async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: AV_CORE });
    const roomId = await rectRoom(h, 8000, 5000, "south", "boardroom", 10);
    const r = await h.ok<{ displayWall: string; counts: Record<string, number> }>("furnish_room", { roomId });
    expect(r.result.displayWall).toBe("north");
    expect(r.result.counts.chair).toBe(10);
    const [display] = itemsOf(h.ctx.store.project, catalog, "display");
    expect(display?.position.y).toBeGreaterThan(4900);
    expect((await checks(h)).errors).toEqual([]);
    catalog.close();
  });

  it("huddle for 4: round table, 4 chairs, display, bar and scheduler; no ceiling arrays", async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: AV_CORE });
    const roomId = await rectRoom(h, 3500, 3000, "south", "huddle", 4);
    const r = await h.ok<{ recipe: string; counts: Record<string, number> }>("furnish_room", { roomId });
    expect(r.result.recipe).toBe("huddle");
    expect(r.result.counts).toEqual({ table: 1, chair: 4, display: 1, "video-bar": 1, scheduler: 1 });
    const [table] = itemsOf(h.ctx.store.project, catalog, "table");
    expect(table?.ref).toEqual({ kind: "product", productId: "herman-miller-everywhere-round-1200" });
    expect((await checks(h)).errors).toEqual([]);
    catalog.close();
  });

  it("training for 24: tables in rows with chairs facing the display; products it cannot find become recipes and are reported", async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: AV_CORE });
    const roomId = await rectRoom(h, 12000, 10000, "west", "training", 24);
    const r = await h.ok<{ counts: Record<string, number>; unresolved: { category: string }[] }>(
      "furnish_room",
      { roomId },
    );
    expect(r.result.counts).toMatchObject({
      chair: 24,
      display: 1,
      "video-bar": 1,
      scheduler: 1,
      "ceiling-mic": 6,
      "ceiling-speaker": 5,
    });
    const p = h.ctx.store.project;
    expect(p.items.filter((i) => i.ref.kind === "recipe" && i.ref.recipe.kind === "table")).toHaveLength(12);
    expect(r.result.unresolved.map((u) => u.category).sort()).toEqual(["table", "video-bar"]);
    expect(r.warnings.some((w) => w.includes("no catalog table matches"))).toBe(true);
    // every chair faces the display on the east wall: front (sin r, -cos r) points to +x
    for (const c of itemsOf(p, catalog, "chair")) expect(c.rotation).toBe(90);
    expect((await checks(h)).errors).toEqual([]);
    catalog.close();
  });

  it("existing categories are kept unless replace is true", async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: AV_CORE });
    const roomId = await rectRoom(h, 8000, 5000, "west", "boardroom", 10);
    await h.ok("furnish_room", { roomId });
    const again = await h.ok<{ counts: Record<string, number> }>("furnish_room", { roomId });
    expect(again.result.counts).toEqual({});
    expect(again.warnings).toContain("nothing to place; the room already has everything the recipe adds");
    expect(h.ctx.store.project.items).toHaveLength(18);
    const replaced = await h.ok<{ counts: Record<string, number> }>("furnish_room", {
      roomId,
      replace: true,
    });
    expect(replaced.result.counts.chair).toBe(10);
    expect(h.ctx.store.project.items).toHaveLength(18);
    catalog.close();
  });

  it("without catalog matches everything is still placed as recipes, and an unknown recipe is an error", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const roomId = await rectRoom(h, 8000, 5000, "west", "boardroom", 10);
    const r = await h.ok<{
      counts: Record<string, number>;
      unresolved: { category: string; placedAs: string }[];
    }>("furnish_room", {
      roomId,
    });
    expect(r.result.counts.chair).toBe(10);
    expect(r.result.unresolved.map((u) => u.category)).toEqual(
      expect.arrayContaining(["video-bar", "ceiling-mic", "ceiling-speaker", "scheduler"]),
    );
    const bad = await h.call("furnish_room", { roomId, recipe: "cafe" });
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.error).toMatchObject({
        code: "recipe.unknown",
        hint: "use one of huddle, boardroom, training, meeting, open-office, cafeteria, reception",
      });
  });
});

describe("create_room_from_brief (PRD P1-4 task card)", () => {
  it("'10-seat boardroom, 8 by 5 metres, video conferencing' becomes a furnished room with a clean BOM", async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: AV_CORE });
    const r = await h.ok<{
      understood: Record<string, unknown>;
      room: { id: string; areaM2: number };
      counts: Record<string, number>;
      displayWall: string;
    }>("create_room_from_brief", { brief: "10-seat boardroom, 8 by 5 metres, video conferencing" });
    expect(r.result.understood).toEqual({
      purpose: "boardroom",
      capacity: 10,
      widthMm: 8000,
      depthMm: 5000,
      av: ["video-conferencing"],
      corridorSide: "west",
    });
    expect(r.result.room.areaM2).toBeCloseTo(40, 1);
    expect(r.result.counts).toEqual({
      table: 1,
      chair: 10,
      display: 1,
      "video-bar": 1,
      "ceiling-mic": 2,
      "ceiling-speaker": 2,
      scheduler: 1,
    });
    const p = h.ctx.store.project;
    expect(p.walls).toHaveLength(4);
    const door = p.openings[0];
    const doorWall = p.walls.find((w) => w.id === door?.wallId);
    expect(doorWall && Math.max(doorWall.start.x, doorWall.end.x)).toBeLessThan(0);
    expect(r.result.displayWall).toBe("east");
    const v = await checks(h);
    expect(v.errors).toEqual([]);
    expect(v.warnings.filter((w) => w.code.startsWith("design."))).toEqual([]);
    const bom = await h.ok<Bom>("get_bom", { scope: `room:${r.result.room.id}` });
    expect(bom.result.lines.find((l) => l.category === "chair")?.quantity).toBe(10);
    catalog.close();
  });

  it("a second brief goes beside the first; without video conferencing there is no bar or ceiling mic", async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: AV_CORE });
    await h.ok("create_room_from_brief", { brief: "10-seat boardroom, 8 by 5 metres, video conferencing" });
    const second = await h.ok<{ counts: Record<string, number>; room: { id: string } }>(
      "create_room_from_brief",
      {
        brief: "4 person huddle room 3 by 3 m with a screen",
      },
    );
    expect(second.result.counts["video-bar"]).toBeUndefined();
    expect(second.warnings).toContain(
      "the brief does not mention video conferencing, so no video bar or ceiling microphones were placed",
    );
    const room = h.ctx.store.project.rooms.find((x) => x.id === second.result.room.id);
    expect(Math.min(...(room?.polygon.map((q) => q.x) ?? []))).toBeGreaterThan(8000);
    expect((await checks(h)).errors).toEqual([]);
    catalog.close();
  });

  it("a failure undoes the walls and room it created", async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: AV_CORE });
    const r = await h.call("create_room_from_brief", {
      brief: "10-seat boardroom 8 by 5 m",
      levelId: "level_zzzzzz",
    });
    expect(r.ok).toBe(false);
    const bad = await h.call("create_room_from_brief", {
      brief: "boardroom 8 by 5 m",
      corridorSide: "north",
      origin: { x: 0, y: 0 },
    });
    expect(bad.ok).toBe(true);
    expect(h.ctx.store.project.rooms).toHaveLength(1);
    catalog.close();
  });
});

// Furnishing a home (spec 07 section 4.2): the residential recipes, the along-wall step they are
// built from, and the size rules that tell a bedroom from a cupboard.
//
// The run these exist because of drew three 8 m² "bedrooms" with no bed, no kitchen and no bathroom,
// because the only recipes in the pack were meeting rooms and the only rule about a room's size was
// that a display had to be big enough to read from the back of it.
import { CORE_RULES, checkDesign, ensureSeed, HOME_CORE, validatePack } from "@fpv/catalog";
import { CatalogStore } from "@fpv/catalog/store";
import type { Item, Project, Room } from "@fpv/ir";
import { derive } from "@fpv/ir";
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
  if (i.ref.kind === "recipe") {
    const k = i.ref.recipe.kind;
    return k === "box" || k === "cylinder" ? "other" : k;
  }
  return catalog.product(i.ref.productId)?.category ?? "unknown";
}

/** The catalogue name of the product an item refers to, for asserting which fixture was placed. */
function nameOf(p: Project, i: Item): string {
  const id = (i.ref as { productId?: string }).productId ?? "";
  const snap = p.catalogRefs[id] as { name?: unknown } | undefined;
  return typeof snap?.name === "string" ? snap.name : id;
}

function counts(p: Project, catalog: CatalogSearch): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of p.items) {
    const c = categoryOf(catalog, i);
    out[c] = (out[c] ?? 0) + 1;
  }
  return out;
}

/** A rectangular room whose inside is w by d, with one door in the middle of the named wall. */
async function rectRoom(
  h: H,
  w: number,
  d: number,
  doorOn: "south" | "east" | "north" | "west",
  purpose: string,
  capacity: number | null = null,
  origin = { x: 0, y: 0 },
) {
  const { x, y } = origin;
  const walls = await h.ok<{ walls: { id: string }[] }>("create_walls", {
    levelId: L,
    points: [
      { x: x - 50, y: y - 50 },
      { x: x + w + 50, y: y - 50 },
      { x: x + w + 50, y: y + d + 50 },
      { x: x - 50, y: y + d + 50 },
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
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + d },
      { x, y: y + d },
    ],
    name: purpose,
    purpose,
    ...(capacity === null ? {} : { capacity }),
  });
  return r.result.room.id;
}

/**
 * Items whose footprint covers part of an opening, as "item over opening" strings.
 *
 * This is the check the flat run would have failed in every bedroom: the wardrobe stood across the
 * door because the placement code looked at the whole wall instead of what was free of it.
 */
function blockedOpenings(p: Project): string[] {
  const sizes = derive.snapshotSizeSource(p);
  const out: string[] = [];
  for (const o of p.openings) {
    const w = p.walls.find((x) => x.id === o.wallId);
    if (!w) continue;
    const len = Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
    if (len === 0) continue;
    const u = { x: (w.end.x - w.start.x) / len, y: (w.end.y - w.start.y) / len };
    const mid = o.position * len;
    for (const it of p.items) {
      const size = derive.itemSize(it, sizes);
      if (!size) continue;
      const fp = derive.itemFootprint(it, size);
      const along = fp.map((q) => (q.x - w.start.x) * u.x + (q.y - w.start.y) * u.y);
      const away = fp.map((q) => Math.abs((q.x - w.start.x) * u.y - (q.y - w.start.y) * u.x));
      const overlaps = Math.min(...along) < mid + o.width / 2 && Math.max(...along) > mid - o.width / 2;
      // only what stands against this wall counts; something across the room is not in the way
      if (overlaps && Math.min(...away) <= w.thickness / 2 + 200)
        out.push(`${(it.ref as { productId?: string }).productId ?? it.ref.kind} over ${o.kind} ${o.id}`);
    }
  }
  return out;
}

const room = (purpose: string, capacity: number | null, w = 4000, d = 3000) =>
  ({
    purpose,
    capacity,
    polygon: [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: d },
      { x: 0, y: d },
    ],
    holes: [],
  }) as never as Room;

describe("the residential pack (spec 07 section 3.2)", () => {
  it("is a valid pack that overlays the AV one, keeping both sets of recipes", () => {
    expect(validatePack(HOME_CORE).problems).toEqual([]);
    expect(CORE_RULES.recipes.map((r) => r.id)).toEqual([
      "huddle",
      "boardroom",
      "training",
      "meeting",
      "open-office",
      "cafeteria",
      "reception",
      "bedroom-single",
      "bedroom",
      "living",
      "kitchen",
      "dining",
      "bathroom",
      "toilet",
      "study",
      "laundry",
      "foyer",
      "balcony",
      "garage",
      "corridor",
    ]);
    // the AV rules survive the merge, so an office in the same session is still checked
    expect(CORE_RULES.designRules.some((r) => r.id === "display-size-detail")).toBe(true);
    expect(CORE_RULES.bomRules.some((r) => r.id === "display-mount")).toBe(true);
  });

  it("chooses a recipe by what the room is for, and never lends a home a workplace one", () => {
    expect(pickRecipe(CORE_RULES, room("bedroom", 2)).id).toBe("bedroom");
    expect(pickRecipe(CORE_RULES, room("bedroom", 1)).id).toBe("bedroom-single");
    // a bedroom for seven is a large bedroom, not the dining room whose seat range it happens to fit
    expect(pickRecipe(CORE_RULES, room("bedroom", 7)).id).toBe("bedroom");
    expect(pickRecipe(CORE_RULES, room("kitchen", null)).id).toBe("kitchen");
    expect(pickRecipe(CORE_RULES, room("bathroom", null)).id).toBe("bathroom");
    expect(pickRecipe(CORE_RULES, room("living", null, 5000, 4000)).id).toBe("living");
    // and the office keeps the behaviour it had: three sizes of one kind of room
    expect(pickRecipe(CORE_RULES, room("boardroom", 10)).id).toBe("boardroom");
    expect(pickRecipe(CORE_RULES, room("boardroom", 80)).id).toBe("training");
    expect(pickRecipe(CORE_RULES, room("other", 30)).id).toBe("training");
  });

  it("refuses rather than furnishing a home from a pack that has no recipe for it", () => {
    const office = { ...CORE_RULES, recipes: CORE_RULES.recipes.slice(0, 3) };
    expect(() => pickRecipe(office, room("bedroom", 2))).toThrow(/no recipe for a bedroom room/);
  });
});

describe("furnishing a home's rooms", () => {
  it("a bedroom gets a bed against the wall opposite the door and a wardrobe on a side wall", async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: CORE_RULES });
    // door on the south wall, so the bed's headboard belongs on the north one
    const roomId = await rectRoom(h, 3600, 4000, "south", "bedroom", 2);
    const r = await h.ok<{ recipe: string; counts: Record<string, number> }>("furnish_room", { roomId });
    expect(r.result.recipe).toBe("bedroom");
    expect(r.result.counts).toMatchObject({ bed: 1, wardrobe: 1 });
    const p = h.ctx.store.project;
    expect(counts(p, catalog)).toEqual({ bed: 1, wardrobe: 1 });

    const bed = p.items.find((i) => categoryOf(catalog, i) === "bed") as Item;
    const size = derive.itemSize(bed, derive.snapshotSizeSource(p)) as { w: number; d: number };
    // headboard (local +y) against the north wall, so the bed faces south, into the room
    expect(bed.position.y + size.d / 2).toBeGreaterThan(3900);
    expect(bed.rotation).toBe(0);
    // and it is inside the room, which is the thing the old office recipes could not promise
    const inside = derive
      .itemFootprint(bed, derive.itemSize(bed, derive.snapshotSizeSource(p)) as never)
      .every((q) => q.x >= 0 && q.x <= 3600 && q.y >= 0 && q.y <= 4000);
    expect(inside).toBe(true);

    const wardrobe = p.items.find((i) => categoryOf(catalog, i) === "wardrobe") as Item;
    expect(Math.min(wardrobe.position.x, 3600 - wardrobe.position.x)).toBeLessThan(700);
    const checks = await h.ok<{ errors: unknown[] }>("validate", {});
    expect(checks.result.errors).toEqual([]);
    catalog.close();
  });

  it("a bathroom's shower, basin and toilet stand in a row along one wall rather than on top of each other", async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: CORE_RULES });
    const roomId = await rectRoom(h, 2400, 2000, "south", "bathroom");
    await h.ok("furnish_room", { roomId });
    const p = h.ctx.store.project;
    const sizes = derive.snapshotSizeSource(p);
    const fixtures = p.items
      .filter((i) => categoryOf(catalog, i) === "sanitary")
      .sort((a, b) => a.position.x - b.position.x);
    expect(fixtures).toHaveLength(3);
    const names = fixtures.map((i) => nameOf(p, i));
    expect(names.join(", ")).toContain("shower");
    for (let i = 1; i < fixtures.length; i += 1) {
      const a = fixtures[i - 1] as Item;
      const b = fixtures[i] as Item;
      const ends = (derive.itemSize(a, sizes) as { w: number }).w / 2;
      const starts = (derive.itemSize(b, sizes) as { w: number }).w / 2;
      expect(b.position.x - starts).toBeGreaterThanOrEqual(a.position.x + ends);
    }
    catalog.close();
  });

  it("a living room seats a sofa facing the television, and a kitchen gets a run and a fridge", async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: CORE_RULES });
    const living = await rectRoom(h, 5000, 4000, "south", "living");
    await h.ok("furnish_room", { roomId: living });
    const p1 = h.ctx.store.project;
    expect(counts(p1, catalog)).toMatchObject({ sofa: 1, storage: 1, display: 1 });
    const sofa = p1.items.find((i) => categoryOf(catalog, i) === "sofa") as Item;
    const tv = p1.items.find((i) => categoryOf(catalog, i) === "display") as Item;
    // they face each other across the room: the sofa on the door side, the television opposite
    expect(Math.abs(sofa.rotation - tv.rotation)).toBe(180);
    expect(sofa.position.y).toBeLessThan(tv.position.y);

    const kitchen = await rectRoom(h, 4200, 2400, "south", "kitchen", null, { x: 8000, y: 0 });
    await h.ok("furnish_room", { roomId: kitchen });
    const p2 = h.ctx.store.project;
    expect(counts(p2, catalog)).toMatchObject({ "kitchen-run": 1, appliance: 1 });
    const fridge = p2.items.find((i) => categoryOf(catalog, i) === "appliance") as Item;
    expect(nameOf(p2, fridge)).toContain("fridge");
    catalog.close();
  });

  it("nothing a recipe places stands across a door or a window", async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: CORE_RULES });
    // a door on the south wall and a wide passage on the north: whichever wall the recipe picks,
    // the opening in it is not a place to stand a bed
    const roomId = await rectRoom(h, 3600, 4000, "south", "bedroom", 2);
    const north = h.ctx.store.project.walls.find((w) => w.start.y === 4050 && w.end.y === 4050) as {
      id: string;
    };
    await h.ok("add_opening", { wallId: north.id, kind: "passage", position: 0.5, width: 1200 });
    await h.ok("furnish_room", { roomId });
    expect(blockedOpenings(h.ctx.store.project)).toEqual([]);
    // and the room really was furnished, so the check above is not passing on an empty room
    expect(h.ctx.store.project.items.length).toBeGreaterThan(0);
    catalog.close();
  });

  it("says so rather than placing over an opening when what is left of the wall is too short", async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: CORE_RULES });
    const roomId = await rectRoom(h, 3600, 4000, "south", "bedroom", 2);
    const north = h.ctx.store.project.walls.find((w) => w.start.y === 4050 && w.end.y === 4050) as {
      id: string;
    };
    await h.ok("add_opening", { wallId: north.id, kind: "passage", position: 0.5, width: 2400 });
    const r = await h.ok("furnish_room", { roomId });
    expect(r.warnings.join(" ")).toMatch(
      /no free run on the (north|south|east|west) wall for the \w+: it is \d+ mm wide and the longest gap between the openings is \d+ mm/,
    );
    expect(blockedOpenings(h.ctx.store.project)).toEqual([]);
    catalog.close();
  });

  it("says so when the room is too shallow for what the recipe wanted, rather than pretending", async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: CORE_RULES });
    const roomId = await rectRoom(h, 1600, 2200, "south", "bedroom", 2);
    const r = await h.ok("furnish_room", { roomId });
    expect(r.warnings.join(" ")).toMatch(/leaves less than 700 mm of floor in front of it/);
    catalog.close();
  });
});

describe("residential design rules", () => {
  const withRoom = async (w: number, d: number, purpose: string) => {
    const h = harness(undefined, { rules: CORE_RULES });
    await rectRoom(h, w, d, "south", purpose);
    return checkDesign(h.ctx.store.project, CORE_RULES).map((x) => x.code);
  };

  it("a bedroom under 9 m², or narrower than 2.4 m, is reported", async () => {
    expect(await withRoom(2600, 3000, "bedroom")).toEqual(["design.bedroom-size"]);
    expect(await withRoom(2000, 5000, "bedroom")).toEqual(["design.bedroom-size"]);
    expect(await withRoom(3000, 3600, "bedroom")).toEqual([]);
  });

  it("the other rooms of a home have sizes of their own", async () => {
    expect(await withRoom(2500, 3000, "living")).toEqual(["design.living-size"]);
    expect(await withRoom(4000, 3500, "living")).toEqual([]);
    expect(await withRoom(1500, 2000, "kitchen")).toEqual(["design.kitchen-size"]);
    expect(await withRoom(1200, 1800, "bathroom")).toEqual(["design.bathroom-size"]);
    expect(await withRoom(900, 1400, "toilet")).toEqual([]);
    expect(await withRoom(800, 1000, "toilet")).toEqual(["design.toilet-size"]);
  });
});

describe("what may stand under a window", () => {
  /** A bedroom whose only long wall carries the window, which is where a bed has to go. */
  const bedroomWithWindow = async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: CORE_RULES });
    const roomId = await rectRoom(h, 2800, 3300, "south", "bedroom", 2);
    const north = h.ctx.store.project.walls.find((w) => w.start.y === 3350 && w.end.y === 3350) as {
      id: string;
    };
    await h.ok("add_opening", {
      wallId: north.id,
      kind: "window",
      position: 0.5,
      width: 1200,
      sill: 900,
    });
    return { h, catalog };
  };

  it("puts the bed under the window rather than leaving the room without one", async () => {
    const { h, catalog } = await bedroomWithWindow();
    const room = h.ctx.store.project.rooms[0] as { id: string };
    const r = await h.ok<{ counts: Record<string, number> }>("furnish_room", { roomId: room.id });
    // the fault this test exists for: two of three bedrooms came back with a wardrobe and no bed,
    // because the window sat in the only wall long enough to take one
    expect(r.result.counts.bed).toBe(1);
    const bed = h.ctx.store.project.items.find((i) =>
      (i.ref as { productId?: string }).productId?.includes("bed"),
    ) as { position: { y: number } };
    expect(bed.position.y).toBeGreaterThan(1500);
    catalog.close();
  });

  it("still keeps a wardrobe off the window, because it is taller than the sill", async () => {
    const { h, catalog } = await bedroomWithWindow();
    const room = h.ctx.store.project.rooms[0] as { id: string };
    await h.ok("furnish_room", { roomId: room.id });
    expect(blockedOpenings(h.ctx.store.project).filter((s) => s.includes("wardrobe"))).toEqual([]);
    catalog.close();
  });

  it("still keeps everything off the door", async () => {
    const { h, catalog } = await bedroomWithWindow();
    const room = h.ctx.store.project.rooms[0] as { id: string };
    await h.ok("furnish_room", { roomId: room.id });
    const doors = h.ctx.store.project.openings.filter((o) => o.kind === "door").map((o) => o.id);
    const over = blockedOpenings(h.ctx.store.project).filter((s) => doors.some((d) => s.includes(d)));
    expect(over).toEqual([]);
    catalog.close();
  });
});

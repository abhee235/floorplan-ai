// The tools a model reads with, and the ones a real run showed were lying (ADR-027 D3, D4, D6, D7):
// look_at, web_search and read_page; batch taking tool calls; arrange saying what it does;
// search_catalog saying where the matches are; and the recipes the pack was always meant to have.
import { AV_CORE, staticFetcher, staticSearch } from "@fpv/catalog";
import type { Item, Project } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { type CatalogSearch, pickRecipe, type ToolContext } from "../src/index.js";
import { type Harness, harness, PRODUCTS } from "./helpers.js";

const L = "level_000000";
/** A 1 x 1 PNG, so a picture can be a real picture. */
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const png = () => new Uint8Array(Buffer.from(PNG_1x1, "base64"));

function attachments(
  files: { id: string; name: string; mime: string; bytes: Uint8Array }[],
): NonNullable<ToolContext["attachments"]> {
  return {
    get: (id) => files.find((f) => f.id === id) ?? null,
    list: () => files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.bytes.length })),
  };
}

const web = (pages: Record<string, string | { contentType?: string; body: string }> = {}) => ({
  search: staticSearch(
    {
      "office layout": [{ url: "https://x.test/office", title: "Office layout", snippet: "Benches of six." }],
    },
    {
      "office layout": [
        {
          url: "https://x.test/office.png",
          title: "An office",
          source: "https://x.test/office",
          thumbnail: null,
        },
      ],
    },
  ),
  fetcher: staticFetcher({
    "https://x.test/office":
      "<html><head><title>Office  layout</title></head><body><p>Benches of six.</p></body></html>",
    "https://x.test/office.png": { contentType: "image/png", body: PNG_1x1 },
    ...pages,
  }),
});

async function rectRoom(
  h: Harness,
  w: number,
  d: number,
  purpose: string,
  capacity: number,
): Promise<string> {
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
  await h.ok("add_opening", { wallId: walls.result.walls[3]?.id, kind: "door", position: 0.5, width: 900 });
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

function categoryOf(catalog: CatalogSearch, i: Item): string {
  if (i.ref.kind === "recipe") return i.ref.recipe.kind;
  return catalog.product(i.ref.productId)?.category ?? "?";
}

function counts(p: Project, catalog: CatalogSearch): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of p.items) out[categoryOf(catalog, i)] = (out[categoryOf(catalog, i)] ?? 0) + 1;
  return out;
}

describe("look_at", () => {
  it("hands an attachment back as a picture, with its size and the question in the caption", async () => {
    const h = harness(undefined, {
      attachments: attachments([{ id: "a1", name: "logo.png", mime: "image/png", bytes: png() }]),
    });
    const r = await h.ok<{
      mime: string;
      width: number;
      height: number;
      caption: string;
      images: { mime: string; pngBase64: string }[];
    }>("look_at", { attachmentId: "a1", question: "is this a floor plan?" });
    expect(r.result).toMatchObject({ mime: "image/png", width: 1, height: 1 });
    expect(r.result.caption).toBe("logo.png, which you asked to look at: is this a floor plan?");
    expect(r.result.images[0]).toMatchObject({ mime: "image/png", pngBase64: PNG_1x1 });
  });

  it("names what is attached when the id is wrong, and sends a PDF to import_plan", async () => {
    const h = harness(undefined, {
      attachments: attachments([
        { id: "a1", name: "logo.png", mime: "image/png", bytes: png() },
        { id: "a2", name: "plan.pdf", mime: "application/pdf", bytes: new Uint8Array([1, 2, 3]) },
      ]),
    });
    const wrong = await h.call("look_at", { attachmentId: "a9" });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.hint).toBe("attached: a1 (logo.png), a2 (plan.pdf)");
    const pdf = await h.call("look_at", { attachmentId: "a2" });
    expect(pdf.ok).toBe(false);
    if (!pdf.ok)
      expect(pdf.error).toMatchObject({
        code: "image.not-an-image",
        hint: "a PDF plan is read with import_plan",
      });
    const neither = await h.call("look_at", {});
    expect(neither.ok).toBe(false);
  });

  it("fetches a picture from the web through the guarded fetcher, and refuses without one", async () => {
    const h = harness(undefined, { web: web() });
    const r = await h.ok<{ name: string; mime: string; width: number }>("look_at", {
      url: "https://x.test/office.png",
    });
    expect(r.result).toMatchObject({ name: "https://x.test/office.png", mime: "image/png", width: 1 });
    const bare = harness();
    const refused = await bare.call("look_at", { url: "https://x.test/office.png" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("unavailable");
  });
});

describe("the web, when the host has it", () => {
  it("searches pages and pictures, and reads a page as text with its title", async () => {
    const h = harness(undefined, { web: web() });
    const pages = await h.ok<{ hits: { url: string; snippet?: string }[] }>("web_search", {
      query: "office layout",
    });
    expect(pages.result.hits).toEqual([
      { url: "https://x.test/office", title: "Office layout", snippet: "Benches of six." },
    ]);
    const pictures = await h.ok<{ hits: { url: string; source?: string }[] }>("web_search", {
      query: "office layout",
      kind: "images",
    });
    expect(pictures.result.hits[0]).toMatchObject({
      url: "https://x.test/office.png",
      source: "https://x.test/office",
    });
    const page = await h.ok<{ title: string | null; text: string; truncated: boolean }>("read_page", {
      url: "https://x.test/office",
    });
    expect(page.result).toMatchObject({ title: "Office layout", truncated: false });
    expect(page.result.text).toContain("Benches of six.");
  });

  it("is not there without a search provider, and says how to get one", async () => {
    const h = harness();
    for (const [name, args] of [
      ["web_search", { query: "x" }],
      ["read_page", { url: "https://x.test/office" }],
    ] as const) {
      const r = await h.call(name, args);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("unavailable");
        expect(r.error.hint).toContain("FPV_SEARCH");
      }
    }
  });
});

describe("batch takes tool calls (ADR-027 D6)", () => {
  const walls = {
    levelId: L,
    points: [
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
      { x: 4000, y: 3000 },
      { x: 0, y: 3000 },
    ],
    closed: true,
    thickness: 100,
    kind: "interior",
  };

  it("runs them in order and returns each result", async () => {
    const h = harness();
    const r = await h.ok<{ applied: number; results: { walls: unknown[] }[] }>("batch", {
      calls: [
        { name: "create_walls", args: walls },
        { name: "validate", args: {} },
      ],
    });
    expect(r.result.applied).toBe(2);
    expect(r.result.results[0]?.walls).toHaveLength(4);
    expect(h.ctx.store.project.walls).toHaveLength(4);
  });

  it("undoes what the earlier calls did when a later one fails, and says which", async () => {
    const h = harness();
    const r = await h.call("batch", {
      calls: [
        { name: "create_walls", args: walls },
        { name: "add_opening", args: { wallId: "wall_nope", kind: "door", position: 0.5, width: 900 } },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error.message).toContain("call 2 of 2 (add_opening) failed and the 1 before it were undone");
    expect(h.ctx.store.project.walls).toHaveLength(0);
    const nested = await h.call("batch", { calls: [{ name: "batch", args: { calls: [] } }] });
    expect(nested.ok).toBe(false);
  });
});

describe("tools that say what they do", () => {
  it("arrange refuses the patterns the reducer never had", async () => {
    const h = harness();
    const roomId = await rectRoom(h, 6000, 5000, "boardroom", 8);
    const r = await h.call("arrange", {
      roomId,
      pattern: "boardroom",
      count: 8,
      productId: "acme-task-chair",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("pattern");
  });

  it("search_catalog with a category that matches nothing says where the matches are", async () => {
    const h = harness();
    const r = await h.ok<{ hits: unknown[]; total: number }>("search_catalog", {
      kind: "product",
      query: "chair",
      category: "table",
    });
    expect(r.result.total).toBe(0);
    expect(
      r.warnings.some((w) => w.includes('nothing under category "table"') && w.includes("chair (1)")),
    ).toBe(true);
  });
});

describe("the recipes the pack was meant to have (ADR-027 D7)", () => {
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

  it("are chosen by purpose, and only the seated rooms stand in for one another", () => {
    expect(AV_CORE.recipes.map((r) => r.id)).toEqual([
      "huddle",
      "boardroom",
      "training",
      "meeting",
      "open-office",
      "cafeteria",
      "reception",
    ]);
    expect(pickRecipe(AV_CORE, room("meeting", 6)).id).toBe("meeting");
    expect(pickRecipe(AV_CORE, room("open-office", 100)).id).toBe("open-office");
    expect(pickRecipe(AV_CORE, room("cafeteria", 30)).id).toBe("cafeteria");
    expect(pickRecipe(AV_CORE, room("reception", 0)).id).toBe("reception");
    // an unknown purpose for forty is a training room, never forty desks
    expect(pickRecipe(AV_CORE, room("other", 40)).id).toBe("training");
    expect(pickRecipe(AV_CORE, room("boardroom", 80)).id).toBe("training");
  });

  it("open-office: every desk has its chair, in benches, and nothing overlaps", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const roomId = await rectRoom(h, 20000, 14000, "open-office", 24);
    const r = await h.ok<{ recipe: string; counts: Record<string, number> }>("furnish_room", { roomId });
    expect(r.result.recipe).toBe("open-office");
    expect(r.result.counts).toMatchObject({ desk: 24, chair: 24 });
    const p = h.ctx.store.project;
    const catalog = h.ctx.catalog;
    // a bench is two rows facing away from each other: the chairs face two ways, 180 degrees apart
    const facings = new Set(p.items.filter((i) => categoryOf(catalog, i) === "chair").map((i) => i.rotation));
    expect(facings.size).toBe(2);
    const [a, b] = [...facings] as [number, number];
    expect(Math.abs(a - b) % 360).toBe(180);
    const problems = await h.ok<{ errors: { code: string }[] }>("validate", {});
    expect(problems.result.errors).toEqual([]);
    expect(counts(p, catalog)).toMatchObject({ table: 24, chair: 24 });
  });

  it("meeting, cafeteria and reception furnish the rooms a run asked for by name", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const meeting = await rectRoom(h, 6000, 5000, "meeting", 6);
    const m = await h.ok<{ recipe: string; counts: Record<string, number> }>("furnish_room", {
      roomId: meeting,
    });
    expect(m.result.recipe).toBe("meeting");
    expect(m.result.counts).toMatchObject({ table: 1, chair: 6, display: 1 });

    const h2 = harness(undefined, { rules: AV_CORE });
    const cafe = await rectRoom(h2, 10000, 8000, "cafeteria", 24);
    const c = await h2.ok<{ recipe: string; counts: Record<string, number> }>("furnish_room", {
      roomId: cafe,
    });
    expect(c.result.recipe).toBe("cafeteria");
    expect(c.result.counts).toMatchObject({ table: 6, chair: 24 });
    expect((await h2.ok<{ errors: unknown[] }>("validate", {})).result.errors).toEqual([]);

    const h3 = harness(undefined, { rules: AV_CORE });
    // two sofas of 1,800 with 300 between and past each end need 4,500 mm of side wall
    const reception = await rectRoom(h3, 8000, 5000, "reception", 8);
    // and a window on the wall opposite the door, where the desk goes: a desk with its back to a
    // window is the ordinary thing, and a real run's reception had none because of one
    const east = h3.ctx.store.project.walls.find((w) => w.start.x === 8050 && w.end.x === 8050);
    await h3.ok("add_opening", { wallId: east?.id, kind: "window", position: 0.5, width: 1500, sill: 900 });
    const r = await h3.ok<{ recipe: string; counts: Record<string, number> }>("furnish_room", {
      roomId: reception,
    });
    expect(r.result.recipe).toBe("reception");
    expect(r.result.counts).toMatchObject({ desk: 1, sofa: 2 });
  });
});

// the seed products the harness knows, so a reviewer can see what "chair (1)" counts
void PRODUCTS;

describe("the agent builds in the project it was asked in", () => {
  it("may not start or open a project, and is told where to build instead", async () => {
    const h = harness();
    const before = h.ctx.store.project.meta.id;
    for (const op of ["new", "open"] as const) {
      const r = await h.registry.call(
        "project",
        { op, name: "Another", path: "elsewhere" },
        { origin: "agent" },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("unavailable");
        expect(r.error.hint).toContain("build here");
      }
    }
    expect(h.ctx.store.project.meta.id).toBe(before);
    // a person at the editor may
    const mine = await h.registry.call("project", { op: "new", name: "Fresh" }, { origin: "editor" });
    expect(mine.ok).toBe(true);
    expect(h.ctx.store.project.meta.name).toBe("Fresh");
  });
});

describe("an empty search says what to do instead", () => {
  it("tells the model to place a labelled box, not to search again", async () => {
    const h = harness();
    const products = await h.ok<{ total: number }>("search_catalog", {
      kind: "product",
      query: "server rack",
    });
    expect(products.result.total).toBe(0);
    expect(
      products.warnings.some((w) => w.includes('kind: "box"') && w.includes('label: "server rack"')),
    ).toBe(true);
    const recipes = await h.ok<{ total: number }>("search_catalog", {
      kind: "recipe",
      query: "espresso machine",
    });
    expect(recipes.result.total).toBe(0);
    expect(recipes.warnings.some((w) => w.includes("rewording will not find one"))).toBe(true);
    // a search that found something says nothing of the kind
    const chairs = await h.ok("search_catalog", { kind: "product", query: "chair" });
    expect(chairs.warnings).toEqual([]);
  });
});

describe("a room of rows and no screen is laid out along its length", () => {
  it("fits a narrow cafeteria that was framed across its width, and says so when nothing fits", async () => {
    // the room from the run: 4.3 by 17.4 m, door on the long side
    const h = harness(undefined, { rules: AV_CORE });
    const roomId = await rectRoom(h, 17400, 4300, "cafeteria", 24);
    const r = await h.ok<{ counts: Record<string, number> }>("furnish_room", { roomId });
    expect(r.result.counts.table ?? 0).toBeGreaterThanOrEqual(4);
    expect(r.result.counts.chair).toBe(2 * (r.result.counts.table ?? 0) * 2);
    expect((await h.ok<{ errors: unknown[] }>("validate", {})).result.errors).toEqual([]);

    // and a cupboard of a room, where nothing can fit, is not said to be full
    const h2 = harness(undefined, { rules: AV_CORE });
    const tiny = await rectRoom(h2, 1800, 1500, "cafeteria", 8);
    const t = await h2.ok("furnish_room", { roomId: tiny });
    expect(t.warnings.some((w) => w.includes("nothing from the cafeteria recipe fitted this room"))).toBe(
      true,
    );
    expect(t.warnings.some((w) => w.includes("already has everything"))).toBe(false);
  });
});

describe("a mount on another item is where the thing goes", () => {
  it("stands it on the item it names, and refuses an item in another room", async () => {
    const h = harness();
    const a = await rectRoom(h, 6000, 5000, "other", 0);
    const table = await h.ok<{ item: { id: string; position: { x: number; y: number } } }>("place_item", {
      recipe: { kind: "table", shape: "rect", size: { w: 1800, d: 900, h: 740 } },
      roomId: a,
      anchor: "center",
    });
    const tv = await h.ok<{ item: { position: { x: number; y: number }; elevation: number } }>("place_item", {
      recipe: { kind: "display", diagonalIn: 55, bezelMm: 15 },
      roomId: a,
      mount: { kind: "table", targetId: table.result.item.id },
    });
    expect(tv.result.item.position).toEqual(table.result.item.position);
    expect(tv.result.item.elevation).toBeGreaterThanOrEqual(700);

    // the run's second slip: a room named, and a table from the room next door
    const h2 = harness();
    const first = await rectRoom(h2, 6000, 5000, "cafeteria", 0);
    const t2 = await h2.ok<{ item: { id: string } }>("place_item", {
      recipe: { kind: "table", shape: "rect", size: { w: 1800, d: 900, h: 740 } },
      roomId: first,
      anchor: "center",
    });
    const other = await h2.ok<{ room: { id: string } }>("create_room", {
      levelId: L,
      polygon: [
        { x: 7000, y: 0 },
        { x: 11000, y: 0 },
        { x: 11000, y: 4000 },
        { x: 7000, y: 4000 },
      ],
      name: "Breakout",
      purpose: "other",
    });
    const wrong = await h2.call("place_item", {
      recipe: { kind: "display", diagonalIn: 55, bezelMm: 15 },
      roomId: other.result.room.id,
      mount: { kind: "table", targetId: t2.result.item.id },
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.message).toContain("not in the room you named");
  });
});

describe("a room's openings are the ones in its own stretch of wall", () => {
  it("does not claim the windows of the rooms that share its long outside wall", async () => {
    // two rooms side by side under one 12 m outside wall, each with its own window in it
    const h = harness();
    const outside = await h.ok<{ walls: { id: string }[] }>("create_walls", {
      levelId: L,
      points: [
        { x: 0, y: 4000 },
        { x: 12000, y: 4000 },
      ],
      closed: false,
      thickness: 230,
      kind: "exterior",
    });
    const wallId = outside.result.walls[0]?.id;
    await h.ok("add_opening", { wallId, kind: "window", position: 0.25, width: 1200, sill: 900 });
    await h.ok("add_opening", { wallId, kind: "window", position: 0.75, width: 1200, sill: 900 });
    const room = (x0: number, name: string) =>
      h.ok<{ room: { id: string } }>("create_room", {
        levelId: L,
        polygon: [
          { x: x0, y: 0 },
          { x: x0 + 6000, y: 0 },
          { x: x0 + 6000, y: 3885 },
          { x: x0, y: 3885 },
        ],
        name,
        purpose: "other",
      });
    const west = await room(0, "West");
    const east = await room(6000, "East");
    const seen = async (id: string) =>
      (await h.ok<{ openings: { id: string }[] }>("describe_room", { roomId: id })).result.openings.length;
    expect(await seen(west.result.room.id)).toBe(1);
    expect(await seen(east.result.room.id)).toBe(1);
  });
});

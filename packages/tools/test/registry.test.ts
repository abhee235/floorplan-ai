import { describe, expect, it } from "vitest";
import { hingeEndFor, parseAnchor, RECIPE_TEMPLATES, TOOLS } from "../src/index.js";
import { buildFixtureRoom, harness } from "./helpers.js";

describe("registry conventions (spec 04 section 1, ADR-006 D3, D4)", () => {
  it("registers the 23 first-release tools, import_plan, the finish tools, the four design tools and the three reading tools", () => {
    const h = harness();
    const names = h.registry.list().map((t) => t.name);
    expect(names).toHaveLength(38);
    expect(new Set(names).size).toBe(38);
    for (const name of [
      "design_layout",
      "plan_rooms",
      "check_design",
      "build_design",
      "look_at",
      "web_search",
      "read_page",
    ])
      expect(names, name).toContain(name);
    expect(TOOLS.every((t) => t.description.length > 20)).toBe(true);
  });

  it("applies as whoever called, and records it (ADR-019 D2)", async () => {
    const h = harness();
    // The origin rides on the store's event, which is what the session log and every tab read
    const seen: string[] = [];
    h.ctx.store.subscribe((e) => seen.push(e.origin));
    await h.registry.call(
      "create_walls",
      {
        levelId: "level_000000",
        points: [
          { x: 0, y: 0 },
          { x: 3000, y: 0 },
        ],
        closed: false,
      },
      { origin: "editor" },
    );
    expect(seen).toEqual(["editor"]);
    expect(h.transcript.entries.at(-1)?.origin).toBe("editor");

    // and an agent is still the default, because that is who calls a tool when nobody says otherwise
    await h.registry.call("get_scene", { detail: "summary" });
    expect(h.transcript.entries.at(-1)?.origin).toBe("agent");
  });

  it("unknown arguments never fail a call; they are reported in warnings", async () => {
    const h = harness();
    const r = await h.ok("get_scene", { detail: "summary", colour: "red", verbose: true });
    expect(r.warnings).toEqual(["Unknown arguments ignored: colour, verbose"]);
  });

  it("invalid arguments name the field and the valid fields", async () => {
    const h = harness();
    const r = await h.call("create_walls", {
      levelId: "level_000000",
      points: [{ x: 0, y: 0 }],
      closed: "yes",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("args.invalid");
    expect(r.error.message).toContain("points");
    expect(r.error.message).toContain("closed");
    expect(r.error.hint).toContain("snapMm");
  });

  it("an unknown tool and a missing reference produce errors with hints", async () => {
    const h = harness();
    const unknown = await h.call("teleport", {});
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("tool.unknown");
    const missing = await h.call("describe_room", { roomId: "room_zzzzzz" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("ref.missing");
      expect(missing.error.hint).toContain("get_scene");
    }
  });

  it("mutations carry the validation state and the change set; reads carry neither", async () => {
    const h = harness();
    const walls = await h.ok("create_walls", {
      levelId: "level_000000",
      points: [
        { x: 0, y: 0 },
        { x: 4000, y: 0 },
      ],
      closed: false,
    });
    expect(walls.changed?.commandType).toBe("wall.createChain");
    expect(Array.isArray(walls.problems)).toBe(true);
    const scene = await h.ok("get_scene", { detail: "summary" });
    expect(scene.changed).toBeNull();
    expect(scene.problems).toEqual([]);
  });

  it("an ambiguous or unknown product fails with candidates in one error", async () => {
    const h = harness();
    const r = await h.call("place_item", { x: 0, y: 0, productId: "acme" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("catalog.unknown-product");
      expect(r.error.hint).toContain("acme-boardroom-3600");
      expect(r.error.hint).toContain("acme-task-chair");
    }
  });

  it("tools that need a missing service say so instead of pretending", async () => {
    const h = harness();
    for (const [name, args] of [
      ["render", { view: "plan" }],
      ["verify_product", { make: "ViewCo", model: "QM75" }],
      ["get_bom", { scope: "project" }],
      ["furnish_room", { roomId: "room_000001" }],
      ["create_room_from_brief", { brief: "10-seat boardroom" }],
      ["export", { format: "csv", path: "x.csv" }],
      ["project", { op: "save" }],
    ] as const) {
      const r = await h.call(name, args);
      expect(r.ok, name).toBe(false);
      if (!r.ok) {
        expect(r.error.code, name).toBe("unavailable");
        expect(r.error.message, name).toContain("because");
      }
    }
  });

  it("profiles advertise a subset while every tool stays callable (ADR-006 D6)", async () => {
    const h = harness();
    expect(h.registry.advertised("high")).toHaveLength(38);
    expect(h.registry.advertised("medium").map((t) => t.name)).not.toContain("modify_wall");
    const low = h.registry.advertised("low").map((t) => t.name);
    expect(low).toHaveLength(27);
    expect(low).not.toContain("create_walls");
    expect(low).toContain("place_item");
    // A weak model is offered fewer ways to do a thing, never fewer things it can say: a storey, a
    // plan to read and the colour of a pane of glass are parts of an ordinary brief.
    for (const name of [
      "add_level",
      "import_plan",
      "finish_opening",
      "finish_wall",
      "design_layout",
      "plan_rooms",
      "check_design",
      "build_design",
    ])
      expect(low, name).toContain(name);
    await buildFixtureRoom(h);
    const r = await h.call("modify_wall", { wallId: "wall_000001", thickness: 150 });
    expect(r.ok).toBe(true);
  });

  it("get_scene full pages at 100 entities with a cursor and honours bbox and type filters", async () => {
    const h = harness();
    await h.ok("create_walls", {
      levelId: "level_000000",
      points: Array.from({ length: 121 }, (_, i) => ({ x: i * 500, y: (i % 2) * 500 })),
      closed: false,
    });
    const first = await h.ok<{ walls: unknown[]; cursor: string | null; truncated: boolean; total: number }>(
      "get_scene",
      { detail: "full", types: ["wall"] },
    );
    expect(first.result.walls).toHaveLength(100);
    expect(first.result.truncated).toBe(true);
    expect(first.result.total).toBe(120);
    const second = await h.ok<{ walls: unknown[]; cursor: string | null; truncated: boolean }>("get_scene", {
      detail: "full",
      types: ["wall"],
      cursor: first.result.cursor,
    });
    expect(second.result.walls).toHaveLength(20);
    expect(second.result.truncated).toBe(false);
    const boxed = await h.ok<{ walls?: unknown[] }>("get_scene", {
      detail: "full",
      types: ["wall"],
      bbox: { minX: 0, minY: -100, maxX: 1000, maxY: 600 },
    });
    expect(boxed.result.walls?.length).toBeLessThan(6);
    const bad = await h.call("get_scene", { detail: "full", cursor: "!!" });
    expect(bad.ok).toBe(false);
  });

  it("search_catalog finds products by words or exact id, and recipes by kind", async () => {
    const h = harness();
    const words = await h.ok<{ hits: { id: string }[]; total: number }>("search_catalog", {
      kind: "product",
      query: "boardroom table",
    });
    expect(words.result.hits[0]?.id).toBe("acme-boardroom-3600");
    const exact = await h.ok<{ hits: { id: string }[]; total: number }>("search_catalog", {
      kind: "product",
      query: "viewco-qm75",
    });
    expect(exact.result.total).toBe(1);
    const recipes = await h.ok<{ hits: { id: string; recipe: unknown }[] }>("search_catalog", {
      kind: "recipe",
      query: "display",
      limit: 2,
    });
    expect(recipes.result.hits).toHaveLength(2);
    expect(recipes.result.hits.every((r) => r.recipe)).toBe(true);
    expect(RECIPE_TEMPLATES.length).toBeGreaterThan(8);
    const capped = await h.call("search_catalog", { kind: "product", query: "x", limit: 50 });
    expect(capped.ok).toBe(false);
  });

  it("compass hinge sides map to wall ends; off-axis words are refused with the two valid words", async () => {
    const h = harness();
    await buildFixtureRoom(h);
    const p = h.ctx.store.project;
    const south = p.walls.find((w) => w.id === "wall_000001") as (typeof p.walls)[number];
    expect(hingeEndFor(p, south, "west")).toBe("start");
    expect(hingeEndFor(p, south, "east")).toBe("end");
    expect(() => hingeEndFor(p, south, "north")).toThrow(/west|east/);
    const r = await h.call("add_opening", {
      wallId: "wall_000002",
      kind: "door",
      atMm: 1500,
      hingeSide: "west",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.hint).toMatch(/"south" or "north"|"north" or "south"/);
  });

  it("anchor strings parse into the command's anchor union", () => {
    expect(parseAnchor("center")).toBe("center");
    expect(parseAnchor("along-wall:wall_000001@2400")).toEqual({ alongWall: "wall_000001", atMm: 2400 });
    expect(parseAnchor("on:item_000001")).toEqual({ on: "item_000001" });
    expect(() => parseAnchor("near the door")).toThrow(/anchor/);
  });

  it("project new starts a blank project and info reports it, for a person at the editor", async () => {
    const h = harness();
    await buildFixtureRoom(h);
    // The agent may not: it builds in the project it was asked in (ADR-027, run 3).
    const fresh = await h.registry.call("project", { op: "new", name: "Second" }, { origin: "editor" });
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(fresh.result).toMatchObject({ name: "Second", path: null });
    expect(h.ctx.store.project.walls).toHaveLength(0);
    const info = await h.ok<{ name: string }>("project", { op: "info" });
    expect(info.result.name).toBe("Second");
  });

  it("every call is recorded in the transcript with its result", async () => {
    const h = harness();
    await h.ok("get_scene", { detail: "summary" });
    await h.call("teleport", {});
    expect(h.transcript.entries.map((e) => e.tool)).toEqual(["get_scene", "teleport"]);
    expect(h.transcript.entries[1]?.result).toMatchObject({ ok: false });
  });
});

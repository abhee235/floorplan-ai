// check_design and build_design (ADR-022 D2, D4): a design measured, refused or drawn.
//
// The test that matters most is the last one in the first block: the flat the checker passed, drawn,
// comes out of `validate` clean. That is the claim the whole design phase rests on -- that a design
// which adds up produces a drawing that holds together, without the model discovering it wall by
// wall.
import { CORE_RULES, ensureSeed } from "@fpv/catalog";
import { CatalogStore } from "@fpv/catalog/store";
import type { DesignInput } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { harness, NOW } from "./helpers.js";

/** The three-bedroom flat of the checker's tests: 99 m² of shell, nine rooms, one corridor. */
const FLAT: DesignInput = {
  brief: "3 bedroom apartment with hall and lobby",
  kind: "dwelling",
  levelId: null,
  shell: { x: 0, y: 0, w: 11000, d: 9000, wallMm: 230, interiorWallMm: 115 },
  rooms: [
    {
      key: "lobby",
      name: "Lobby",
      purpose: "foyer",
      rect: { x: 0, y: 0, w: 1800, d: 2000 },
      doorsTo: ["outside", "hall"],
    },
    {
      key: "hall",
      name: "Hall",
      purpose: "living",
      rect: { x: 1900, y: 0, w: 4000, d: 4000 },
      doorsTo: ["lobby", "corridor", "kitchen"],
      window: true,
    },
    {
      key: "kitchen",
      name: "Kitchen",
      purpose: "kitchen",
      rect: { x: 6000, y: 0, w: 2400, d: 4000 },
      doorsTo: ["hall"],
      window: true,
    },
    {
      key: "dining",
      name: "Dining",
      purpose: "dining",
      rect: { x: 8500, y: 0, w: 2500, d: 4000 },
      doorsTo: ["corridor"],
      window: true,
    },
    {
      key: "corridor",
      name: "Corridor",
      purpose: "corridor",
      rect: { x: 1000, y: 4000, w: 9000, d: 1200 },
      doorsTo: [],
    },
    {
      key: "bed1",
      name: "Bedroom 1",
      purpose: "bedroom",
      rect: { x: 0, y: 5200, w: 3000, d: 3800 },
      doorsTo: ["corridor"],
      window: true,
      capacity: 2,
    },
    {
      key: "bed2",
      name: "Bedroom 2",
      purpose: "bedroom",
      rect: { x: 3100, y: 5200, w: 3000, d: 3800 },
      doorsTo: ["corridor"],
      window: true,
      capacity: 2,
    },
    {
      key: "bath",
      name: "Bathroom",
      purpose: "bathroom",
      rect: { x: 6200, y: 5200, w: 1900, d: 3800 },
      doorsTo: ["corridor"],
    },
    {
      key: "bed3",
      name: "Bedroom 3",
      purpose: "bedroom",
      rect: { x: 8200, y: 5200, w: 2800, d: 3800 },
      doorsTo: ["corridor"],
      window: true,
      capacity: 1,
    },
  ],
  circulation: ["corridor", "lobby"],
  assumptions: ["the hall is the living room and the lobby the entrance foyer"],
};

const design = (change: (d: DesignInput) => void = () => {}): DesignInput => {
  const d = JSON.parse(JSON.stringify(FLAT)) as DesignInput;
  change(d);
  return d;
};
const roomOf = (d: DesignInput, key: string) =>
  d.rooms.find((r) => r.key === key) as DesignInput["rooms"][number];

function seeded() {
  const store = CatalogStore.open(":memory:");
  ensureSeed(store, NOW);
  return store;
}

interface CheckResult {
  designId: string;
  buildable: boolean;
  totals: { shellM2: number; roomsM2: number; rooms: number };
  errors: { code: string; message: string }[];
  warnings: { code: string }[];
}

describe("check_design", () => {
  it("passes the flat and hands back an id to build", async () => {
    const h = harness(undefined, { rules: CORE_RULES });
    const r = await h.ok<CheckResult>("check_design", { design: design() });
    expect(r.result.buildable).toBe(true);
    expect(r.result.errors).toEqual([]);
    expect(r.result.designId).toMatch(/^design_/);
    expect(r.result.totals).toMatchObject({ shellM2: 99, rooms: 9 });
  });

  it("says what is wrong, in the words a person would use, and warns as well as answers", async () => {
    const h = harness(undefined, { rules: CORE_RULES });
    const r = await h.ok<CheckResult>("check_design", {
      design: design((d) => {
        roomOf(d, "bed1").rect.w = 2100;
      }),
    });
    expect(r.result.buildable).toBe(false);
    expect(r.result.errors[0]?.code).toBe("design.too-small");
    // the same thing appears in the envelope's warnings, so a card shows it without unpacking result
    expect(r.warnings.join(" ")).toMatch(/Bedroom 1 is 8.0 m²/);
  });

  it("refuses a design that is not one, rather than measuring nonsense", async () => {
    const h = harness(undefined, { rules: CORE_RULES });
    const r = await h.call("check_design", { design: { brief: "x", kind: "dwelling", rooms: [] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("args.invalid");
  });
});

describe("build_design", () => {
  it("refuses to draw a design the checker did not pass", async () => {
    const h = harness(undefined, { rules: CORE_RULES });
    const checked = await h.ok<CheckResult>("check_design", {
      design: design((d) => {
        roomOf(d, "bed1").rect.w = 2100;
      }),
    });
    const r = await h.call("build_design", { designId: checked.result.designId });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("design.not-checked");
      expect(r.error.message).toMatch(/still has 1 error\(s\), the first being: Bedroom 1 is 8.0 m²/);
    }
    expect(h.ctx.store.project.walls).toHaveLength(0);
  });

  it("refuses an id it never checked", async () => {
    const h = harness(undefined, { rules: CORE_RULES });
    const r = await h.call("build_design", { designId: "design_9999" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("design.unknown");
  });

  it("draws the flat: nine rooms, one wall between neighbours, a door in every pair the design joins", async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: CORE_RULES });
    const checked = await h.ok<CheckResult>("check_design", { design: design() });
    const built = await h.ok<{
      walls: number;
      doors: number;
      windows: number;
      rooms: { id: string; name: string | null }[];
      unplaced: string[];
    }>("build_design", { designId: checked.result.designId });

    expect(built.result.rooms).toHaveLength(9);
    expect(built.result.unplaced).toEqual([]);
    // the front door, and one for each of the eight pairs of rooms the design joins
    expect(built.result.doors).toBe(9);
    expect(built.result.windows).toBe(6);
    const p = h.ctx.store.project;
    expect(p.rooms.map((r) => r.name)).toEqual([
      "Lobby",
      "Hall",
      "Kitchen",
      "Dining",
      "Corridor",
      "Bedroom 1",
      "Bedroom 2",
      "Bathroom",
      "Bedroom 3",
    ]);
    expect(p.rooms.find((r) => r.name === "Bedroom 1")?.purpose).toBe("bedroom");
    // one wall between two neighbouring rooms, not one each
    expect(p.walls.length).toBeLessThan(20);
    catalog.close();
  });

  it("leaves a drawing validate is happy with, which is the whole claim", async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: CORE_RULES });
    const checked = await h.ok<CheckResult>("check_design", { design: design() });
    await h.ok("build_design", { designId: checked.result.designId });
    const checks = await h.ok<{ errors: { code: string }[]; warnings: { code: string; message: string }[] }>(
      "validate",
      {},
    );
    expect(checks.result.errors).toEqual([]);
    // and in particular, every room is fenced in: the fault five of nine rooms had in the real run
    expect(checks.result.warnings.filter((w) => w.code === "room.unenclosed")).toEqual([]);
    catalog.close();
  });

  it("is one step, so one undo takes the whole building away", async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: CORE_RULES });
    const checked = await h.ok<CheckResult>("check_design", { design: design() });
    const at = h.ctx.store.historyPosition;
    await h.ok("build_design", { designId: checked.result.designId });
    expect(h.ctx.store.project.rooms).toHaveLength(9);
    // three entries: walls, openings, rooms -- each atomic, and the run's checkpoint covers all three
    expect(h.ctx.store.historyPosition - at).toBeLessThanOrEqual(3);
    while (h.ctx.store.historyPosition > at) h.ctx.store.undo();
    expect(h.ctx.store.project.walls).toHaveLength(0);
    expect(h.ctx.store.project.rooms).toHaveLength(0);
    catalog.close();
  });

  it("furnishes what it drew, which is what the builder does next", async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: CORE_RULES });
    const checked = await h.ok<CheckResult>("check_design", { design: design() });
    const built = await h.ok<{ rooms: { id: string; name: string | null }[] }>("build_design", {
      designId: checked.result.designId,
    });
    for (const room of built.result.rooms) {
      if (["Corridor", "Lobby"].includes(room.name ?? "")) continue;
      const r = await h.call("furnish_room", { roomId: room.id });
      expect(r.ok, room.name ?? "").toBe(true);
    }
    const p = h.ctx.store.project;
    expect(p.items.length).toBeGreaterThan(10);
    const checks = await h.ok<{ errors: unknown[] }>("validate", {});
    expect(checks.result.errors).toEqual([]);
    catalog.close();
  });
});

describe("best of several (ADR-024 D5)", () => {
  const programme = (rooms: { key: string; name: string; purpose: string; targetM2?: number }[]) => ({
    brief: "a two bedroom flat",
    kind: "dwelling" as const,
    rooms,
  });
  const BASE = [
    { key: "living", name: "Living room", purpose: "living", targetM2: 18 },
    { key: "bed1", name: "Bedroom 1", purpose: "bedroom", targetM2: 12 },
    { key: "bed2", name: "Bedroom 2", purpose: "bedroom", targetM2: 10 },
    { key: "kitchen", name: "Kitchen", purpose: "kitchen", targetM2: 8 },
    { key: "bath", name: "Bathroom", purpose: "bathroom", targetM2: 4 },
  ];

  interface PlanResult {
    designId: string;
    buildable: boolean;
    score: number;
    tried: number;
    chosen: string;
    rejected: { note: string; score: number; errors: number }[];
  }

  it("takes whatever the model called a room and makes a key of it", async () => {
    // What a real run did, and what it cost: a model asked to design an office wrote "Open
    // Workspace" in a field called key, the design's own schema wanted a slug, and the run died
    // three steps later on a page of raw schema errors that said "Invalid" and nothing else. The
    // name it meant was never in doubt.
    const h = harness(undefined, { rules: CORE_RULES });
    const r = await h.ok<PlanResult & { rooms: { key: string; name: string }[] }>("plan_rooms", {
      ...programme([
        { key: "Open Workspace", name: "Open workspace", purpose: "office", targetM2: 60 },
        { key: "Meeting-Room 1", name: "Meeting room", purpose: "meeting", targetM2: 20 },
        { key: "99 Kitchen!", name: "Tea point", purpose: "kitchen", targetM2: 10 },
      ]),
      kind: "workplace",
    });
    expect(r.result.buildable).toBe(true);
    // The packer decides the order and adds its own circulation, so what matters is that every key
    // the model gave came back as a usable one.
    const keys = r.result.rooms.map((x) => x.key);
    expect(keys).toContain("open_workspace");
    expect(keys).toContain("meeting_room_1");
    expect(keys).toContain("kitchen");
    for (const k of keys) expect(k).toMatch(/^[a-z][a-z0-9_]{0,23}$/);
  });

  it("keeps two rooms apart when their names slug to the same thing", async () => {
    const h = harness(undefined, { rules: CORE_RULES });
    const r = await h.ok<PlanResult & { rooms: { key: string }[] }>("plan_rooms", {
      ...programme([
        { key: "Meeting Room!", name: "Meeting room A", purpose: "meeting", targetM2: 18 },
        { key: "Meeting Room?", name: "Meeting room B", purpose: "meeting", targetM2: 18 },
        { key: "kitchen", name: "Tea point", purpose: "kitchen", targetM2: 10 },
      ]),
      kind: "workplace",
    });
    const keys = r.result.rooms.map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("packs one programme when only one is given, and says so", async () => {
    const h = harness(undefined, { rules: CORE_RULES });
    const r = await h.ok<PlanResult>("plan_rooms", programme(BASE));
    expect(r.result.tried).toBe(1);
    expect(r.result.chosen).toBe("as asked for");
    expect(r.result.rejected).toEqual([]);
    expect(r.result.buildable).toBe(true);
    // no errors, so the score is only nicked by whatever warnings the checker has
    expect(r.result.score).toBeGreaterThan(0.9);
  });

  it("keeps the one the checker likes best, and says what the others scored", async () => {
    const h = harness(undefined, { rules: CORE_RULES });
    const r = await h.ok<PlanResult>("plan_rooms", {
      ...programme(BASE),
      alternatives: [
        {
          note: "a third bedroom instead of the dining space",
          // a bedroom far too small to be one, so this alternative must lose
          rooms: [...BASE, { key: "bed3", name: "Bedroom 3", purpose: "bedroom", targetM2: 9 }],
          shell: { w: 6000, d: 5200 },
        },
      ],
    });
    expect(r.result.tried).toBe(2);
    expect(r.result.chosen).toBe("as asked for");
    expect(r.result.buildable).toBe(true);
    expect(r.result.rejected[0]?.note).toBe("a third bedroom instead of the dining space");
    expect(r.result.rejected[0]?.errors).toBeGreaterThan(0);
    expect(r.warnings.join(" ")).toMatch(/tried 2 ways of arranging it and kept "as asked for"/);
  });

  it("takes an alternative when it is the better one", async () => {
    const h = harness(undefined, { rules: CORE_RULES });
    const rooms = [
      { key: "living", name: "Living room", purpose: "living", targetM2: 18 },
      { key: "bed1", name: "Bedroom 1", purpose: "bedroom", targetM2: 12 },
      { key: "kitchen", name: "Kitchen", purpose: "kitchen", targetM2: 8 },
      { key: "bath", name: "Bathroom", purpose: "bathroom", targetM2: 4 },
    ];
    const r = await h.ok<PlanResult>("plan_rooms", {
      ...programme(rooms),
      // a plot far too small for 42 m² of rooms; the alternative is the same rooms on one that fits
      shell: { w: 4000, d: 4000 },
      alternatives: [{ note: "on a plot that fits it", rooms, shell: { w: 9000, d: 7000 } }],
    });
    expect(r.result.tried).toBe(2);
    expect(r.result.chosen).toBe("on a plot that fits it");
    expect(r.result.buildable).toBe(true);
    expect(r.result.rejected[0]?.errors).toBeGreaterThan(0);
  });

  it("hands back a design that build_design will take", async () => {
    const catalog = seeded();
    const h = harness(undefined, { catalog, rules: CORE_RULES });
    const planned = await h.ok<PlanResult>("plan_rooms", {
      ...programme(BASE),
      alternatives: [
        {
          note: "a bigger living room",
          rooms: BASE.map((r) => (r.key === "living" ? { ...r, targetM2: 24 } : r)),
        },
      ],
    });
    const built = await h.ok<{ rooms: unknown[] }>("build_design", { designId: planned.result.designId });
    expect(built.result.rooms.length).toBeGreaterThan(4);
    const checks = await h.ok<{ errors: unknown[] }>("validate", {});
    expect(checks.result.errors).toEqual([]);
    catalog.close();
  });
});

import { defaultRoom } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import {
  AV_CORE,
  AV_CORE_INPUT,
  Bom,
  type BomLine,
  getBom,
  mergePacks,
  parseBomScope,
  RulesPack,
} from "../src/index.js";
import { arrayCatalog, boardroomItems, CATALOG, item, L, NOW, project, R } from "./rules.helpers.js";

const bom = (p = project(), options: Partial<Parameters<typeof getBom>[2]> = {}) =>
  getBom(p, AV_CORE, { now: NOW, catalog: arrayCatalog(), explain: true, ...options });
const byRule = (b: ReturnType<typeof getBom>, ruleId: string): BomLine[] =>
  b.lines.filter((l) => l.reason.ruleId === ruleId);
const one = (b: ReturnType<typeof getBom>, ruleId: string): BomLine => {
  const lines = byRule(b, ruleId);
  expect(lines, ruleId).toHaveLength(1);
  return lines[0] as BomLine;
};
const wall = { kind: "wall" as const, targetId: null, height: null };

describe("item lines (ADR-009 D3 kind 1)", () => {
  it("one line per product within its room, openings at level scope, recipes and unknowns as placeholders", () => {
    const items = [
      ...boardroomItems(),
      item("item_ghost", "not-in-snapshots", 7000, 4000),
      {
        ...item("item_box", "x", 7000, 1000),
        ref: {
          kind: "recipe" as const,
          recipe: { kind: "box" as const, size: { w: 1800, d: 600, h: 720 }, label: "Credenza" },
        },
      },
    ];
    const b = bom(project(items));
    expect(Bom.safeParse(b).success).toBe(true);
    const chairs = b.lines.find((l) => l.productId === "chr" && l.reason.kind === "item") as BomLine;
    expect(chairs).toMatchObject({
      quantity: 10,
      unit: "each",
      scope: { levelId: L, roomId: R },
      status: "verified",
      total: 9000,
    });
    expect(chairs.reason.ids).toHaveLength(10);
    expect(b.lines.find((l) => l.reason.kind === "opening")).toMatchObject({
      productId: "generic-door-900",
      scope: { levelId: L, roomId: null },
      status: "verified",
    });
    expect(b.lines.find((l) => l.recipe === "recipe:box:1800x600x720")).toMatchObject({
      description: "Credenza 1800 x 600 x 720 (placeholder)",
      category: "other",
      status: "placeholder",
    });
    expect(b.lines.find((l) => l.reason.ids.includes("item_ghost"))).toMatchObject({
      description: "Unknown product not-in-snapshots",
      status: "placeholder",
    });
  });
});

describe("core BOM rules (spec 07 section 3.1)", () => {
  it("display-mount: a wall display gets a mount matching VESA and weight; a floor display gets none", () => {
    expect(one(bom(), "display-mount")).toMatchObject({
      productId: "acme-vm-600",
      quantity: 1,
      status: "verified",
      reason: { ids: ["item_display"] },
    });
    const floor = boardroomItems().map((i) =>
      i.id === "item_display" ? { ...i, mount: { ...i.mount, kind: "floor" as const } } : i,
    );
    expect(byRule(bom(project(floor)), "display-mount")).toEqual([]);
  });

  it("display-mount: too heavy for every mount is a placeholder carrying the constraint", () => {
    const p = project();
    const heavy = { ...p.catalogRefs, "disp-75": { ...(p.catalogRefs["disp-75"] as object), weightKg: 95 } };
    const line = one(bom({ ...p, catalogRefs: heavy as unknown as typeof p.catalogRefs }), "display-mount");
    expect(line).toMatchObject({ productId: null, description: "VESA wall mount", status: "placeholder" });
    expect(line.reason.evaluated).toContain(
      "no product matches has(vesa, spec('vesa')) and maxKg >= item.weightKg",
    );
  });

  it("distance: display at 1400 mm, 2700 mm ceiling, bar 4000 mm away gives 4000 + 1300 + 1300 + 1000 = 7600, rounded to 10000", () => {
    const items = [
      item("item_d", "disp-75", 2000, 2500, { elevation: 919, mount: wall }),
      item("item_b", "bar", 6000, 2500, { elevation: 1332, mount: wall }),
    ];
    const line = one(bom(project(items)), "display-hdmi");
    expect(line).toMatchObject({
      productId: "acme-hdmi-10m",
      quantity: 1,
      reason: { ids: ["item_b", "item_d"] },
    });
    expect(line.reason.evaluated).toBe(
      "roundUpToAny(distance(from, to) + cableSlackMm, cableStockLengthsMm) = 10000",
    );
    const none = one(
      bom(project(items), { catalog: arrayCatalog(CATALOG.filter((c) => c.category !== "cable")) }),
      "display-hdmi",
    );
    expect(none).toMatchObject({ productId: null, description: "HDMI cable 10 m", status: "placeholder" });
  });

  it("display-hdmi goes to the nearest video bar or table; bar-usb from the bar to the table; nothing without a target", () => {
    const b = bom();
    // display centre 1400, bar centre 821, 40 mm apart: 40 + 1300 + 1879 + 1000 slack = 4219 -> 5000
    expect(one(b, "display-hdmi")).toMatchObject({
      productId: "acme-hdmi-5m",
      reason: { ids: ["item_bar", "item_display"] },
    });
    // bar to table top: 2387 + 1879 + 1960 + 1000 = 7226 -> 7500 -> the shortest USB cable that long is 10 m
    expect(one(b, "bar-usb")).toMatchObject({
      productId: "acme-usb-10m",
      reason: { ids: ["item_bar", "item_table"] },
    });
    const alone = [item("item_d", "disp-75", 2000, 2500, { elevation: 919, mount: wall })];
    expect(byRule(bom(project(alone)), "display-hdmi")).toEqual([]);
  });

  it("bar-usb respects sameRoom: a table in another room is not a target", () => {
    const p = project();
    const annex = defaultRoom("room_000002", L, [
      { x: 8100, y: 50 },
      { x: 12000, y: 50 },
      { x: 12000, y: 4950 },
      { x: 8100, y: 4950 },
    ]);
    const items = boardroomItems().map((i) =>
      i.id === "item_table" ? { ...i, position: { x: 10000, y: 2500 } } : i,
    );
    expect(byRule(bom({ ...p, rooms: [...p.rooms, annex], items }), "bar-usb")).toEqual([]);
  });

  it("speaker-amp: one amplifier per room with enough channels, cheapest verified; unverified products are never picked", () => {
    expect(one(bom(), "speaker-amp")).toMatchObject({
      productId: "acme-amp-4",
      quantity: 1,
      reason: { ids: ["item_spk1", "item_spk2"] },
    });
    const many = [
      ...boardroomItems(),
      ...[1, 2, 3].map((k) =>
        item(`item_spk_x${k}`, "spk", 1000 * k, 4000, {
          elevation: 2510,
          mount: { kind: "ceiling", targetId: null, height: null },
        }),
      ),
    ];
    expect(one(bom(project(many)), "speaker-amp").productId).toBe("acme-amp-8");
    const noSpeakers = boardroomItems().filter((i) => !i.id.startsWith("item_spk"));
    expect(byRule(bom(project(noSpeakers)), "speaker-amp")).toEqual([]);
  });

  it("mic-dsp: inputs must cover the summed channels of the ceiling mics", () => {
    expect(one(bom(), "mic-dsp")).toMatchObject({ productId: "acme-dsp-24", reason: { evaluated: "1 = 1" } });
    const oneMic = boardroomItems().filter((i) => i.id !== "item_mic2");
    expect(one(bom(project(oneMic)), "mic-dsp").productId).toBe("acme-dsp-12");
  });

  it("network-ports: display, bar, touch panel, PoE mics and the DSP the mics need", () => {
    expect(one(bom(), "network-ports")).toMatchObject({
      description: "PoE switch port",
      category: "switch",
      quantity: 6,
      status: "placeholder",
    });
    const bare = [item("item_table", "tbl", 4000, 2500)];
    expect(byRule(bom(project(bare)), "network-ports")).toEqual([]);
  });

  it("scheduler: a meeting room for four or more without a scheduler gets one", () => {
    expect(one(bom(), "scheduler")).toMatchObject({
      productId: "acme-room-panel",
      quantity: 1,
      reason: { ids: [R] },
    });
    const p = project();
    const small = { ...p, rooms: p.rooms.map((r) => ({ ...r, capacity: 2 })) };
    expect(byRule(bom(small), "scheduler")).toEqual([]);
    const cafe = { ...p, rooms: p.rooms.map((r) => ({ ...r, purpose: "cafeteria" as const })) };
    expect(byRule(bom(cafe), "scheduler")).toEqual([]);
    const withPanel = project([
      ...boardroomItems(),
      item("item_sched", "acme-room-panel", 1800, 60, { elevation: 1400, mount: wall }),
    ]);
    expect(byRule(bom(withPanel), "scheduler")).toEqual([]);
  });

  it("table-power: one module per four seats of capacity, only with a table", () => {
    expect(one(bom(), "table-power")).toMatchObject({ productId: "acme-table-box", quantity: 3, total: 630 });
    expect(
      byRule(bom(project(boardroomItems().filter((i) => i.id !== "item_table"))), "table-power"),
    ).toEqual([]);
  });

  it("commissioning: off by default; enabled by an overlay it is a labour line in hours", () => {
    expect(byRule(bom(), "commissioning")).toEqual([]);
    const on = mergePacks(
      AV_CORE,
      RulesPack.parse({
        id: "office",
        version: "1.0.0",
        name: "Office",
        extends: "av-core",
        bomRules: [{ ...AV_CORE_INPUT.bomRules?.find((r) => r.id === "commissioning"), enabled: true }],
      }),
    );
    const b = getBom(project(), on, { now: NOW, catalog: arrayCatalog() });
    expect(one(b, "commissioning")).toMatchObject({
      quantity: 4,
      unit: "hour",
      status: "labour",
      total: null,
    });
    expect(b.rulesPack).toEqual({ id: "office", version: "1.0.0" });
  });

  it("an expression that cannot be evaluated becomes a placeholder line with the error, never a crash", () => {
    const broken = RulesPack.parse({
      ...AV_CORE_INPUT,
      bomRules: [
        {
          kind: "scope",
          id: "broken",
          scope: "room",
          when: null,
          add: { category: "other", description: "x" },
          quantity: "room.capacity / (count('display') - 1)",
          unit: "each",
        },
        {
          kind: "dependency",
          id: "no-spec",
          when: { category: "table", where: null },
          add: { category: "connector", constraint: "true" },
          quantity: "spec('grommets')",
          unit: "each",
        },
      ],
    });
    const b = getBom(project(), broken, { now: NOW, catalog: arrayCatalog() });
    expect(one(b, "broken")).toMatchObject({
      description: "broken: division by zero: expression is 0",
      status: "placeholder",
    });
    expect(one(b, "no-spec")).toMatchObject({
      description: "no-spec: item_table has no spec grommets",
      status: "placeholder",
    });
  });
});

describe("resolution order (ADR-009 D4)", () => {
  it("a matching product already in the project wins over the catalog, even if dearer", () => {
    const p = project();
    const refs = {
      ...p.catalogRefs,
      "own-amp": { ...(CATALOG.find((c) => c.id === "acme-amp-8") as object), id: "own-amp", price: null },
    };
    expect(
      one(bom({ ...p, catalogRefs: refs as unknown as typeof p.catalogRefs }), "speaker-amp").productId,
    ).toBe("own-amp");
  });

  it("preferSameMake picks the triggering product's make among matching candidates", () => {
    const pack = RulesPack.parse({
      ...AV_CORE_INPUT,
      bomRules: [
        {
          kind: "dependency",
          id: "bar-mount",
          when: { category: "video-bar", where: null },
          add: { category: "mount", constraint: "true", preferSameMake: true },
          quantity: "1",
          unit: "each",
        },
      ],
    });
    const catalog = arrayCatalog([
      ...CATALOG,
      {
        ...(CATALOG[0] as object),
        id: "viewco-bar-mount",
        make: "Viewco",
        price: {
          amount: 999,
          currency: "USD",
          type: "list",
          sourceUrl: null,
          capturedAt: NOW,
          expiresAt: NOW,
        },
      },
    ]);
    const b = getBom(project(), pack, { now: NOW, catalog });
    expect(one(b, "bar-mount").productId).toBe("viewco-bar-mount");
  });
});

describe("BOM output (spec 07 section 5)", () => {
  it("is deterministic: two runs differ only in generatedAt", () => {
    const a = bom(project(), { now: "2026-09-15T12:00:00.000Z" });
    const b = bom(project([...boardroomItems()].reverse()), { now: "2026-09-16T08:00:00.000Z" });
    expect({ ...b, generatedAt: a.generatedAt }).toEqual(a);
  });

  it("orders lines by scope, then category, then product id", () => {
    const b = bom();
    const keys = b.lines.map((l) =>
      [l.scope.roomId === null ? 0 : 1, l.category, l.productId ?? `~${l.description}`].join("|"),
    );
    expect(keys[0]).toBe("0|door|generic-door-900");
    const roomKeys = keys.filter((k) => k.startsWith("1|"));
    const cats = roomKeys.map((k) => k.split("|")[1] as string);
    expect(cats).toEqual([...cats].sort());
  });

  it("totals by status in the project currency; other currencies are excluded and named", () => {
    const p = project();
    const refs = {
      ...p.catalogRefs,
      bar: {
        ...(p.catalogRefs.bar as object),
        price: {
          amount: 2000,
          currency: "EUR",
          type: "list",
          sourceUrl: null,
          capturedAt: NOW,
          expiresAt: NOW,
        },
      },
    };
    const b = bom({ ...p, catalogRefs: refs as unknown as typeof p.catalogRefs });
    expect(b.currency).toBe("USD");
    expect(b.lines.find((l) => l.productId === "bar")?.total).toBeNull();
    expect(b.totals.excludedCurrencies).toEqual(["EUR"]);
    const sum = (status: string) =>
      b.lines.filter((l) => l.status === status).reduce((s, l) => s + (l.total ?? 0), 0);
    expect(b.totals.verified).toBeCloseTo(sum("verified"), 2);
    expect(b.totals.all).toBeCloseTo(
      b.totals.verified + b.totals.unverified + b.totals.placeholder + b.totals.labour,
      2,
    );
    expect(b.byRoom).toEqual([
      { roomId: R, name: "Boardroom", total: expect.any(Number), lines: expect.any(Number) },
    ]);
  });

  it("scopes filter lines; explain off drops expressions; scope text parses", () => {
    expect(bom(project(), { scope: { kind: "room", id: R } }).lines.every((l) => l.scope.roomId === R)).toBe(
      true,
    );
    expect(bom(project(), { scope: { kind: "level", id: L } }).lines.length).toBe(bom().lines.length);
    expect(
      bom(project(), { explain: false }).lines.every(
        (l) => l.reason.expression === null && l.reason.evaluated === null,
      ),
    ).toBe(true);
    expect(parseBomScope("room:room_000001")).toEqual({ kind: "room", id: "room_000001" });
    expect(parseBomScope("project")).toEqual({ kind: "project" });
    expect(parseBomScope("everything")).toBeNull();
  });
});

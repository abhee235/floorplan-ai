// A hand-built 8 by 5 m boardroom for rule tests: no commands, no tools, just IR records, so a rule
// test fails only because of the rule.
import {
  defaultItem,
  defaultLevel,
  defaultOpening,
  defaultRoom,
  defaultWall,
  type Item,
  type Project,
  SCHEMA_VERSION,
} from "@fpv/ir";
import type { BomCatalog } from "../src/index.js";

export const NOW = "2026-09-15T12:00:00.000Z";
export const L = "level_000000";
export const R = "room_000001";

const SOURCE = ["https://example.com/spec"];

function product(
  id: string,
  category: string,
  dims: { w: number; d: number; h: number },
  specs: Record<string, string | number | boolean>,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    make: "Acme",
    model: id.toUpperCase(),
    name: `Acme ${id}`,
    category,
    dims,
    weightKg: null,
    specs,
    price: null,
    verification: { status: "verified", confidence: 0.9, sources: SOURCE, verifiedAt: NOW, notes: null },
    snapshotAt: NOW,
    ...over,
  };
}

const usd = (amount: number) => ({
  amount,
  currency: "USD",
  type: "list",
  sourceUrl: null,
  capturedAt: NOW,
  expiresAt: "2026-12-14T12:00:00.000Z",
});

/** Snapshots the project carries for the products its items use. */
export const SNAPSHOTS: Record<string, Record<string, unknown>> = {
  "disp-75": product(
    "disp-75",
    "display",
    { w: 1672, d: 45, h: 962 },
    { diagonalIn: 75, vesa: "400x400" },
    {
      make: "Viewco",
      weightKg: 32,
      price: usd(3200),
    },
  ),
  bar: product(
    "bar",
    "video-bar",
    { w: 1092, d: 125, h: 136 },
    { fovDeg: 90 },
    { make: "Viewco", weightKg: 7 },
  ),
  tbl: product("tbl", "table", { w: 3600, d: 1400, h: 740 }, { seats: 12 }),
  chr: product("chr", "chair", { w: 686, d: 640, h: 1040 }, {}, { price: usd(900) }),
  mic: product("mic", "ceiling-mic", { w: 600, d: 600, h: 55 }, { channels: 8, poe: true }),
  spk: product("spk", "ceiling-speaker", { w: 250, d: 250, h: 190 }, { impedanceOhm: 8 }),
  panel: product("panel", "touch-panel", { w: 244, d: 120, h: 174 }, {}),
  "generic-door-900": product(
    "generic-door-900",
    "door",
    { w: 900, d: 40, h: 2100 },
    {},
    {
      make: "Generic",
      verification: { status: "manual", confidence: 1, sources: [], verifiedAt: NOW, notes: null },
    },
  ),
};

/** The live catalog rule-added products come from (ADR-009 D4). */
export const CATALOG: Record<string, unknown>[] = [
  product(
    "acme-vm-600",
    "mount",
    { w: 620, d: 60, h: 420 },
    { vesa: "200x200, 300x300, 400x400, 600x400", maxKg: 60 },
    {
      price: usd(149),
    },
  ),
  product(
    "acme-amp-4",
    "amplifier",
    { w: 440, d: 300, h: 44 },
    { channels: 4, powerPerChannelW: 60 },
    { price: usd(420) },
  ),
  product(
    "acme-amp-8",
    "amplifier",
    { w: 440, d: 300, h: 44 },
    { channels: 8, powerPerChannelW: 60 },
    { price: usd(690) },
  ),
  product(
    "cheap-amp-16",
    "amplifier",
    { w: 440, d: 300, h: 44 },
    { channels: 16 },
    {
      price: usd(10),
      verification: { status: "unverified", confidence: 0.3, sources: [], verifiedAt: null, notes: null },
    },
  ),
  product(
    "acme-dsp-12",
    "dsp",
    { w: 440, d: 300, h: 44 },
    { inputs: 12, outputs: 8, dante: true },
    { price: usd(1800) },
  ),
  product(
    "acme-dsp-24",
    "dsp",
    { w: 440, d: 300, h: 44 },
    { inputs: 24, outputs: 12, dante: true },
    { price: usd(2600) },
  ),
  product(
    "acme-hdmi-3m",
    "cable",
    { w: 10, d: 10, h: 10 },
    { type: "HDMI", lengthMm: 3000 },
    { price: usd(25) },
  ),
  product(
    "acme-hdmi-5m",
    "cable",
    { w: 10, d: 10, h: 10 },
    { type: "HDMI", lengthMm: 5000 },
    { price: usd(35) },
  ),
  product(
    "acme-hdmi-10m",
    "cable",
    { w: 10, d: 10, h: 10 },
    { type: "HDMI", lengthMm: 10000 },
    { price: usd(60) },
  ),
  product(
    "acme-hdmi-15m",
    "cable",
    { w: 10, d: 10, h: 10 },
    { type: "HDMI", lengthMm: 15000 },
    { price: usd(80) },
  ),
  product(
    "acme-usb-5m",
    "cable",
    { w: 10, d: 10, h: 10 },
    { type: "USB", lengthMm: 5000 },
    { price: usd(30) },
  ),
  product(
    "acme-usb-10m",
    "cable",
    { w: 10, d: 10, h: 10 },
    { type: "USB", lengthMm: 10000 },
    { price: usd(55) },
  ),
  product(
    "acme-table-box",
    "connector",
    { w: 300, d: 150, h: 100 },
    { kind: "table-power" },
    { price: usd(210) },
  ),
  product(
    "acme-room-panel",
    "scheduler",
    { w: 230, d: 30, h: 150 },
    { screenIn: 8, poe: true },
    { price: usd(540) },
  ),
];

export function arrayCatalog(products: readonly Record<string, unknown>[] = CATALOG): BomCatalog {
  return {
    byCategory: (category) => products.filter((p) => p.category === category),
    product: (id) => products.find((p) => p.id === id) ?? null,
  };
}

export function item(
  id: string,
  productId: string,
  x: number,
  y: number,
  over: Partial<Omit<Item, "id" | "levelId" | "ref" | "position">> = {},
): Item {
  return defaultItem(id, L, { kind: "product", productId }, { x, y }, over);
}

/** Ten chairs around a 3600 x 1400 table centred at (4000, 2500), all facing it. */
export function chairs(): Item[] {
  const out: Item[] = [];
  [2650, 3550, 4450, 5350].forEach((x, i) => {
    out.push(item(`item_c0${i}s`, "chr", x, 1400, { rotation: 180 }));
    out.push(item(`item_c0${i}n`, "chr", x, 3600, { rotation: 0 }));
  });
  out.push(item("item_c0w", "chr", 1800, 2500, { rotation: 90 }));
  out.push(item("item_c0e", "chr", 6200, 2500, { rotation: 270 }));
  return out;
}

/** The full room: table, chairs, wall display centred at 1400 mm, bar below it, two mics, two speakers, a touch panel. */
export function boardroomItems(): Item[] {
  return [
    item("item_table", "tbl", 4000, 2500),
    ...chairs(),
    item("item_display", "disp-75", 4000, 4927, {
      elevation: 919,
      mount: { kind: "wall", targetId: "wall_000003", height: null },
    }),
    item("item_bar", "bar", 4000, 4887, {
      elevation: 753,
      mount: { kind: "wall", targetId: "wall_000003", height: null },
    }),
    item("item_mic1", "mic", 2800, 2500, {
      elevation: 2645,
      mount: { kind: "ceiling", targetId: null, height: null },
    }),
    item("item_mic2", "mic", 5200, 2500, {
      elevation: 2645,
      mount: { kind: "ceiling", targetId: null, height: null },
    }),
    item("item_spk1", "spk", 2000, 2500, {
      elevation: 2510,
      mount: { kind: "ceiling", targetId: null, height: null },
    }),
    item("item_spk2", "spk", 6000, 2500, {
      elevation: 2510,
      mount: { kind: "ceiling", targetId: null, height: null },
    }),
    item("item_panel", "panel", 4000, 2300, {
      elevation: 740,
      parentId: "item_table",
      mount: { kind: "table", targetId: "item_table", height: null },
    }),
  ];
}

export function project(items: Item[] = boardroomItems(), over: Partial<Project> = {}): Project {
  const walls = [
    defaultWall("wall_000001", L, { x: 0, y: 0 }, { x: 8000, y: 0 }, { thickness: 100 }),
    defaultWall("wall_000002", L, { x: 8000, y: 0 }, { x: 8000, y: 5000 }, { thickness: 100 }),
    defaultWall("wall_000003", L, { x: 8000, y: 5000 }, { x: 0, y: 5000 }, { thickness: 100 }),
    defaultWall("wall_000004", L, { x: 0, y: 5000 }, { x: 0, y: 0 }, { thickness: 100 }),
  ];
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      id: "catalogtest01",
      name: "Rules test",
      createdAt: NOW,
      updatedAt: NOW,
      currency: "USD",
      north: 90,
      units: "mm",
    },
    levels: [defaultLevel(L, { name: "Ground", height: 2700, elevation: 0 })],
    walls,
    openings: [
      defaultOpening("opening_000001", L, "wall_000001", "door", {
        position: 0.15,
        width: 900,
        productId: "generic-door-900",
      }),
    ],
    rooms: [
      defaultRoom(
        R,
        L,
        [
          { x: 50, y: 50 },
          { x: 7950, y: 50 },
          { x: 7950, y: 4950 },
          { x: 50, y: 4950 },
        ],
        { name: "Boardroom", purpose: "boardroom", capacity: 10 },
      ),
    ],
    items,
    zones: [],
    annotations: [],
    catalogRefs: SNAPSHOTS as Project["catalogRefs"],
    textures: {},
    provenance: null,
    properties: {},
    ...over,
  };
}

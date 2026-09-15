// Builds tools/fixtures/boardroom.fpviz: the PRD task card room ("10-seat boardroom, 8 by 5 metres,
// video conferencing") placed through the real tool registry against the seed catalog plus a small
// fixture library of verified infrastructure products. The golden BOM test reads what this writes.
// Usage: corepack pnpm exec tsx --disable-warning=ExperimentalWarning tools/build-boardroom-fixture.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AV_CORE, ensureSeed, type LibraryManifestInput, type ProductInput } from "@fpv/catalog";
import { CatalogStore } from "@fpv/catalog/store";
import { createStore } from "@fpv/commands";
import { sequentialIdGenerator, serialize } from "@fpv/ir";
import {
  blankProject,
  catalogSourceOf,
  createRegistry,
  createTranscript,
  type ToolContext,
} from "@fpv/tools";

const NOW = "2026-09-15T12:00:00.000Z";
const OUT = fileURLToPath(new URL("./fixtures/boardroom.fpviz/", import.meta.url));

const fixtureProduct = (
  id: string,
  category: ProductInput["category"],
  name: string,
  dims: { w: number; d: number; h: number },
  specs: Record<string, string | number | boolean>,
  amount: number,
  kinds: ("floor" | "wall" | "ceiling" | "table")[] = ["floor"],
): ProductInput => ({
  id,
  make: "Acme",
  model: id.slice("acme-".length).toUpperCase(),
  name,
  category,
  dims,
  mount: { kinds },
  specs,
  price: {
    amount,
    currency: "USD",
    type: "list",
    sourceUrl: `https://example.com/acme/${id}`,
    capturedAt: NOW,
    expiresAt: "2026-12-14T12:00:00.000Z",
  },
  verification: {
    status: "verified",
    confidence: 0.9,
    sources: [`https://example.com/acme/${id}`],
    verifiedAt: NOW,
    notes: "fixture product for the golden BOM, not a real item",
  },
  lifecycle: "active",
  createdAt: NOW,
  updatedAt: NOW,
});

export const FIXTURE_LIBRARY: LibraryManifestInput = {
  id: "fixture-av",
  name: "Fixture infrastructure products",
  version: "1.0.0",
  licence: { id: "own", author: null, sourceUrl: null, attribution: null },
  products: [
    fixtureProduct(
      "acme-vm-600",
      "mount",
      "Acme VESA wall mount up to 600 x 400",
      { w: 620, d: 60, h: 420 },
      { vesa: "200x200, 300x300, 400x400, 600x400", maxKg: 60 },
      149,
      ["wall"],
    ),
    fixtureProduct(
      "acme-amp-4",
      "amplifier",
      "Acme 4 channel amplifier",
      { w: 440, d: 300, h: 44 },
      { channels: 4, powerPerChannelW: 60 },
      420,
    ),
    fixtureProduct(
      "acme-amp-8",
      "amplifier",
      "Acme 8 channel amplifier",
      { w: 440, d: 300, h: 44 },
      { channels: 8, powerPerChannelW: 60 },
      690,
    ),
    fixtureProduct(
      "acme-dsp-12",
      "dsp",
      "Acme DSP 12 inputs",
      { w: 440, d: 300, h: 44 },
      { inputs: 12, outputs: 8, dante: true },
      1800,
    ),
    fixtureProduct(
      "acme-dsp-24",
      "dsp",
      "Acme DSP 24 inputs",
      { w: 440, d: 300, h: 44 },
      { inputs: 24, outputs: 12, dante: true },
      2600,
    ),
    fixtureProduct(
      "acme-hdmi-3m",
      "cable",
      "Acme HDMI cable 3 m",
      { w: 10, d: 10, h: 10 },
      { type: "HDMI", lengthMm: 3000, connectors: "HDMI-A" },
      25,
    ),
    fixtureProduct(
      "acme-hdmi-5m",
      "cable",
      "Acme HDMI cable 5 m",
      { w: 10, d: 10, h: 10 },
      { type: "HDMI", lengthMm: 5000, connectors: "HDMI-A" },
      35,
    ),
    fixtureProduct(
      "acme-hdmi-10m",
      "cable",
      "Acme HDMI cable 10 m",
      { w: 10, d: 10, h: 10 },
      { type: "HDMI", lengthMm: 10000, connectors: "HDMI-A" },
      60,
    ),
    fixtureProduct(
      "acme-usb-5m",
      "cable",
      "Acme USB cable 5 m",
      { w: 10, d: 10, h: 10 },
      { type: "USB", lengthMm: 5000, connectors: "USB-C" },
      30,
    ),
    fixtureProduct(
      "acme-usb-10m",
      "cable",
      "Acme active USB cable 10 m",
      { w: 10, d: 10, h: 10 },
      { type: "USB", lengthMm: 10000, connectors: "USB-C" },
      55,
    ),
    fixtureProduct(
      "acme-table-box",
      "connector",
      "Acme table power and data module",
      { w: 300, d: 150, h: 100 },
      { kind: "table-power" },
      210,
      ["table"],
    ),
    fixtureProduct(
      "acme-room-panel",
      "scheduler",
      "Acme room booking panel",
      { w: 230, d: 30, h: 150 },
      { screenIn: 8, poe: true },
      540,
      ["wall"],
    ),
  ],
};

async function main(): Promise<void> {
  const catalog = CatalogStore.open(":memory:");
  ensureSeed(catalog, NOW);
  catalog.installLibrary(FIXTURE_LIBRARY, NOW);
  const now = () => NOW;
  const store = createStore(blankProject("Boardroom task card", NOW), {
    ids: sequentialIdGenerator(1),
    now,
    catalog: catalogSourceOf(catalog, now),
  });
  const ctx: ToolContext = {
    store,
    catalog,
    viewer: null,
    files: null,
    verifier: null,
    rules: AV_CORE,
    writer: null,
    transcript: createTranscript(),
    now,
  };
  const registry = createRegistry(ctx);
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    // exact positions: the fixture predates the placement pipeline and must stay reproducible
    const r = await registry.call(name, name === "place_item" ? { snap: false, ...args } : args);
    if (!r.ok) throw new Error(`${name}: ${r.error.code}: ${r.error.message}`);
    for (const w of r.warnings) console.log(`  warning from ${name}: ${w}`);
    return r.result as T;
  };
  const L = "level_000000";
  const wall = { kind: "wall", targetId: "wall_000003" };
  const ceiling = { kind: "ceiling" };

  await call("create_walls", {
    levelId: L,
    points: [
      { x: 0, y: 0 },
      { x: 8000, y: 0 },
      { x: 8000, y: 5000 },
      { x: 0, y: 5000 },
    ],
    closed: true,
    thickness: 100,
    kind: "interior",
  });
  await call("add_opening", {
    wallId: "wall_000001",
    kind: "door",
    atMm: 1200,
    productId: "generic-door-900",
  });
  const { room } = await call<{ room: { id: string } }>("create_room", {
    levelId: L,
    atPoint: { x: 4000, y: 2500 },
    name: "Boardroom",
    purpose: "boardroom",
    capacity: 10,
  });
  const { item: table } = await call<{ item: { id: string } }>("place_item", {
    productId: "steelcase-convene-3600x1400",
    levelId: L,
    x: 4000,
    y: 2500,
    rotation: 0,
  });
  for (const x of [2650, 3550, 4450, 5350]) {
    await call("place_item", { productId: "herman-miller-aeron-b", levelId: L, x, y: 1400, rotation: 180 });
    await call("place_item", { productId: "herman-miller-aeron-b", levelId: L, x, y: 3600, rotation: 0 });
  }
  await call("place_item", {
    productId: "herman-miller-aeron-b",
    levelId: L,
    x: 1800,
    y: 2500,
    rotation: 90,
  });
  await call("place_item", {
    productId: "herman-miller-aeron-b",
    levelId: L,
    x: 6200,
    y: 2500,
    rotation: 270,
  });
  // display centred at 1400 mm on the wall opposite the door; the video bar just below it
  await call("place_item", {
    productId: "samsung-qm75c",
    roomId: room.id,
    anchor: "against-north-wall",
    elevation: 919,
    mount: wall,
  });
  await call("place_item", {
    productId: "logitech-rally-bar",
    levelId: L,
    x: 4000,
    y: 4887,
    rotation: 0,
    elevation: 753,
    mount: wall,
  });
  for (const x of [2800, 5200])
    await call("place_item", {
      productId: "shure-mxa920-s",
      levelId: L,
      x,
      y: 2500,
      elevation: 2645,
      mount: ceiling,
    });
  for (const x of [2000, 6000])
    await call("place_item", {
      productId: "biamp-desono-c-ic6",
      levelId: L,
      x,
      y: 2500,
      elevation: 2510,
      mount: ceiling,
    });
  await call("place_item", { productId: "logitech-tap-ip", roomId: room.id, anchor: `on:${table.id}` });

  const problems = registry.problems();
  for (const p of problems) console.log(`  ${p.severity} ${p.code} ${p.entityId ?? ""}: ${p.message}`);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "project.json"), serialize(store.project));
  writeFileSync(join(OUT, "catalog.json"), `${JSON.stringify(FIXTURE_LIBRARY, null, 2)}\n`);
  console.log(`wrote ${OUT}: ${store.project.items.length} items, ${problems.length} problems`);
  catalog.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

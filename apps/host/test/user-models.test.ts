// A person's own 3D models (ADR-010 D10, ADR-012 D1, PRD P3-8): normalised and kept by their hash, made a
// product the catalog offers, served to the viewer, and carried in a project's assets/ folder to another
// installation, which takes them in.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeModel } from "@fpv/assets";
import { CatalogStore } from "@fpv/catalog/store";
import { Project, sequentialIdGenerator } from "@fpv/ir";
import { afterEach, describe, expect, it } from "vitest";
import { boxGlb } from "../../../packages/assets/test/glb-maker.js";
import { modelList } from "../src/bridge.js";
import {
  createSession,
  MANIFEST_FILE,
  type Manifest,
  ModelFiles,
  ProjectFileStore,
  type Served,
  serve,
  UserModels,
} from "../src/index.js";

const NOW = "2026-11-19T10:00:00.000Z";
const tmp = () => mkdtempSync(join(tmpdir(), "fpv-user-models-"));
const fixture = () =>
  Project.parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../tools/fixtures/six-wall-room.fpviz/project.json", import.meta.url)),
        "utf8",
      ),
    ),
  );
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** A lounge chair as it often arrives: in centimetres, made with z up, so lying on its back. */
const chairGlb = () =>
  boxGlb([
    { min: [0, 0, 0], max: [80, 70, 40], material: "Fabric" }, // seat, 80 wide, 70 deep, 40 high
    { min: [0, 60, 40], max: [80, 70, 95], material: null }, // back, at the rear, up to 95
  ]);

function installation() {
  const data = tmp();
  const catalog = CatalogStore.open(":memory:");
  const kept = new UserModels(catalog, data, () => NOW);
  const files = new ProjectFileStore({
    now: () => NOW,
    autosaveMs: 60_000,
    assets: { assetsFor: (p) => kept.assetsFor(p), adopt: (p, dir) => kept.adopt(p, dir) },
  });
  return { data, catalog, kept, files };
}

let served: Served | null = null;
afterEach(async () => {
  await served?.close();
  served = null;
});

describe("importing a model (P3-8)", () => {
  it("makes it a product of its own size, standing up and in millimetres, and keeps its file once", async () => {
    const { catalog, kept } = installation();
    const session = createSession({ project: fixture(), catalog, models: kept, now: () => NOW });
    const r = await session.registry.call("import_model", {
      contentBase64: base64(chairGlb()),
      fileName: "lounge_chair.glb",
      category: "chair",
      units: "cm",
      tip: 1,
    });
    expect(r.ok).toBe(true);
    const made = (r as { result: Record<string, unknown> }).result;
    expect(made).toMatchObject({
      productId: "user-lounge-chair",
      name: "Lounge chair",
      category: "chair",
      dims: { w: 800, d: 700, h: 950 },
      parts: ["Fabric", "material-2"],
      existing: false,
      triangles: 24,
    });
    const key = made.assetKey as string;
    expect(key).toMatch(/^user\/[0-9a-f]{16}\/std$/);
    expect(catalog.get("user-lounge-chair")).toMatchObject({
      assetKey: key,
      deformable: true,
      mount: { kinds: ["floor"] },
      tags: ["imported"],
      verification: { status: "manual" },
    });
    const hex = catalog.assetOrigin(key)?.entry.sha256 as string;
    expect(readdirSync(kept.dir)).toEqual([`${hex}.glb`]);
    // the kept file is the normalised one: it stands on the floor, centred, in metres
    expect(describeModel(new Uint8Array(readFileSync(join(kept.dir, `${hex}.glb`)))).size).toEqual({
      w: 0.8,
      d: 0.7,
      h: 0.95,
    });

    // the same model at the same size is the product already made of it; at another size, a new product
    const again = await session.registry.call("import_model", {
      contentBase64: base64(chairGlb()),
      fileName: "lounge_chair.glb",
      category: "chair",
      units: "cm",
      tip: 1,
    });
    expect((again as { result: { productId: string; existing: boolean } }).result).toMatchObject({
      productId: "user-lounge-chair",
      existing: true,
    });
    const bigger = await session.registry.call("import_model", {
      contentBase64: base64(chairGlb()),
      fileName: "lounge_chair.glb",
      category: "chair",
      units: "cm",
      tip: 1,
      size: { w: 900, d: 800, h: 1000 },
    });
    const second = (bigger as { result: { productId: string; assetKey: string } }).result;
    expect(second.productId).toBe("user-lounge-chair-2");
    expect(second.assetKey).toBe(key);
    expect(readdirSync(kept.dir)).toHaveLength(1);
    catalog.close();
  });

  it("says why it refuses a file it cannot draw, and is unavailable where nothing can be kept", async () => {
    const { catalog, kept } = installation();
    const session = createSession({ project: fixture(), catalog, models: kept, now: () => NOW });
    const refused = async (args: Record<string, unknown>) => {
      const r = await session.registry.call("import_model", args);
      return r.ok ? "ok" : r.error.code;
    };
    const draco = boxGlb([{ min: [0, 0, 0], max: [1, 1, 1] }], {
      extensionsRequired: ["KHR_draco_mesh_compression"],
    });
    expect(await refused({ contentBase64: base64(draco), fileName: "chair.glb" })).toBe("model.draco");
    expect(
      await refused({ contentBase64: base64(new TextEncoder().encode('{"asset":{}}')), fileName: "a.gltf" }),
    ).toBe("model.gltf-text");
    expect(await refused({ contentBase64: base64(chairGlb()), category: "door" })).toBe("args.invalid");
    const bare = createSession({ project: fixture(), now: () => NOW });
    expect(
      await (async () => {
        const r = await bare.registry.call("import_model", { contentBase64: base64(chairGlb()) });
        return r.ok ? "ok" : r.error.code;
      })(),
    ).toBe("unavailable");
    expect(catalog.models()).toEqual([]);
    catalog.close();
  });

  it("serves the model to the viewer and lists it, with the box it fills and its parts", async () => {
    const { catalog, kept, data } = installation();
    const session = createSession({ project: fixture(), catalog, models: kept, now: () => NOW });
    const r = await session.registry.call("import_model", { contentBase64: base64(chairGlb()), tip: 1 });
    const key = (r as { result: { assetKey: string } }).result.assetKey;
    expect(modelList(session)).toEqual([
      {
        key,
        bbox: { w: 80, d: 70, h: 95 },
        materialSlots: ["Fabric", "material-2"],
        sha256: catalog.assetOrigin(key)?.entry.sha256,
      },
    ]);
    const files = new ModelFiles(catalog, data, kept);
    served = await serve(session, { port: 0, models: (k) => files.file(k) });
    const base = `http://127.0.0.1:${served.port}`;
    const ok = await fetch(`${base}/models/${key}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("model/gltf-binary");
    expect(describeModel(new Uint8Array(await ok.arrayBuffer())).size.h).toBe(95);
    expect((await fetch(`${base}/models/user/ffffffffffffffff/std`)).status).toBe(404);
    expect((await fetch(`${base}/models/..%2F..%2Fsecret`)).status).toBe(404);
    catalog.close();
  });

  it("carries the models a project places in its assets/ folder, and another installation takes them in", async () => {
    const a = installation();
    const session = createSession({
      files: a.files,
      project: fixture(),
      catalog: a.catalog,
      models: a.kept,
      ids: sequentialIdGenerator(900),
      now: () => NOW,
    });
    const r = await session.registry.call("import_model", {
      contentBase64: base64(chairGlb()),
      fileName: "lounge chair.glb",
      category: "chair",
      units: "cm",
      tip: 1,
    });
    const { productId, assetKey } = (r as { result: { productId: string; assetKey: string } }).result;
    // imported but not placed: nothing to carry yet
    const where = tmp();
    await a.files.save(where);
    expect(() => readdirSync(join(where, "assets"))).toThrow();
    const placed = await session.registry.call(
      "place_item",
      { productId, x: 2000, y: 2000, snap: false },
      { origin: "editor" },
    );
    expect(placed.ok).toBe(true);
    await a.files.save(where);
    const hex = a.catalog.assetOrigin(assetKey)?.entry.sha256 as string;
    expect(readdirSync(join(where, "assets"))).toEqual([`${hex}.glb`]);
    const manifest = JSON.parse(readFileSync(join(where, MANIFEST_FILE), "utf8")) as Manifest;
    expect(manifest.assets).toEqual([{ key: assetKey, file: `${hex}.glb`, sha256: hex }]);

    // another installation, which has never seen the model, opens the project
    const b = installation();
    await b.files.open(where);
    expect(b.catalog.assetEntry(assetKey)?.bbox).toEqual({ w: 0.8, d: 0.7, h: 0.95 });
    expect(b.catalog.get(productId)).toMatchObject({ name: "Lounge chair", assetKey });
    expect(new ModelFiles(b.catalog, b.data, b.kept).file(assetKey)).not.toBeNull();

    // a file whose bytes do not match its name is not taken in
    const c = installation();
    writeFileSync(join(where, "assets", `${hex}.glb`), new Uint8Array([1, 2, 3]));
    await c.files.open(where);
    expect(c.catalog.assetEntry(assetKey)).toBeNull();
    for (const x of [a, b, c]) x.catalog.close();
  });
});

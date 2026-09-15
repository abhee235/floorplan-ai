import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetEntry } from "@fpv/assets";
import { afterEach, describe, expect, it } from "vitest";
import type { LibraryManifestInput, ProductInput, TextureInput } from "../src/index.js";
import {
  CatalogError,
  CatalogStore,
  installLibraryDir,
  libraryDir,
  uninstallLibraryDir,
} from "../src/node.js";

const AT = "2026-09-15T00:00:00.000Z";
const LATER = "2026-09-16T00:00:00.000Z";

const chair = (id: string, w = 600, over: Partial<ProductInput> = {}): ProductInput => ({
  id,
  make: "Acme",
  model: id,
  name: `Acme ${id}`,
  category: "chair",
  dims: { w, d: 600, h: 900 },
  mount: { kinds: ["floor"] },
  verification: { status: "unverified", confidence: 0.5, sources: [], verifiedAt: null, notes: null },
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const lib = (
  id: string,
  version: string,
  products: ProductInput[],
  over: Partial<LibraryManifestInput> = {},
): LibraryManifestInput => ({
  id,
  name: `${id} ${version}`,
  version,
  licence: { id: "CC0-1.0", author: "a", sourceUrl: null, attribution: null },
  provider: null,
  products,
  textures: [],
  assets: { version: 1, entries: [] },
  localized: {},
  ...over,
});

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("library precedence (spec 02 section 4, C-027, C-028)", () => {
  it("C-027 the highest installed version of an id provides its products, whatever the install order", () => {
    const store = CatalogStore.open(":memory:");
    store.installLibrary(lib("pack", "1.0.0", [chair("pack-a", 100)]), AT);
    store.installLibrary(lib("pack", "2.0.0", [chair("pack-a", 200)]), LATER);
    expect(store.get("pack-a")?.dims.w).toBe(200);
    const reversed = CatalogStore.open(":memory:");
    reversed.installLibrary(lib("pack", "2.0.0", [chair("pack-a", 200)]), AT);
    reversed.installLibrary(lib("pack", "1.0.0", [chair("pack-a", 100)]), LATER);
    expect(reversed.get("pack-a")?.dims.w).toBe(200);
    expect(reversed.installLibrary(lib("pack", "10.0.0", [chair("pack-a", 1000)]), LATER).version).toBe(
      "10.0.0",
    );
    expect(reversed.get("pack-a")?.dims.w).toBe(1000); // numeric, not lexical
    store.close();
    reversed.close();
  });

  it("uninstalling one version re-indexes from what remains; removing the last drops its products", () => {
    const store = CatalogStore.open(":memory:");
    store.installLibrary(lib("pack", "1.0.0", [chair("pack-a", 100), chair("pack-old")]), AT);
    store.installLibrary(lib("pack", "2.0.0", [chair("pack-a", 200)]), LATER);
    expect(store.get("pack-old")).toBeNull(); // 2.0.0 no longer ships it
    expect(store.uninstallLibrary("pack", "2.0.0", LATER)).toBe(true);
    expect(store.get("pack-a")?.dims.w).toBe(100);
    expect(store.get("pack-old")).not.toBeNull();
    expect(store.uninstallLibrary("pack", "1.0.0", LATER)).toBe(true);
    expect(store.get("pack-a")).toBeNull();
    expect(store.uninstallLibrary("pack", "1.0.0", LATER)).toBe(false);
    store.close();
  });

  it("C-028 libraries list newest first", () => {
    const store = CatalogStore.open(":memory:");
    store.installLibrary(lib("a", "1.0.0", []), AT);
    store.installLibrary(lib("b", "1.0.0", []), LATER);
    expect(store.libraries().map((l) => l.id)).toEqual(["b", "a"]);
    store.close();
  });

  it("C-026 (reversed) a product id already provided by another owner fails the install and rolls back", () => {
    const store = CatalogStore.open(":memory:");
    store.insert(chair("mine"));
    expect(() => store.installLibrary(lib("pack", "1.0.0", [chair("mine", 999)]), AT)).toThrow(CatalogError);
    expect(store.libraries()).toEqual([]);
    expect(store.get("mine")?.dims.w).toBe(600);
    expect(store.ownerOf("mine")).toBeNull();
    store.installLibrary(lib("other", "1.0.0", [chair("shared")]), AT);
    expect(() => store.installLibrary(lib("pack", "1.0.0", [chair("shared")]), AT)).toThrow(
      /already provided by library other/,
    );
    expect(() => store.installLibrary(lib("pack", "1.0.0", [chair("dup"), chair("dup")]), AT)).toThrow(
      /duplicate product id dup/,
    );
    store.close();
  });

  it("a library with an invalid product or manifest is refused whole", () => {
    const store = CatalogStore.open(":memory:");
    expect(() => store.installLibrary(lib("pack", "1.0.0", [chair("ok"), chair("bad", 0)]), AT)).toThrow(
      CatalogError,
    );
    expect(() => store.installLibrary(lib("Pack", "1", []), AT)).toThrow(/library.invalid|manifest|version/);
    expect(store.get("ok")).toBeNull();
    store.close();
  });

  it("textures and assets belong to their library; keys clash across libraries; texture ids carry the library", () => {
    const store = CatalogStore.open(":memory:");
    const entry: AssetEntry = {
      key: "chair/task/std",
      kind: "recipe",
      file: null,
      recipe: "chair",
      bbox: { w: 0.6, d: 0.6, h: 0.9 },
      triangles: 0,
      bytes: 0,
      sha256: null,
      materialSlots: [],
      articulations: [],
      presets: {},
      planIcon: null,
      licence: { id: "CC0-1.0", author: null, sourceUrl: null, attribution: null },
      tags: [],
    };
    const texture: TextureInput = {
      id: "pack/oak",
      name: "Oak",
      image: `sha256:${"c".repeat(64)}`,
      widthMm: 200,
      heightMm: 200,
      licence: { id: "CC0-1.0", author: null, sourceUrl: null, attribution: null },
    };
    store.installLibrary(
      lib("pack", "1.0.0", [], { assets: { version: 1, entries: [entry] }, textures: [texture] }),
      AT,
    );
    expect(store.assetEntry("chair/task/std")?.recipe).toBe("chair");
    expect(store.getTexture("pack/oak")?.name).toBe("Oak");
    expect(() =>
      store.installLibrary(lib("other", "1.0.0", [], { assets: { version: 1, entries: [entry] } }), AT),
    ).toThrow(/asset key chair\/task\/std is already provided/);
    expect(() => store.installLibrary(lib("other", "1.0.0", [], { textures: [texture] }), AT)).toThrow(
      /must be named <library>\/<slug>/,
    );
    store.uninstallLibrary("pack", "1.0.0", AT);
    expect(store.assetEntry("chair/task/std")).toBeNull();
    expect(store.getTexture("pack/oak")).toBeNull();
    store.close();
  });

  it("C-034 localised names are kept with the manifest and never touch dimensions", () => {
    const store = CatalogStore.open(":memory:");
    store.installLibrary(
      lib("pack", "1.0.0", [chair("pack-a")], { localized: { fr: { "pack-a": "Chaise Acme" } } }),
      AT,
    );
    expect(store.library("pack", "1.0.0")?.localized.fr?.["pack-a"]).toBe("Chaise Acme");
    expect(store.get("pack-a")?.name).toBe("Acme pack-a");
    store.close();
  });
});

describe("installing from a directory (ADR-010 D10, C-025, C-029)", () => {
  function source(over: { sha?: string; bytes?: number; drop?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "fpv-lib-src-"));
    temps.push(dir);
    const content = Buffer.from("glTF-bytes");
    mkdirSync(join(dir, "assets", "files"), { recursive: true });
    if (!over.drop) writeFileSync(join(dir, "assets", "files", "chair.glb"), content);
    const manifest = lib("pack", "1.0.0", [chair("pack-a")], {
      assets: {
        version: 1,
        entries: [
          {
            key: "chair/task/std",
            kind: "gltf",
            file: "chair.glb",
            recipe: null,
            bbox: { w: 0.6, d: 0.6, h: 0.9 },
            triangles: 10,
            bytes: over.bytes ?? content.length,
            sha256: over.sha ?? createHash("sha256").update(content).digest("hex"),
            materialSlots: ["seat"],
            articulations: [],
            presets: {},
            planIcon: null,
            licence: {
              id: "CC-BY-4.0",
              author: "someone",
              sourceUrl: "https://example.com/chair",
              attribution: "Chair by someone, CC BY 4.0",
            },
            tags: [],
          },
        ],
      },
    });
    writeFileSync(join(dir, "library.json"), JSON.stringify(manifest));
    return dir;
  }

  it("C-029 copies the library under the data directory so later edits to the source do not reach it", () => {
    const data = mkdtempSync(join(tmpdir(), "fpv-data-"));
    temps.push(data);
    const store = CatalogStore.open(":memory:");
    const src = source();
    const rec = installLibraryDir(store, src, data, AT);
    expect(rec).toMatchObject({ id: "pack", version: "1.0.0", productCount: 1, assetCount: 1 });
    const copied = join(libraryDir(data, "pack", "1.0.0"), "assets", "files", "chair.glb");
    expect(readFileSync(copied, "utf8")).toBe("glTF-bytes");
    writeFileSync(join(src, "assets", "files", "chair.glb"), "changed");
    expect(readFileSync(copied, "utf8")).toBe("glTF-bytes");
    expect(store.get("pack-a")).not.toBeNull();
    expect(uninstallLibraryDir(store, "pack", "1.0.0", data, AT)).toBe(true);
    expect(existsSync(libraryDir(data, "pack", "1.0.0"))).toBe(false);
    expect(store.get("pack-a")).toBeNull();
    store.close();
  });

  it("C-025 (verified) a wrong hash, wrong size or missing file refuses the install before anything is written", () => {
    const data = mkdtempSync(join(tmpdir(), "fpv-data-"));
    temps.push(data);
    const store = CatalogStore.open(":memory:");
    expect(() => installLibraryDir(store, source({ sha: "d".repeat(64) }), data, AT)).toThrow(
      /sha256 mismatch/,
    );
    expect(() => installLibraryDir(store, source({ bytes: 1 }), data, AT)).toThrow(/manifest says 1/);
    expect(() => installLibraryDir(store, source({ drop: true }), data, AT)).toThrow(/file not found/);
    expect(existsSync(join(data, "libraries"))).toBe(false);
    expect(store.libraries()).toEqual([]);
    store.close();
  });
});

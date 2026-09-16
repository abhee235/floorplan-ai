import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureSeed,
  normaliseMeshRotation,
  type ProductInput,
  ProductSnapshot,
  SEED_LIBRARY,
  SEED_PRODUCTS,
  validateProduct,
} from "../src/index.js";
import { CatalogError, CatalogStore } from "../src/node.js";

const AT = "2026-09-15T00:00:00.000Z";
const chair = (id: string, over: Partial<ProductInput> = {}): ProductInput => ({
  id,
  make: "Acme",
  model: id.toUpperCase(),
  name: `Acme ${id} chair`,
  category: "chair",
  dims: { w: 600, d: 600, h: 900 },
  mount: { kinds: ["floor"] },
  verification: { status: "unverified", confidence: 0.5, sources: [], verifiedAt: null, notes: null },
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

function seeded(): CatalogStore {
  const store = CatalogStore.open(":memory:");
  ensureSeed(store, AT);
  return store;
}

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("seed library (ADR-008 D5)", () => {
  it("installs once, every product validates without errors, and AV products carry their spec keys", () => {
    const store = CatalogStore.open(":memory:");
    expect(ensureSeed(store, AT)).toBe(true);
    expect(ensureSeed(store, AT)).toBe(false);
    expect(store.count()).toBe(SEED_PRODUCTS.length);
    for (const p of store.all()) {
      const problems = validateProduct(p);
      expect(
        problems.filter((x) => x.severity === "error"),
        p.id,
      ).toEqual([]);
      expect(
        problems.map((x) => x.code),
        p.id,
      ).not.toContain("specs.missing");
      expect(p.verification.status === "verified", p.id).toBe(false); // nothing is claimed verified without a source
    }
    expect(store.libraries().map((l) => l.id)).toEqual(["generated", "seed"]);
    // P3-5: the drawn textures come with it, and say where they come from
    expect(store.textures().map((t) => t.id)).toContain("generated/oak");
    expect(store.texture("generated/oak")).toMatchObject({ image: "generated:oak", widthMm: 880 });
    expect(store.textureOrigin("generated/oak")).toMatchObject({ library: "generated", version: "1.0.0" });
    expect(store.textureOrigin("generated/nothing")).toBeNull();
    store.close();
  });

  it("offers a table, a desk and a chair that can be any size, while branded furniture keeps its own", () => {
    const store = seeded();
    for (const id of ["generic-table-1800x900", "generic-desk-1600x800", "generic-chair"])
      expect(store.get(id)?.deformable, id).toBe(true);
    const branded = store
      .all()
      .filter((p) => ["table", "chair"].includes(p.category) && p.make !== "Generic");
    expect(branded.length).toBeGreaterThan(0);
    for (const p of branded) expect(p.deformable, p.id).toBe(false);
    // a search for a table finds the one that can be sized
    expect(store.search({ query: "table" }).hits.map((h) => h.id)).toContain("generic-table-1800x900");
    store.close();
  });

  it("brings an older installed seed up to date, so a data folder in use gets the new products", () => {
    const store = CatalogStore.open(":memory:");
    store.installLibrary(
      {
        ...SEED_LIBRARY,
        version: "1.0.0",
        products: SEED_PRODUCTS.filter(
          (p) => !["table", "desk", "chair"].includes(p.category) || p.make !== "Generic",
        ),
      },
      AT,
    );
    expect(store.get("generic-chair")).toBeNull();
    expect(ensureSeed(store, AT)).toBe(true);
    expect(store.get("generic-chair")?.deformable).toBe(true);
    expect(store.count()).toBe(SEED_PRODUCTS.length);
    store.close();
  });
});

describe("search (spec 02 section 5, ADR-008 D4)", () => {
  it("an exact id wins, typed as the slug or as make and model", () => {
    const store = seeded();
    for (const q of ["samsung-qm75c", "Samsung QM75C", "SAMSUNG-QM75C"]) {
      const r = store.search({ query: q });
      expect(r.hits[0]).toMatchObject({ id: "samsung-qm75c", matchedBy: "id" });
    }
    store.close();
  });

  it("then the model number ignoring spaces, dashes and case", () => {
    const store = seeded();
    const r = store.search({ query: "qm 85 c" });
    expect(r.hits[0]).toMatchObject({ id: "samsung-qm85c", matchedBy: "model" });
    expect(store.search({ query: "MXA920S" }).hits[0]?.id).toBe("shure-mxa920-s");
    store.close();
  });

  it("then every word in the name, then tags and aliases with synonyms, then full text", () => {
    const store = seeded();
    const byName = store.search({ query: "boardroom table" });
    expect(byName.hits[0]).toMatchObject({ id: "steelcase-convene-3600x1400", matchedBy: "name" });
    const tv = store.search({ query: "tv" });
    expect(tv.hits.length).toBeGreaterThanOrEqual(5);
    expect(tv.hits.every((h) => h.category === "display")).toBe(true);
    expect(tv.hits[0]?.matchedBy).toBe("term");
    const screen = store.search({ query: "screen" });
    expect(screen.hits.some((h) => h.category === "display")).toBe(true);
    // a prefix plus a wrong word: no exact tier matches, full-text prefix OR ranking still finds it
    const text = store.search({ query: "beamform pendant" });
    expect(text.hits.map((h) => h.id)).toEqual(["sennheiser-tcc2"]);
    expect(text.hits[0]?.matchedBy).toBe("text");
    store.close();
  });

  it("returns every candidate with id, category and dims so a model can disambiguate", () => {
    const store = seeded();
    const r = store.search({ query: "ceiling speaker" });
    expect(r.total).toBeGreaterThanOrEqual(3);
    // the three speakers match by name and come first; ceiling mics follow from full-text ranking
    expect(r.hits.slice(0, 3).every((h) => h.category === "ceiling-speaker")).toBe(true);
    for (const h of r.hits) {
      expect(h.id).toBeTruthy();
      expect(h.category).toBeTruthy();
      expect(h.dims.w).toBeGreaterThan(0);
      expect(typeof h.verified).toBe("boolean");
    }
    expect(store.search({ query: "ceiling speaker", category: "ceiling-speaker" }).hits).toHaveLength(3);
    store.close();
  });

  it("filters by category, caps at 20, and pages with a cursor over the full ordered list", () => {
    const store = CatalogStore.open(":memory:");
    for (let i = 0; i < 25; i += 1)
      store.insert(chair(`acme-c${String(i).padStart(2, "0")}`, { tags: ["stack"] }));
    store.insert(chair("acme-t1", { category: "table", name: "Acme stack table", tags: ["stack"] }));
    const first = store.search({ query: "stack", limit: 50 });
    expect(first.hits).toHaveLength(20);
    expect(first.total).toBe(26);
    expect(first.cursor).not.toBeNull();
    const second = store.search({ query: "stack", cursor: first.cursor as string });
    expect(second.hits).toHaveLength(6);
    expect(second.cursor).toBeNull();
    expect(new Set([...first.hits, ...second.hits].map((h) => h.id)).size).toBe(26);
    const tables = store.search({ query: "stack", category: "table" });
    expect(tables.hits.map((h) => h.id)).toEqual(["acme-t1"]);
    expect(store.search({ query: "", category: "table" }).hits.map((h) => h.id)).toEqual(["acme-t1"]);
    // an empty query browses everything, by category and then name, a page at a time (P3-5 catalog tab)
    const all = store.search({ query: "" });
    expect(all.total).toBe(26);
    expect(all.hits.map((h) => h.category)).toEqual(Array.from({ length: 20 }, () => "chair"));
    const rest = store.search({ query: "  ", cursor: all.cursor as string });
    expect(rest.hits.at(-1)?.id).toBe("acme-t1");
    expect(() => store.search({ query: "stack", cursor: "nope" })).toThrow(/bad cursor/);
    store.close();
  });

  it("rejected products only answer to their exact id", () => {
    const store = CatalogStore.open(":memory:");
    store.insert(
      chair("acme-bad", {
        verification: { status: "rejected", confidence: 0, sources: [], verifiedAt: null, notes: "invented" },
      }),
    );
    expect(store.search({ query: "acme chair" }).hits).toEqual([]);
    expect(store.search({ query: "acme-bad" }).hits[0]?.status).toBe("rejected");
    expect(store.search({ query: "acme chair", includeRejected: true }).hits).toHaveLength(1);
    store.close();
  });

  it("byCategory applies size, spec, tag and status constraints", () => {
    const store = seeded();
    const big = store.byCategory("display", { specs: { diagonalIn: { gte: 85 } } }).map((p) => p.id);
    expect(big).toEqual(["lg-86uh5j", "samsung-qm85c", "samsung-qm98c"]);
    expect(store.byCategory("display", { maxDims: { w: 1700 } }).map((p) => p.id)).toEqual([
      "lg-75uh5j",
      "samsung-qm75c",
    ]);
    expect(store.byCategory("display", { verifiedOnly: true })).toEqual([]);
    expect(store.byCategory("table", { specs: { seats: { gte: 10 } } }).map((p) => p.id)).toEqual([
      "steelcase-convene-3600x1400",
    ]);
    expect(store.byCategory("chair", { tags: ["boardroom"] }).length).toBe(2);
    store.close();
  });
});

describe("writes (C-026 reversed, spec 02 section 1.1)", () => {
  it("insert refuses an existing id; upsert updates the same owner and refuses another owner", () => {
    const store = seeded();
    expect(() => store.insert(chair("samsung-qm75c"))).toThrow(CatalogError);
    expect(() => store.insert(chair("samsung-qm75c"))).toThrow(/already exists/);
    // a direct write over a library product is a clash, not a merge
    expect(() => store.upsert(chair("samsung-qm75c"))).toThrow(/already provided by library seed/);
    store.insert(chair("acme-x"));
    expect(store.upsert(chair("acme-x", { name: "Acme X chair v2" })).changed).toBe(true);
    expect(store.get("acme-x")?.name).toBe("Acme X chair v2");
    expect(store.remove("acme-x")).toBe(true);
    expect(store.remove("acme-x")).toBe(false);
    expect(store.search({ query: "acme-x" }).hits).toEqual([]);
    store.close();
  });

  it("invalid products are refused with every problem listed", () => {
    const store = CatalogStore.open(":memory:");
    try {
      store.insert(chair("Bad Id", { dims: { w: 0, d: 600, h: 900 } }));
      throw new Error("unreachable");
    } catch (e) {
      expect(e).toBeInstanceOf(CatalogError);
      const err = e as CatalogError;
      expect(err.code).toBe("product.invalid");
      expect(err.problems.length).toBeGreaterThanOrEqual(2);
    }
    store.close();
  });

  it("snapshot picks the placement and pricing fields and stamps snapshotAt", () => {
    const store = seeded();
    const snaps = store.snapshot(["samsung-qm75c", "nope"], AT);
    expect(Object.keys(snaps)).toEqual(["samsung-qm75c"]);
    const s = snaps["samsung-qm75c"];
    expect(ProductSnapshot.safeParse(s).success).toBe(true);
    expect(s).toMatchObject({ id: "samsung-qm75c", snapshotAt: AT, dims: { w: 1672 } });
    expect(s).not.toHaveProperty("tags");
    expect(s).not.toHaveProperty("createdAt");
    const view = store.product("samsung-qm75c");
    expect(view).toMatchObject({ status: "unverified", price: null });
    store.close();
  });

  it("P-025 mesh rotations snap near-integers and drop the identity", () => {
    expect(normaliseMeshRotation([0.9999999, 0, 0, 0, 1, 0, 0, 0, 1.0000001])).toBeNull();
    expect(normaliseMeshRotation([0, -0.9999999, 0, 1, 0, 0, 0, 0, 1])).toEqual([0, -1, 0, 1, 0, 0, 0, 0, 1]);
    const store = CatalogStore.open(":memory:");
    store.insert(chair("acme-r", { meshRotation: [0, 1, 0, -1, 0, 0, 0, 0, 1] }));
    expect(store.get("acme-r")?.meshRotation).toEqual([0, 1, 0, -1, 0, 0, 0, 0, 1]);
    store.close();
  });

  it("resolves asset keys through installed packs and built-in recipes", () => {
    const store = seeded();
    expect(store.resolveAssetKey(store.get("herman-miller-aeron-b") as never)).toBe("chair/default/std");
    expect(store.resolveAssetKey(store.get("logitech-tap-scheduler") as never)).toBe("other/default/std");
    store.close();
  });

  it("textures are validated records keyed <library>/<slug>", () => {
    const store = CatalogStore.open(":memory:");
    const t = store.upsertTexture({
      id: "acme/oak",
      name: "Oak",
      image: `sha256:${"b".repeat(64)}`,
      widthMm: 200,
      heightMm: 200,
      licence: { id: "CC0-1.0", author: null, sourceUrl: null, attribution: null },
    });
    expect(t.transparent).toBe(false);
    expect(store.getTexture("acme/oak")?.name).toBe("Oak");
    expect(() => store.upsertTexture({ ...t, id: "oak" })).toThrow();
    expect(store.removeTexture("acme/oak")).toBe(true);
    store.close();
  });

  it("persists to a file and reopens with the same content", () => {
    const dir = mkdtempSync(join(tmpdir(), "fpv-catalog-"));
    temps.push(dir);
    const path = join(dir, "catalog.db");
    const a = CatalogStore.open(path);
    ensureSeed(a, AT);
    a.insert(chair("acme-file"));
    a.close();
    const b = CatalogStore.open(path);
    expect(ensureSeed(b, AT)).toBe(false);
    expect(b.count()).toBe(SEED_PRODUCTS.length + 1);
    expect(b.search({ query: "acme-file" }).hits).toHaveLength(1);
    b.close();
  });

  it("exports direct products as a library that another store installs", () => {
    const a = seeded();
    a.insert(chair("acme-shared"));
    const lib = a.exportDirect("acme-share", "Shared", "1.0.0", "me");
    expect(lib.products.map((p) => p.id)).toEqual(["acme-shared"]);
    const b = CatalogStore.open(":memory:");
    b.installLibrary(lib, AT);
    expect(b.get("acme-shared")?.name).toBe("Acme acme-shared chair");
    expect(b.ownerOf("acme-shared")).toBe("acme-share");
    a.close();
    b.close();
  });
});

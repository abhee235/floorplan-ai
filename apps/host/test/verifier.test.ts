import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSeed, staticFetcher } from "@fpv/catalog";
import { CatalogStore } from "@fpv/catalog/store";
import { sequentialIdGenerator } from "@fpv/ir";
import type { ToolResult } from "@fpv/tools";
import { afterEach, describe, expect, it } from "vitest";
import { createSession } from "../src/session.js";
import { createVerifier, createWeb, loadHostConfig } from "../src/verifier.js";

const NOW = "2026-09-15T12:00:00.000Z";
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "fpv-host-verifier-"));
  temps.push(d);
  return d;
}

describe("verifier configuration (ADR-007 D1, ADR-008 D3)", () => {
  it("nothing configured: no search, no model, private pages refused", () => {
    const loaded = loadHostConfig({ dataDir: dir(), env: {} });
    expect(loaded).toEqual({
      config: { search: null, model: null, allowPrivatePages: false, maxPages: 3 },
      file: null,
      notes: [],
    });
  });

  it("reads config.json with keys from named environment variables, and environment variables win", () => {
    const d = dir();
    writeFileSync(
      join(d, "config.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: "http://127.0.0.1:11434/v1",
            model: "qwen3.6:35b",
            profile: { contextTokens: 32000 },
          },
          router: { baseUrl: "https://openrouter.ai/api/v1", model: "qwen/qwen3", apiKeyEnv: "OR_KEY" },
        },
        roles: { verifier: "router" },
        search: { kind: "brave", apiKeyEnv: "MY_BRAVE" },
        verifier: { maxPages: 2 },
      }),
    );
    const fromFile = loadHostConfig({ dataDir: d, env: { OR_KEY: "or-secret", MY_BRAVE: "brave-secret" } });
    expect(fromFile.file).toBe(join(d, "config.json"));
    expect(fromFile.config).toMatchObject({
      search: { kind: "brave", apiKey: "brave-secret" },
      model: {
        id: "router",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "qwen/qwen3",
        apiKey: "or-secret",
      },
      maxPages: 2,
    });
    const fromEnv = loadHostConfig({
      dataDir: d,
      env: {
        FPV_SEARCH: "searxng",
        FPV_SEARCH_URL: "http://127.0.0.1:8888",
        FPV_VERIFIER_BASE_URL: "http://127.0.0.1:11434/v1",
        FPV_VERIFIER_MODEL: "qwen3.6:35b",
      },
    });
    expect(fromEnv.config.search).toEqual({ kind: "searxng", baseUrl: "http://127.0.0.1:8888" });
    expect(fromEnv.config.model).toMatchObject({ id: "env-verifier", model: "qwen3.6:35b", apiKey: null });
  });

  it("explains incomplete settings and refuses a malformed file", () => {
    const d = dir();
    const loaded = loadHostConfig({ dataDir: d, env: { FPV_SEARCH: "brave" } });
    expect(loaded.config.search).toBeNull();
    expect(loaded.notes).toEqual(["search is brave but no API key is set (FPV_SEARCH_API_KEY)"]);
    writeFileSync(join(d, "config.json"), JSON.stringify({ search: { kind: "google" } }));
    expect(() => loadHostConfig({ dataDir: d, env: {} })).toThrow(/config.json: search/);
  });

  it("with no search and no model, verify_product still verifies from sources and a proposal an agent passes", async () => {
    const store = CatalogStore.open(":memory:");
    ensureSeed(store, NOW);
    const page = "https://www.logitech.com/en-us/products/video-conferencing/room-solutions/rallybar.html";
    const fetcher = staticFetcher({
      [page]:
        "<h1>Logitech Rally Bar</h1><p>Dimensions: Height 164 mm, Width 910 mm, Depth 130.5 mm. Weight 7.08 kg. Field of view 90°.</p>",
    });
    const { verifier, describe: text } = createVerifier(
      store,
      loadHostConfig({ dataDir: dir(), env: {} }).config,
      {
        now: () => NOW,
        fetcher,
      },
    );
    expect(text).toBe(
      "no search provider (callers pass sources), no verifier model (callers pass a proposal)",
    );
    const session = createSession({
      ids: sequentialIdGenerator(1),
      now: () => NOW,
      catalog: store,
      verifier,
    });
    const none = await session.registry.call("verify_product", { make: "Logitech", model: "Rally Bar" });
    expect(none.ok).toBe(false);
    if (!none.ok)
      expect(none.error.message).toBe(
        "verify_product is unavailable because no search provider is configured",
      );
    const r = (await session.registry.call("verify_product", {
      make: "Logitech",
      model: "Rally Bar",
      sources: [page],
      proposal: {
        found: true,
        make: "Logitech",
        model: "Rally Bar",
        category: "video-bar",
        dims: { w: 910, d: 131, h: 164 },
        weightKg: 7.08,
        specs: { fovDeg: 90 },
        fieldSources: { dims: page },
      },
    })) as ToolResult<{ status: string; productId: string; product: { dims: unknown } }>;
    if (!r.ok) throw new Error(r.error.message);
    expect(r.result).toMatchObject({
      status: "verified",
      productId: "logitech-rally-bar",
      product: { dims: { w: 910, d: 131, h: 164 } },
    });
    // the seed had the wrong size for this bar; the verified record replaced it and placement uses it
    expect(store.get("logitech-rally-bar")?.dims).toEqual({ w: 910, d: 131, h: 164 });
    store.close();
  });
});

describe("the web for the agent (ADR-027 D4)", () => {
  it("takes a SearXNG address alone to mean SearXNG, and says so", () => {
    // The owner's own .env: FPV_SEARCH_URL set, FPV_SEARCH not, and the host said "no search
    // provider" with no word about why.
    const loaded = loadHostConfig({ dataDir: dir(), env: { FPV_SEARCH_URL: "http://searx.local:8080" } });
    expect(loaded.config.search).toEqual({ kind: "searxng", baseUrl: "http://searx.local:8080" });
    expect(loaded.notes).toEqual([
      "FPV_SEARCH_URL is set and FPV_SEARCH is not; taking the search to be searxng",
    ]);
  });

  it("is nothing without search, and search with pictures with SearXNG", () => {
    const none = createWeb({ search: null, model: null, allowPrivatePages: false, maxPages: 3 });
    expect(none.web).toBeNull();
    expect(none.describe).toContain("FPV_SEARCH=searxng");
    const searx = createWeb({
      search: { kind: "searxng", baseUrl: "http://searx.local:8080" },
      model: null,
      allowPrivatePages: true,
      maxPages: 3,
    });
    expect(searx.web?.search.id).toBe("searxng");
    expect(typeof searx.web?.search.images).toBe("function");
    expect(searx.describe).toBe("searxng at searx.local:8080, with images");
  });
});

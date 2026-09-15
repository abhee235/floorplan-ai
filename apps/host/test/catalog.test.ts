import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEED_PRODUCTS } from "@fpv/catalog";
import { sequentialIdGenerator } from "@fpv/ir";
import type { ToolResult } from "@fpv/tools";
import { afterEach, describe, expect, it } from "vitest";
import { openCatalog, parseArgs } from "../src/cli.js";
import { defaultDataDir } from "../src/paths.js";
import { createSession } from "../src/session.js";

const NOW = "2026-09-15T12:00:00.000Z";
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "fpv-host-catalog-"));
  temps.push(d);
  return d;
}

describe("host catalog wiring (PRD P1-1, ADR-008 D5)", () => {
  it("--data and FPV_DATA_DIR choose the data directory; the platform default otherwise", () => {
    expect(parseArgs(["--mcp", "--data", "D:/fpv"]).data).toBe("D:/fpv");
    expect(parseArgs(["--mcp"]).data).toBeNull();
    expect(defaultDataDir({ FPV_DATA_DIR: "/tmp/x" }, "linux")).toBe("/tmp/x");
    expect(defaultDataDir({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "win32")).toBe(
      join("C:\\Users\\me\\AppData\\Local", "floorplan-viz"),
    );
    expect(defaultDataDir({ XDG_DATA_HOME: "/data" }, "linux")).toBe(join("/data", "floorplan-viz"));
  });

  it("opens catalog.db in the data directory and installs the seed exactly once", () => {
    const dir = tempDir();
    const first = openCatalog(dir, () => NOW);
    expect(first.seeded).toBe(true);
    expect(existsSync(join(dir, "catalog.db"))).toBe(true);
    expect(first.store.count()).toBe(SEED_PRODUCTS.length);
    first.store.close();
    const second = openCatalog(dir, () => NOW);
    expect(second.seeded).toBe(false);
    expect(second.store.count()).toBe(SEED_PRODUCTS.length);
    second.store.close();
  });

  it("search_catalog through the registry returns at most 20 hits with id, category and dims, and pages", async () => {
    const { store } = openCatalog(tempDir(), () => NOW);
    const session = createSession({ ids: sequentialIdGenerator(1), now: () => NOW, catalog: store });
    const r = (await session.registry.call("search_catalog", {
      kind: "product",
      query: "display",
    })) as ToolResult<{
      hits: { id: string; category: string; dims: { w: number }; verified: boolean }[];
      total: number;
      cursor: string | null;
    }>;
    if (!r.ok) throw new Error(r.error.message);
    expect(r.result.hits.length).toBeGreaterThanOrEqual(5);
    expect(r.result.hits.length).toBeLessThanOrEqual(20);
    for (const h of r.result.hits)
      expect(h).toMatchObject({ id: expect.any(String), category: expect.any(String) });
    const paged = (await session.registry.call("search_catalog", {
      kind: "product",
      query: "",
      category: "display",
      limit: 2,
    })) as ToolResult<{ hits: unknown[]; total: number; cursor: string | null }>;
    if (!paged.ok) throw new Error(paged.error.message);
    expect(paged.result.hits).toHaveLength(2);
    expect(paged.result.total).toBe(5);
    expect(paged.result.cursor).not.toBeNull();
    const next = (await session.registry.call("search_catalog", {
      kind: "product",
      query: "",
      category: "display",
      limit: 2,
      cursor: paged.result.cursor as string,
    })) as ToolResult<{ hits: unknown[]; cursor: string | null }>;
    if (!next.ok) throw new Error(next.error.message);
    expect(next.result.hits).toHaveLength(2);
    store.close();
  });

  it("placing a seed product snapshots the strict record into the project's catalogRefs", async () => {
    const { store } = openCatalog(tempDir(), () => NOW);
    const session = createSession({ ids: sequentialIdGenerator(1), now: () => NOW, catalog: store });
    const levelId = session.store.project.levels[0]?.id as string;
    const placed = await session.registry.call("place_item", {
      productId: "herman-miller-aeron-b",
      levelId,
      x: 1000,
      y: 1000,
    });
    expect(placed.ok).toBe(true);
    const snap = session.store.project.catalogRefs["herman-miller-aeron-b"] as Record<string, unknown>;
    expect(snap).toMatchObject({
      id: "herman-miller-aeron-b",
      snapshotAt: NOW,
      dims: { w: 686, d: 640, h: 1040 },
    });
    expect(snap).not.toHaveProperty("tags");
    expect(snap).not.toHaveProperty("aliases");
    const unknown = await session.registry.call("place_item", {
      productId: "acme-invented",
      levelId,
      x: 0,
      y: 0,
    });
    expect(unknown.ok).toBe(false);
    store.close();
  });
});

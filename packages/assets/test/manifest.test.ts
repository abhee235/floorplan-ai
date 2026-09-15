import { describe, expect, it } from "vitest";
import {
  type AssetEntry,
  AssetManifest,
  entryFor,
  MAX_TRIANGLES,
  RECIPE_MANIFEST,
  recipeForCategory,
  resolveAssetKey,
  sizeDistance,
  validateManifest,
  withBuiltIns,
} from "../src/index.js";

const gltf = (key: string, over: Partial<AssetEntry> = {}): AssetEntry => ({
  key,
  kind: "gltf",
  file: `${key.replaceAll("/", "-")}.glb`,
  recipe: null,
  bbox: { w: 0.6, d: 0.6, h: 0.9 },
  triangles: 1200,
  bytes: 40_000,
  sha256: "a".repeat(64),
  materialSlots: ["seat", "frame"],
  articulations: [],
  presets: {},
  planIcon: null,
  licence: { id: "CC0-1.0", author: "someone", sourceUrl: null, attribution: null },
  tags: [],
  ...over,
});

describe("asset manifest (spec 02 section 3)", () => {
  it("the built-in recipe manifest is valid and covers every fallback category", () => {
    expect(AssetManifest.safeParse(RECIPE_MANIFEST).success).toBe(true);
    expect(validateManifest(RECIPE_MANIFEST)).toEqual([]);
    for (const category of [
      "table",
      "desk",
      "chair",
      "sofa",
      "display",
      "video-bar",
      "soundbar",
      "ceiling-speaker",
      "ceiling-mic",
    ])
      expect(RECIPE_MANIFEST.entries.some((e) => e.key === `${category}/default/std`)).toBe(true);
    expect(recipeForCategory("scheduler")).toBe("box");
    expect(recipeForCategory("desk")).toBe("table");
  });

  it("C-038 every entry can draw itself; C-039 planIcon is optional and null lets the plan draw the footprint", () => {
    for (const e of RECIPE_MANIFEST.entries) {
      expect(e.kind).toBe("recipe");
      expect(e.recipe).not.toBeNull();
      expect(e.planIcon).toBeNull();
    }
    const withIcon = gltf("chair/task/std", { planIcon: "icons/chair-task.png" });
    expect(validateManifest({ version: 1, entries: [withIcon] })).toEqual([]);
    expect(
      AssetManifest.safeParse({ version: 1, entries: [{ ...withIcon, planIcon: undefined }] }).success,
    ).toBe(false);
  });

  it("rejects duplicate keys, gltf entries without file or hash, and budget overruns", () => {
    const problems = validateManifest({
      version: 1,
      entries: [
        gltf("chair/task/std"),
        gltf("chair/task/std", { file: null, sha256: null, triangles: MAX_TRIANGLES + 1 }),
        gltf("table/rect/std", { kind: "recipe", recipe: "table" }),
        gltf("desk/rect/std", { materialSlots: ["top", "top"] }),
      ],
    });
    const codes = problems.map((p) => p.code);
    expect(codes).toContain("key.duplicate");
    expect(codes).toContain("gltf.file");
    expect(codes).toContain("gltf.sha256");
    expect(codes).toContain("gltf.triangles");
    expect(codes).toContain("recipe.file");
    expect(codes).toContain("materialSlots.duplicate");
  });

  it("CC-BY needs attribution text; NC, ND and copyleft licences are not in the enum at all", () => {
    const bare = gltf("chair/task/std", {
      licence: { id: "CC-BY-4.0", author: "a", sourceUrl: null, attribution: null },
    });
    expect(validateManifest({ version: 1, entries: [bare] }).map((p) => p.code)).toEqual([
      "licence.attribution",
    ]);
    const credited = { ...bare, licence: { ...bare.licence, attribution: "Chair by a, CC BY 4.0" } };
    expect(validateManifest({ version: 1, entries: [credited] })).toEqual([]);
    expect(
      AssetManifest.safeParse({
        version: 1,
        entries: [
          { ...bare, licence: { id: "CC-BY-NC-4.0", author: "a", sourceUrl: null, attribution: "x" } },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("asset key resolution (spec 02 section 3.1, ADR-010 D1)", () => {
  const packs = [
    gltf("display/default/75", { bbox: { w: 1.672, d: 0.045, h: 0.962 } }),
    gltf("display/default/98", { bbox: { w: 2.19, d: 0.088, h: 1.252 } }),
    gltf("chair/task/std"),
  ];

  it("an explicit key that exists wins; a missing explicit key falls through to the size class", () => {
    const chair = { category: "chair", dims: { w: 600, d: 600, h: 900 }, assetKey: "chair/task/std" };
    expect(resolveAssetKey(chair, packs)).toBe("chair/task/std");
    expect(resolveAssetKey({ ...chair, assetKey: "chair/lounge/std" }, packs)).toBe("chair/default/std");
  });

  it("picks the nearest default size class by log ratio of the bounding box", () => {
    const small = { category: "display", dims: { w: 1672, d: 45, h: 962 }, assetKey: null };
    const big = { category: "display", dims: { w: 2190, d: 88, h: 1252 }, assetKey: null };
    expect(resolveAssetKey(small, packs)).toBe("display/default/75");
    expect(resolveAssetKey(big, packs)).toBe("display/default/98");
    expect(sizeDistance(small.dims, { w: 1.68, d: 0.06, h: 0.96 })).toBeLessThan(
      sizeDistance(small.dims, { w: 2.19, d: 0.09, h: 1.25 }),
    );
  });

  it("falls back to the category recipe, then to the labelled box", () => {
    expect(resolveAssetKey({ category: "table", dims: { w: 2400, d: 1200, h: 750 }, assetKey: null })).toBe(
      "table/default/std",
    );
    expect(resolveAssetKey({ category: "scheduler", dims: { w: 244, d: 30, h: 162 }, assetKey: null })).toBe(
      "other/default/std",
    );
    expect(entryFor("nope/nope/nope").recipe).toBe("box");
  });

  it("a pack entry with a built-in key replaces the recipe", () => {
    const real = gltf("chair/default/std");
    const merged = withBuiltIns([real]);
    expect(merged.filter((e) => e.key === "chair/default/std")).toEqual([real]);
    expect(merged.length).toBe(RECIPE_MANIFEST.entries.length);
  });
});

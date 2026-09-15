import { describe, expect, it } from "vitest";
import { effectiveCutOutPath, Product, type ProductInput, validateProduct } from "../src/index.js";
import { CatalogStore } from "../src/node.js";

const AT = "2026-09-15T00:00:00.000Z";
const base = (over: Partial<ProductInput> = {}): ProductInput => ({
  id: "acme-door-900",
  make: "Acme",
  model: "Door 900",
  name: "Acme door 900",
  category: "door",
  dims: { w: 900, d: 40, h: 2100 },
  mount: { kinds: ["wall"] },
  opening: {},
  verification: { status: "manual", confidence: 1, sources: [], verifiedAt: AT, notes: null },
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

describe("opening products (spec 02 section 1, ADR-008 D1)", () => {
  it("O-001 O-002 a door that omits embed fields gets 1/0/1/0, no cut-out path, both sides cut, deformable", () => {
    const p = Product.parse(base());
    expect(p.opening).toEqual({
      embed: { thickness: 1, distance: 0, width: 1, left: 0, height: 1, top: 0 },
      cutOutPath: null,
      cutBothSides: true,
      sashes: [],
    });
    expect(p.deformable).toBe(true);
  });

  it("O-003 embed fractions given are read verbatim and the rest keep their defaults", () => {
    const p = Product.parse(base({ opening: { embed: { left: 0.25, width: 0.5 } } }));
    expect(p.opening?.embed).toEqual({
      thickness: 1,
      distance: 0,
      width: 0.5,
      left: 0.25,
      height: 1,
      top: 0,
    });
  });

  it("O-005 (rejected) fractions outside 0..1 are refused instead of stored", () => {
    expect(Product.safeParse(base({ opening: { embed: { left: -0.5 } } })).success).toBe(false);
    expect(Product.safeParse(base({ opening: { embed: { thickness: 1.5 } } })).success).toBe(false);
  });

  it("O-006 writing an identical product is not a change: updatedAt is kept and nothing is rewritten", () => {
    const store = CatalogStore.open(":memory:");
    expect(store.upsert(base(), { now: "2026-09-16T00:00:00.000Z" }).changed).toBe(true);
    expect(store.get("acme-door-900")?.updatedAt).toBe("2026-09-16T00:00:00.000Z");
    expect(store.upsert(base(), { now: "2026-09-17T00:00:00.000Z" }).changed).toBe(false);
    expect(store.get("acme-door-900")?.updatedAt).toBe("2026-09-16T00:00:00.000Z");
    expect(
      store.upsert(base({ name: "Acme door 900 oak" }), { now: "2026-09-18T00:00:00.000Z" }).changed,
    ).toBe(true);
    expect(store.get("acme-door-900")?.updatedAt).toBe("2026-09-18T00:00:00.000Z");
    store.close();
  });

  it("O-013 doors and windows are openings, never items: they mount only in walls", () => {
    const floorDoor = Product.parse(base({ mount: { kinds: ["wall", "floor"] } }));
    expect(validateProduct(floorDoor).map((p) => p.code)).toContain("opening.mount");
    const ok = Product.parse(base());
    expect(validateProduct(ok).filter((p) => p.severity === "error")).toEqual([]);
  });

  it("opening is required for doors and windows and forbidden elsewhere", () => {
    const noSpec = Product.parse(base({ opening: null }));
    expect(validateProduct(noSpec).map((p) => p.code)).toContain("opening.required");
    const chair = Product.parse(
      base({ id: "acme-chair", category: "chair", mount: { kinds: ["floor"] }, opening: {} }),
    );
    expect(validateProduct(chair).map((p) => p.code)).toContain("opening.unexpected");
  });

  it("C-050 an unparseable cut-out path warns and the effective path is the rectangle", () => {
    const bad = Product.parse(base({ opening: { cutOutPath: "M0,0 Zzz" } }));
    const problems = validateProduct(bad);
    expect(problems.map((p) => p.code)).toContain("opening.cutOutPath");
    expect(problems.every((p) => p.severity === "warning")).toBe(true);
    expect(bad.opening?.cutOutPath).toBe("M0,0 Zzz"); // never rewritten
    expect(effectiveCutOutPath("M0,0 Zzz")).toBeNull();
    expect(effectiveCutOutPath("M0,0 v1 h1 v-1 z")).toBe("M0,0 v1 h1 v-1 z");
    expect(effectiveCutOutPath("M 0.5 0 A 0.5 0.5 0 0 1 0.5 1 L 0 1 Z")).not.toBeNull();
    expect(validateProduct(Product.parse(base({ opening: { cutOutPath: "M0,0 v1 h1 v-1 z" } })))).toEqual([]);
  });

  it("other shape rules: VESA implies wall mounting; a deep display and missing spec keys warn", () => {
    const display = Product.parse(
      base({
        id: "acme-d75",
        category: "display",
        dims: { w: 1670, d: 400, h: 960 },
        mount: { kinds: ["floor"], vesa: "400x400" },
        opening: null,
      }),
    );
    const codes = validateProduct(display).map((p) => `${p.severity}:${p.code}`);
    expect(codes).toContain("error:mount.vesa");
    expect(codes).toContain("warning:dims.implausible");
    expect(codes).toContain("warning:specs.missing");
  });
});

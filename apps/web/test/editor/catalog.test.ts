// The words the catalog tab uses for a search hit (P3-5).
import { CATEGORIES } from "@fpv/catalog";
import { describe, expect, it } from "vitest";
import {
  CATEGORY_CHOICES,
  type CatalogHit,
  categoryLabel,
  pageOf,
  sizeText,
  trustNote,
} from "../../src/editor/catalog.js";

const hit = (over: Partial<CatalogHit> = {}): CatalogHit => ({
  id: "acme-chair",
  name: "Acme chair",
  make: "Acme",
  model: "C1",
  category: "chair",
  dims: { w: 600, d: 580, h: 1040 },
  verified: true,
  price: null,
  ...over,
});

describe("the catalog tab's words", () => {
  it("offers every category the catalog has, in words", () => {
    expect(CATEGORY_CHOICES.map((c) => c.value)).toEqual([...CATEGORIES]);
    expect(categoryLabel("video-bar")).toBe("Video bar");
    expect(categoryLabel("ceiling-mic")).toBe("Ceiling mic");
  });

  it("writes a size as a drawing does and says it in full", () => {
    expect(sizeText({ w: 1600, d: 800, h: 740 })).toEqual({
      shown: "1 600 × 800 × 740 mm",
      said: "1600 wide, 800 deep, 740 high, in millimetres",
    });
  });

  it("warns only about what cannot be trusted", () => {
    expect(trustNote(hit())).toBeNull();
    expect(trustNote(hit({ verified: false, status: "unverified" }))).toBe("Unverified");
    expect(trustNote(hit({ verified: false, status: "rejected" }))).toBe("Rejected");
    expect(trustNote(hit({ recipe: { kind: "chair" } }))).toBe("Generic");
  });

  it("reads a search answer out of the host's tool reply, and nothing else", () => {
    const reply = { ok: true, result: { hits: [hit()], total: 1, cursor: null }, warnings: [] };
    expect(pageOf(reply)).toEqual({ hits: [hit()], total: 1, cursor: null });
    expect(pageOf({ result: { hits: [], total: 30, cursor: "abc" } })?.cursor).toBe("abc");
    expect(pageOf({ result: { hits: "none" } })).toBeNull();
    expect(pageOf(null)).toBeNull();
  });
});

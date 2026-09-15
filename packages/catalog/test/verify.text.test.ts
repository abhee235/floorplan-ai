import { describe, expect, it } from "vitest";
import {
  canonicalMake,
  findQuantity,
  htmlToText,
  isManufacturerUrl,
  mentionsModel,
  ProductProposal,
  plausibility,
  quantities,
  relevantExcerpt,
  scoreProposal,
  VERIFIED_THRESHOLD,
} from "../src/index.js";

const lengths = (text: string) =>
  quantities(text)
    .filter((q) => q.kind === "length")
    .map((q) => Math.round(q.value * 10) / 10);

describe("page text (ADR-008 D3 step 4)", () => {
  it("strips scripts, styles, comments and tags and decodes entities", () => {
    const text = htmlToText(
      "<html><head><style>.a{}</style><script>var d = '1 x 2 x 3 mm';</script></head><body><!-- 9 x 9 mm --><h1>QM75C&nbsp;75&quot; display</h1><p>Size&#58; 1672&#x2E;2 mm</p></body></html>",
    );
    expect(text).toBe('QM75C 75" display\nSize: 1672.2 mm');
  });

  it("reads runs with one unit, units after each number, bracketed units before or after, and thousands", () => {
    expect(lengths("Set Dimension without Stand (WxHxD) 1672.2 x 962.4 x 45.1 mm")).toEqual([
      1672.2, 962.4, 45.1,
    ]);
    expect(lengths("65.8 x 37.9 x 1.8 inches")).toEqual([1671.3, 962.7, 45.7]);
    expect(lengths("W 1672 mm × H 962 mm")).toEqual([1672, 962]);
    expect(lengths("Dimensions (mm) W x H x D: 1,679.4 x 969.1 x 69.9")).toEqual([1679.4, 969.1, 69.9]);
    expect(lengths("Set 1679 x 969 x 70 (mm)")).toEqual([1679, 969, 70]);
    expect(lengths('Diagonal 75"')).toEqual([1905]);
    expect(lengths("coverage 9 m")).toEqual([9000]);
  });

  it("reads masses in kg and lb, and keeps every number as plain for spec checks", () => {
    const qs = quantities("Weight 32.5 kg (71.6 lbs), power 210 W, 4 channels");
    expect(qs.filter((q) => q.kind === "mass").map((q) => Math.round(q.value * 10) / 10)).toEqual([
      32.5, 32.5,
    ]);
    expect(findQuantity(qs, "plain", 210)).not.toBeNull();
    expect(findQuantity(qs, "plain", 4)).not.toBeNull();
    expect(findQuantity(qs, "length", 210)).toBeNull();
  });

  it("does not take letters after a number as a unit, and never shortens a number glued to a letter", () => {
    expect(lengths("75 most popular")).toEqual([]);
    expect(lengths("210 W")).toEqual([]);
    const glued = quantities("Power consumption typical 230W, 45mm deep");
    expect(findQuantity(glued, "plain", 230, 0)).not.toBeNull();
    expect(findQuantity(glued, "plain", 23, 0)).toBeNull();
    expect(findQuantity(glued, "length", 45)).not.toBeNull();
  });

  it("matches within 2 percent, with half a millimetre of slack for small rounded values", () => {
    const qs = quantities("1672.2 x 962.4 x 45.1 mm");
    expect(findQuantity(qs, "length", 1672)).not.toBeNull();
    expect(findQuantity(qs, "length", 1700)).not.toBeNull(); // 1.66 percent
    expect(findQuantity(qs, "length", 1710)).toBeNull(); // 2.2 percent
    expect(findQuantity(qs, "length", 45)).not.toBeNull();
  });

  it("names a model with separators ignored, and short models only as a whole token", () => {
    expect(mentionsModel("Samsung QM-75C display", "QM75C")).toBe(false); // short key: the dash splits the token
    expect(mentionsModel("Samsung QM75C display", "QM75C")).toBe(true);
    expect(mentionsModel("LG 75UH5J-H series", "75UH5J")).toBe(true);
    expect(mentionsModel("MeetingBar A300", "A30")).toBe(false);
    expect(mentionsModel("MeetingBar A30 video bar", "A30")).toBe(true);
    expect(mentionsModel("Logitech Rally Bar Mini", "Rally Bar")).toBe(true);
    expect(mentionsModel("TeamConnect Ceiling 2", "TeamConnect Ceiling 2")).toBe(true);
  });

  it("excerpts long pages around the model and dimension words", () => {
    const filler = "lorem ipsum ".repeat(3000);
    const page = `${filler} QM75C dimensions 1672 x 962 x 45 mm ${filler}`;
    const excerpt = relevantExcerpt(page, "QM75C", 4000);
    expect(excerpt.length).toBeLessThanOrEqual(4000);
    expect(excerpt).toContain("1672 x 962 x 45 mm");
  });
});

describe("makes and manufacturer pages", () => {
  it("canonicalises make spellings and recognises the manufacturer's domains", () => {
    expect(canonicalMake("samsung electronics")).toBe("Samsung");
    expect(canonicalMake("HP Poly")).toBe("Poly");
    expect(canonicalMake("Acme AV")).toBe("Acme AV");
    expect(isManufacturerUrl("https://www.samsung.com/us/business/displays/qm75c/", "Samsung")).toBe(true);
    expect(isManufacturerUrl("https://images.samsung.com.evil.example/", "Samsung")).toBe(false);
    expect(isManufacturerUrl("https://www.bhphotovideo.com/c/product/samsung-qm75c", "Samsung")).toBe(false);
    expect(isManufacturerUrl("https://www.hp.com/us-en/poly/studio-x52.html", "Polycom")).toBe(true);
    expect(isManufacturerUrl("https://acmeav.com/products/x1", "Acme AV")).toBe(true);
  });
});

describe("scoring (ADR-008 D3 step 5)", () => {
  const page = (url: string, dims = "1672.2 x 962.4 x 45.1 mm") => ({
    url,
    text: `Samsung QM75C 75" 4K display. Resolution 3840 x 2160. Set Dimension without Stand (WxHxD) ${dims}. Weight 32.5 kg. VESA 400 x 400 mm. Typical power 210 W.`,
  });
  const proposal = (over: Record<string, unknown> = {}) =>
    ProductProposal.parse({
      found: true,
      make: "Samsung",
      model: "QM75C",
      name: "Samsung QM75C",
      category: "display",
      dims: { w: 1672, d: 45, h: 962 },
      weightKg: 32.5,
      mount: { kinds: ["wall"], vesa: "400x400" },
      specs: { diagonalIn: 75, resolution: "3840x2160", vesa: "400x400", powerW: 210 },
      ...over,
    });
  const req = { make: "Samsung", model: "QM75C" };

  it("a manufacturer page stating the dimensions verifies with every check recorded", () => {
    const s = scoreProposal(proposal(), [page("https://www.samsung.com/us/business/qm75c/")], req);
    expect(s.status).toBe("verified");
    expect(s.confidence).toBe(0.85);
    expect(s.checks).toMatchObject({
      manufacturerPages: ["https://www.samsung.com/us/business/qm75c/"],
      dimsGroundedIn: ["https://www.samsung.com/us/business/qm75c/"],
      specsGrounded: ["diagonalIn", "resolution", "vesa", "powerW"],
      weightGrounded: true,
      plausible: true,
    });
  });

  it("one third-party page is not enough; two independent hosts agreeing are", () => {
    const one = scoreProposal(proposal(), [page("https://shop-a.example/samsung-qm75c")], req);
    expect(one.status).toBe("unverified");
    expect(one.confidence).toBeLessThan(VERIFIED_THRESHOLD);
    const two = scoreProposal(
      proposal(),
      [page("https://shop-a.example/samsung-qm75c"), page("https://shop-b.example/qm75c")],
      req,
    );
    expect(two.status).toBe("verified");
  });

  it("dimensions a page does not state never verify, whatever else matches", () => {
    const s = scoreProposal(
      proposal({ dims: { w: 1700, d: 60, h: 1000 } }),
      [page("https://www.samsung.com/qm75c")],
      req,
    );
    expect(s.status).toBe("unverified");
    expect(s.grounded.dims).toBe(false);
    expect(s.notes.join(" ")).toContain("not stated on any page");
  });

  it("no page naming the model is a rejection, whatever the proposal claims", () => {
    const s = scoreProposal(proposal({ model: "QX99Z" }), [page("https://www.samsung.com/qm75c")], {
      make: "Samsung",
      model: "QX99Z",
    });
    expect(s).toMatchObject({ status: "rejected", confidence: 0, sources: [] });
  });

  it("a proposal for a different model, or with found false, is not credited", () => {
    const other = scoreProposal(proposal({ model: "QM85C" }), [page("https://www.samsung.com/qm75c")], req);
    expect(other.status).toBe("unverified");
    expect(other.notes[0]).toContain("describes QM85C");
    const notFound = scoreProposal(proposal({ found: false }), [page("https://www.samsung.com/qm75c")], req);
    expect(notFound.status).toBe("unverified");
  });

  it("implausible dimensions cap confidence below the threshold", () => {
    const deep = {
      url: "https://www.samsung.com/qm75c",
      text: "Samsung QM75C dimensions 1672 x 962 x 450 mm",
    };
    const s = scoreProposal(
      proposal({ dims: { w: 1672, d: 450, h: 962 }, specs: {}, weightKg: null }),
      [deep],
      req,
    );
    expect(s.grounded.dims).toBe(true);
    expect(s.checks.plausible).toBe(false);
    expect(s.confidence).toBeLessThanOrEqual(0.4);
    expect(s.status).toBe("unverified");
    expect(plausibility("display", { w: 1672, d: 450, h: 962 }, null).notes[0]).toContain("depth 450 mm");
  });

  it("ungrounded specs and prices are reported and excluded from what may be saved", () => {
    const s = scoreProposal(
      proposal({
        specs: { diagonalIn: 75, powerW: 999 },
        price: { amount: 1299, currency: "USD", sourceUrl: "https://www.samsung.com/qm75c" },
      }),
      [page("https://www.samsung.com/qm75c")],
      req,
    );
    expect(s.checks.specsUngrounded).toEqual(["powerW"]);
    expect(s.grounded.specs).toEqual({ diagonalIn: 75 });
    expect(s.checks.priceGrounded).toBe(false);
    expect(s.grounded.price).toBe(false);
  });
});

// Grounding must not be fooled by numbers that merely happen to be on a page. These cases come from a
// live run: a manufacturer page listing screen-size options (75", 43") and a marketing depth line
// (28.5mm) "stated" 1904 x 29 x 1085 mm one number at a time without stating any dimensions at all.
import { describe, expect, it } from "vitest";
import { dimsStated, ProductProposal, quantities, scoreProposal, specStated } from "../src/index.js";

const SHELL =
  '85-Inch QMC Series Commercial Display | Samsung Business US\nQMC Series 85" Commercial Display\nQM85C / LH85QMCEBGCXGO\n' +
  "Key Features\nSlim Depth\nQMC, slimmest display in Samsung's UHD Digital Signage, ultra-slim 28.5mm depth optimizes space.\n" +
  "Dynamic Crystal Color with over one billion shades.\nPowered by Quantum Processor Lite 4K.\n" +
  "SmartView+ enables wireless screen sharing on your commercial display easy and functional.\n" +
  'Size\n98"\n$6,350.00\n85"\n$4,600.00\n75"\n$3,200.00\n65"\n$1,450.00\n55"\n$1,260.00\n50"\n$1,050.00\n43"\n$830.00\n';

const at = (text: string, dims: { w: number; d: number; h: number }) => dimsStated(quantities(text), dims);

describe("dimensions are grounded as a group", () => {
  it("numbers scattered over a page (size options, a marketing depth) do not state dimensions", () => {
    expect(at(SHELL, { w: 1904, d: 29, h: 1085 })).toBe(false);
  });

  it("a spec line in any common format does", () => {
    expect(
      at("Dimensions (WxDxH) without stand: 190.43 cm x 2.85 cm x 108.53 cm", { w: 1904, d: 29, h: 1085 }),
    ).toBe(true);
    expect(
      at("Set Dimension without Stand (WxHxD) 1904.3 x 1085.3 x 28.5 mm", { w: 1904, d: 29, h: 1085 }),
    ).toBe(true);
    expect(at("Height 164 mm, Width 910 mm, Depth 130.5 mm", { w: 910, d: 131, h: 164 })).toBe(true);
    expect(at('Product size: 75" x 43" x 1.1"', { w: 1905, d: 28, h: 1092 })).toBe(true); // one run of inch marks is fine
  });

  it("each dimension needs its own number: one 600 cannot be both width and depth", () => {
    expect(at("Ceiling array 600 x 600 x 55 mm", { w: 600, d: 600, h: 55 })).toBe(true);
    expect(at("Ceiling array width 600 mm, height 55 mm", { w: 600, d: 600, h: 55 })).toBe(false);
  });

  it("inch marks from separate mentions are not stitched into dimensions even when close together", () => {
    expect(at('Sizes 75" and 43", depth 28.5 mm', { w: 1905, d: 29, h: 1092 })).toBe(false);
  });

  it("the shell page earns no dimension credit in scoring", () => {
    const proposal = ProductProposal.parse({
      found: true,
      make: "Samsung",
      model: "QM85C",
      category: "display",
      dims: { w: 1904, d: 29, h: 1085 },
    });
    const s = scoreProposal(proposal, [{ url: "https://www.samsung.com/us/business/qm85c/", text: SHELL }], {
      make: "Samsung",
      model: "QM85C",
    });
    expect(s.checks.dimsGroundedIn).toEqual([]);
    expect(s.status).toBe("unverified");
  });
});

describe("numeric specs need a nearby keyword or unit", () => {
  const stated = (key: string, value: number | string, text: string) =>
    specStated(key, value, text, quantities(text));

  it("power, channels, field of view, coverage and diagonal", () => {
    expect(stated("powerW", 280, "Power consumption (typical) 280 W")).toBe(true);
    expect(stated("powerW", 280, "Series 280 frames, standby 0.5 W")).toBe(false);
    expect(stated("channels", 8, "8 channels of Dante audio")).toBe(true);
    expect(stated("channels", 8, "Ships in 8 business days")).toBe(false);
    expect(stated("fovDeg", 90, "Field of view 90°")).toBe(true);
    expect(stated("coverageRadiusMm", 4500, "Coverage radius up to 4.5 m")).toBe(true);
    expect(stated("coverageRadiusMm", 4500, "Cable length 4.5 m")).toBe(false);
    expect(stated("diagonalIn", 75, '75" class display')).toBe(true);
    expect(stated("diagonalIn", 75, "75-Inch QMC Series")).toBe(true);
    expect(stated("seats", 10, "Seats 10 people")).toBe(true);
  });

  it("an unknown numeric key falls back to the words of its name", () => {
    expect(stated("brightnessNits", 500, "Brightness 500 nits")).toBe(true);
    expect(stated("brightnessNits", 500, "500 units sold")).toBe(false);
  });

  it("string specs keep matching by letters and digits; booleans are not checkable", () => {
    expect(stated("resolution", "3840x2160", "Resolution 3840 x 2160")).toBe(true);
    expect(specStated("dante", true as never, "Dante", [])).toBeNull();
  });
});

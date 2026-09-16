import { describe, expect, it } from "vitest";
import {
  finishedMaterialKey,
  MATERIAL_COLOURS,
  materialColour,
  materialKeyOf,
  materialRoughness,
  roughnessForShininess,
} from "../src/index.js";

describe("finished material keys (ADR-003 D4)", () => {
  it("keeps the plain key when a surface has no finish of its own", () => {
    expect(finishedMaterialKey("wall-side", null)).toBe("wall-side");
    expect(finishedMaterialKey("wall-side", { color: null, shininess: null })).toBe("wall-side");
  });

  it("carries a colour and a shininess, either one alone", () => {
    expect(finishedMaterialKey("wall-side", { color: "#FF0000", shininess: null })).toBe(
      "wall-side|#FF0000|",
    );
    expect(finishedMaterialKey("wall-side", { color: null, shininess: 0.25 })).toBe("wall-side||0.25");
    expect(finishedMaterialKey("wall-top", { color: "#00FF00", shininess: 0.6 })).toBe(
      "wall-top|#00FF00|0.6",
    );
  });

  it("gives the finish's colour, and the base colour when the finish has none", () => {
    expect(materialColour("wall-side|#FF0000|")).toBe(0xff0000);
    expect(materialColour("wall-side||0.25")).toBe(MATERIAL_COLOURS["wall-side"]);
    // a colour that is not six hex digits is ignored rather than read as black
    expect(materialColour("wall-side|red|")).toBe(MATERIAL_COLOURS["wall-side"]);
  });

  it("turns shininess into roughness, matt by default and glossier as it rises", () => {
    expect(materialRoughness("wall-side")).toBe(0.85);
    expect(materialRoughness("wall-side|#FF0000|")).toBe(0.85);
    expect(roughnessForShininess(0)).toBe(0.85);
    expect(materialRoughness("wall-side||1")).toBeCloseTo(0.15, 10);
    expect(materialRoughness("wall-side||0.25")).toBeLessThan(materialRoughness("wall-side"));
    // out of range is held to the ends, never a roughness above 1 or below 0
    expect(roughnessForShininess(-1)).toBe(0.85);
    expect(roughnessForShininess(3)).toBeCloseTo(0.15, 10);
  });

  it("keeps two finishes apart as two materials", () => {
    expect(materialKeyOf("wall-side|#FF0000|")).not.toBe(materialKeyOf("wall-side|#0000FF|"));
    expect(materialKeyOf("recipe:table:boat:3600x1400x750")).toBe("recipe:table");
  });
});

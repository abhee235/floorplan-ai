import { describe, expect, it } from "vitest";
import {
  finishedMaterialKey,
  MATERIAL_COLOURS,
  materialColour,
  materialKeyOf,
  materialLook,
  materialRoughness,
  roughnessForShininess,
  textureSourceOf,
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

  it("draws glass seen through, smooth and reflective, and its frame solid metal", () => {
    expect(materialLook("wall-glass")).toEqual({
      colour: MATERIAL_COLOURS["wall-glass"],
      roughness: 0.05,
      metalness: 0,
      opacity: 0.3,
      reflective: true,
      texture: null,
      plainColour: MATERIAL_COLOURS["wall-glass"],
    });
    expect(materialLook("wall-glass-frame")).toMatchObject({ opacity: 1, metalness: 0.6, reflective: true });
    expect(materialLook("wall-side")).toMatchObject({ opacity: 1, metalness: 0, reflective: false });
  });

  it("tints painted glass without making it solid, and frosts it with a finish", () => {
    expect(materialLook("wall-glass|#88CC88|")).toMatchObject({
      colour: 0x88cc88,
      opacity: 0.3,
      roughness: 0.05,
    });
    expect(materialLook("wall-glass||0.6").roughness).toBeGreaterThan(materialLook("wall-glass").roughness);
  });
});

describe("textured materials (P3-5)", () => {
  const textures = textureSourceOf({
    textures: {
      "generated/oak": { id: "generated/oak", widthMm: 880, heightMm: 1800 },
      "bad/one": { id: "bad/one" },
    },
  });
  const oak = { color: null, shininess: null, textureId: "generated/oak" };

  it("carries a texture and the size one copy of it covers, after the colour and shininess", () => {
    expect(finishedMaterialKey("floor", oak, textures)).toBe("floor|||generated/oak@880x1800");
    expect(finishedMaterialKey("floor", { ...oak, shininess: 0.25 }, textures)).toBe(
      "floor||0.25|generated/oak@880x1800",
    );
    // a texture whose size is not known, or no source to ask, leaves the texture off
    expect(finishedMaterialKey("floor", { ...oak, textureId: "bad/one" }, textures)).toBe("floor");
    expect(finishedMaterialKey("floor", oak)).toBe("floor");
    expect(textures("generated/nothing")).toBeNull();
  });

  it("draws a textured surface white under its image, and knows its plain colour", () => {
    const look = materialLook("floor|#123456||generated/oak@880x1800");
    expect(look.texture).toEqual({ id: "generated/oak", widthMm: 880, heightMm: 1800 });
    expect(look.colour).toBe(0xffffff);
    expect(look.plainColour).toBe(0x123456);
    expect(materialLook("floor").texture).toBeNull();
    expect(materialLook("floor").plainColour).toBe(MATERIAL_COLOURS.floor);
    expect(materialLook("floor||0.6|generated/oak@880x1800").roughness).toBeLessThan(0.85);
  });
});

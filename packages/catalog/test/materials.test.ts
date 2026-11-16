// The parts a catalogue product can be finished in (spec 02 sections 1 and 3.1).
import { describe, expect, it } from "vitest";
import { productMaterialSlots } from "../src/index.js";

describe("a product's material slots", () => {
  it("are its model's when it has them, else its category's recipe's, else a box's", () => {
    expect(productMaterialSlots({ category: "chair", materialSlots: ["seat", "shell", "base"] })).toEqual([
      "seat",
      "shell",
      "base",
    ]);
    expect(productMaterialSlots({ category: "chair", materialSlots: [] })).toEqual(["fabric", "frame"]);
    expect(productMaterialSlots({ category: "desk" })).toEqual(["top", "legs"]);
    expect(productMaterialSlots({ category: "display" })).toEqual(["screen", "frame"]);
    expect(productMaterialSlots({ category: "plant" })).toEqual(["body"]);
    expect(productMaterialSlots({})).toEqual(["body"]);
  });
});

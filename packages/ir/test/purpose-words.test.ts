// Reading what a model called a room (ADR-022 D2).
//
// The architect's first live run spent six of its sixteen turns being told that "living room" is not
// a purpose. It is the living room. A lookup table costs nothing and saves a round trip each time.
import { describe, expect, it } from "vitest";
import { purposeFromWord, RoomPurpose } from "../src/index.js";

describe("a purpose from whatever was written", () => {
  it("takes a purpose that is already one", () => {
    for (const p of RoomPurpose.options) expect(purposeFromWord(p)).toBe(p);
  });

  it("reads the words the model actually used, whatever the case", () => {
    expect(purposeFromWord("living room")).toBe("living");
    expect(purposeFromWord("Master bedroom")).toBe("bedroom");
    expect(purposeFromWord("Double Bedroom")).toBe("bedroom");
    expect(purposeFromWord("entrance foyer")).toBe("foyer");
    expect(purposeFromWord("bathroom with shower")).toBe("bathroom");
    expect(purposeFromWord("  WC  ")).toBe("toilet");
    expect(purposeFromWord("dining_room")).toBe("dining");
    expect(purposeFromWord("hall-way")).toBe("corridor");
  });

  it("reads an Indian brief's words the way the brief means them", () => {
    expect(purposeFromWord("hall")).toBe("living");
    expect(purposeFromWord("lobby")).toBe("foyer");
  });

  it("takes the room from a numbered or qualified name", () => {
    expect(purposeFromWord("bedroom 1")).toBe("bedroom");
    expect(purposeFromWord("bathroom (family)")).toBe("bathroom");
  });

  it("says nothing rather than guessing at something it does not know", () => {
    expect(purposeFromWord("orangery")).toBeNull();
    expect(purposeFromWord("")).toBeNull();
    expect(purposeFromWord("zzz")).toBeNull();
  });
});

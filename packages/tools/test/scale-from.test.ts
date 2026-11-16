// scaleFrom (ADR-030 D6): a picture's scale from what the model measured, where most measurements agree.
import { describe, expect, it } from "vitest";
import { scaleFrom } from "../src/sandbox/scale.js";

describe("scaleFrom", () => {
  it("finds the scale several things agree on and names the one that does not", () => {
    // Drawn at 20 mm/px: a 900 door is 45 px, a 1400 desk 70, a 500 chair 25. The "door" at 30 px is
    // something else, and alone would say 27 to 33 mm/px.
    const s = scaleFrom([
      { kind: "door", px: 45 },
      { kind: "desk", px: 70 },
      { kind: "chair", px: 25 },
      { kind: "door", px: 30, label: "the narrow door" },
    ]);
    expect(s.mmPerPx).toBeGreaterThanOrEqual(19);
    expect(s.mmPerPx).toBeLessThanOrEqual(21);
    expect(s.outliers.map((o) => o.label)).toEqual(["the narrow door"]);
    expect(s.note).toMatch(/3 of 4 agree/);
  });

  it("takes a size it does not know when it is given, and says when one measurement is all there is", () => {
    const s = scaleFrom([{ label: "parking bay", px: 100, mm: [2400, 2600] }]);
    expect(s.mmPerPx).toBe(25);
    expect(s.note).toMatch(/one measurement only/);
  });

  it("knows things by their everyday names (a live run wrote bed, and its script stopped)", () => {
    const s = scaleFrom([
      { kind: "bed", px: 90 },
      { kind: "Toilet", px: 35 },
      { kind: "door leaf", px: 45 },
    ]);
    expect(s.agree).toHaveLength(3);
  });

  it("says what it needs when a kind is unknown or nothing is given", () => {
    expect(() => scaleFrom([{ kind: "spaceship", px: 10 }])).toThrow(/no known size/);
    expect(() => scaleFrom([])).toThrow(/give what you measured/);
  });
});

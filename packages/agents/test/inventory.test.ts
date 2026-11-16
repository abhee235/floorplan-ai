// A copy is held to what was measured in the picture (ADR-030 D6). Found on 2026-09-24: a run placed 15 of
// 91 pieces of furniture and 1 of 15 openings, said in its answer what was missing, and finished.
import { describe, expect, it } from "vitest";
import { COPY_GATE_FIRINGS, copyReminder, inventoryFrom, inventoryGap } from "../src/index.js";

const built = { walls: 8, doors: 1, windows: 0, passages: 0, rooms: 7, items: 15 };

describe("the inventory a copy is held to", () => {
  it("is read from the notes, whatever else they say", () => {
    expect(
      inventoryFrom("scale 22 mm/px\nINVENTORY walls=9 doors=5 windows=9 rooms=7 items=91\nnext: desks"),
    ).toEqual({
      walls: 9,
      doors: 5,
      windows: 9,
      rooms: 7,
      items: 91,
    });
    expect(inventoryFrom("Inventory: walls: 9, items: 91")).toEqual({ walls: 9, items: 91 });
    expect(inventoryFrom("no count here")).toBeNull();
  });

  it("reads a rough count as a count (a live run wrote items=~50 and was never held to it)", () => {
    expect(inventoryFrom("INVENTORY walls=8 doors=4 items=~50 (approximate)")).toEqual({
      walls: 8,
      doors: 4,
      items: 50,
    });
    expect(inventoryFrom("INVENTORY rooms: about 7, items: ≈90")).toEqual({ rooms: 7, items: 90 });
  });

  it("names every kind that is short, and none that is close enough", () => {
    expect(inventoryGap({ walls: 9, doors: 5, windows: 9, rooms: 7, items: 91 }, built)).toEqual([
      "walls 8 of 9",
      "doors 1 of 5",
      "windows 0 of 9",
      "items 15 of 91",
    ]);
    expect(inventoryGap({ walls: 9 }, { ...built, walls: 9 })).toEqual([]);
  });

  it("asks for the count once, then holds the run to it, then believes the model", () => {
    expect(copyReminder("", built, 0)).toMatch(/INVENTORY walls=N/);
    expect(copyReminder("", built, 1)).toBeNull();
    const notes = "INVENTORY walls=9 doors=5 windows=9 rooms=7 items=91";
    expect(copyReminder(notes, built, 1)).toMatch(/doors 1 of 5.*items 15 of 91/);
    expect(copyReminder(notes, built, COPY_GATE_FIRINGS)).toBeNull();
    expect(
      copyReminder(notes, { walls: 9, doors: 5, windows: 9, passages: 0, rooms: 7, items: 90 }, 1),
    ).toBeNull();
  });
});

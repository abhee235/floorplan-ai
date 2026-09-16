import { describe, expect, it } from "vitest";
import { deleteCommands, kindOf, nextSelection } from "../../src/editor/selection.js";

describe("what an id names", () => {
  it("reads the kind from the prefix", () => {
    expect(kindOf("wall_000002")).toBe("wall");
    expect(kindOf("room_abc123")).toBe("room");
    expect(kindOf("item_zzz999")).toBe("item");
    expect(kindOf("opening_a1b2c3")).toBe("opening");
  });

  it("returns null for a kind the editor does not handle, rather than throwing", () => {
    // A selection can hold a zone or an annotation. Delete must leave those alone, not fall over:
    // an exception on Delete would lose the whole gesture over one entity the UI cannot act on.
    expect(kindOf("zone_000001")).toBeNull();
    expect(kindOf("annot_000001")).toBeNull();
    expect(kindOf("nonsense")).toBeNull();
    expect(kindOf("")).toBeNull();
  });
});

describe("deleting a selection", () => {
  it("emits nothing for an empty selection", () => {
    expect(deleteCommands([])).toEqual([]);
  });

  it("emits one command per kind, since each payload names its own id array", () => {
    const cmds = deleteCommands(["wall_000001", "wall_000002", "room_000001"]);
    expect(cmds).toEqual([
      { type: "room.delete", payload: { roomIds: ["room_000001"] } },
      { type: "wall.delete", payload: { wallIds: ["wall_000001", "wall_000002"] } },
    ]);
  });

  it("deletes openings and rooms before the walls they belong to", () => {
    // Deleting a wall takes its openings with it, so sending wall.delete first would leave the opening
    // command naming an id that no longer exists.
    const cmds = deleteCommands(["wall_000001", "opening_a1b2c3", "item_000001", "room_000001"]);
    expect(cmds.map((c) => c.type)).toEqual(["opening.delete", "item.delete", "room.delete", "wall.delete"]);
  });

  it("skips ids it cannot classify and still deletes the rest", () => {
    const cmds = deleteCommands(["zone_000001", "wall_000001"]);
    expect(cmds).toEqual([{ type: "wall.delete", payload: { wallIds: ["wall_000001"] } }]);
  });
});

describe("what a click selects (F-138, F-140, F-141)", () => {
  it("F-138 a press on bare plan clears the selection", () => {
    expect(nextSelection(["wall_000001", "wall_000002"], null, false)).toEqual([]);
  });

  it("F-138 but shift-clicking nothing leaves the selection alone", () => {
    expect(nextSelection(["wall_000001"], null, true)).toEqual(["wall_000001"]);
  });

  it("F-141 a plain click collapses a multi-selection to the one under the cursor", () => {
    expect(nextSelection(["wall_000001", "wall_000002"], "wall_000002", false)).toEqual(["wall_000002"]);
  });

  it("F-140 shift-click adds, and a second shift-click on the same entity removes", () => {
    const added = nextSelection(["wall_000001"], "wall_000002", true);
    expect(added).toEqual(["wall_000001", "wall_000002"]);
    expect(nextSelection(added, "wall_000002", true)).toEqual(["wall_000001"]);
  });

  it("does not mutate the selection it was given", () => {
    const current = ["wall_000001"];
    nextSelection(current, "wall_000002", true);
    expect(current).toEqual(["wall_000001"]);
  });
});

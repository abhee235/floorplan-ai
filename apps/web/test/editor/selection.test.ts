import { describe, expect, it } from "vitest";
import { deleteCommands, kindOf, moveCommands, nextSelection } from "../../src/editor/selection.js";

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

describe("moving a selection", () => {
  const project = {
    walls: [],
    items: [],
    openings: [],
    rooms: [
      {
        id: "room_000001",
        polygon: [
          { x: 0, y: 0 },
          { x: 1000, y: 0 },
          { x: 1000, y: 800 },
        ],
        holes: [
          [
            { x: 200, y: 200 },
            { x: 400, y: 200 },
            { x: 400, y: 400 },
          ],
        ],
      },
    ],
  } as unknown as Parameters<typeof moveCommands>[0];

  it("emits nothing for a drag that goes nowhere", () => {
    expect(moveCommands(project, ["wall_000001"], 0, 0)).toEqual([]);
    // and nothing for a sub-millimetre drag, which would round to zero anyway
    expect(moveCommands(project, ["wall_000001"], 0.4, -0.4)).toEqual([]);
  });

  it("rounds to whole millimetres, because Mm is an integer", () => {
    const [cmd] = moveCommands(project, ["wall_000001"], 12.6, -4.2);
    expect(cmd).toEqual({ type: "wall.move", payload: { wallIds: ["wall_000001"], dx: 13, dy: -4 } });
  });

  it("moves walls and items as one command each", () => {
    const cmds = moveCommands(project, ["wall_000001", "wall_000002", "item_000001"], 100, 50);
    expect(cmds).toEqual([
      { type: "wall.move", payload: { wallIds: ["wall_000001", "wall_000002"], dx: 100, dy: 50 } },
      { type: "item.move", payload: { itemIds: ["item_000001"], dx: 100, dy: 50 } },
    ]);
  });

  it("translates a room polygon and its holes, since rooms have no move command", () => {
    const [cmd] = moveCommands(project, ["room_000001"], 100, -50);
    expect(cmd?.type).toBe("room.setPolygon");
    expect(cmd?.payload).toEqual({
      roomId: "room_000001",
      polygon: [
        { x: 100, y: -50 },
        { x: 1100, y: -50 },
        { x: 1100, y: 750 },
      ],
      holes: [
        [
          { x: 300, y: 150 },
          { x: 500, y: 150 },
          { x: 500, y: 350 },
        ],
      ],
    });
  });

  it("leaves openings alone: they slide along a wall rather than moving freely", () => {
    expect(moveCommands(project, ["opening_a1b2c3"], 100, 50)).toEqual([]);
  });

  it("skips a room that is not in the project rather than emitting a broken command", () => {
    expect(moveCommands(project, ["room_zzzzzz"], 100, 50)).toEqual([]);
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

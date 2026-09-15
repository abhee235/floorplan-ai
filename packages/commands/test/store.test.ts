import { describe, expect, it } from "vitest";
import { BOX, fixture, LEVEL, store } from "./helpers.js";

describe("history", () => {
  it("F-154 F-161 a command outside a transaction is one entry; a new entry after undo discards redo", () => {
    const s = store();
    s.apply({ type: "wall.move", payload: { wallIds: ["wall_000001"], dx: 0, dy: -100 } });
    expect(s.historyPosition).toBe(1);
    expect(s.modified).toBe(true);
    s.undo();
    expect(s.historyPosition).toBe(0);
    expect(s.project.walls[0]?.start).toEqual({ x: 0, y: 0 });
    expect(s.canRedo).toBe(true);
    s.apply({ type: "wall.move", payload: { wallIds: ["wall_000001"], dx: 0, dy: -50 } });
    expect(s.canRedo).toBe(false);
    expect(s.historyPosition).toBe(1);
  });

  it("W-146 F-155 F-157 F-060 F-158 W-135 undo and redo restore topology, geometry and selection", () => {
    const s = store();
    s.setSelection(["wall_000002"]);
    s.begin("split");
    const r = s.apply({ type: "wall.split", payload: { wallId: "wall_000002", at: 0.5 } });
    expect(r.ok).toBe(true);
    s.setSelection(["wall_000003"]); // the gesture ends by selecting the new wall
    s.commit();
    const before = JSON.stringify(fixture());
    s.undo();
    expect(JSON.stringify(s.project)).toBe(before);
    expect(s.selection).toEqual(["wall_000002"]);
    s.redo();
    expect(s.project.walls).toHaveLength(7);
    expect(s.selection).toEqual(["wall_000003"]);
    expect(s.project.walls.find((w) => w.id === "wall_000001")?.joins.end?.wallId).not.toBe("wall_000002");
  });

  it("F-156 F-159 F-160 F-115 F-146 W-145 a transaction is one entry with a merged change set; escape rolls back with no entry (F-162, W-086)", () => {
    const s = store();
    s.begin("furnish");
    s.apply({ type: "item.place", payload: { levelId: LEVEL, ref: BOX, position: { x: 1000, y: 1000 } } });
    s.apply({ type: "item.place", payload: { levelId: LEVEL, ref: BOX, position: { x: 2000, y: 1000 } } });
    const entry = s.commit();
    expect(entry?.changes.added).toHaveLength(2);
    expect(s.historyPosition).toBe(1);
    s.begin("gesture");
    s.apply({ type: "wall.move", payload: { wallIds: ["wall_000001"], dx: 5, dy: 5 } });
    s.rollback();
    expect(s.project.walls[0]?.start).toEqual({ x: 0, y: 0 });
    expect(s.historyPosition).toBe(1);
    // a transaction with no net change records nothing
    s.begin("noop");
    expect(s.commit()).toBeNull();
    expect(s.historyPosition).toBe(1);
  });

  it("atomic transaction: any failure rolls everything back and reports the failing index", () => {
    const s = store();
    const r = s.transaction("batch", [
      { type: "item.place", payload: { levelId: LEVEL, ref: BOX, position: { x: 1000, y: 1000 } } },
      { type: "opening.add", payload: { wallId: "wall_000001", kind: "window", position: 0.5 } }, // overlaps the door
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failedIndex).toBe(1);
      expect(r.error.code).toBe("opening.overlap");
    }
    expect(s.project.items).toHaveLength(0);
    expect(s.historyPosition).toBe(0);
  });

  it("checkpoint and restore are undoable; markSaved tracks the modified flag", () => {
    const s = store();
    const cp = s.checkpoint("before");
    s.apply({ type: "wall.delete", payload: { wallIds: ["wall_000001"] } });
    expect(s.project.walls).toHaveLength(5);
    s.restore(cp);
    expect(s.project.walls).toHaveLength(6);
    expect(s.historyPosition).toBe(2);
    s.undo();
    expect(s.project.walls).toHaveLength(5);
    s.markSaved();
    expect(s.modified).toBe(false);
    s.redo();
    expect(s.modified).toBe(true);
    expect(s.listCheckpoints()[0]?.label).toBe("before");
  });

  it("events carry the change set and origin; a failed command emits nothing", () => {
    const s = store();
    const events: string[] = [];
    s.subscribe((e) => events.push(`${e.origin}:${e.changes.commandType}`));
    s.apply({ type: "wall.move", payload: { wallIds: ["wall_000001"], dx: 1, dy: 0 } }, "agent");
    s.apply({ type: "wall.move", payload: { wallIds: ["wall_ghost0"], dx: 1, dy: 0 } });
    s.undo();
    expect(events).toEqual(["agent:wall.move", "undo:undo:wall.move"]);
  });

  it("command.payload for an unknown command type", () => {
    const s = store();
    const r = s.apply({ type: "wall.explode", payload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("command.payload");
  });

  it("F-163 add two, delete the first, undo, undo, redo, redo (asserted sequence)", () => {
    const s = store();
    s.apply({ type: "item.place", payload: { levelId: LEVEL, ref: BOX, position: { x: 1000, y: 1000 } } });
    s.apply({ type: "item.place", payload: { levelId: LEVEL, ref: BOX, position: { x: 2000, y: 1000 } } });
    const first = s.project.items[0]?.id as string;
    s.setSelection([first]);
    s.begin("delete");
    s.apply({ type: "item.delete", payload: { itemIds: [first] } });
    s.setSelection([]); // deleting deselects, as the editor gesture does
    s.commit();
    s.undo();
    expect(s.project.items[0]?.id).toBe(first);
    expect(s.selection).toEqual([first]);
    s.undo();
    expect(s.project.items).toHaveLength(1);
    s.redo();
    expect(s.project.items).toHaveLength(2);
    s.redo();
    expect(s.project.items.map((i) => i.id)).not.toContain(first);
    expect(s.selection).toEqual([]);
  });
});

// The rules a copy of a picture is held to (ADR-030 D6): which calls count as changing the project,
// including a change made from inside a run_code script, and which count as comparing it with the picture.
import { describe, expect, it } from "vitest";
import { changesProject, comparesWithPicture, inventingTool } from "../src/agent-runs.js";

const mutating = new Set(["create_walls", "place_item", "run_code", "add_opening"]);

describe("what counts as changing the project", () => {
  it("is a mutating tool called directly", () => {
    expect(changesProject("create_walls", {}, mutating)).toBe(true);
    expect(changesProject("get_scene", {}, mutating)).toBe(false);
  });

  it("is an undo, a redo or a restore, and not a checkpoint or a look at the list", () => {
    const all = new Set([...mutating, "history"]);
    expect(changesProject("history", { op: "checkpoint", label: "before" }, all)).toBe(false);
    expect(changesProject("history", { op: "list" }, all)).toBe(false);
    expect(changesProject("history", { op: "undo" }, all)).toBe(true);
    expect(changesProject("history", { op: "restore", checkpointId: "c1" }, all)).toBe(true);
  });

  it("is a script that calls one, and not a script that only measures", () => {
    expect(changesProject("run_code", { code: 'tools.call("place_item", { x: 1 })' }, mutating)).toBe(true);
    expect(changesProject("run_code", { code: "tools.call(`add_opening`, {})" }, mutating)).toBe(true);
    expect(
      changesProject("run_code", { code: 'var im = image("a1"); tools.call("get_scene", {})' }, mutating),
    ).toBe(false);
    expect(changesProject("run_code", { code: 'tools.call("run_code", {})' }, mutating)).toBe(false);
  });
});

describe("what counts as making things up in a copy", () => {
  it("is the architect or furnish_room, called directly, in a batch, or from a script", () => {
    expect(inventingTool("design_layout", {})).toBe("design_layout");
    expect(inventingTool("batch", { calls: [{ name: "create_room" }, { name: "furnish_room" }] })).toBe(
      "furnish_room",
    );
    expect(inventingTool("run_code", { code: 'tools.call("furnish_room", { roomId: r })' })).toBe(
      "furnish_room",
    );
  });

  it("is not placing what was measured", () => {
    expect(inventingTool("place_item", {})).toBeNull();
    expect(inventingTool("batch", { calls: [{ name: "place_item" }] })).toBeNull();
    expect(inventingTool("run_code", { code: 'tools.call("place_item", {})' })).toBeNull();
  });
});

describe("what counts as comparing the build with the picture", () => {
  const shown = { ok: true, images: [{ pngBase64: "x" }] };
  const overlay = 'var s = project(); show(draw(image("a1"), marks), "what I built")';

  it("is a script that drew over a picture and showed it", () => {
    expect(comparesWithPicture("run_code", { code: overlay }, shown)).toBe(true);
  });

  it("is not a look without a drawing, a script that stopped, or a call that is not a script", () => {
    expect(comparesWithPicture("run_code", { code: 'show(crop(image("a1")))' }, shown)).toBe(false);
    expect(comparesWithPicture("run_code", { code: overlay }, { ok: false, images: [] })).toBe(false);
    expect(comparesWithPicture("preview_design", { code: overlay }, shown)).toBe(false);
  });
});

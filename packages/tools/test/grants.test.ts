// Tool grants (ADR-022 D1a): a role is what it can reach, not what it was asked to do.
//
// The architect must not draw. Its prompt says so, and that is not what makes it true: a prompt is
// kept most of the time, and the time it is not is the run that draws twenty-four walls around
// nothing. The registry refuses the name, and the refusal reads like any other tool error, so the
// model corrects itself rather than failing.
import { describe, expect, it } from "vitest";
import { harness } from "./helpers.js";

const INSPECT = new Set(["get_scene", "describe_room", "measure", "check_design"]);
const L = "level_000000";

describe("what a granted role may reach", () => {
  it("lets through a tool in the set", async () => {
    const h = harness();
    const r = await h.registry.call("get_scene", { detail: "summary" }, { granted: INSPECT });
    expect(r.ok).toBe(true);
  });

  it("refuses one outside it, and says which are left", async () => {
    const h = harness();
    const r = await h.registry.call(
      "create_walls",
      {
        levelId: L,
        points: [
          { x: 0, y: 0 },
          { x: 1000, y: 0 },
        ],
        closed: false,
      },
      { granted: INSPECT },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("tool.not-granted");
      expect(r.error.message).toBe("create_walls is not one of the tools this step may use");
      expect(r.error.hint).toBe("use one of: check_design, describe_room, get_scene, measure");
    }
  });

  it("refuses before the tool runs, so nothing is half done", async () => {
    const h = harness();
    await h.registry.call(
      "create_walls",
      {
        levelId: L,
        points: [
          { x: 0, y: 0 },
          { x: 1000, y: 0 },
        ],
        closed: false,
      },
      { granted: INSPECT },
    );
    expect(h.ctx.store.project.walls).toHaveLength(0);
    expect(h.ctx.store.historyPosition).toBe(0);
  });

  it("leaves a caller with no grant list alone, which is every caller there was before", async () => {
    const h = harness();
    const r = await h.registry.call("create_walls", {
      levelId: L,
      points: [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
      ],
      closed: false,
    });
    expect(r.ok).toBe(true);
  });

  it("records the refusal in the transcript like any other call", async () => {
    const h = harness();
    await h.registry.call("render", { view: "plan" }, { granted: INSPECT });
    const last = h.transcript.entries.at(-1);
    expect(last?.tool).toBe("render");
    expect((last?.result as { ok: boolean }).ok).toBe(false);
  });
});

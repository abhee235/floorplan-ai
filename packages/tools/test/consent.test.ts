// The agent asking before it changes a person's work (ADR-023 D3, D4).
//
// Enforced by the registry rather than by the prompt, because a rule that lives only in a prompt is
// a rule the model keeps most of the time, and "most of the time" is the failure that costs a
// person their trust in the thing. The prompt says it too, so a model that reads it does the right
// thing for the right reason; this is for the model that did not.
import { describe, expect, it } from "vitest";
import { harness } from "./helpers.js";

const L = "level_000000";

/** A wall the agent drew, and one the person then moved: two walls with different stamps. */
async function twoWalls() {
  const h = harness();
  const mine = await h.ok<{ walls: { id: string }[] }>("create_walls", {
    levelId: L,
    points: [
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
    ],
    closed: false,
  });
  const theirs = await h.ok<{ walls: { id: string }[] }>("create_walls", {
    levelId: L,
    points: [
      { x: 0, y: 3000 },
      { x: 4000, y: 3000 },
    ],
    closed: false,
  });
  const id = theirs.result.walls[0]?.id as string;
  // the person nudges it in the editor
  h.ctx.store.apply({ type: "wall.move", payload: { wallIds: [id], dx: 0, dy: 100 } }, "editor");
  return { h, agentWall: mine.result.walls[0]?.id as string, personWall: id };
}

describe("what the agent may change without asking", () => {
  it("changes its own work freely", async () => {
    const { h, agentWall } = await twoWalls();
    const r = await h.call("modify_wall", { wallId: agentWall, thickness: 200 });
    expect(r.ok).toBe(true);
  });

  it("is refused, and undone, when it changes what the person made", async () => {
    const { h, personWall } = await twoWalls();
    const before = JSON.stringify(h.ctx.store.project.walls.find((w) => w.id === personWall));
    const r = await h.call("modify_wall", { wallId: personWall, thickness: 200 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("consent.needed");
      expect(r.error.message).toMatch(new RegExp(`${personWall} was made or changed by the person`));
      expect(r.error.hint).toMatch(/ask_user with kind 'consent'/);
    }
    // the call is taken back, not left half-applied
    expect(JSON.stringify(h.ctx.store.project.walls.find((w) => w.id === personWall))).toBe(before);
  });

  it("may change it once the person has released it", async () => {
    const { h, personWall } = await twoWalls();
    const r = await h.registry.call(
      "modify_wall",
      { wallId: personWall, thickness: 200 },
      { released: new Set([personWall]) },
    );
    expect(r.ok).toBe(true);
    expect(h.ctx.store.project.walls.find((w) => w.id === personWall)?.thickness).toBe(200);
  });

  it("leaves the editor alone: a person's own call is never refused", async () => {
    const { h, personWall } = await twoWalls();
    const r = await h.registry.call(
      "modify_wall",
      { wallId: personWall, thickness: 200 },
      { origin: "editor" },
    );
    expect(r.ok).toBe(true);
  });

  it("is not asked about work nobody did: a wall it moves re-mitres the person's walls beside it", async () => {
    const h = harness();
    const drawn = await h.ok<{ walls: { id: string }[] }>("create_walls", {
      levelId: L,
      points: [
        { x: 0, y: 0 },
        { x: 4000, y: 0 },
        { x: 4000, y: 3000 },
      ],
      closed: false,
    });
    const [first, second] = drawn.result.walls.map((w) => w.id);
    // the person adjusts the second wall, so it is theirs; the first is still the agent's
    h.ctx.store.apply(
      { type: "wall.modify", payload: { wallIds: [second as string], changes: { thickness: 150 } } },
      "editor",
    );
    // moving the agent's own wall updates the join on the person's wall, which nobody chose
    const r = await h.call("modify_wall", { wallId: first as string, thickness: 250 });
    expect(r.ok).toBe(true);
  });

  it("refuses a delete of the person's work as readily as a change", async () => {
    const { h, personWall } = await twoWalls();
    const r = await h.call("delete", { ids: [personWall] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("consent.needed");
    expect(h.ctx.store.project.walls.some((w) => w.id === personWall)).toBe(true);
  });

  it("treats an imported plan as the person's, because they chose it and confirmed its scale", async () => {
    const h = harness();
    const made = await h.ok<{ walls: { id: string }[] }>("create_walls", {
      levelId: L,
      points: [
        { x: 0, y: 0 },
        { x: 4000, y: 0 },
      ],
      closed: false,
    });
    const id = made.result.walls[0]?.id as string;
    // the project is frozen, so the import stamp is put on by loading a copy with it
    const p = h.ctx.store.project;
    h.ctx.store.load({
      ...p,
      walls: p.walls.map((w) =>
        w.id === id ? { ...w, by: { ...w.by, createdBy: "import", touchedByPerson: false } } : w,
      ),
    });
    const r = await h.call("modify_wall", { wallId: id, thickness: 200 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("consent.needed");
  });
});

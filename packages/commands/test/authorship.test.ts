// Who made this (ADR-023 D1, D2): the stamp the command layer writes on everything a command
// touches, so the agent can tell its own work from the person's before it changes anything.
import { addAuthorship, migrate, type Project, SCHEMA_VERSION } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { fixture, LEVEL, store } from "./helpers.js";

const wall = (p: Project, id = "wall_000001") => p.walls.find((w) => w.id === id) as Project["walls"][number];
const at = (p: Project, id: string) =>
  [...p.walls, ...p.rooms, ...p.items, ...p.openings].find((e) => e.id === id) as {
    by: Project["walls"][number]["by"];
  };

describe("the stamp a command writes", () => {
  it("records the agent on what the agent draws, and the person on what the person draws", () => {
    const s = store();
    const drawn = s.apply(
      {
        type: "wall.createChain",
        payload: {
          levelId: LEVEL,
          points: [
            { x: 20000, y: 0 },
            { x: 24000, y: 0 },
          ],
          closed: false,
        },
      },
      "agent",
    );
    expect(drawn.ok).toBe(true);
    const id = ((drawn as { result: { id: string }[] }).result[0] as { id: string }).id;
    expect(at(s.project, id).by).toMatchObject({
      createdBy: "agent",
      editedBy: "agent",
      touchedByPerson: false,
    });

    s.apply({ type: "wall.move", payload: { wallIds: [id], dx: 0, dy: 100 } }, "editor");
    expect(at(s.project, id).by).toMatchObject({
      createdBy: "agent",
      editedBy: "person",
      touchedByPerson: true,
    });
  });

  it("treats everything in a file written before the stamp existed as the person's", () => {
    // the fixture is a migrated version-4 document, which is the common case for a while yet
    const s = store();
    expect(wall(s.project).by).toMatchObject({ createdBy: "unknown", touchedByPerson: true });
    s.apply({ type: "wall.move", payload: { wallIds: ["wall_000001"], dx: 0, dy: -100 } }, "agent");
    expect(wall(s.project).by).toMatchObject({ editedBy: "agent", touchedByPerson: true });
  });

  it("remembers who created a thing after somebody else changes it", () => {
    const s = store();
    const made = s.apply(
      {
        type: "item.place",
        payload: {
          levelId: LEVEL,
          ref: { kind: "recipe", recipe: { kind: "chair", size: { w: 600, d: 600, h: 900 } } },
          position: { x: 1000, y: 1000 },
        },
      },
      "agent",
    );
    expect(made.ok).toBe(true);
    const id = (made as { result: { id: string } }).result.id;
    expect(at(s.project, id).by).toMatchObject({ createdBy: "agent", editedBy: "agent" });

    s.apply({ type: "item.move", payload: { itemIds: [id], dx: 100, dy: 0 } }, "editor");
    expect(at(s.project, id).by).toMatchObject({
      createdBy: "agent",
      editedBy: "person",
      touchedByPerson: true,
    });
  });

  it("never takes back the person's mark: an agent may change their sofa and it stays theirs", () => {
    const s = store();
    s.apply({ type: "wall.move", payload: { wallIds: ["wall_000001"], dx: 0, dy: -100 } }, "editor");
    s.apply({ type: "wall.move", payload: { wallIds: ["wall_000001"], dx: 0, dy: 100 } }, "agent");
    expect(wall(s.project).by).toMatchObject({ editedBy: "agent", touchedByPerson: true });
  });

  it("gives the stamp back on undo, because the patches carry it", () => {
    const s = store();
    s.apply({ type: "wall.move", payload: { wallIds: ["wall_000001"], dx: 0, dy: -100 } }, "editor");
    const after = wall(s.project).by;
    expect(after.touchedByPerson).toBe(true);
    s.apply({ type: "wall.move", payload: { wallIds: ["wall_000001"], dx: 0, dy: 50 } }, "agent");
    s.undo();
    expect(wall(s.project).by).toEqual(after);
  });

  it("does not make an author of undo, redo or restore", () => {
    const s = store();
    s.apply({ type: "wall.move", payload: { wallIds: ["wall_000001"], dx: 0, dy: -100 } }, "agent");
    s.undo();
    s.redo();
    expect(wall(s.project).by.editedBy).toBe("agent");
  });

  it("refuses a payload that tries to write its own stamp", () => {
    const s = store();
    const r = s.apply(
      {
        type: "wall.modify",
        payload: {
          wallIds: ["wall_000001"],
          changes: {
            thickness: 150,
            by: {
              createdBy: "person",
              editedBy: "person",
              editedAt: "2026-01-01T00:00:00.000Z",
              touchedByPerson: true,
            },
          },
        },
      },
      "agent",
    );
    // the field is not in the payload schema, so it is dropped or refused; either way the stamp is ours
    if (r.ok) expect(wall(s.project).by.editedBy).toBe("agent");
    else expect(r.error.code).toBe("command.payload");
  });

  it("times the edit by the store's clock, so a replay gives the same document", () => {
    const s = store();
    s.apply({ type: "wall.move", payload: { wallIds: ["wall_000001"], dx: 0, dy: -100 } }, "agent");
    expect(wall(s.project).by.editedAt).toBe("2026-09-15T00:00:00.000Z");
  });
});

describe("what a file written before any of this says", () => {
  it("marks everything as the person's, because nobody knows and only one mistake is recoverable", () => {
    const v4 = {
      schemaVersion: 4,
      meta: { createdAt: "2026-01-02T03:04:05.000Z" },
      walls: [{ id: "wall_000001" }],
      rooms: [{ id: "room_000001" }],
      items: [
        {
          id: "item_000001",
          by: { createdBy: "agent", editedBy: "agent", editedAt: "x", touchedByPerson: false },
        },
      ],
    };
    const out = addAuthorship(v4) as typeof v4;
    expect(out.walls[0]).toEqual({
      id: "wall_000001",
      by: {
        createdBy: "unknown",
        editedBy: "unknown",
        editedAt: "2026-01-02T03:04:05.000Z",
        touchedByPerson: true,
      },
    });
    // one that already has a stamp is left as it is
    expect(out.items[0]?.by.createdBy).toBe("agent");
  });

  it("runs in the ordinary chain and leaves a document the schema accepts", () => {
    const old = JSON.parse(JSON.stringify(fixture())) as Record<string, unknown> & { schemaVersion: number };
    old.schemaVersion = 4;
    for (const key of ["levels", "walls", "openings", "rooms", "items", "zones", "annotations"])
      old[key] = (old[key] as { by?: unknown }[]).map(({ by, ...rest }) => rest);
    const { raw, migrated } = migrate(old);
    expect(migrated).toBe(true);
    expect(raw.schemaVersion).toBe(SCHEMA_VERSION);
    const parsed = (raw.walls as { by: { touchedByPerson: boolean } }[])[0];
    expect(parsed?.by.touchedByPerson).toBe(true);
  });
});

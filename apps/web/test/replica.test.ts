import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChangeSet, SnapshotMsg } from "@fpv/commands";
import { Project, type Project as ProjectT } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { Replica } from "../src/replica.js";

const fixtureDir = fileURLToPath(new URL("../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const fixture = (): ProjectT => Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));

/** A replica holding the fixture, as if the host had just sent its snapshot. */
function seeded(): { replica: Replica; project: ProjectT } {
  const project = fixture();
  const replica = new Replica();
  const snapshot: SnapshotMsg = {
    type: "snapshot",
    seq: 7,
    project,
    historyPosition: 3,
    savedPosition: 0,
  };
  replica.applySnapshot(snapshot);
  return { replica, project };
}

function firstWall(p: ProjectT) {
  const w = p.walls[0];
  if (!w) throw new Error("the fixture should have walls");
  return w;
}

/** A project with one wall bent, as a local edit would produce. */
function bent(p: ProjectT, arcExtent: number): ProjectT {
  const wall = firstWall(p);
  return { ...p, walls: p.walls.map((w) => (w.id === wall.id ? { ...w, arcExtent } : w)) };
}

describe("replica", () => {
  it("takes a locally edited project and reports what changed", () => {
    const { replica, project } = seeded();
    const wall = firstWall(project);
    const seen: ChangeSet[] = [];
    replica.subscribe(({ changes }) => seen.push(changes));

    replica.applyLocally(bent(project, 90), {
      commandType: "local.reshape",
      added: [],
      updated: [{ type: "wall", id: wall.id }],
      removed: [],
    });

    expect(replica.project?.walls.find((w) => w.id === wall.id)?.arcExtent).toBe(90);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.updated).toEqual([{ type: "wall", id: wall.id }]);
    expect(seen[0]?.added).toEqual([]);
    expect(seen[0]?.removed).toEqual([]);
  });

  it("leaves seq alone, so the host's next patch is still the one expected", () => {
    const { replica, project } = seeded();
    const before = replica.seq;

    replica.applyLocally(bent(project, 45), {
      commandType: "local.reshape",
      added: [],
      updated: [{ type: "wall", id: firstWall(project).id }],
      removed: [],
    });

    // The sequence counts the HOST's messages. Moving it here would make the next real patch look like a
    // gap, and the client would throw the session away and ask for a fresh snapshot.
    expect(replica.seq).toBe(before);
    expect(replica.historyPosition).toBe(3);
  });

  it("does not mutate the project object it replaces", () => {
    const { replica, project } = seeded();
    const wall = firstWall(project);
    const held = replica.project;

    replica.applyLocally(bent(project, 120), {
      commandType: "local.reshape",
      added: [],
      updated: [{ type: "wall", id: wall.id }],
      removed: [],
    });

    // immer applies the host's patches against whatever object is held; editing the previous one in
    // place would change a structure the next patch still expects to find as it was.
    expect(replica.project).not.toBe(held);
    expect(held?.walls.find((w) => w.id === wall.id)?.arcExtent).toBe(wall.arcExtent);
  });

  it("passes a whole project and its change set straight through", () => {
    const { replica, project } = seeded();
    const seen: ChangeSet[] = [];
    replica.subscribe(({ changes }) => seen.push(changes));

    const moved = { ...project, walls: project.walls.map((w) => ({ ...w, levelId: w.levelId })) };
    // A move drags joined neighbours along, so the change set names entities the caller never asked
    // about. It has to arrive at the renderers exactly as the reducer produced it, or a corner tears.
    const changes: ChangeSet = {
      commandType: "local.move",
      added: [],
      updated: [
        { type: "wall", id: "wall_000001" },
        { type: "wall", id: "wall_000002" },
      ],
      removed: [],
    };
    replica.applyLocally(moved, changes);

    expect(replica.project).toBe(moved);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.updated).toHaveLength(2);
    expect(replica.seq).toBe(7);
  });
});

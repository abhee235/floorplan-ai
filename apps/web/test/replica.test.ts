import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChangeSet, SnapshotMsg } from "@fpv/commands";
import { defaultWall, Project, type Project as ProjectT } from "@fpv/ir";
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

describe("replica", () => {
  it("replaces a wall locally and reports it as updated", () => {
    const { replica, project } = seeded();
    const wall = firstWall(project);
    const seen: ChangeSet[] = [];
    replica.subscribe(({ changes }) => seen.push(changes));

    replica.replaceWallLocally({ ...wall, arcExtent: 90 });

    expect(replica.project?.walls.find((w) => w.id === wall.id)?.arcExtent).toBe(90);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.updated).toEqual([{ type: "wall", id: wall.id }]);
    expect(seen[0]?.added).toEqual([]);
    expect(seen[0]?.removed).toEqual([]);
  });

  it("leaves seq alone, so the host's next patch is still the one expected", () => {
    const { replica, project } = seeded();
    const before = replica.seq;

    replica.replaceWallLocally({ ...firstWall(project), arcExtent: 45 });

    // The sequence counts the HOST's messages. Moving it here would make the next real patch look like a
    // gap, and the client would throw the session away and ask for a fresh snapshot.
    expect(replica.seq).toBe(before);
    expect(replica.historyPosition).toBe(3);
  });

  it("does not mutate the project object it replaces", () => {
    const { replica, project } = seeded();
    const wall = firstWall(project);
    const held = replica.project;

    replica.replaceWallLocally({ ...wall, arcExtent: 120 });

    // immer applies the host's patches against whatever object is held; editing the previous one in
    // place would change a structure the next patch still expects to find as it was.
    expect(replica.project).not.toBe(held);
    expect(held?.walls.find((w) => w.id === wall.id)?.arcExtent).toBe(wall.arcExtent);
  });

  it("ignores a wall the project does not have", () => {
    const { replica, project } = seeded();
    const seen: ChangeSet[] = [];
    replica.subscribe(({ changes }) => seen.push(changes));

    const stranger = defaultWall("wall_zzzzzz", firstWall(project).levelId, { x: 0, y: 0 }, { x: 100, y: 0 });
    replica.replaceWallLocally(stranger);

    expect(replica.project?.walls).toHaveLength(project.walls.length);
    expect(seen).toHaveLength(0);
  });
});

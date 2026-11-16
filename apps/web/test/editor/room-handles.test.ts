// Editing a room's corners: the rules, with no canvas involved.
//
// A room drawn from a plan read is usually nearly right. Before this, nearly right meant deleting it —
// and its name, purpose, capacity and every item assigned to it — and drawing it again.
import { apply, type Ctx } from "@fpv/commands";
import { type Project, type Room, sequentialIdGenerator } from "@fpv/ir";
import { blankProject } from "@fpv/tools";
import { describe, expect, it } from "vitest";
import {
  addCornerCommands,
  aimCorner,
  cornerMarginMm,
  crossed,
  describeCorner,
  edgeMidpoints,
  MIN_CORNERS,
  moveCornerCommand,
  removable,
  removeCornerCommand,
  roomHandleAt,
  snapCandidates,
  withCornerAt,
} from "../../src/editor/room-handles.js";

const NOW = "2026-09-19T10:00:00.000Z";
const LEVEL = "level_000000";
// ONE generator for the file: a fresh one restarts at the same id and the store refuses the duplicate.
const ids = sequentialIdGenerator(1);
const ctx = (): Ctx => ({ ids, now: () => NOW });

/** A 4 m by 3 m room, corners anticlockwise from the origin. */
function aRoom(): { project: Project; room: Room } {
  const r = apply(
    blankProject("Test", NOW, "testproject0"),
    {
      type: "room.create",
      payload: {
        levelId: LEVEL,
        polygon: [
          { x: 0, y: 0 },
          { x: 4000, y: 0 },
          { x: 4000, y: 3000 },
          { x: 0, y: 3000 },
        ],
        name: "Boardroom",
      },
    },
    ctx(),
  );
  if (!r.ok) throw new Error(r.error.message);
  return { project: r.project, room: r.project.rooms[0] as Room };
}

const aim = (over: Partial<Parameters<typeof aimCorner>[3]> = {}) => ({
  magnetism: true,
  pixelMm: 1,
  walls: [],
  ...over,
});

describe("what is under the pointer", () => {
  it("finds the corner pressed, and the middle of an edge", () => {
    const { room } = aRoom();
    expect(roomHandleAt(room, { x: 4002, y: 3 }, 12)).toEqual({ kind: "corner", index: 1 });
    // the middle of the first edge, which runs from (0,0) to (4000,0)
    expect(roomHandleAt(room, { x: 2000, y: 4 }, 12)).toEqual({
      kind: "edge",
      index: 0,
      at: { x: 2000, y: 0 },
    });
  });

  it("prefers a corner to an edge dot when both are in reach", () => {
    // a room with one very short edge, where the corner and the edge's middle nearly coincide
    const { room } = aRoom();
    const short: Room = { ...room, polygon: [...room.polygon, { x: 20, y: 3000 }] };
    const near = roomHandleAt(short, { x: 10, y: 3000 }, 40);
    expect(near?.kind).toBe("corner");
  });

  it("finds nothing away from the outline, and reaches further for a fingertip", () => {
    const { room } = aRoom();
    expect(roomHandleAt(room, { x: 2000, y: 1500 }, 12)).toBeNull();
    expect(cornerMarginMm(1, true)).toBe(cornerMarginMm(1) * 3);
    // the margin shrinks in plan millimetres as the plan zooms in, which keeps it constant on screen
    expect(cornerMarginMm(2)).toBeLessThan(cornerMarginMm(1));
  });

  it("gives the middle of every edge, including the one that closes the ring", () => {
    const { room } = aRoom();
    const mids = edgeMidpoints(room);
    expect(mids).toHaveLength(4);
    expect(mids[3]).toEqual({ x: 0, y: 1500 });
  });
});

describe("where a dragged corner lands", () => {
  it("catches another corner of the same room, but never the one being dragged", () => {
    const { room } = aRoom();
    const candidates = snapCandidates(room, 0, []);
    expect(candidates).not.toContainEqual({ x: 0, y: 0 });
    expect(candidates).toContainEqual({ x: 4000, y: 3000 });
    const got = aimCorner({ x: 3998, y: 2998 }, room, 0, aim({ pixelMm: 2 }));
    expect(got.point).toEqual({ x: 4000, y: 3000 });
    expect(got.note).toBe("corner");
  });

  it("catches the end of a wall, because a room is drawn against a structure", () => {
    const { project, room } = aRoom();
    const w = apply(
      project,
      {
        type: "wall.create",
        payload: { levelId: LEVEL, start: { x: 5000, y: 5000 }, end: { x: 7000, y: 5000 } },
      },
      ctx(),
    );
    if (!w.ok) throw new Error(w.error.message);
    const got = aimCorner({ x: 4998, y: 5002 }, room, 2, aim({ walls: w.project.walls, pixelMm: 2 }));
    expect(got.point).toEqual({ x: 5000, y: 5000 });
  });

  it("aligns each axis on its own with a nearby corner, and says what it lined up with", () => {
    const { room } = aRoom();
    // near the x of corner 1 (4000) but nowhere near any corner's y
    const got = aimCorner({ x: 4002, y: 1500 }, room, 2, aim({ pixelMm: 2 }));
    expect(got.point.x).toBe(4000);
    expect(got.point.y).toBe(1500);
    expect(got.note).toBe("aligned");
    expect(got.guides).toHaveLength(1);
    expect(got.guides[0]?.to).toEqual({ x: 4000, y: 0 });
  });

  it("leaves the point where it is when Alt is held, and rounds to whole millimetres", () => {
    const { room } = aRoom();
    const got = aimCorner({ x: 3998.4, y: 2998.6 }, room, 0, aim({ altHeld: true, pixelMm: 2 }));
    expect(got.point).toEqual({ x: 3998, y: 2999 });
    expect(got.note).toBe("");
    // and the same with magnetism switched off in the options bar
    expect(aimCorner({ x: 3998, y: 2998 }, room, 0, aim({ magnetism: false })).point).toEqual({
      x: 3998,
      y: 2998,
    });
  });
});

describe("what a gesture commits", () => {
  it("moves one corner by index", () => {
    expect(moveCornerCommand("room_000001", 2, { x: 100, y: 200 })).toEqual({
      type: "room.movePoint",
      payload: { roomId: "room_000001", index: 2, point: { x: 100, y: 200 } },
    });
  });

  it("adds a corner on an edge and moves it where the drag ended, as one pair", () => {
    const { project, room } = aRoom();
    const mid = edgeMidpoints(room)[0] as { x: number; y: number };
    const commands = addCornerCommands(room.id, 0, mid, { x: 2000, y: -500 });
    expect(commands.map((c) => c.type)).toEqual(["room.addPoint", "room.movePoint"]);

    // the predicted index is the one the reducer actually gives the new corner, which is the whole
    // reason the pair can be a single transaction
    let p = project;
    for (const c of commands) {
      const r = apply(p, c, ctx());
      if (!r.ok) throw new Error(r.error.message);
      p = r.project;
    }
    const after = p.rooms[0] as Room;
    expect(after.polygon).toHaveLength(5);
    expect(after.polygon[1]).toEqual({ x: 2000, y: -500 });
  });

  it("adds without a move when the dot was pressed and not dragged", () => {
    const { room } = aRoom();
    const mid = edgeMidpoints(room)[0] as { x: number; y: number };
    expect(addCornerCommands(room.id, 0, mid, mid)).toHaveLength(1);
  });

  it("removes a corner, but not the third: a room needs three", () => {
    const { project, room } = aRoom();
    expect(removable(room)).toBe(true);
    const r = apply(project, removeCornerCommand(room.id, 1), ctx());
    if (!r.ok) throw new Error(r.error.message);
    const three = r.project.rooms[0] as Room;
    expect(three.polygon).toHaveLength(MIN_CORNERS);
    expect(removable(three)).toBe(false);
    // and the model refuses it too, so the guard above is a message and not the rule itself
    const refused = apply(r.project, removeCornerCommand(room.id, 1), ctx());
    expect(refused.ok).toBe(false);
  });
});

describe("a shape that is no longer a room", () => {
  it("notices an outline that crosses itself, without refusing the drag", () => {
    const { room } = aRoom();
    // pulling corner 1 across to where corner 3 is makes a bowtie
    const bad = withCornerAt(room, 1, { x: -1000, y: 3000 });
    expect(crossed(bad)).toBe(true);
    expect(crossed(room.polygon)).toBe(false);
    // the command is still the one it would have been: the drag reports, it does not block
    expect(moveCornerCommand(room.id, 1, { x: -1000, y: 3000 }).type).toBe("room.movePoint");
  });

  it("says where the corner is, what it caught and whether the shape is broken", () => {
    const { room } = aRoom();
    const aimed = aimCorner({ x: 4002, y: 1500 }, room, 2, aim({ pixelMm: 2 }));
    const said = describeCorner(2, 4, aimed, true);
    expect(said).toContain("Corner 3 of 4");
    expect(said).toContain("4000, 1500 mm");
    expect(said).toContain("aligned");
    expect(said).toContain("crosses itself");
  });
});

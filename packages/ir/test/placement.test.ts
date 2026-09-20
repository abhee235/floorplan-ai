// Three checks a drawing has to pass that it did not have to before, each one a thing a real run got
// wrong: a room drawn over open floor, a wardrobe standing across the door it is beside, and a bed
// with nothing behind its head.
//
// All three are warnings, not errors, because the command layer refuses a command that introduces an
// error and a person dragging their own furniture must not be refused. The agent's checker is what
// treats them as blocking (ADR-022 D3).
import { describe, expect, it } from "vitest";
import {
  defaultItem,
  defaultOpening,
  defaultRoom,
  defaultWall,
  type Project,
  type Room,
  validate,
  type Wall,
} from "../src/index.js";
import { fixture, LEVEL } from "./helpers.js";

const codes = (p: Project, only?: string) =>
  validate(p)
    .map((x) => x.code)
    .filter((c) => !only || c === only);
const find = (p: Project, code: string) => validate(p).find((x) => x.code === code);

/** A blank project with one level, and whatever walls, rooms and items a test adds. */
function empty(): Project {
  const p = fixture();
  return { ...p, walls: [], openings: [], rooms: [], items: [] };
}

let seq = 0;
const id = (kind: string) => `${kind}_${(seq += 1).toString(36).padStart(6, "0")}`;

function wall(from: { x: number; y: number }, to: { x: number; y: number }, thickness = 100): Wall {
  return defaultWall(id("wall"), LEVEL, from, to, { thickness });
}

/** Four walls round a rectangle, their centrelines half a thickness outside the room's polygon. */
function box(x: number, y: number, w: number, d: number, t = 100): Wall[] {
  const h = t / 2;
  const c = [
    { x: x - h, y: y - h },
    { x: x + w + h, y: y - h },
    { x: x + w + h, y: y + d + h },
    { x: x - h, y: y + d + h },
  ];
  return [
    wall(c[0] as never, c[1] as never, t),
    wall(c[1] as never, c[2] as never, t),
    wall(c[2] as never, c[3] as never, t),
    wall(c[3] as never, c[0] as never, t),
  ];
}

function room(x: number, y: number, w: number, d: number, over: Partial<Room> = {}): Room {
  return defaultRoom(
    id("room"),
    LEVEL,
    [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + d },
      { x, y: y + d },
    ],
    over,
  );
}

describe("a room has to be fenced in", () => {
  it("says nothing about a room with a wall along every side", () => {
    const p = empty();
    p.walls = box(0, 0, 4000, 3000);
    p.rooms = [room(0, 0, 4000, 3000)];
    expect(codes(p, "room.unenclosed")).toEqual([]);
  });

  it("reports the side with no wall along it, and where it runs", () => {
    const p = empty();
    p.walls = box(0, 0, 4000, 3000).slice(0, 3); // no west wall
    p.rooms = [room(0, 0, 4000, 3000)];
    const problem = find(p, "room.unenclosed");
    expect(problem?.severity).toBe("warning");
    expect(problem?.message).toMatch(/one side has no wall along it: 3000 mm/);
    expect(problem?.message).toMatch(/\(0, 3000\) to \(0, 0\)/);
  });

  it("counts a long wall shared with the room next door", () => {
    // one 12 m wall divides a floor; three rooms sit along it and each is bounded by part of it
    const p = empty();
    const long = wall({ x: -50, y: 3050 }, { x: 12050, y: 3050 });
    p.walls = [
      long,
      wall({ x: -50, y: -50 }, { x: 12050, y: -50 }),
      wall({ x: -50, y: -50 }, { x: -50, y: 3050 }),
      wall({ x: 4050, y: -50 }, { x: 4050, y: 3050 }),
      wall({ x: 8050, y: -50 }, { x: 8050, y: 3050 }),
      wall({ x: 12050, y: -50 }, { x: 12050, y: 3050 }),
    ];
    p.rooms = [room(0, 0, 4000, 3000), room(4100, 0, 3900, 3000), room(8100, 0, 3900, 3000)];
    expect(codes(p, "room.unenclosed")).toEqual([]);
  });

  it("ignores a gap shorter than a door", () => {
    const p = empty();
    const walls = box(0, 0, 4000, 3000);
    // shorten the west wall by 400 mm at one end
    const west = walls[3] as Wall;
    p.walls = [...walls.slice(0, 3), { ...west, end: { x: west.end.x, y: west.end.y + 400 } }];
    p.rooms = [room(0, 0, 4000, 3000)];
    expect(codes(p, "room.unenclosed")).toEqual([]);
  });
});

describe("nothing stands in a doorway", () => {
  const withDoor = () => {
    const p = empty();
    p.walls = box(0, 0, 4000, 3000);
    p.rooms = [room(0, 0, 4000, 3000)];
    const south = p.walls[0] as Wall;
    p.openings = [defaultOpening(id("opening"), LEVEL, south.id, "door", { position: 0.5, width: 900 })];
    return p;
  };

  it("reports a wardrobe across the door, with how much of it is covered", () => {
    const p = withDoor();
    p.items = [
      defaultItem(
        id("item"),
        LEVEL,
        { kind: "recipe", recipe: { kind: "box", size: { w: 1800, d: 600, h: 2100 }, label: "Wardrobe" } },
        { x: 2000, y: 300 },
        { rotation: 180 },
      ),
    ];
    const problem = find(p, "item.blocks-opening");
    expect(problem?.severity).toBe("warning");
    expect(problem?.message).toMatch(/stands across 900 mm of door/);
    expect(problem?.hint).toBe("keep the doorway clear");
  });

  it("says nothing about one standing clear of the doorway", () => {
    const p = withDoor();
    // the door covers 1550 to 2450; a 1200 chest centred at 3300 covers 2700 to 3900
    p.items = [
      defaultItem(
        id("item"),
        LEVEL,
        { kind: "recipe", recipe: { kind: "box", size: { w: 1200, d: 600, h: 900 }, label: "Chest" } },
        { x: 3300, y: 300 },
        { rotation: 180 },
      ),
    ];
    expect(codes(p, "item.blocks-opening")).toEqual([]);
  });

  it("says nothing about something standing across the room from the door", () => {
    const p = withDoor();
    p.items = [
      defaultItem(
        id("item"),
        LEVEL,
        { kind: "recipe", recipe: { kind: "table", size: { w: 1800, d: 900, h: 740 }, shape: "rect" } },
        { x: 2000, y: 2000 },
      ),
    ];
    expect(codes(p, "item.blocks-opening")).toEqual([]);
  });

  it("says nothing about a bed under a window, which is where a bed goes", () => {
    const p = withDoor();
    const north = p.walls[2] as Wall;
    p.openings = [
      defaultOpening(id("opening"), LEVEL, north.id, "window", { position: 0.5, width: 1200, sill: 900 }),
    ];
    p.items = [
      defaultItem(
        id("item"),
        LEVEL,
        { kind: "recipe", recipe: { kind: "bed", size: { w: 1350, d: 2000, h: 900 } } },
        { x: 2000, y: 2000 },
      ),
    ];
    expect(codes(p, "item.blocks-opening")).toEqual([]);
  });

  it("reports a wardrobe across a window, which is taller than the sill", () => {
    const p = withDoor();
    const north = p.walls[2] as Wall;
    p.openings = [
      defaultOpening(id("opening"), LEVEL, north.id, "window", { position: 0.5, width: 1200, sill: 900 }),
    ];
    p.items = [
      defaultItem(
        id("item"),
        LEVEL,
        { kind: "recipe", recipe: { kind: "box", size: { w: 1800, d: 600, h: 2100 }, label: "Wardrobe" } },
        { x: 2000, y: 2650 },
      ),
    ];
    expect(find(p, "item.blocks-opening")?.hint).toBe("leave the window reachable");
  });

  it("leaves a bath under a window alone, which is where baths are", () => {
    const p = withDoor();
    const north = p.walls[2] as Wall;
    p.openings = [
      defaultOpening(id("opening"), LEVEL, north.id, "window", { position: 0.5, width: 1200, sill: 900 }),
    ];
    p.items = [
      defaultItem(
        id("item"),
        LEVEL,
        { kind: "recipe", recipe: { kind: "box", size: { w: 1700, d: 750, h: 550 }, label: "Bath" } },
        { x: 2000, y: 2650 },
      ),
    ];
    expect(codes(p, "item.blocks-opening")).toEqual([]);
  });
});

describe("a bed has its back to a wall", () => {
  const bedroom = () => {
    const p = empty();
    p.walls = box(0, 0, 4000, 4000);
    p.rooms = [room(0, 0, 4000, 4000, { purpose: "bedroom" })];
    return p;
  };
  const bed = (x: number, y: number, rotation: number) =>
    defaultItem(
      id("item"),
      LEVEL,
      { kind: "recipe", recipe: { kind: "bed", size: { w: 1500, d: 2000, h: 900 } } },
      { x, y },
      { rotation },
    );

  it("says nothing when the headboard is against the north wall", () => {
    const p = bedroom();
    // rotation 0 faces south, so the back (local +y) is to the north
    p.items = [bed(2000, 3000, 0)];
    expect(codes(p, "item.needs-wall")).toEqual([]);
  });

  it("reports a bed adrift in the middle of the room", () => {
    const p = bedroom();
    p.items = [bed(2000, 2000, 0)];
    expect(find(p, "item.needs-wall")?.message).toMatch(
      /a bed belongs with its back to a wall; the nearest is 1000 mm away/,
    );
  });

  it("reports a bed against the wall the wrong way round", () => {
    const p = bedroom();
    // at the north wall but facing north, so its head is out in the room
    p.items = [bed(2000, 3000, 180)];
    expect(find(p, "item.needs-wall")?.message).toMatch(/the nearest is 2000 mm away/);
  });

  it("leaves a chair and a table alone, which have no back to put anywhere", () => {
    const p = bedroom();
    p.items = [
      defaultItem(
        id("item"),
        LEVEL,
        { kind: "recipe", recipe: { kind: "table", size: { w: 1200, d: 800, h: 740 }, shape: "rect" } },
        { x: 2000, y: 2000 },
      ),
      defaultItem(
        id("item"),
        LEVEL,
        { kind: "recipe", recipe: { kind: "chair", size: { w: 600, d: 600, h: 900 } } },
        { x: 2000, y: 1200 },
      ),
    ];
    expect(codes(p, "item.needs-wall")).toEqual([]);
  });
});

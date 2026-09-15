import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultWall, Project, poly, type Wall } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { detectEnclosures, detectRoomAt, wallFootprints } from "../src/index.js";

const fixtureDir = fileURLToPath(new URL("../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const project = Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));
const expected = JSON.parse(readFileSync(`${fixtureDir}expected.json`, "utf8")) as {
  detectedRoomPolygonWithoutThreshold: { x: number; y: number }[];
  detectedRoomAreaMm2WithoutThreshold: number;
  detectedRoomAreaMm2WithThreshold: number;
  thresholdNotch: { fromX: number; toX: number; toY: number };
};

const L = "level_000000";
const mk = (id: string, sx: number, sy: number, ex: number, ey: number, t = 100) =>
  defaultWall(id, L, { x: sx, y: sy }, { x: ex, y: ey }, { thickness: t });
function chain(points: [number, number][], closed: boolean, t = 100): Wall[] {
  const walls: Wall[] = [];
  const n = closed ? points.length : points.length - 1;
  for (let i = 0; i < n; i += 1) {
    const [sx, sy] = points[i] as [number, number];
    const [ex, ey] = points[(i + 1) % points.length] as [number, number];
    walls.push(mk(`wall_${String(i + 1).padStart(6, "0")}`, sx, sy, ex, ey, t));
  }
  for (let i = 0; i < walls.length; i += 1) {
    const a = walls[i] as Wall;
    const b = walls[(i + 1) % walls.length] as Wall;
    if (i === walls.length - 1 && !closed) break;
    a.joins.end = { wallId: b.id, end: "start" };
    b.joins.start = { wallId: a.id, end: "end" };
  }
  return walls;
}

function sameRing(a: { x: number; y: number }[], b: { x: number; y: number }[]): boolean {
  if (a.length !== b.length) return false;
  const n = a.length;
  for (let offset = 0; offset < n; offset += 1) {
    let ok = true;
    for (let i = 0; i < n; i += 1) {
      const p = a[(i + offset) % n] as { x: number; y: number };
      const q = b[i] as { x: number; y: number };
      if (Math.abs(p.x - q.x) > 0.5 || Math.abs(p.y - q.y) > 0.5) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

describe("fixture room", () => {
  it("R-131 R-021 R-022 R-027 R-028 the six-wall room is detected with the expected polygon and area", () => {
    const enclosures = detectEnclosures(project.walls);
    expect(enclosures).toHaveLength(1);
    const ring = enclosures[0]?.polygon as { x: number; y: number }[];
    expect(sameRing(ring, expected.detectedRoomPolygonWithoutThreshold)).toBe(true);
    expect(poly.area(ring)).toBeCloseTo(expected.detectedRoomAreaMm2WithoutThreshold, 0);
  });

  it("R-032 R-033 R-034 R-035 R-036 R-037 R-038 R-039 O-100 the door threshold extends the room to the wall centreline (thresholds come from bound openings)", () => {
    const room = detectRoomAt(project.walls, project.openings, { x: 2000, y: 2000 });
    expect(room).not.toBeNull();
    expect(room?.wallIds.sort()).toEqual(project.walls.map((w) => w.id).sort());
    expect(room?.area).toBeCloseTo(expected.detectedRoomAreaMm2WithThreshold, 0);
    // the notch reaches y = 0 between x 3550 and 4450
    const notchPoints = (room?.polygon ?? []).filter(
      (p) => Math.abs(p.y - expected.thresholdNotch.toY) < 0.5,
    );
    const xs = notchPoints.map((p) => p.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(expected.thresholdNotch.fromX, 1);
    expect(xs[xs.length - 1]).toBeCloseTo(expected.thresholdNotch.toX, 1);
  });

  it("R-025 a point outside every enclosure returns null", () => {
    expect(detectRoomAt(project.walls, project.openings, { x: 9000, y: 9000 })).toBeNull();
    expect(detectRoomAt(project.walls, project.openings, { x: 7000, y: 4500 })).toBeNull(); // inside the notch, outside the L
  });
});

describe("detection rules", () => {
  it("R-024 a small gap is closed by the tolerance, a large gap is not (reversed)", () => {
    const walls = chain(
      [
        [0, 0],
        [4000, 0],
        [4000, 3000],
        [0, 3000],
      ],
      true,
    );
    // open a 15 mm gap at the last corner by shortening the last wall and dropping its end join
    const last = walls[3] as Wall;
    last.end = { x: 0, y: 65 }; // 15 mm short of wall 1's top face at y = 50
    last.joins.end = null;
    (walls[0] as Wall).joins.start = null;
    expect(detectEnclosures(walls, { gap: 20 })).toHaveLength(1);
    expect(detectEnclosures(walls, { gap: 0 })).toHaveLength(0);
    last.end = { x: 0, y: 200 }; // 150 mm gap
    expect(detectEnclosures(walls, { gap: 20 })).toHaveLength(0);
  });

  it("R-026 R-149 nested enclosures: the smallest containing enclosure wins", () => {
    const outer = chain(
      [
        [0, 0],
        [10000, 0],
        [10000, 10000],
        [0, 10000],
      ],
      true,
    );
    const inner = chain(
      [
        [3000, 3000],
        [5000, 3000],
        [5000, 5000],
        [3000, 5000],
      ],
      true,
    ).map((w) => ({
      ...w,
      id: w.id.replace("wall_0", "wall_9"),
      joins: {
        start: w.joins.start && {
          ...w.joins.start,
          wallId: w.joins.start.wallId.replace("wall_0", "wall_9"),
        },
        end: w.joins.end && { ...w.joins.end, wallId: w.joins.end.wallId.replace("wall_0", "wall_9") },
      },
    }));
    const walls = [...outer, ...inner];
    const enclosures = detectEnclosures(walls);
    expect(enclosures).toHaveLength(2);
    const room = detectRoomAt(walls, [], { x: 4000, y: 4000 });
    expect(room?.area).toBeCloseTo(1900 * 1900, 0);
    const big = detectRoomAt(walls, [], { x: 1000, y: 1000 });
    expect(big?.area).toBeGreaterThan(1900 * 1900);
  });

  it("R-027 R-030 rooms sharing a wall stop at its faces; a zero-thickness wall cannot split (schema forbids it, so a 1 mm wall is the floor)", () => {
    const walls = chain(
      [
        [0, 0],
        [8000, 0],
        [8000, 4000],
        [0, 4000],
      ],
      true,
    );
    const divider = mk("wall_000099", 4000, 0, 4000, 4000, 100);
    const rooms = detectEnclosures([...walls, divider]);
    expect(rooms).toHaveLength(2);
    const areas = rooms.map((r) => r.area).sort();
    expect(areas[0]).toBeCloseTo(3900 * 3900, 0);
  });

  it("R-031 W-127 arc walls contribute their flattened outline", () => {
    const walls = chain(
      [
        [0, 0],
        [4000, 0],
        [4000, 3000],
        [0, 3000],
      ],
      true,
    );
    (walls[1] as Wall).arcExtent = -90; // negative extent bulges to the right of a +y chord: outward
    const rooms = detectEnclosures(walls);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.polygon.length).toBeGreaterThan(6);
    expect(rooms[0]?.area).toBeGreaterThan(3900 * 2900);
  });

  it("O-101 a door wider than its wall segment inside the ring is skipped", () => {
    const walls = chain(
      [
        [0, 0],
        [1000, 0],
        [1000, 1000],
        [0, 1000],
      ],
      true,
    );
    const wide = {
      ...project.openings[0],
      id: "opening_000009",
      wallId: "wall_000001",
      width: 1500,
      position: 0.5,
    } as (typeof project.openings)[number];
    const before = detectRoomAt(walls, [], { x: 500, y: 500 })?.area;
    const after = detectRoomAt(walls, [wide], { x: 500, y: 500 })?.area;
    expect(after).toBeCloseTo(before as number, 0);
  });

  it("footprints can be reused across calls", () => {
    const fps = wallFootprints(project.walls);
    expect(detectEnclosures(project.walls, { footprints: fps })).toHaveLength(1);
  });
});

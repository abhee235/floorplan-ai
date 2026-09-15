// Spec 05 section 8, PRD P2-6: the ground slab under the lowest level, with visible floors cut out (R-089..R-100
// simplified; R-092..R-096 and R-099 omitted: no underground terraces, digging furniture or images in 3D).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { derive, Project, type Room } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import {
  buildGround,
  type GeometryPart,
  GROUND_DEPTH_MM,
  GROUND_MARGIN_MM,
  partArea,
  partBounds,
} from "../src/index.js";

const DIR = fileURLToPath(new URL("../../../tools/fixtures/boardroom.fpviz/", import.meta.url));
const project = Project.parse(JSON.parse(readFileSync(`${DIR}project.json`, "utf8")));
const room = project.rooms[0] as Room;

const rectArea = (r: { minX: number; minY: number; maxX: number; maxY: number }) =>
  (r.maxX - r.minX) * (r.maxY - r.minY);
const sides = (r: { minX: number; minY: number; maxX: number; maxY: number }) =>
  2 * (r.maxX - r.minX + (r.maxY - r.minY)) * GROUND_DEPTH_MM;

describe("ground slab (PRD P2-6)", () => {
  it("R-089 R-090 R-097 the slab spans the project bounds plus the margin at the lowest level's elevation", () => {
    const g = buildGround(project);
    const b = derive.projectBounds(project) as NonNullable<ReturnType<typeof derive.projectBounds>>;
    expect(g.rect).toEqual({
      minX: b.minX - GROUND_MARGIN_MM,
      minY: b.minY - GROUND_MARGIN_MM,
      maxX: b.maxX + GROUND_MARGIN_MM,
      maxY: b.maxY + GROUND_MARGIN_MM,
    });
    const pb = partBounds(g.part as GeometryPart);
    expect(pb.max[1]).toBeCloseTo(0, 6);
    expect(pb.min[1]).toBeCloseTo(-GROUND_DEPTH_MM / 1000, 6);
    expect(g.part?.entityId).toBe("ground");
    // nothing to bound: a 10 m square; a sunken lowest level carries the ground down with it
    const empty = buildGround({ ...project, walls: [], openings: [], rooms: [], items: [] });
    expect(empty.rect).toEqual({ minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 });
    const sunk = buildGround({ ...project, levels: project.levels.map((l) => ({ ...l, elevation: -3000 })) });
    expect(sunk.elevation).toBe(-3000);
    expect(partBounds(sunk.part as GeometryPart).max[1]).toBeCloseTo(-3, 6);
  });

  it("R-091 R-095 visible floors on the lowest level are holes in the ground; hidden floors and hidden levels are not", () => {
    const g = buildGround(project);
    const roomArea = derive.roomArea(room);
    expect(partArea(g.part as GeometryPart)).toBeCloseTo(
      (rectArea(g.rect) - roomArea + sides(g.rect)) / 1e6,
      2,
    );
    const hiddenFloor = buildGround({ ...project, rooms: [{ ...room, floorVisible: false }] });
    expect(partArea(hiddenFloor.part as GeometryPart)).toBeCloseTo(
      (rectArea(g.rect) + sides(g.rect)) / 1e6,
      2,
    );
    const hiddenLevel = buildGround({
      ...project,
      levels: project.levels.map((l) => ({ ...l, viewable: false })),
    });
    expect(partArea(hiddenLevel.part as GeometryPart)).toBeCloseTo(
      (rectArea(g.rect) + sides(g.rect)) / 1e6,
      2,
    );
  });

  it("R-098 top UVs are plan metres", () => {
    const part = buildGround(project).part as GeometryPart;
    let checked = 0;
    for (let i = 0; i < part.positions.length / 3; i += 1) {
      if (part.normals[i * 3 + 1] !== 1) continue;
      expect(part.uvs[i * 2]).toBeCloseTo(part.positions[i * 3] as number, 4);
      expect(part.uvs[i * 2 + 1]).toBeCloseTo(-(part.positions[i * 3 + 2] as number), 4);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(4);
  });

  it("R-100 a room with no area carves nothing", () => {
    const sliver = {
      ...room,
      polygon: [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 2000, y: 0 },
      ],
    };
    const g = buildGround({ ...project, rooms: [sliver] });
    expect(partArea(g.part as GeometryPart)).toBeCloseTo((rectArea(g.rect) + sides(g.rect)) / 1e6, 2);
  });
});

// The plan as shapes (ADR-013 D5, PRD P3-7): what the editor's plan and the layout drawing both draw.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { multiArea, ringToMulti } from "@fpv/geometry";
import { derive, type Point, Project, type Project as ProjectT, poly } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import {
  clipToShape,
  hatchLines,
  planBounds,
  planItems,
  planStructure,
  planZones,
  shapeTriangles,
  withoutGaps,
  zoneLabel,
} from "../src/index.js";

const fixture = (name: string): ProjectT =>
  Project.parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../../../tools/fixtures/${name}.fpviz/project.json`, import.meta.url)),
        "utf8",
      ),
    ),
  );
const L = "level_000000";

describe("plan shapes (ADR-013 D5)", () => {
  it("gives the boardroom's room, one fused wall cut, the door's gap and its quarter swing", () => {
    const p = fixture("boardroom");
    const s = planStructure(p, p.levels[0]?.id ?? L);
    expect(s.rooms).toHaveLength(1);
    const room = p.rooms[0];
    expect(s.rooms[0]).toMatchObject({ id: room?.id, name: "Boardroom" });
    expect(s.rooms[0]?.areaM2).toBeCloseTo(derive.roomArea(room as never) / 1e6, 6);
    // four walls of one kind and pattern fuse into a single ring with the room as its hole
    expect(s.walls).toHaveLength(1);
    expect(s.walls[0]?.shape).toHaveLength(1);
    expect(s.walls[0]?.shape[0]?.holes).toHaveLength(1);
    expect(s.openings).toHaveLength(1);
    const door = s.openings[0];
    expect(door?.gap).toHaveLength(4);
    expect(door?.glazing).toBeNull();
    expect(Math.abs(door?.swing?.sweep ?? 0)).toBeCloseTo(Math.PI / 2, 9);
    expect(door?.swing?.radius).toBe(p.openings[0]?.width);
  });

  it("gives a window its glass along the wall, a third of the wall thick, and no swing", () => {
    const p = fixture("six-wall-room");
    const o = p.openings[0] as { kind: string; swing: unknown };
    o.kind = "window";
    o.swing = null;
    const w = p.walls.find((x) => x.id === p.openings[0]?.wallId);
    const s = planStructure(p, L);
    expect(s.openings[0]?.swing).toBeNull();
    expect(s.openings[0]?.glazing?.widthMm).toBeCloseTo((w?.thickness ?? 0) / 3, 9);
  });

  it("gives each item its footprint, front edge, title and the height a fitter mounts it at", () => {
    const p = fixture("boardroom");
    const sizes = derive.snapshotSizeSource(p);
    const shapes = planItems(p, L, sizes);
    expect(shapes).toHaveLength(p.items.filter((i) => i.visible).length);
    const level = p.levels[0];
    for (const it of p.items) {
      const shape = shapes.find((s) => s.id === it.id);
      const size = derive.itemSize(it, sizes);
      expect(shape?.footprint).toEqual(derive.itemFootprint(it, size as never));
      expect(shape?.front).toEqual([shape?.footprint[2], shape?.footprint[3]]);
      if (it.mount.kind === "wall") expect(shape?.mountHeight).toBe(it.elevation + (size?.h ?? 0) / 2);
      else if (it.mount.kind === "ceiling")
        expect(shape?.mountHeight).toBe(p.rooms[0]?.ceilingHeight ?? level?.height);
      else expect(shape?.mountHeight).toBeNull();
    }
    // a product is called by its name up to the first comma
    const product = shapes.find((s) => p.items.find((i) => i.id === s.id)?.ref.kind === "product");
    expect(product?.title).not.toContain(",");
    expect(product?.title.length).toBeGreaterThan(2);
  });

  it("names a zone after itself, else what it lays out, with how many stand in it", () => {
    const p = fixture("boardroom");
    const base = {
      levelId: L,
      polygon: [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 1000, y: 800 },
      ],
      kind: "desk-cluster" as const,
      properties: {},
      by: p.walls[0]?.by as never,
    };
    p.zones.push(
      {
        ...base,
        id: "zone_aaaaaa",
        name: "Bench A",
        rule: null,
        generatedItemIds: [p.items[0]?.id as string],
      },
      {
        ...base,
        id: "zone_bbbbbb",
        name: null,
        generatedItemIds: [],
        rule: {
          pattern: "grid",
          productId: null,
          recipe: { kind: "desk", size: { w: 1400, d: 700, h: 740 } } as never,
          count: 1,
          spacing: { x: 0, y: 0 },
          facing: 0,
          margin: 0,
        },
      },
    );
    const zones = planZones(p, L);
    expect(zones.map((z) => z.label)).toEqual(["Bench A · 1", "Desk"]);
    expect(zones[0]?.labelAt).toEqual({ x: 0, y: 800 });
    expect(zoneLabel(p.zones[1] as never)).toBe("Desk cluster");
  });

  it("bounds everything drawn on a level, and nothing on an empty one", () => {
    const p = fixture("boardroom");
    const b = planBounds(planStructure(p, L), planItems(p, L, derive.snapshotSizeSource(p)), []);
    expect(b?.maxX).toBeGreaterThan(b?.minX ?? 0);
    expect(planBounds({ rooms: [], walls: [], skirting: [], openings: [] }, [], [])).toBeNull();
  });
});

describe("drawing helpers for formats that cannot clip or paint white (ADR-013 D5)", () => {
  it("lays hatch lines the given distance apart, anchored to the plan", () => {
    const box = { minX: 3, minY: 7, maxX: 503, maxY: 207 };
    const lines = hatchLines(box, 50, 1);
    // y = x + c: lines 50 apart have intercepts 50√2 apart, all on multiples of it
    const cs = lines.map(([a]) => a.y - a.x);
    for (let i = 1; i < cs.length; i += 1)
      expect((cs[i] as number) - (cs[i - 1] as number)).toBeCloseTo(50 * Math.SQRT2, 9);
    expect(((cs[0] as number) / (50 * Math.SQRT2)) % 1).toBeCloseTo(0, 9);
    expect(hatchLines(box, 50, -1).every(([a, b]) => b.y - a.y < 0)).toBe(true);
  });

  it("keeps only the parts of a segment inside a shape, holes counted out", () => {
    const outer: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const hole: Point[] = [
      { x: 40, y: 40 },
      { x: 60, y: 40 },
      { x: 60, y: 60 },
      { x: 40, y: 60 },
    ];
    const pieces = clipToShape({ x: -20, y: 50 }, { x: 120, y: 50 }, [{ outer, holes: [hole] }]);
    expect(pieces.map(([a, b]) => [Math.round(a.x), Math.round(b.x)])).toEqual([
      [0, 40],
      [60, 100],
    ]);
    expect(clipToShape({ x: -20, y: 150 }, { x: 120, y: 150 }, [{ outer, holes: [] }])).toEqual([]);
  });

  it("takes a door's gap out of its wall, and fills what is left with triangles of the same area", () => {
    const p = fixture("boardroom");
    const s = planStructure(p, L);
    const cut = s.walls[0]?.shape ?? [];
    const broken = withoutGaps(
      cut,
      s.openings.map((o) => o.gap),
    );
    const wallArea = multiArea(cut);
    const gapInWall = wallArea - multiArea(broken);
    const door = p.openings[0];
    const wall = p.walls.find((w) => w.id === door?.wallId);
    // the gap is two millimetres wider than the wall each side, so what it takes is the opening through the wall
    expect(gapInWall).toBeCloseTo((door?.width ?? 0) * (wall?.thickness ?? 0), -2);
    const triangles = shapeTriangles(broken);
    const area = triangles.reduce((sum, t) => sum + Math.abs(poly.signedArea(t)), 0);
    expect(area).toBeCloseTo(multiArea(broken), 0);
    expect(withoutGaps(cut, [])).toBe(cut);
    expect(multiArea(ringToMulti(s.openings[0]?.gap ?? []))).toBeGreaterThan(0);
  });
});

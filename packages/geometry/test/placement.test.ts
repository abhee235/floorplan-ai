import {
  defaultItem,
  defaultLevel,
  defaultOpening,
  defaultWall,
  derive,
  type Item,
  type Project,
  poly,
  SCHEMA_VERSION,
  type Size3,
  type Wall,
} from "@fpv/ir";
import { describe, expect, it } from "vitest";
import {
  alignedDragPoint,
  anchorsStartEdge,
  constrainToWall,
  DragSession,
  doorSwingZones,
  footprintAt,
  freeRunsAlongEdge,
  magnetizedLength,
  magnetizedSize,
  type PlacementOptions,
  placeItem,
  type Subject,
  wallFootprints,
} from "../src/index.js";

const L = "level_000000";
const NOW = "2026-09-15T12:00:00.000Z";

function project(over: Partial<Project> = {}): Project {
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      id: "geometrytst1",
      name: "t",
      createdAt: NOW,
      updatedAt: NOW,
      currency: "USD",
      north: 90,
      units: "mm",
    },
    levels: [defaultLevel(L, { name: "G", height: 2700, elevation: 0 })],
    walls: [],
    openings: [],
    rooms: [],
    items: [],
    zones: [],
    annotations: [],
    catalogRefs: {},
    textures: {},
    provenance: null,
    properties: {},
    ...over,
  };
}

const ctx = (p: Project) => ({ project: p, sizes: derive.snapshotSizeSource(p) });
const subject = (over: Partial<Subject> = {}): Subject => ({
  id: null,
  levelId: L,
  position: { x: 0, y: 0 },
  rotation: 0,
  elevation: 0,
  size: { w: 600, d: 400, h: 500 },
  mountKind: "floor",
  parentId: null,
  ...over,
});
const DROP: PlacementOptions = {
  forceOrientation: true,
  adjustElevation: true,
  adjustOnlyNullElevation: false,
};
const DRAG: PlacementOptions = {
  forceOrientation: false,
  adjustElevation: true,
  adjustOnlyNullElevation: true,
};
const FLAT: PlacementOptions = {
  forceOrientation: true,
  adjustElevation: false,
  adjustOnlyNullElevation: false,
};

const wall = (id: string, x1: number, y1: number, x2: number, y2: number, over: Partial<Wall> = {}) =>
  defaultWall(id, L, { x: x1, y: y1 }, { x: x2, y: y2 }, { thickness: 100, ...over });
const table = (
  id: string,
  x: number,
  y: number,
  size: Size3 = { w: 1200, d: 800, h: 740 },
  over: Partial<Item> = {},
) => defaultItem(id, L, { kind: "recipe", recipe: { kind: "table", size, shape: "rect" } }, { x, y }, over);
const book = (id: string, x: number, y: number, elevation: number) =>
  defaultItem(
    id,
    L,
    { kind: "recipe", recipe: { kind: "box", size: { w: 300, d: 200, h: 40 }, label: "book" } },
    { x, y },
    { elevation },
  );
const chair = (
  id: string,
  x: number,
  y: number,
  size: Size3 = { w: 600, d: 400, h: 900 },
  over: Partial<Item> = {},
) => defaultItem(id, L, { kind: "recipe", recipe: { kind: "chair", size } }, { x, y }, over);

const south = () => project({ walls: [wall("wall_s", 0, 0, 4000, 0)] });

describe("stage 2: against a wall (F-082..F-090)", () => {
  it("F-075 F-085 a drop turns the back to the nearer face and stops at it, on either side", () => {
    const inside = placeItem(subject({ position: { x: 2000, y: 280 } }), ctx(south()), DROP);
    expect(inside).toMatchObject({ position: { x: 2000, y: 250 }, rotation: 180, wallId: "wall_s" });
    const outside = placeItem(subject({ position: { x: 2000, y: -280 } }), ctx(south()), DROP);
    expect(outside).toMatchObject({ position: { x: 2000, y: -250 }, rotation: 0, wallId: "wall_s" });
  });

  it("F-082 F-083 (reversed) the wall is found within 40 mm of the footprint, or by containing the position; beyond that nothing snaps", () => {
    expect(placeItem(subject({ position: { x: 2000, y: 280 } }), ctx(south()), DROP).wallId).toBe("wall_s");
    const far = placeItem(subject({ position: { x: 2000, y: 300 } }), ctx(south()), DROP);
    expect(far).toMatchObject({ position: { x: 2000, y: 300 }, rotation: 0, wallId: null });
    const onCentreline = placeItem(subject({ position: { x: 2000, y: 30 } }), ctx(south()), DROP);
    expect(onCentreline).toMatchObject({ position: { x: 2000, y: 250 }, wallId: "wall_s" });
  });

  it("F-084 skirting on that side counts only for an item on the floor", () => {
    const skirted = project({
      walls: [
        wall("wall_s", 0, 0, 4000, 0, {
          skirting: {
            left: { thickness: 20, height: 100, color: null },
            right: { thickness: 20, height: 100, color: null },
          },
        }),
      ],
    });
    expect(placeItem(subject({ position: { x: 2000, y: 280 } }), ctx(skirted), DROP).position.y).toBe(270);
    expect(
      placeItem(subject({ position: { x: 2000, y: 280 }, elevation: 100 }), ctx(skirted), FLAT).position.y,
    ).toBe(250);
  });

  it("F-086 an edge-anchored item extends the same way whichever direction the wall was drawn", () => {
    const opts = { ...DROP, alignEdgeToPosition: true };
    const drawnEast = placeItem(subject({ position: { x: 2000, y: 280 } }), ctx(south()), opts);
    const drawnWest = placeItem(
      subject({ position: { x: 2000, y: 280 } }),
      ctx(project({ walls: [wall("wall_w", 4000, 0, 0, 0)] })),
      opts,
    );
    expect(drawnEast.position.x).toBe(2300);
    expect(drawnWest.position.x).toBe(2300);
    const up = placeItem(
      subject({ position: { x: 280, y: 2000 } }),
      ctx(project({ walls: [wall("wall_u", 0, 0, 0, 4000)] })),
      opts,
    );
    const down = placeItem(
      subject({ position: { x: 280, y: 2000 } }),
      ctx(project({ walls: [wall("wall_d", 0, 4000, 0, 0)] })),
      opts,
    );
    expect(up.position.y).toBe(2300);
    expect(down.position.y).toBe(2300);
  });

  it("F-087 (reversed) the edge branch boundary is exact and symmetric, with no epsilon added on one side", () => {
    expect(anchorsStartEdge(0)).toBe(true);
    expect(anchorsStartEdge(90)).toBe(true);
    expect(anchorsStartEdge(-90)).toBe(false);
    expect(anchorsStartEdge(180)).toBe(false);
    expect(anchorsStartEdge(-90 + 1e-7)).toBe(true);
    expect(anchorsStartEdge(270 - 1e-7)).toBe(false);
  });

  it("F-088 an item overlapping a second wall slides clear along the first; straddling two non-parallel walls it stays", () => {
    const alcove = project({ walls: [wall("wall_s", 0, 0, 4000, 0), wall("wall_2", 3000, 0, 3000, 1000)] });
    const wide = { w: 2000, d: 400, h: 500 };
    const slid = placeItem(subject({ position: { x: 2000, y: 260 }, size: wide }), ctx(alcove), DROP);
    expect(slid).toMatchObject({ wallId: "wall_s", position: { x: 1950, y: 250 } });
    const fp = footprintAt(slid.position, slid.rotation, wide);
    expect(Math.max(...fp.map((q) => q.x))).toBe(2950);
    const two = project({ walls: [...alcove.walls, wall("wall_3", 1000, 0, 500, 1000)] });
    const stayed = placeItem(subject({ position: { x: 2000, y: 260 }, size: wide }), ctx(two), DROP);
    expect(stayed.position.x).toBe(2000);
  });

  it("F-089 an item entirely inside a wall is not snapped and is reported", () => {
    const thick = project({ walls: [wall("wall_s", 0, 0, 4000, 0, { thickness: 400 })] });
    const r = placeItem(
      subject({ position: { x: 2000, y: 0 }, size: { w: 50, d: 50, h: 50 } }),
      ctx(thick),
      DROP,
    );
    expect(r.position).toEqual({ x: 2000, y: 0 });
    expect(r.warnings.map((w) => w.code)).toEqual(["item.in-wall"]);
  });

  it("F-090 against a round wall the item turns to the tangent at the nearest point", () => {
    const arcWall = wall("wall_a", 0, 0, 4000, 0, { arcExtent: 90 });
    const p = project({ walls: [arcWall] });
    const arc = derive.arcParams(arcWall);
    if (!arc) throw new Error("not an arc");
    const mid = { x: 2000, y: 0 };
    const len = Math.hypot(mid.x - arc.centre.x, mid.y - arc.centre.y);
    const radial = { x: (mid.x - arc.centre.x) / len, y: (mid.y - arc.centre.y) / len };
    // on the centre side of the arc, 250 mm in from the centreline at the apex
    const apex = { x: arc.centre.x + radial.x * arc.radius, y: arc.centre.y + radial.y * arc.radius };
    const start = { x: apex.x - radial.x * 250, y: apex.y - radial.y * 250 };
    const r = placeItem(subject({ position: start }), ctx(p), DROP);
    expect(r.wallId).toBe("wall_a");
    const tangent = Math.atan2(radial.x, -radial.y);
    const localX = (r.rotation * Math.PI) / 180;
    expect(Math.abs(Math.sin(localX - tangent))).toBeLessThan(0.001);
  });
});

describe("stage 1: onto a surface (F-062..F-069)", () => {
  it("F-063 all four corners must lie on the surface within 5 percent of the item's smaller side", () => {
    const p = project({ items: [table("item_table", 0, 0)] });
    const on = placeItem(subject({ size: { w: 400, d: 300, h: 100 } }), ctx(p), DROP);
    expect(on).toMatchObject({ elevation: 740, parentId: "item_table", surfaceId: "item_table" });
    // table edge at x = 600; margin 15 mm
    expect(
      placeItem(subject({ position: { x: 410, y: 0 }, size: { w: 400, d: 300, h: 100 } }), ctx(p), DROP)
        .elevation,
    ).toBe(740);
    expect(
      placeItem(subject({ position: { x: 430, y: 0 }, size: { w: 400, d: 300, h: 100 } }), ctx(p), DROP)
        .elevation,
    ).toBe(0);
  });

  it("F-064 the highest surface wins: a book on the table", () => {
    const p = project({ items: [table("item_table", 0, 0), book("item_book", 0, 0, 740)] });
    const r = placeItem(subject({ size: { w: 200, d: 150, h: 50 } }), ctx(p), DROP);
    expect(r).toMatchObject({ elevation: 780, parentId: "item_book" });
  });

  it("F-065 a surface on another level counts relative to the item's level", () => {
    const L1 = "level_000001";
    const p = project({
      levels: [
        defaultLevel(L, { name: "G", height: 2700, elevation: 0 }),
        defaultLevel(L1, { name: "Mezzanine", height: 2700, elevation: 500, index: 1 }),
      ],
      items: [table("item_table", 0, 0)],
    });
    const r = placeItem(subject({ levelId: L1, size: { w: 400, d: 300, h: 100 } }), ctx(p), DROP);
    expect(r.elevation).toBe(240);
  });

  it("F-062 the drop ratio is a fraction of the height; null means nothing stacks there", () => {
    const shelf = defaultItem("item_shelf", L, { kind: "product", productId: "shelf" }, { x: 0, y: 0 });
    const p = project({
      items: [shelf, chair("item_chair", 3000, 3000)],
      catalogRefs: {
        shelf: {
          id: "shelf",
          snapshotAt: NOW,
          dims: { w: 800, d: 400, h: 1000 },
          mountPoints: [{ name: "top", kind: "surface", dropRatio: 0.5, offset: null }],
        },
      } as Project["catalogRefs"],
    });
    expect(placeItem(subject({ size: { w: 300, d: 200, h: 100 } }), ctx(p), DROP).elevation).toBe(500);
    expect(
      placeItem(subject({ position: { x: 3000, y: 3000 }, size: { w: 300, d: 200, h: 100 } }), ctx(p), DROP)
        .elevation,
    ).toBe(0);
  });

  it("F-066 while moving, only an item at elevation 0 is lifted", () => {
    const p = project({ items: [table("item_table", 0, 0)] });
    expect(
      placeItem(subject({ elevation: 30, size: { w: 400, d: 300, h: 100 } }), ctx(p), DRAG).elevation,
    ).toBe(30);
    expect(
      placeItem(subject({ elevation: 0, size: { w: 400, d: 300, h: 100 } }), ctx(p), DRAG).elevation,
    ).toBe(740);
  });

  it("F-069 an item moved off its surface drops back to the floor", () => {
    const p = project({ items: [table("item_table", 0, 0)] });
    const r = placeItem(
      subject({
        position: { x: 3000, y: 0 },
        elevation: 740,
        parentId: "item_table",
        size: { w: 400, d: 300, h: 100 },
      }),
      ctx(p),
      DRAG,
    );
    expect(r).toMatchObject({ elevation: 0, parentId: null });
  });

  it("F-075 dropped onto a table in a corner it is elevated and not snapped side by side", () => {
    const p = project({
      walls: [wall("wall_s", 0, 0, 4000, 0), wall("wall_w", 0, 0, 0, 4000)],
      items: [table("item_table", 700, 500)],
    });
    const r = placeItem(
      subject({ position: { x: 700, y: 500 }, size: { w: 300, d: 300, h: 100 } }),
      ctx(p),
      DROP,
    );
    expect(r).toMatchObject({ elevation: 740, surfaceId: "item_table", neighbourId: null });
  });
});

describe("stage 3: side by side (F-092..F-097)", () => {
  it("F-092 only neighbours whose height range overlaps are candidates", () => {
    const p = project({ items: [chair("item_a", 1000, 1000)] });
    const high = placeItem(
      subject({ position: { x: 1660, y: 1000 }, elevation: 1500, size: { w: 600, d: 400, h: 300 } }),
      ctx(p),
      FLAT,
    );
    expect(high).toMatchObject({ position: { x: 1660, y: 1000 }, neighbourId: null });
    const low = placeItem(subject({ position: { x: 1660, y: 1000 } }), ctx(p), FLAT);
    expect(low).toMatchObject({ position: { x: 1600, y: 1000 }, neighbourId: "item_a" });
  });

  it("F-093 within the 80 mm band the item goes flush; beyond it nothing moves", () => {
    const p = project({ items: [chair("item_a", 1000, 1000)] });
    expect(placeItem(subject({ position: { x: 1660, y: 1000 } }), ctx(p), FLAT).position.x).toBe(1600);
    expect(placeItem(subject({ position: { x: 1720, y: 1000 } }), ctx(p), FLAT).position.x).toBe(1720);
  });

  it("F-094 the face is chosen by which bow-tie the item overlaps more", () => {
    const p = project({ items: [chair("item_a", 0, 0, { w: 1200, d: 400, h: 900 })] });
    const behind = placeItem(
      subject({ position: { x: 0, y: 450 }, size: { w: 400, d: 400, h: 500 } }),
      ctx(p),
      FLAT,
    );
    expect(behind.position).toEqual({ x: 0, y: 400 });
    const beside = placeItem(
      subject({ position: { x: 850, y: 0 }, size: { w: 400, d: 400, h: 500 } }),
      ctx(p),
      FLAT,
    );
    expect(beside.position).toEqual({ x: 800, y: 0 });
  });

  it("F-095 a move that would leave the items only at a corner is not applied", () => {
    const p = project({ items: [chair("item_a", 0, 0)] });
    const r = placeItem(
      subject({ position: { x: 560, y: 460 }, size: { w: 400, d: 400, h: 500 } }),
      ctx(p),
      FLAT,
    );
    expect(r).toMatchObject({ position: { x: 560, y: 460 }, neighbourId: null });
  });

  it("F-096 a flush move keeps only the part that does not push into the magnet wall", () => {
    const wfp = wallFootprints([wall("wall_s", 0, 0, 4000, 0)]).get("wall_s") as { x: number; y: number }[];
    const at = (d: { x: number; y: number }) =>
      footprintAt({ x: 2000 + d.x, y: 250 + d.y }, 180, { w: 600, d: 400 });
    expect(constrainToWall({ x: 30, y: -30 }, at, wfp, { x: 1, y: 0 })).toEqual({ x: 30, y: 0 });
    expect(constrainToWall({ x: 0, y: 20 }, at, wfp, { x: 1, y: 0 })).toEqual({ x: 0, y: 20 });
  });

  it("F-097 (reversed) a turned item is matched by its real footprint, not its unrotated depth", () => {
    const p = project({ items: [chair("item_a", 0, 0)] });
    const size = { w: 400, d: 400, h: 500 };
    const r = placeItem(subject({ position: { x: 633, y: 0 }, rotation: 45, size }), ctx(p), {
      ...FLAT,
      forceOrientation: false,
    });
    expect(r.neighbourId).toBe("item_a");
    const fp = footprintAt(r.position, 45, size);
    const a = footprintAt({ x: 0, y: 0 }, 0, { w: 600, d: 400 });
    expect(poly.convexOverlapArea(fp, a)).toBeLessThanOrEqual(1);
    expect(poly.polygonsIntersect(footprintAt(r.position, 45, { w: size.w + 2, d: size.d + 2 }), a)).toBe(
      true,
    );
  });
});

describe("drag behaviour and helpers (F-076..F-081, F-098, F-099)", () => {
  it("F-076 dragging keeps the rotation while dropping turns the item", () => {
    const dragged = placeItem(subject({ position: { x: 2000, y: 280 }, rotation: 30 }), ctx(south()), DRAG);
    expect(dragged.rotation).toBe(30);
    expect(dragged.wallId).toBe("wall_s");
    expect(
      placeItem(subject({ position: { x: 2000, y: 280 }, rotation: 30 }), ctx(south()), DROP).rotation,
    ).toBe(180);
  });

  it("F-080 F-081 every drag move starts from the press state, so magnetism never accumulates; the first 100 ms are ignored", () => {
    const drag = new DragSession(subject({ position: { x: 2000, y: 1000 } }), ctx(south()), 5000);
    expect(drag.accepts(5099)).toBe(false);
    expect(drag.accepts(5100)).toBe(true);
    expect(drag.move(0, -720).position).toEqual({ x: 2000, y: 250 });
    expect(drag.move(0, 0).position).toEqual({ x: 2000, y: 1000 });
    expect(drag.move(0, -720, false).position).toEqual({ x: 2000, y: 280 });
  });

  it("F-079 with the alignment modifier the cursor moves along 15 degree rays and keeps its distance", () => {
    const h = alignedDragPoint({ x: 0, y: 0 }, { x: 1000, y: 30 });
    expect(h.y).toBeCloseTo(0, 9);
    expect(h.x).toBeCloseTo(Math.hypot(1000, 30), 9);
    const d = alignedDragPoint({ x: 0, y: 0 }, { x: 1000, y: 600 });
    expect((Math.atan2(d.y, d.x) * 180) / Math.PI).toBeCloseTo(30, 9);
  });

  it("F-098 F-099 dragged sizes snap to whole millimetres; a positive length never rounds to zero", () => {
    expect(magnetizedSize({ w: 623.4, d: 0.2, h: 900.6 })).toEqual({ w: 623, d: 1, h: 901 });
    expect(magnetizedLength(0.3, 10)).toBe(0.3);
    expect(magnetizedLength(1234, 10)).toBe(1230);
  });
});

describe("anchors and clearances (spec 05 section 5)", () => {
  const room = () =>
    project({
      walls: [wall("wall_s", 0, 0, 8000, 0)],
      openings: [defaultOpening("opening_door", L, "wall_s", "door", { position: 0.5, width: 900 })],
    });

  it("door swing squares sit on both faces of the wall", () => {
    const zones = doorSwingZones(room(), L);
    expect(zones).toHaveLength(2);
    const ys = zones.map((z) => z.polygon.map((q) => Math.round(q.y)));
    expect(
      ys.map((y) => [Math.min(...y), Math.max(...y)]).sort((a, b) => (a[0] as number) - (b[0] as number)),
    ).toEqual([
      [-950, -50],
      [50, 950],
    ]);
  });

  it("free runs along a wall skip the door swing, items already there, and windows lower than the item", () => {
    const p = room();
    const along = (items: Item[], size: Size3, extra: Partial<Project> = {}) =>
      freeRunsAlongEdge(
        { ...p, items, ...extra },
        L,
        { x: 50, y: 50 },
        { x: 7950, y: 50 },
        { x: 0, y: -1 },
        size,
        derive.snapshotSizeSource(p),
      );
    expect(along([], { w: 600, d: 400, h: 500 })).toEqual([
      { from: 0, to: 3500 },
      { from: 4400, to: 7900 },
    ]);
    expect(along([chair("item_x", 1000, 300)], { w: 600, d: 400, h: 500 })).toEqual([
      { from: 0, to: 650 },
      { from: 1250, to: 3500 },
      { from: 4400, to: 7900 },
    ]);
    const windowed = {
      openings: [
        ...p.openings,
        defaultOpening("opening_win", L, "wall_s", "window", { position: 0.2, width: 1000, sill: 900 }),
      ],
    };
    expect(along([], { w: 600, d: 400, h: 500 }, windowed)).toHaveLength(2);
    expect(along([], { w: 600, d: 400, h: 1200 }, windowed)).toEqual([
      { from: 0, to: 1050 },
      { from: 2050, to: 3500 },
      { from: 4400, to: 7900 },
    ]);
  });

  it("an item left in a door's swing gets a warning naming the door", () => {
    const r = placeItem(
      subject({ position: { x: 4000, y: 600 }, size: { w: 400, d: 400, h: 500 } }),
      ctx(room()),
      DROP,
    );
    expect(r.wallId).toBeNull();
    expect(r.warnings).toEqual([
      {
        code: "item.door-swing",
        message: "the item stands in the swing of door opening_door",
        related: ["opening_door"],
      },
    ]);
  });

  it("a product's access clearance overlapping a neighbour is reported", () => {
    const p = project({ items: [chair("item_n", 0, 900)] });
    const clearance = { front: 0, back: 900, left: 0, right: 0 };
    const r = placeItem(
      subject({ position: { x: 0, y: 0 } }),
      ctx(p),
      { ...FLAT, forceOrientation: false },
      clearance,
    );
    expect(r.warnings.map((w) => w.code)).toEqual(["item.clearance"]);
    expect(
      placeItem(subject({ position: { x: 0, y: 0 } }), ctx(p), { ...FLAT, forceOrientation: false }).warnings,
    ).toEqual([]);
  });
});

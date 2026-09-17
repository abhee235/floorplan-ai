// Drawing a desk cluster (P3-6): the rectangle a drag makes, how many desks the tool says fit, and the
// one command it sends. The count is checked against the real reducer — the promise the tool makes while
// you drag ("48 pieces") is worthless if the command then produces a different number.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apply, type Ctx } from "@fpv/commands";
import { Project, type Project as ProjectT, sequentialIdGenerator } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PIECE,
  DEFAULT_RULE,
  fitCount,
  MIN_SIDE_MM,
  rectPolygon,
  type ZoneAimOptions,
  type ZoneRule,
  ZoneTool,
} from "../../src/editor/zone-tool.js";

const fixtureDir = fileURLToPath(new URL("../../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const fixture = (): ProjectT => Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));
// The six-wall fixture has walls but no room entity; the boardroom has both.
const boardroomDir = fileURLToPath(new URL("../../../../tools/fixtures/boardroom.fpviz/", import.meta.url));
const boardroom = (): ProjectT =>
  Project.parse(JSON.parse(readFileSync(`${boardroomDir}project.json`, "utf8")));
const ctxOf = (): Ctx => ({ ids: sequentialIdGenerator(900), now: () => "2026-09-18T00:00:00.000Z" });

const levelId = () => fixture().levels[0]?.id as string;

/** No walls to snap to unless a test asks for them, and one millimetre to a pixel. */
const aimOptions = (over: Partial<ZoneAimOptions> = {}): ZoneAimOptions => ({
  walls: [],
  pixelMm: 1,
  magnetism: true,
  ...over,
});

function toolWith(rule: ZoneRule = DEFAULT_RULE, piece = DEFAULT_PIECE): ZoneTool {
  return new ZoneTool({ levelId: levelId(), piece: () => piece, rule: () => rule });
}

describe("the rectangle a drag makes", () => {
  it("reads the same whichever corner it started from", () => {
    const a = rectPolygon({ x: 8000, y: 6000 }, { x: 1000, y: 2000 });
    expect(a).toEqual([
      { x: 1000, y: 2000 },
      { x: 8000, y: 2000 },
      { x: 8000, y: 6000 },
      { x: 1000, y: 6000 },
    ]);
    expect(rectPolygon({ x: 1000, y: 2000 }, { x: 8000, y: 6000 })).toEqual(a);
  });

  it("is a square while Shift is held, following the longer side", () => {
    const tool = toolWith();
    tool.begin({ x: 0, y: 0 }, aimOptions());
    const aimed = tool.aim({ x: 5000, y: -2000 }, aimOptions({ shiftHeld: true }));
    expect(aimed?.widthMm).toBe(5000);
    expect(aimed?.depthMm).toBe(5000);
    expect(aimed?.polygon).toContainEqual({ x: 5000, y: -5000 });
  });

  it("takes a wall corner when one is within reach, and Alt bypasses it", () => {
    const walls = fixture().walls;
    const corner = walls[0]?.start as { x: number; y: number };
    const tool = toolWith();
    tool.begin({ x: 0, y: 0 }, aimOptions());
    // WALL_END_PX is two pixels, and this test runs at one millimetre to the pixel
    const near = { x: corner.x + 1, y: corner.y + 1 };
    expect(tool.aim(near, aimOptions({ walls }))?.snapNote).toBe("wall corner");
    expect(tool.aim(near, aimOptions({ walls, altHeld: true }))?.snapNote).toBe("");
  });
});

describe("how many pieces the tool says fit", () => {
  it("is what the reducer then places", () => {
    const tool = toolWith();
    const options = aimOptions();
    tool.begin({ x: 500, y: 500 }, options);
    const aimed = tool.aim({ x: 12500, y: 8500 }, options);
    const command = tool.end({ x: 12500, y: 8500 }, options);
    expect(aimed?.fits).toBeGreaterThan(10);
    expect(command?.payload.rule.count).toBe(aimed?.fits);

    const result = apply(fixture(), command, ctxOf());
    if (!result.ok) throw new Error(result.error.message);
    const placed = result.project.items.filter((i) => i.tags.includes("generated"));
    expect(placed).toHaveLength(aimed?.fits as number);
    expect(result.warnings).toEqual([]);
    // and the zone it made holds exactly those pieces
    const zone = result.project.zones[0];
    expect(zone?.generatedItemIds).toHaveLength(placed.length);
    expect(zone?.kind).toBe("desk-cluster");
  });

  it("falls as the spacing grows", () => {
    const polygon = rectPolygon({ x: 0, y: 0 }, { x: 12000, y: 8000 });
    const tight = fitCount(polygon, { ...DEFAULT_RULE, spacing: { x: 0, y: 0 } }, DEFAULT_PIECE.size);
    const loose = fitCount(polygon, { ...DEFAULT_RULE, spacing: { x: 2000, y: 2000 } }, DEFAULT_PIECE.size);
    expect(tight).toBeGreaterThan(loose);
    expect(loose).toBeGreaterThan(0);
  });

  it("is none at all when the box is smaller than the piece", () => {
    expect(fitCount(rectPolygon({ x: 0, y: 0 }, { x: 900, y: 900 }), DEFAULT_RULE, DEFAULT_PIECE.size)).toBe(
      0,
    );
  });
});

describe("what a finished drag sends", () => {
  it("is one item.arrange carrying the piece, the pattern and the count", () => {
    const tool = toolWith({ ...DEFAULT_RULE, pattern: "bench", facing: 90, margin: 0 });
    const options = aimOptions();
    tool.begin({ x: 0, y: 0 }, options);
    const command = tool.end({ x: 10000, y: 7000 }, options);
    expect(command?.type).toBe("item.arrange");
    expect(command?.payload.rule.pattern).toBe("bench");
    expect(command?.payload.rule.facing).toBe(90);
    const ref = DEFAULT_PIECE.ref as { kind: "recipe"; recipe: unknown };
    expect(command?.payload.rule.recipe).toEqual(ref.recipe);
    expect(command?.payload.rule.productId).toBeNull();
    const target = command?.payload.target as { levelId: string; polygon: unknown[] };
    expect(target.levelId).toBe(levelId());
    expect(target.polygon).toHaveLength(4);
    expect(tool.drawing).toBe(false);
  });

  it("is nothing at all from a mis-click, or from a box nothing fits in", () => {
    const tool = toolWith();
    const options = aimOptions();
    tool.begin({ x: 0, y: 0 }, options);
    expect(tool.end({ x: MIN_SIDE_MM - 1, y: MIN_SIDE_MM - 1 }, options)).toBeNull();
    tool.begin({ x: 0, y: 0 }, options);
    // wide enough to be meant, too small to hold a 1600 x 800 desk
    expect(tool.end({ x: 1000, y: 700 }, options)).toBeNull();
    expect(tool.drawing).toBe(false);
  });

  it("fills a room from its own polygon", () => {
    const p = boardroom();
    const room = p.rooms[0];
    if (!room) throw new Error("no room in the fixture");
    const tool = toolWith();
    const command = tool.fillRoom(room.id, room.polygon);
    expect(command?.payload.target).toEqual({ roomId: room.id });
    const result = apply(p, command, ctxOf());
    if (!result.ok) throw new Error(result.error.message);
    expect(result.project.items.filter((i) => i.tags.includes("generated")).length).toBe(
      command?.payload.rule.count,
    );
  });

  it("says the size and the count out loud while it is dragged", () => {
    const tool = toolWith();
    const options = aimOptions();
    tool.begin({ x: 0, y: 0 }, options);
    const aimed = tool.aim({ x: 6000, y: 4000 }, options);
    // Said, not printed: a screen reader reads "millimetres", and the plan draws the digits.
    expect(aimed?.announcement).toBe(`Cluster 6000 millimetres by 4000 millimetres, ${aimed?.fits} pieces.`);
  });
});

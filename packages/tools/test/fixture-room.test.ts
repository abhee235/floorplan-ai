import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ItemView, type RoomView, replay, type WallView } from "../src/index.js";
import { buildFixtureRoom, harness } from "./helpers.js";

const fixtureDir = fileURLToPath(new URL("../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const expected = JSON.parse(readFileSync(`${fixtureDir}expected.json`, "utf8")) as {
  wallLengthsMm: Record<string, number>;
  wallCompassLeftSide: Record<string, string>;
  detectedRoomAreaMm2WithoutThreshold: number;
  detectedRoomAreaMm2WithThreshold: number;
};

describe("the six-wall room by tool calls alone", () => {
  it("create_walls, add_opening and create_room reproduce the fixture's golden values", async () => {
    const h = harness();
    const walls = await h.ok<{ walls: WallView[] }>("create_walls", {
      levelId: "level_000000",
      points: [
        { x: 0, y: 0 },
        { x: 8000, y: 0 },
        { x: 8000, y: 3000 },
        { x: 5000, y: 3000 },
        { x: 5000, y: 5000 },
        { x: 0, y: 5000 },
      ],
      closed: true,
      thickness: 100,
      kind: "interior",
    });
    expect(walls.result.walls).toHaveLength(6);
    for (const w of walls.result.walls) {
      expect(w.lengthMm).toBe(expected.wallLengthsMm[w.id]);
      expect(w.compass.left).toBe(expected.wallCompassLeftSide[w.id]);
      expect(w.joins.start).not.toBeNull();
      expect(w.joins.end).not.toBeNull();
    }
    expect(walls.changed?.added).toHaveLength(6);
    expect(walls.problems.filter((p) => p.severity === "error")).toHaveLength(0);

    const door = await h.ok<{ opening: { hinge: string; atMm: number; wallId: string } }>("add_opening", {
      wallId: "wall_000001",
      kind: "door",
      position: 0.5,
      hingeSide: "west",
      swingDirection: "left",
    });
    expect(door.result.opening.atMm).toBe(4000);
    expect(door.result.opening.hinge).toBe("west");

    const room = await h.ok<{ room: RoomView }>("create_room", {
      levelId: "level_000000",
      atPoint: { x: 2000, y: 2000 },
      purpose: "boardroom",
      capacity: 10,
    });
    // areaM2 is rounded to 0.01 m²; the detected polygon matches one of the two golden areas
    const areaMm2 = room.result.room.areaM2 * 1e6;
    const nearest = Math.min(
      Math.abs(areaMm2 - expected.detectedRoomAreaMm2WithoutThreshold),
      Math.abs(areaMm2 - expected.detectedRoomAreaMm2WithThreshold),
    );
    expect(nearest).toBeLessThan(10_000);
    expect(room.result.room.walls).toHaveLength(6);
    const compass = Object.fromEntries(room.result.room.walls.map((w) => [w.wallId, w.compass]));
    // the room lies to the left of every wall in this counter-clockwise chain, so the outward side is the right one
    expect(compass).toEqual({
      wall_000001: "south",
      wall_000002: "east",
      wall_000003: "north",
      wall_000004: "east",
      wall_000005: "north",
      wall_000006: "west",
    });
    const v = await h.ok<{ errors: unknown[]; warnings: unknown[] }>("validate");
    expect(v.result.errors).toHaveLength(0);
    const summary = await h.ok<{ counts: { walls: number; rooms: number }; rooms: { itemCount: number }[] }>(
      "get_scene",
      { detail: "summary" },
    );
    expect(summary.result.counts).toMatchObject({ walls: 6, rooms: 1 });
    expect(JSON.stringify(summary.result).length).toBeLessThan(2048);
  });

  it("describe_room names free segments around the door and suggests the display wall opposite it", async () => {
    const h = harness();
    const { roomId } = await buildFixtureRoom(h);
    const d = await h.ok<
      RoomView & {
        freeSegments: { wallId: string; fromMm: number; toMm: number; compass: string }[];
        suggestedDisplayWall: string;
      }
    >("describe_room", { roomId });
    const south = d.result.freeSegments.filter((s) => s.wallId === "wall_000001");
    expect(south).toHaveLength(2);
    // the room polygon runs along the inner face (50..7950); the 900 mm door at 4000 splits it
    expect(south.map((s) => [s.fromMm, s.toMm])).toEqual([
      [50, 3550],
      [4450, 7950],
    ]);
    expect(d.result.suggestedDisplayWall).toBe("north");
    expect(d.result.openingIds).toEqual(["opening_000001"]);
  });

  it("place_item with anchors, modify_item, measure and delete round-trip through views", async () => {
    const h = harness();
    const { roomId } = await buildFixtureRoom(h);
    const table = await h.ok<{ item: ItemView; adjusted: boolean }>("place_item", {
      roomId,
      anchor: "center",
      productId: "acme-boardroom-3600",
    });
    expect(table.result.item.size).toEqual({ w: 3600, d: 1400, h: 750 });
    expect(table.result.item.roomId).toBe(roomId);
    expect(table.result.item.verified).toBe(true);
    const display = await h.ok<{ item: ItemView }>("place_item", {
      roomId,
      anchor: "against-north-wall",
      recipe: { kind: "display", diagonalIn: 75, bezelMm: 15 },
      elevation: 1200,
    });
    expect(display.result.item.position.y).toBeGreaterThan(4000);
    const m = await h.ok<{ mm: number }>("measure", {
      fromId: table.result.item.id,
      toId: display.result.item.id,
    });
    expect(m.result.mm).toBeGreaterThan(0);
    const chair = await h.ok<{ item: ItemView }>("place_item", {
      x: 4000,
      y: 600,
      productId: "acme-task-chair",
    });
    expect(chair.warnings.some((w) => w.includes("door"))).toBe(true); // within the door swing
    const moved = await h.ok<{ item: ItemView; descendants: ItemView[] }>("modify_item", {
      itemId: chair.result.item.id,
      x: 1000,
      y: 4000,
      rotation: 90,
    });
    expect(moved.result.item.position).toEqual({ x: 1000, y: 4000 });
    expect(moved.result.item.rotation).toBe(90);
    const del = await h.ok<{ removed: { id: string }[] }>("delete", { ids: [chair.result.item.id] });
    expect(del.result.removed.map((r) => r.id)).toEqual([chair.result.item.id]);
    const after = await h.ok<{ items: ItemView[] }>("get_scene", { detail: "full", types: ["item"] });
    expect(after.result.items).toHaveLength(2);
  });

  it("arrange fills the room with chairs and reports how many fit", async () => {
    const h = harness();
    const { roomId } = await buildFixtureRoom(h);
    const r = await h.ok<{ placed: number; requested: number; zoneId: string; items: ItemView[] }>(
      "arrange",
      {
        roomId,
        pattern: "grid",
        productId: "acme-task-chair",
        count: 6,
        facing: "north",
      },
    );
    expect(r.result.placed).toBe(6);
    expect(r.result.items[0]?.rotation).toBe(90); // faces north: +y with north at 90 degrees
    expect(r.result.zoneId.startsWith("zone_")).toBe(true);
  });

  it("history checkpoints and undo restore the project; batch is atomic", async () => {
    const h = harness();
    const { roomId } = await buildFixtureRoom(h);
    const cp = await h.ok<{ checkpointId: string; position: number }>("history", {
      op: "checkpoint",
      label: "before items",
    });
    await h.ok("place_item", {
      roomId,
      anchor: "center",
      recipe: { kind: "box", size: { w: 600, d: 400, h: 500 }, label: "b" },
    });
    const failed = await h.call("batch", {
      commands: [
        {
          type: "item.place",
          payload: {
            levelId: "level_000000",
            ref: { kind: "recipe", recipe: { kind: "box", size: { w: 600, d: 400, h: 500 }, label: "b" } },
            position: { x: 1000, y: 1000 },
          },
        },
        { type: "item.move", payload: { itemIds: ["item_zzzzzz"], dx: 1, dy: 0 } },
      ],
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.message).toContain("command 2 of 2");
    expect(h.ctx.store.project.items).toHaveLength(1);
    const undo = await h.ok<{ position: number }>("history", { op: "undo" });
    expect(h.ctx.store.project.items).toHaveLength(0);
    expect(undo.changed?.removed.map((r) => r.type)).toEqual(["item"]);
    await h.ok("history", { op: "redo" });
    expect(h.ctx.store.project.items).toHaveLength(1);
    await h.ok("history", { op: "restore", checkpointId: cp.result.checkpointId });
    expect(h.ctx.store.project.items).toHaveLength(0);
    const list = await h.ok<{ checkpoints: { id: string }[] }>("history", { op: "list" });
    expect(list.result.checkpoints.map((c) => c.id)).toEqual([cp.result.checkpointId]);
  });

  it("a recorded transcript replays onto a fresh session and yields the same project", async () => {
    const a = harness();
    const { roomId } = await buildFixtureRoom(a);
    await a.ok("place_item", {
      roomId,
      anchor: "against-east-wall",
      recipe: { kind: "box", size: { w: 600, d: 400, h: 500 }, label: "credenza" },
    });
    const b = harness();
    const results = await replay(b.registry, a.transcript.entries);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(b.ctx.store.project).toEqual(a.ctx.store.project);
  });
});

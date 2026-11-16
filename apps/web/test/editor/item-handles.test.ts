// Handles on a selected item (P3-3): where they sit, what a press finds, and what a drag asks for. The
// resize is checked against the real reducer, because keeping the far side put takes two commands.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apply, type Ctx } from "@fpv/commands";
import { derive, Project, type Project as ProjectT, sequentialIdGenerator } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import {
  itemHandleAnchors,
  itemHandleAt,
  itemHandleCursor,
  resizeCommands,
  rotateCommand,
} from "../../src/editor/item-handles.js";

const fixtureDir = fileURLToPath(new URL("../../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const fixture = (): ProjectT => Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));
const ctx: Ctx = { ids: sequentialIdGenerator(900), now: () => "2026-09-17T00:00:00.000Z" };
const SIZE = { w: 1600, d: 800, h: 740 };
const at = (rotation: number) => ({ id: "item_zz0001", position: { x: 3000, y: 2500 }, rotation });
const close = (p: { x: number; y: number }, x: number, y: number) => {
  expect(p.x).toBeCloseTo(x, 6);
  expect(p.y).toBeCloseTo(y, 6);
};

describe("item handles", () => {
  it("sits on the corners, the edge middles, and off the front", () => {
    const anchors = itemHandleAnchors(at(0), SIZE, 1, true);
    expect(anchors).toHaveLength(9);
    const find = (sx: number, sy: number) =>
      anchors.find((a) => a.handle.kind === "resize" && a.handle.sx === sx && a.handle.sy === sy)?.at;
    close(find(1, 1) as { x: number; y: number }, 3800, 2900); // back right
    close(find(0, -1) as { x: number; y: number }, 3000, 2100); // front middle
    const turn = anchors.find((a) => a.handle.kind === "rotate")?.at as { x: number; y: number };
    close(turn, 3000, 2100 - 26); // 26 px off the front, one mm a px here
    // turned a quarter, the right side faces north
    const turned = itemHandleAnchors(at(90), SIZE, 1, true);
    close(
      turned.find((a) => a.handle.kind === "resize" && a.handle.sx === 1 && a.handle.sy === 0)?.at as {
        x: number;
        y: number;
      },
      3000,
      3300,
    );
    // a one-size product can only be turned
    expect(itemHandleAnchors(at(0), SIZE, 1, false).map((a) => a.handle.kind)).toEqual(["rotate"]);
  });

  it("finds the handle under a press, the turn handle first, and nothing between them", () => {
    expect(itemHandleAt(at(0), SIZE, { x: 3803, y: 2897 }, 1, true)).toEqual({
      kind: "resize",
      sx: 1,
      sy: 1,
    });
    expect(itemHandleAt(at(0), SIZE, { x: 2200, y: 2500 }, 1, true)).toEqual({
      kind: "resize",
      sx: -1,
      sy: 0,
    });
    expect(itemHandleAt(at(0), SIZE, { x: 3000, y: 2074 }, 1, true)).toEqual({ kind: "rotate" });
    expect(itemHandleAt(at(0), SIZE, { x: 3000, y: 2500 }, 1, true)).toBeNull();
    // the reach is in screen pixels: at 1 px = 10 mm it reaches 70 mm
    expect(itemHandleAt(at(0), SIZE, { x: 3850, y: 2900 }, 10, true)).toEqual({
      kind: "resize",
      sx: 1,
      sy: 1,
    });
    expect(itemHandleAt(at(0), SIZE, { x: 3803, y: 2897 }, 1, false)).toBeNull();
  });

  it("shows a resize arrow along the pull, turning with the item, and a grab to turn", () => {
    expect(itemHandleCursor({ kind: "resize", sx: 1, sy: 0 }, 0)).toBe("ew-resize");
    expect(itemHandleCursor({ kind: "resize", sx: 1, sy: 1 }, 0)).toBe("nesw-resize");
    expect(itemHandleCursor({ kind: "resize", sx: -1, sy: 1 }, 0)).toBe("nwse-resize");
    expect(itemHandleCursor({ kind: "resize", sx: 1, sy: 0 }, 90)).toBe("ns-resize");
    expect(itemHandleCursor({ kind: "rotate" }, 0)).toBe("grab");
  });
});

describe("resizing by a handle", () => {
  const snap = { snap: true, keepRatio: false };

  it("grows the dragged side and keeps the other where it was", () => {
    expect(
      resizeCommands(at(0), SIZE, { sx: 1, sy: 0 }, { x: 3800, y: 2500 }, { x: 4003, y: 2600 }, snap),
    ).toEqual([
      {
        type: "item.resize",
        payload: { itemId: "item_zz0001", size: { w: 1800, d: 800, h: 740 }, anchor: "center" },
      },
      { type: "item.move", payload: { itemIds: ["item_zz0001"], dx: 100, dy: 0, magnetism: false } },
    ]);
    // turned a quarter, the item's right is plan north, so a pull north grows its width
    const turned = resizeCommands(
      at(90),
      SIZE,
      { sx: 1, sy: 0 },
      { x: 3000, y: 3300 },
      { x: 3000, y: 3500 },
      snap,
    );
    expect(turned[0]?.payload.size).toEqual({ w: 1800, d: 800, h: 740 });
    expect(turned[1]?.payload).toMatchObject({ dx: 0, dy: 100 });
  });

  it("keeps a corner's proportions with Shift, stops at 10 mm, and asks for nothing without a change", () => {
    const ratio = resizeCommands(
      at(0),
      SIZE,
      { sx: 1, sy: 1 },
      { x: 0, y: 0 },
      { x: 800, y: 0 },
      { snap: true, keepRatio: true },
    );
    expect(ratio[0]?.payload.size).toEqual({ w: 2400, d: 1200, h: 740 });
    const tiny = resizeCommands(at(0), SIZE, { sx: -1, sy: 0 }, { x: 0, y: 0 }, { x: 5000, y: 0 }, snap);
    expect(tiny[0]?.payload.size).toMatchObject({ w: 10 });
    expect(resizeCommands(at(0), SIZE, { sx: 0, sy: 1 }, { x: 0, y: 0 }, { x: 900, y: 4 }, snap)).toEqual([]);
    // without snapping every millimetre counts
    const exact = resizeCommands(
      at(0),
      SIZE,
      { sx: 0, sy: 1 },
      { x: 0, y: 0 },
      { x: 0, y: 7 },
      { snap: false, keepRatio: false },
    );
    expect(exact[0]?.payload.size).toMatchObject({ d: 807 });
  });

  it("leaves the far side where it was when the commands run through the reducer", () => {
    const placed = apply(
      fixture(),
      {
        type: "item.place",
        payload: {
          levelId: "level_000000",
          ref: { kind: "recipe", recipe: { kind: "box", size: { w: 1600, d: 800, h: 740 }, label: "" } },
          position: { x: 3000, y: 2500 },
          rotation: 30,
          magnetism: false,
        },
      },
      ctx,
    );
    if (!placed.ok) throw new Error(placed.error.message);
    let p = placed.project;
    const item = p.items.at(-1) as ProjectT["items"][number];
    const before = derive.itemFootprint(item, SIZE);
    // pull the back left corner out and back
    for (const command of resizeCommands(
      item,
      SIZE,
      { sx: -1, sy: 1 },
      { x: 0, y: 0 },
      { x: -300, y: 400 },
      snap,
    )) {
      const r = apply(p, command, ctx);
      if (!r.ok) throw new Error(r.error.message);
      p = r.project;
    }
    const after = p.items.at(-1) as ProjectT["items"][number];
    const fp = derive.itemFootprint(after, after.size as typeof SIZE);
    // the front right corner, opposite the one dragged, has not moved (to the rounding of a millimetre)
    expect(
      Math.hypot((fp[2]?.x ?? 0) - (before[2]?.x ?? 0), (fp[2]?.y ?? 0) - (before[2]?.y ?? 0)),
    ).toBeLessThan(1.5);
    expect(after.size?.w).toBeGreaterThan(1600);
    expect(after.size?.d).toBeGreaterThan(800);
  });
});

describe("turning by the handle", () => {
  it("faces the item's front toward the pointer, in 15 degree steps unless Alt is held", () => {
    // the front is south at rotation 0, so a pointer due east turns the front east: 90 degrees
    expect(rotateCommand(at(0), { x: 4000, y: 2500 }, true)).toEqual({
      type: "item.rotate",
      payload: { itemIds: ["item_zz0001"], angle: 90 },
    });
    expect(rotateCommand(at(0), { x: 4000, y: 2420 }, true)?.payload.angle).toBe(90);
    // a little south of east is a little short of a quarter turn
    expect(rotateCommand(at(0), { x: 4000, y: 2420 }, false)?.payload.angle).toBeCloseTo(85.4, 1);
    // a pointer due south is where the front already faces
    expect(rotateCommand(at(0), { x: 3000, y: 1000 }, true)).toBeNull();
    expect(rotateCommand(at(0), { x: 3000, y: 2500 }, true)).toBeNull();
  });
});

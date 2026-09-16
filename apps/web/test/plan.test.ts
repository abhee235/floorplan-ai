import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apply, type Ctx } from "@fpv/commands";
import type { Layer } from "@fpv/engine";
import { Project, type Project as ProjectT, sequentialIdGenerator } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { type Ctx2D, PlanRenderer } from "../src/index.js";

const fixtureDir = fileURLToPath(new URL("../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const fixture = (): ProjectT => Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));
const ctx: Ctx = { ids: sequentialIdGenerator(900), now: () => "2026-09-15T00:00:00.000Z" };
const L = "level_000000";
const BOX = {
  kind: "recipe" as const,
  recipe: { kind: "box" as const, size: { w: 600, d: 400, h: 500 }, label: "b" },
};

/** Records drawing calls; enough to assert what each layer drew. */
function recorder(): Ctx2D & { calls: string[]; transforms: number[][]; texts: string[] } {
  const calls: string[] = [];
  const transforms: number[][] = [];
  const texts: string[] = [];
  const rec = (name: string) => () => calls.push(name);
  return {
    calls,
    transforms,
    texts,
    save: rec("save"),
    restore: rec("restore"),
    setTransform: (...m: number[]) => {
      transforms.push(m);
      calls.push("setTransform");
    },
    clearRect: rec("clearRect"),
    beginPath: rec("beginPath"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    arc: rec("arc"),
    closePath: rec("closePath"),
    fill: rec("fill"),
    stroke: rec("stroke"),
    fillText: (t: string) => {
      texts.push(t);
      calls.push("fillText");
    },
    setLineDash: rec("setLineDash"),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
  };
}

function run(p: ProjectT, command: unknown): ProjectT {
  const r = apply(p, command, ctx);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.project;
}

function layers() {
  const l = { static: recorder(), structure: recorder(), items: recorder(), overlay: recorder() };
  return { layers: l as Record<Layer, Ctx2D>, rec: l };
}

describe("plan renderer (ADR-003 D6)", () => {
  it("fits the project, applies one transform per layer with a y flip, and maps points both ways", () => {
    const { layers: ctxs } = layers();
    const plan = new PlanRenderer(ctxs, 800, 600);
    plan.setProject(fixture());
    plan.fit(40);
    expect(plan.view.scale).toBeCloseTo((800 - 80) / 8100, 6);
    const s = plan.toScreen({ x: 0, y: 0 });
    const back = plan.toPlan(s.x, s.y);
    expect(back.x).toBeCloseTo(0, 6);
    expect(back.y).toBeCloseTo(0, 6);
    // +y in the plan goes up the screen
    expect(plan.toScreen({ x: 0, y: 1000 }).y).toBeLessThan(s.y);
    plan.flush();
    const t = (ctxs.structure as ReturnType<typeof recorder>).transforms.at(-1) as number[];
    expect(t[0]).toBeCloseTo(plan.view.scale, 9);
    expect(t[3]).toBeCloseTo(-plan.view.scale, 9);
  });

  it("draws walls, the door gap and swing, rooms with labels, and item footprints on their layers", () => {
    const { layers: ctxs, rec } = layers();
    const plan = new PlanRenderer(ctxs, 800, 600);
    let p = fixture();
    p = run(p, {
      type: "room.create",
      payload: { levelId: L, atPoint: { x: 2000, y: 2000 }, name: "Boardroom" },
    });
    p = run(p, { type: "item.place", payload: { levelId: L, ref: BOX, position: { x: 2000, y: 2000 } } });
    plan.setProject(p);
    plan.flush();
    expect(rec.static.calls.filter((c) => c === "stroke").length).toBeGreaterThan(5); // grid lines
    expect(rec.structure.calls).toContain("arc"); // the door swing
    expect(rec.structure.texts).toContain("Boardroom");
    expect(rec.structure.texts.some((t) => t.endsWith("m²"))).toBe(true);
    expect(rec.items.calls.filter((c) => c === "fill")).toHaveLength(1);
    expect(plan.draws).toEqual({ static: 1, structure: 1, items: 1, overlay: 1 });
  });

  it("redraws only the layers a change touches; selection touches the overlay only", () => {
    const { layers: ctxs } = layers();
    const plan = new PlanRenderer(ctxs, 800, 600);
    let p = fixture();
    plan.setProject(p);
    plan.flush();
    const moved = apply(p, { type: "wall.move", payload: { wallIds: ["wall_000004"], dx: 0, dy: 100 } }, ctx);
    if (!moved.ok) throw new Error(moved.error.message);
    p = moved.project;
    plan.onChanges(moved.changes, p);
    plan.flush();
    expect(plan.draws).toEqual({ static: 1, structure: 2, items: 1, overlay: 1 });
    const placed = apply(
      p,
      { type: "item.place", payload: { levelId: L, ref: BOX, position: { x: 2000, y: 2000 } } },
      ctx,
    );
    if (!placed.ok) throw new Error(placed.error.message);
    plan.onChanges(placed.changes, placed.project);
    plan.flush();
    expect(plan.draws).toEqual({ static: 1, structure: 2, items: 2, overlay: 1 });
    plan.setSelection(["wall_000001"]);
    plan.flush();
    expect(plan.draws).toEqual({ static: 1, structure: 2, items: 2, overlay: 2 });
  });

  it("redraws the selection outline when the geometry under it changes", () => {
    const { layers: ctxs } = layers();
    const plan = new PlanRenderer(ctxs, 800, 600);
    const p = fixture();
    plan.setProject(p);
    plan.setSelection(["wall_000003"]);
    plan.flush();
    expect(plan.draws.overlay).toBe(1);
    // wall 4 moves, and wall 3 is joined to it: the selected wall's corner moves although it was not named
    const moved = apply(p, { type: "wall.move", payload: { wallIds: ["wall_000004"], dx: 0, dy: 100 } }, ctx);
    if (!moved.ok) throw new Error(moved.error.message);
    plan.onChanges(moved.changes, moved.project);
    plan.flush();
    expect(plan.draws.overlay).toBe(2);
  });

  it("W-107 draws baseboards on the structure layer, stroked so a thin one still shows", () => {
    const count = (p: ProjectT) => {
      const { layers: ctxs, rec } = layers();
      const plan = new PlanRenderer(ctxs, 800, 600);
      plan.setProject(p);
      plan.flush();
      return {
        fills: rec.structure.calls.filter((c) => c === "fill").length,
        strokes: rec.structure.calls.filter((c) => c === "stroke").length,
      };
    };
    const plain = fixture();
    const boarded = {
      ...plain,
      walls: plain.walls.map((w) => ({
        ...w,
        skirting: { left: { thickness: 15, height: 100, color: null }, right: null },
      })),
    };
    const before = count(plain);
    const after = count(boarded);
    expect(after.fills).toBe(before.fills + 1);
    expect(after.strokes).toBe(before.strokes + 1);
  });

  it("hit tests items before walls before rooms in plan millimetres", () => {
    const { layers: ctxs } = layers();
    const plan = new PlanRenderer(ctxs, 800, 600);
    let p = fixture();
    p = run(p, { type: "room.create", payload: { levelId: L, atPoint: { x: 2000, y: 2000 } } });
    p = run(p, { type: "item.place", payload: { levelId: L, ref: BOX, position: { x: 2000, y: 2000 } } });
    plan.setProject(p);
    expect(plan.hitTest({ x: 2000, y: 2000 })).toBe(p.items[0]?.id);
    expect(plan.hitTest({ x: 4000, y: 0 })).toBe("wall_000001");
    expect(plan.hitTest({ x: 1000, y: 1000 })).toBe(p.rooms[0]?.id);
    expect(plan.hitTest({ x: 20000, y: 20000 })).toBeNull();
  });

  it("F-130 a selection margin catches a click just outside a thin wall", () => {
    // Without this a wall is barely selectable: at a normal zoom its footprint is about one screen pixel
    // wide, so containsPoint alone asks for a one-pixel-accurate click.
    const { layers: ctxs } = layers();
    const plan = new PlanRenderer(ctxs, 800, 600);
    plan.setProject(fixture());

    // The test above establishes that (4000, 0) is inside wall_000001. Step out along y until the strict
    // test stops finding it, rather than assuming how far the footprint reaches: thickness is the full
    // width and which side of the centreline it sits on is the geometry's business, not this test's.
    let outsideY = 0;
    while (outsideY < 5000 && plan.hitTest({ x: 4000, y: outsideY }) !== null) outsideY += 10;
    expect(outsideY).toBeLessThan(5000); // it does end somewhere

    const justOutside = { x: 4000, y: outsideY + 10 };
    expect(plan.hitTest(justOutside)).toBeNull();
    expect(plan.hitTest(justOutside, 100)).toBe("wall_000001");
    // and the margin does not reach forever
    expect(plan.hitTest({ x: 4000, y: outsideY + 2000 }, 100)).toBeNull();
  });

  it("zoom keeps the point under the cursor fixed; pan shifts the offset", () => {
    const { layers: ctxs } = layers();
    const plan = new PlanRenderer(ctxs, 800, 600);
    plan.setProject(fixture());
    plan.fit();
    const before = plan.toPlan(300, 200);
    plan.zoomAt(300, 200, 1.5);
    const after = plan.toPlan(300, 200);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    const o = plan.view.offsetX;
    plan.panBy(25, -10);
    expect(plan.view.offsetX).toBe(o + 25);
  });
});

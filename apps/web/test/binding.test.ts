import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apply, type Ctx } from "@fpv/commands";
import { Project, type Project as ProjectT, sequentialIdGenerator } from "@fpv/ir";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { clippingFor, frameScheduler, SceneBinding } from "../src/index.js";

const fixtureDir = fileURLToPath(new URL("../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const fixture = (): ProjectT => Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));
const ctx: Ctx = { ids: sequentialIdGenerator(900), now: () => "2026-09-15T00:00:00.000Z" };
const BOX = {
  kind: "recipe" as const,
  recipe: { kind: "box" as const, size: { w: 600, d: 400, h: 500 }, label: "b" },
};
const L = "level_000000";

function run(p: ProjectT, command: unknown) {
  const r = apply(p, command, ctx);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r;
}

/** A scheduler whose frames run only when the test pumps them. */
function manualFrames() {
  const queue: (() => void)[] = [];
  return {
    scheduler: frameScheduler((cb) => queue.push(cb)),
    pump: () => queue.splice(0).forEach((cb) => cb()),
    queue,
  };
}

describe("scene binding (ADR-003 D1, ADR-015 D3)", () => {
  // `preview` is the wall chain being drawn, and it is not project content, so S-003's tree order has
  // nothing to say about it. It sits after overlay because it must paint above the walls it previews,
  // and before lights because S-001 puts the lights last.
  it("S-001 S-003 the scene is ordered ground, rooms, walls, items, overlay, preview, lights", () => {
    const b = new SceneBinding();
    expect(b.scene.children.map((c) => c.name)).toEqual([
      "ground",
      "rooms",
      "walls",
      "items",
      "overlay",
      "preview",
      "lights",
    ]);
  });

  it("builds a mesh per wall part, per room part and per item from the fixture", () => {
    const b = new SceneBinding();
    const p = run(fixture(), {
      type: "room.create",
      payload: { levelId: L, atPoint: { x: 2000, y: 2000 } },
    }).project;
    const withItem = run(p, {
      type: "item.place",
      payload: { levelId: L, ref: BOX, position: { x: 2000, y: 2000 } },
    }).project;
    b.setProject(withItem);
    expect(b.objectsOf("wall_000001").length).toBeGreaterThanOrEqual(5); // sides, top, two caps
    expect(b.objectsOf("opening_000001").length).toBeGreaterThanOrEqual(2); // head and jambs
    const room = withItem.rooms[0]?.id as string;
    expect(
      b
        .objectsOf(room)
        .map((o) => (o.userData as { part: string }).part)
        .sort(),
    ).toEqual(["ceiling", "floor"]);
    expect(b.objectsOf(withItem.items[0]?.id as string)).toHaveLength(1);
    expect(b.bounds.isEmpty()).toBe(false);
    expect(b.bounds.max.x).toBeCloseTo(8.05, 2);
    expect(b.ground.children).toHaveLength(1);
  });

  it("S-037 S-038 many changes in one turn flush once per frame and rebuild only the dirty entities", () => {
    const { scheduler, pump } = manualFrames();
    const b = new SceneBinding({ scheduler });
    b.setProject(fixture());
    pump();
    expect(b.flushes).toBe(1);
    const before = b.objectsOf("wall_000004")[0];
    const untouched = b.objectsOf("wall_000002")[0];
    let p = fixture();
    for (const dy of [10, 20, 30]) {
      const r = run(p, { type: "wall.move", payload: { wallIds: ["wall_000004"], dx: 0, dy } });
      p = r.project;
      b.onChanges(r.changes, p);
    }
    expect(b.flushes).toBe(1);
    pump();
    expect(b.flushes).toBe(2);
    expect(b.objectsOf("wall_000004")[0]).not.toBe(before); // rebuilt
    expect(b.objectsOf("wall_000003")[0]).not.toBe(before); // joined neighbours follow (commands list them)
    expect(b.objectsOf("wall_000002")[0]).toBe(untouched); // wall 2 is not joined to wall 4
  });

  it("S-005 S-055 a deleted entity's objects are dropped; after dispose nothing updates", () => {
    const b = new SceneBinding();
    const p0 = fixture();
    b.setProject(p0);
    const r = run(p0, { type: "wall.delete", payload: { wallIds: ["wall_000001"] } });
    b.onChanges(r.changes, r.project);
    expect(b.objectsOf("wall_000001")).toHaveLength(0);
    expect(b.objectsOf("opening_000001")).toHaveLength(0);
    expect(
      b.walls.children.every((c) => (c.userData as { entityId: string }).entityId !== "wall_000001"),
    ).toBe(true);
    const flushes = b.flushes;
    b.dispose();
    b.setProject(fixture());
    expect(b.flushes).toBe(flushes);
    expect(b.scene.children).toHaveLength(0);
  });

  it("S-047 S-048 S-049 reversed: hidden items and unviewable levels are neither rendered nor counted in the exact bounds", () => {
    const b = new SceneBinding();
    const p = run(fixture(), {
      type: "item.place",
      payload: { levelId: L, ref: BOX, position: { x: 20000, y: 20000 } },
    }).project;
    b.setProject(p);
    expect(b.bounds.max.x).toBeGreaterThan(19);
    const hidden = { ...p, items: p.items.map((i) => ({ ...i, visible: false })) };
    b.setProject(hidden);
    expect(b.objectsOf(p.items[0]?.id as string)[0]?.visible).toBe(false);
    expect(b.bounds.max.x).toBeCloseTo(8.05, 2);
    const unviewable = { ...p, levels: p.levels.map((l) => ({ ...l, viewable: false })) };
    b.setProject(unviewable);
    expect(b.walls.children.every((c) => !c.visible)).toBe(true);
    expect(b.bounds.isEmpty()).toBe(true);
  });

  it("R-087 S-034 the selection outline follows selected visible objects only", () => {
    const b = new SceneBinding();
    b.setProject(fixture());
    expect(b.overlay.children).toHaveLength(0);
    b.setSelection(["wall_000002"]);
    expect(b.overlay.children.length).toBe(b.objectsOf("wall_000002").length);
    expect(b.overlay.children.every((c) => c instanceof THREE.LineSegments)).toBe(true);
    b.setSelection([]);
    expect(b.overlay.children).toHaveLength(0);
  });

  it("R-087 the selection outline follows the selected wall when it changes shape", () => {
    const b = new SceneBinding();
    const p = fixture();
    b.setProject(p);
    b.setSelection(["wall_000002"]);
    const outline = () => new THREE.Box3().setFromObject(b.overlay);
    const before = outline();
    const r = run(p, {
      type: "wall.modify",
      payload: { wallId: "wall_000002", changes: { thickness: 600 } },
    });
    b.onChanges(r.changes, r.project);
    const after = outline();
    const mesh = new THREE.Box3();
    for (const o of b.objectsOf("wall_000002")) mesh.expandByObject(o);
    // wall 2 runs along y, so its thickness is its extent in x
    expect(after.max.x - after.min.x).toBeGreaterThan(before.max.x - before.min.x);
    expect(after.min.x).toBeCloseTo(mesh.min.x, 3);
    expect(after.max.x).toBeCloseTo(mesh.max.x, 3);
  });

  it("R-088 a ray from above hits the floor, never the ceiling; the ground is not pickable", () => {
    const b = new SceneBinding();
    const p = run(fixture(), {
      type: "room.create",
      payload: { levelId: L, atPoint: { x: 2000, y: 2000 } },
    }).project;
    b.setProject(p);
    const ray = new THREE.Raycaster(new THREE.Vector3(2, 10, -2), new THREE.Vector3(0, -1, 0));
    const hit = b.pick(ray);
    expect(hit?.part).toBe("floor");
    expect(hit?.point).toEqual({ x: 2000, y: 2000 });
    const outside = new THREE.Raycaster(new THREE.Vector3(50, 10, -50), new THREE.Vector3(0, -1, 0));
    expect(b.pick(outside)).toBeNull();
  });

  it("S-051 S-054 the ground is a plane sized from the bounds, visible only from above; S-050 clipping follows the bounds", () => {
    const b = new SceneBinding();
    b.setProject(fixture());
    const ground = b.ground.children[0] as THREE.Mesh;
    const gb = new THREE.Box3().setFromObject(ground);
    expect(gb.min.x).toBeLessThan(b.bounds.min.x - 9); // bounds plus a 10 m margin
    expect(gb.max.z).toBeGreaterThan(b.bounds.max.z + 9);
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 5, 0);
    b.updateCamera(cam);
    expect(b.ground.children[0]?.visible).toBe(true);
    cam.position.set(0, -5, 0);
    b.updateCamera(cam);
    expect(b.ground.children[0]?.visible).toBe(false);
    expect(clippingFor(20, 10)).toEqual({ near: 0.05, far: 60 });
    expect(clippingFor(2000, 10).near).toBe(2);
    expect(clippingFor(0, 0).far).toBe(400);
  });

  it("S-042 a product without an asset renders as a placeholder box at its size", () => {
    const b = new SceneBinding();
    const withCatalog: Ctx = {
      ...ctx,
      catalog: { product: (id) => ({ id, dims: { w: 1800, d: 800, h: 750 }, snapshotAt: ctx.now() }) },
    };
    const r = apply(
      fixture(),
      {
        type: "item.place",
        payload: {
          levelId: L,
          ref: { kind: "product", productId: "acme-desk" },
          position: { x: 3000, y: 2000 },
          rotation: 0,
        },
      },
      withCatalog,
    );
    if (!r.ok) throw new Error(r.error.message);
    const p = r.project;
    b.setProject(p);
    const mesh = b.objectsOf(p.items[0]?.id as string)[0] as THREE.Mesh;
    expect((mesh.material as THREE.Material).name).toBe("placeholder");
    const box = new THREE.Box3().setFromObject(mesh);
    expect(box.max.x - box.min.x).toBeCloseTo(1.8, 5);
    expect(box.max.y - box.min.y).toBeCloseTo(0.75, 5);
  });
});

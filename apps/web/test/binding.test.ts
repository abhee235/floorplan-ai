import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apply, type Ctx } from "@fpv/commands";
import { Project, type Project as ProjectT, sequentialIdGenerator } from "@fpv/ir";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  clippingFor,
  frameScheduler,
  ModelCache,
  type ModelLoad,
  ModelRegistry,
  namesUnknownModel,
  SceneBinding,
} from "../src/index.js";

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

  /** Places a product the given catalogue knows, and returns the project. */
  const placeProduct = (
    product: Record<string, unknown>,
    at = { x: 3000, y: 2000 },
    p: ProjectT = fixture(),
  ): ProjectT => {
    const withCatalog: Ctx = {
      ...ctx,
      catalog: { product: (id) => ({ id, snapshotAt: ctx.now(), ...product }) },
    };
    const r = apply(
      p,
      {
        type: "item.place",
        payload: {
          levelId: L,
          ref: { kind: "product", productId: product.id as string },
          position: at,
          rotation: 0,
          magnetism: false,
        },
      },
      withCatalog,
    );
    if (!r.ok) throw new Error(r.error.message);
    return r.project;
  };
  const sizeOf = (objects: THREE.Object3D[]) => {
    const box = new THREE.Box3();
    for (const o of objects) box.expandByObject(o);
    return box.getSize(new THREE.Vector3());
  };
  const materialOf = (o: THREE.Object3D | undefined) =>
    (o as THREE.Mesh).material as THREE.MeshStandardMaterial;

  it("S-042 a product whose model is not loaded renders as a white placeholder box at its size", () => {
    const b = new SceneBinding({
      assets: {
        keyFor: (id) => (id === "acme-desk" ? "desk/acme/std" : null),
        bbox: () => ({ w: 1.6, d: 0.7, h: 0.72 }),
      },
    });
    const p = placeProduct({ id: "acme-desk", category: "desk", dims: { w: 1800, d: 800, h: 750 } });
    b.setProject(p);
    const objects = b.objectsOf(p.items[0]?.id as string);
    expect(objects).toHaveLength(1);
    expect(materialOf(objects[0]).name).toBe("placeholder");
    const size = sizeOf(objects);
    expect([size.x, size.y, size.z].map((v) => Number(v.toFixed(5)))).toEqual([1.8, 0.75, 0.8]);
  });

  it("draws a product without a model as its category's recipe, part by part, at its size (spec 02 3.1)", () => {
    const b = new SceneBinding();
    const p = placeProduct({ id: "acme-chair", category: "chair", dims: { w: 640, d: 580, h: 1000 } });
    b.setProject(p);
    const objects = b.objectsOf(p.items[0]?.id as string);
    expect(objects.map((o) => (o.userData as { slot: string }).slot)).toEqual(["fabric", "frame"]);
    expect(objects.map((o) => materialOf(o).name)).toEqual(["chair/fabric", "chair/frame"]);
    const size = sizeOf(objects);
    expect([size.x, size.y, size.z].map((v) => Number(v.toFixed(5)))).toEqual([0.64, 1, 0.58]);
    // a category with no recipe of its own is a box
    const plant = placeProduct({ id: "acme-plant", category: "plant", dims: { w: 400, d: 400, h: 1200 } });
    b.setProject(plant);
    expect(b.objectsOf(plant.items[0]?.id as string).map((o) => materialOf(o).name)).toEqual(["box/body"]);
  });

  it("P3-5 changing a chair's fabric slot updates the 3D view for that item only", () => {
    const { scheduler, pump } = manualFrames();
    const b = new SceneBinding({ scheduler });
    const chair = (x: number) => ({
      type: "item.place",
      payload: {
        levelId: L,
        ref: { kind: "recipe", recipe: { kind: "chair", size: { w: 600, d: 600, h: 900 } } },
        position: { x, y: 2000 },
        rotation: 0,
        magnetism: false,
      },
    });
    let p = run(run(fixture(), chair(2000)).project, chair(3000)).project;
    const [a, other] = p.items.map((i) => i.id) as [string, string];
    b.setProject(p);
    pump();
    const before = { a: b.objectsOf(a), other: b.objectsOf(other) };
    const sharedFabric = materialOf(before.other[0]);
    expect(materialOf(before.a[0])).toBe(sharedFabric);

    const r = run(p, {
      type: "item.setFinish",
      payload: {
        itemIds: [a],
        materials: {
          fabric: {
            color: "#AA3333",
            textureId: null,
            placement: null,
            mirrorForLeftSide: false,
            shininess: null,
          },
        },
      },
    });
    p = r.project;
    b.onChanges(r.changes, p);
    pump();
    const [fabric, frame] = b.objectsOf(a);
    expect(`#${materialOf(fabric).color.getHexString()}`).toBe("#aa3333");
    expect(materialOf(frame)).toBe(materialOf(before.a[1]));
    // the other chair was not rebuilt, and still shares the plain fabric
    expect(b.objectsOf(other)).toEqual(before.other);
    expect(materialOf(b.objectsOf(other)[0])).toBe(sharedFabric);
    expect(`#${sharedFabric.color.getHexString()}`).not.toBe("#aa3333");
  });
});

describe("models in the 3D view (ADR-003 D5, P3-8)", () => {
  const materialOf = (o: THREE.Object3D | undefined) =>
    (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
  const KEY = "user/0123456789abcdef/std";
  /** A model as a loader hands it over: a seat and a shade, each with its own named material. */
  const lampTemplate = () => {
    const root = new THREE.Group();
    const seat = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.5, 0.5).translate(0, 0.25, 0),
      new THREE.MeshStandardMaterial({ name: "fabric", color: 0x336699 }),
    );
    const shade = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.5, 0.2).translate(0, 0.75, 0),
      new THREE.MeshStandardMaterial({ name: "glass_shade", color: 0xffffff }),
    );
    root.add(seat, shade);
    return root;
  };
  const placeLamp = () => {
    const withCatalog: Ctx = {
      ...ctx,
      catalog: {
        product: (id) => ({
          id,
          snapshotAt: ctx.now(),
          category: "lighting",
          dims: { w: 1000, d: 1000, h: 2000 },
          deformable: true,
          assetKey: KEY,
          materialSlots: ["fabric", "glass_shade"],
        }),
      },
    };
    const r = apply(
      fixture(),
      {
        type: "item.place",
        payload: {
          levelId: L,
          ref: { kind: "product", productId: "user-lamp" },
          position: { x: 3000, y: 2000 },
          rotation: 0,
          magnetism: false,
        },
      },
      withCatalog,
    );
    if (!r.ok) throw new Error(r.error.message);
    return r.project;
  };
  const registry = () => {
    const models = new ModelRegistry();
    models.set([
      { key: KEY, bbox: { w: 0.5, d: 0.5, h: 1 }, materialSlots: ["fabric", "glass_shade"], sha256: null },
    ]);
    return models;
  };
  /** A loader the test settles by hand. */
  const pendingLoads = () => {
    const settle: { resolve: (o: THREE.Object3D) => void; reject: (e: Error) => void }[] = [];
    const load: ModelLoad = () =>
      new Promise<THREE.Object3D>((resolve, reject) => {
        settle.push({ resolve, reject });
      });
    return { load, settle };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("S-042 draws a box while the model loads, then the model at the item's size; picking finds the item", async () => {
    const { load, settle } = pendingLoads();
    const { scheduler, pump } = manualFrames();
    const b = new SceneBinding({ scheduler, assets: registry(), models: new ModelCache(load) });
    const p = placeLamp();
    const id = p.items[0]?.id as string;
    b.setProject(p);
    pump();
    expect(materialOf(b.objectsOf(id)[0]).name).toBe("placeholder");
    settle[0]?.resolve(lampTemplate());
    await tick();
    pump();
    const [group] = b.objectsOf(id);
    expect(group).toBeInstanceOf(THREE.Group);
    // the normalised 0.5 x 1 x 0.5 model scaled onto the product's 1000 x 2000 x 1000
    const size = new THREE.Box3().setFromObject(group as THREE.Object3D).getSize(new THREE.Vector3());
    expect([size.x, size.y, size.z].map((v) => Number(v.toFixed(5)))).toEqual([1, 2, 1]);
    // a ray straight down onto the item lands on one of the model's meshes and names the item
    const ray = new THREE.Raycaster(new THREE.Vector3(3, 10, -2), new THREE.Vector3(0, -1, 0));
    expect(b.pick(ray)?.entityId).toBe(id);
    // selected, it is outlined by its box, not by every edge of its mesh
    b.setSelection([id]);
    pump();
    expect(b.overlay.children).toHaveLength(1);
  });

  it("shares the model between items, and finishes only the parts a finish reaches (ADR-010 D8)", async () => {
    const template = lampTemplate();
    const b = new SceneBinding({ assets: registry(), models: new ModelCache(async () => template) });
    b.setProject(placeLamp());
    await tick();
    const red = {
      color: "#CC2200",
      shininess: null,
      textureId: null,
      placement: null,
      mirrorForLeftSide: false,
    };
    const placed = placeLamp();
    const p = run(placed, {
      type: "item.setFinish",
      payload: { itemIds: [placed.items[0]?.id], finish: red },
    }).project;
    b.setProject(p);
    const meshes: THREE.Mesh[] = [];
    b.objectsOf(p.items[0]?.id as string)[0]?.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    const [seat, shade] = meshes;
    // the template's geometry is shared, never copied per item
    expect(seat?.geometry).toBe((template.children[0] as THREE.Mesh).geometry);
    expect(`#${materialOf(seat).color.getHexString()}`).toBe("#cc2200");
    // glass keeps its look under a whole-item finish
    expect(shade?.material).toBe((template.children[1] as THREE.Mesh).material);
  });

  it("S-043 a model that cannot be loaded is a red box, and the log names it once", async () => {
    const { load, settle } = pendingLoads();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = new SceneBinding({ assets: registry(), models: new ModelCache(load) });
    const p = placeLamp();
    b.setProject(p);
    settle[0]?.reject(new Error("404"));
    await tick();
    expect(materialOf(b.objectsOf(p.items[0]?.id as string)[0]).name).toBe("failed");
    b.refreshAssets();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(KEY);
    warn.mockRestore();
  });

  it("asks for the list again when a project names a model the tab was not told of, once per key", () => {
    const models = new ModelRegistry();
    models.set([{ key: KEY, bbox: { w: 1, d: 1, h: 1 }, materialSlots: [], sha256: "a" }]);
    const seen = new Set<string>();
    const refs = (...keys: (string | null)[]) =>
      Object.fromEntries(keys.map((assetKey, i) => [`p${i}`, { assetKey }]));
    expect(namesUnknownModel(refs(KEY, null), seen, models)).toBe(false);
    // imported elsewhere after this tab asked: ask again, but only the first time the key is seen
    expect(namesUnknownModel(refs(KEY, "user/fedcba9876543210/std"), seen, models)).toBe(true);
    expect(namesUnknownModel(refs(KEY, "user/fedcba9876543210/std"), seen, models)).toBe(false);
    // a recipe's key is not a model either, and is not asked about twice
    expect(namesUnknownModel(refs("chair/task/std"), seen, models)).toBe(true);
    expect(namesUnknownModel(refs("chair/task/std"), seen, models)).toBe(false);
  });

  it("asks again for a model whose file changed, and drops one that went", () => {
    const models = new ModelRegistry();
    models.set([{ key: KEY, bbox: { w: 1, d: 1, h: 1 }, materialSlots: [], sha256: "a" }]);
    expect(models.set([{ key: KEY, bbox: { w: 1, d: 1, h: 1 }, materialSlots: [], sha256: "a" }])).toEqual(
      [],
    );
    expect(models.set([{ key: KEY, bbox: { w: 1, d: 1, h: 1 }, materialSlots: [], sha256: "b" }])).toEqual([
      KEY,
    ]);
    expect(models.set([])).toEqual([KEY]);
    expect(models.bbox(KEY)).toBeNull();
  });
});

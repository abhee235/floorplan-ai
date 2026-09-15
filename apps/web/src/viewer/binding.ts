// The three.js binding (ADR-003 D1): one scene, a map from entity id to objects, and a dirty set that
// is flushed once per animation frame (ADR-015 D3). Pure scene-graph code: no renderer, no DOM, so it
// runs in Node tests.
import type { ChangeSet } from "@fpv/commands";
import {
  buildGround,
  buildItems,
  buildRecipe,
  buildRooms,
  buildWalls,
  emptyRebuildSet,
  expand,
  type GeometryPart,
  type ItemInstance,
  type RebuildSet,
  snapshotCutOuts,
} from "@fpv/engine";
import { wallFootprints } from "@fpv/geometry";
import type { Item, Level, Point, Project } from "@fpv/ir";
import { derive } from "@fpv/ir";
import * as THREE from "three";
import { MaterialCache } from "./materials.js";

/** Schedules one flush per frame; the browser uses requestAnimationFrame, tests call flush themselves. */
export interface Scheduler {
  schedule(flush: () => void): void;
}

export const immediateScheduler: Scheduler = { schedule: (f) => f() };

/** Coalesces any number of schedule calls per turn into one flush (S-037, S-038). */
export function frameScheduler(raf: (cb: () => void) => void): Scheduler {
  let queued = false;
  return {
    schedule(flush) {
      if (queued) return;
      queued = true;
      raf(() => {
        queued = false;
        flush();
      });
    },
  };
}

export interface BindingOptions {
  scheduler?: Scheduler;
  sizes?: derive.SizeSource;
}

export class SceneBinding {
  readonly scene = new THREE.Scene();
  readonly ground = new THREE.Group();
  readonly rooms = new THREE.Group();
  readonly walls = new THREE.Group();
  readonly items = new THREE.Group();
  readonly overlay = new THREE.Group();
  readonly lights = new THREE.Group();
  readonly bounds = new THREE.Box3();
  private readonly objects = new Map<string, THREE.Object3D[]>();
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly materials = new MaterialCache();
  private readonly scheduler: Scheduler;
  private dirty: RebuildSet = emptyRebuildSet();
  private full = false;
  private project: Project | null = null;
  private selection: string[] = [];
  private groundMesh: THREE.Mesh | null = null;
  private groundElevation = 0;
  private disposed = false;
  private sizes: derive.SizeSource | null;
  flushes = 0;

  constructor(options: BindingOptions = {}) {
    this.scheduler = options.scheduler ?? immediateScheduler;
    this.sizes = options.sizes ?? null;
    // S-001, S-003: ground, then rooms, walls, items, overlay; lights last.
    this.ground.name = "ground";
    this.rooms.name = "rooms";
    this.walls.name = "walls";
    this.items.name = "items";
    this.overlay.name = "overlay";
    this.lights.name = "lights";
    this.scene.add(this.ground, this.rooms, this.walls, this.items, this.overlay, this.lights);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(8, 14, 6);
    sun.castShadow = true;
    const sky = new THREE.HemisphereLight(0xffffff, 0xa8a8a8, 1.2);
    this.lights.add(sun, sky);
  }

  /** Replace the project: everything is rebuilt on the next flush. */
  setProject(project: Project): void {
    this.project = project;
    this.full = true;
    this.scheduler.schedule(() => this.flush());
  }

  /** Feed a change set; the rebuild set is merged until the next flush. */
  onChanges(changes: ChangeSet, project: Project): void {
    this.project = project;
    if (changes.updated.some((r) => r.type === "meta")) this.full = true;
    else expand(changes, project, this.dirty);
    this.scheduler.schedule(() => this.flush());
  }

  setSelection(ids: string[]): void {
    this.selection = [...ids];
    this.dirty.layers.add("overlay");
    this.scheduler.schedule(() => this.flush());
  }

  objectsOf(entityId: string): THREE.Object3D[] {
    return this.objects.get(entityId) ?? [];
  }

  /** Rebuild what is dirty (ADR-015 D3): walls, rooms, items, ground, overlay. */
  flush(): void {
    if (this.disposed || !this.project) return;
    const p = this.project;
    const dirty = this.dirty;
    this.dirty = emptyRebuildSet();
    this.flushes += 1;
    const full = this.full;
    this.full = false;
    if (full) for (const id of [...this.objects.keys()]) this.drop(id);
    for (const ref of dirty.removed) this.drop(ref.id);

    const levels = [...p.levels].sort(derive.compareLevels);
    const lowest = levels[0];
    const highest = levels[levels.length - 1];
    const sizes = this.sizes ?? derive.snapshotSizeSource(p);
    const cutOuts = snapshotCutOuts(p);

    for (const level of levels) {
      const ctx = { level, isLowest: level === lowest, isHighest: level === highest };
      // walls: footprints for the whole level (joins need neighbours), parts only for dirty walls
      const wallsOnLevel = p.walls.filter((w) => w.levelId === level.id);
      const dirtyWalls = full ? wallsOnLevel : wallsOnLevel.filter((w) => dirty.walls.has(w.id));
      if (dirtyWalls.length > 0) {
        const footprints = wallFootprints(wallsOnLevel);
        const parts = buildWalls(dirtyWalls, p.openings, { ...ctx, footprints, cutOuts });
        // opening parts (sill, head, jambs) belong to the opening id but are rebuilt with their wall
        const wallIds = new Set(dirtyWalls.map((w) => w.id));
        const openingIds = p.openings.filter((o) => wallIds.has(o.wallId)).map((o) => o.id);
        this.replaceParts([...wallIds, ...openingIds], parts, this.walls, level);
      }
      const roomsOnLevel = p.rooms.filter((r) => r.levelId === level.id);
      const dirtyRooms = full ? roomsOnLevel : roomsOnLevel.filter((r) => dirty.rooms.has(r.id));
      if (dirtyRooms.length > 0) {
        const wanted = new Set(dirtyRooms.map((r) => r.id));
        const parts = buildRooms(roomsOnLevel, ctx).filter((part) => wanted.has(part.entityId));
        this.replaceParts([...wanted], parts, this.rooms, level);
      }
      const itemsOnLevel = p.items.filter((i) => i.levelId === level.id);
      const dirtyItems = full ? itemsOnLevel : itemsOnLevel.filter((i) => dirty.items.has(i.id));
      if (dirtyItems.length > 0) {
        const instances = buildItems(dirtyItems, { level, sizes });
        this.replaceItems(dirtyItems, instances, level, sizes);
      }
    }
    if (full || dirty.bounds || dirty.ground) this.updateBounds();
    if (full || dirty.ground || dirty.bounds) this.updateGround();
    if (full || dirty.layers.has("overlay")) this.updateOverlay();
  }

  private drop(id: string): void {
    const objs = this.objects.get(id);
    if (!objs) return;
    for (const o of objs) {
      o.removeFromParent();
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        const g = o.geometry as THREE.BufferGeometry;
        if (!this.geometries.has(g.name)) g.dispose();
      }
    }
    this.objects.delete(id);
  }

  private replaceParts(ids: string[], parts: GeometryPart[], group: THREE.Group, level: Level): void {
    // new geometry first, then drop the old (ADR-015 D3: no frame shows a missing entity)
    const fresh = new Map<string, THREE.Object3D[]>();
    for (const part of parts) {
      const geometry = toGeometry(part);
      const mesh = new THREE.Mesh(geometry, this.materials.get(part.materialKey));
      mesh.name = `${part.entityId}:${part.part}`;
      mesh.userData = { entityId: part.entityId, part: part.part };
      mesh.castShadow = part.part.startsWith("wall");
      mesh.receiveShadow = true;
      mesh.visible = level.viewable;
      if (part.part === "ceiling") mesh.raycast = () => {}; // R-088: ceilings are not pickable
      (
        fresh.get(part.entityId) ?? (fresh.set(part.entityId, []).get(part.entityId) as THREE.Object3D[])
      ).push(mesh);
    }
    for (const id of ids) {
      const objs = fresh.get(id) ?? [];
      for (const o of objs) group.add(o);
      this.drop(id);
      if (objs.length > 0) this.objects.set(id, objs);
    }
  }

  private replaceItems(
    items: Item[],
    instances: ItemInstance[],
    level: Level,
    sizes: derive.SizeSource,
  ): void {
    const byId = new Map(instances.map((i) => [i.entityId, i]));
    for (const item of items) {
      const inst = byId.get(item.id);
      const size = derive.itemSize(item, sizes);
      let mesh: THREE.Mesh | null = null;
      if (inst && size) {
        const geometry = this.itemGeometry(item, inst.assetKey, size);
        const materialKey = item.ref.kind === "recipe" ? inst.assetKey : "placeholder";
        mesh = new THREE.Mesh(geometry, this.materials.get(materialKey));
        mesh.name = `${item.id}:item`;
        mesh.userData = { entityId: item.id, part: "item" };
        mesh.matrix.fromArray(inst.matrix);
        mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
        mesh.updateMatrixWorld(true);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // S-047: rendered only when the item and its level are visible
        mesh.visible = inst.visible && level.viewable;
        this.items.add(mesh);
      }
      this.drop(item.id);
      if (mesh) this.objects.set(item.id, [mesh]);
    }
  }

  /** Recipes build their exact shape; products get a placeholder box at their size until assets load (S-042). */
  private itemGeometry(
    item: Item,
    assetKey: string,
    size: { w: number; d: number; h: number },
  ): THREE.BufferGeometry {
    let g = this.geometries.get(assetKey);
    if (g) return g;
    const part =
      item.ref.kind === "recipe"
        ? buildRecipe(item.ref.recipe)
        : buildRecipe({ kind: "box", size, label: item.ref.productId });
    g = toGeometry(part);
    g.name = assetKey;
    this.geometries.set(assetKey, g);
    return g;
  }

  /** Bounds from the visible objects' geometry (S-048 reversed: one visibility rule for bounds and rendering). */
  private updateBounds(): void {
    this.bounds.makeEmpty();
    const box = new THREE.Box3();
    for (const group of [this.walls, this.rooms, this.items]) {
      for (const o of group.children) {
        if (!o.visible) continue;
        box.setFromObject(o);
        if (!box.isEmpty()) this.bounds.union(box);
      }
    }
  }

  /** The engine's ground slab under the lowest level, with room floors cut out (S-051; R-089..R-100 simplified). */
  private updateGround(): void {
    if (this.groundMesh) {
      this.groundMesh.removeFromParent();
      this.groundMesh.geometry.dispose();
      this.groundMesh = null;
    }
    if (!this.project) return;
    const ground = buildGround(this.project, {
      sizes: this.sizes ?? derive.snapshotSizeSource(this.project),
    });
    this.groundElevation = ground.elevation / 1000;
    if (!ground.part) return;
    const mesh = new THREE.Mesh(toGeometry(ground.part), this.materials.get("ground"));
    mesh.name = "ground";
    mesh.userData = { entityId: ground.part.entityId, part: ground.part.part };
    mesh.receiveShadow = true;
    mesh.raycast = () => {};
    this.ground.add(mesh);
    this.groundMesh = mesh;
  }

  /** Selection outline (R-087, S-034): edges of every visible object of a selected entity. */
  private updateOverlay(): void {
    for (const o of [...this.overlay.children]) {
      o.removeFromParent();
      if (o instanceof THREE.LineSegments) o.geometry.dispose();
    }
    const material = new THREE.LineBasicMaterial({ color: 0x1e88e5 });
    for (const id of this.selection) {
      for (const o of this.objectsOf(id)) {
        if (!(o instanceof THREE.Mesh) || !o.visible) continue;
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(o.geometry as THREE.BufferGeometry, 20),
          material,
        );
        edges.name = `${id}:outline`;
        edges.position.copy(o.position);
        edges.quaternion.copy(o.quaternion);
        edges.scale.copy(o.scale);
        this.overlay.add(edges);
      }
    }
  }

  /** Per-frame camera coupling: the ground is visible only from above (S-054). */
  updateCamera(camera: THREE.Camera): void {
    if (this.groundMesh) this.groundMesh.visible = camera.position.y >= this.groundElevation;
  }

  /** Point in plan mm under a ray, or null. */
  pick(raycaster: THREE.Raycaster): { entityId: string; part: string; point: Point } | null {
    const hits = raycaster.intersectObjects(
      [...this.walls.children, ...this.rooms.children, ...this.items.children],
      false,
    );
    const hit = hits.find((h) => h.object.visible);
    if (!hit) return null;
    const { entityId, part } = hit.object.userData as { entityId: string; part: string };
    return {
      entityId,
      part,
      point: { x: Math.round(hit.point.x * 1000), y: Math.round(-hit.point.z * 1000) },
    };
  }

  /** S-055: release every object, geometry and material; further updates are ignored. */
  dispose(): void {
    this.disposed = true;
    for (const id of [...this.objects.keys()]) this.drop(id);
    for (const g of this.geometries.values()) g.dispose();
    this.geometries.clear();
    this.groundMesh?.geometry.dispose();
    this.groundMesh = null;
    this.materials.dispose();
    this.scene.clear();
  }
}

/** Engine buffers to a BufferGeometry, sharing the typed arrays (ADR-003 D2). */
export function toGeometry(part: GeometryPart): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(part.positions, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(part.normals, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(part.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(part.indices, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

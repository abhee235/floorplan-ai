// The three.js binding (ADR-003 D1): one scene, a map from entity id to objects, and a dirty set that
// is flushed once per animation frame (ADR-015 D3). Pure scene-graph code: no renderer, no DOM, so it
// runs in Node tests.
import type { ChangeSet } from "@fpv/commands";
import {
  type AssetRegistry,
  buildGround,
  buildItems,
  buildRecipe,
  buildRecipeParts,
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
import type { Item, Level, Point, Project, Wall } from "@fpv/ir";
import { defaultRoom, defaultWall, derive } from "@fpv/ir";
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
  /** Model assets for products; without one a product is drawn as its category's recipe. */
  assets?: AssetRegistry;
}

export class SceneBinding {
  readonly scene = new THREE.Scene();
  readonly ground = new THREE.Group();
  readonly rooms = new THREE.Group();
  readonly walls = new THREE.Group();
  readonly items = new THREE.Group();
  readonly overlay = new THREE.Group();
  /** The wall chain being drawn right now, before it is committed. Its own group on purpose: overlay is
   *  emptied and rebuilt from the selection on every flush, so a preview parked there would vanish the
   *  moment anything was selected or a patch arrived. */
  readonly preview = new THREE.Group();
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
  private readonly assets: AssetRegistry | undefined;
  flushes = 0;

  constructor(options: BindingOptions = {}) {
    this.scheduler = options.scheduler ?? immediateScheduler;
    this.sizes = options.sizes ?? null;
    this.assets = options.assets;
    // S-001, S-003: ground, then rooms, walls, items, overlay; lights last.
    this.ground.name = "ground";
    this.rooms.name = "rooms";
    this.walls.name = "walls";
    this.items.name = "items";
    this.overlay.name = "overlay";
    this.preview.name = "preview";
    this.lights.name = "lights";
    this.scene.add(this.ground, this.rooms, this.walls, this.items, this.overlay, this.preview, this.lights);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(8, 14, 6);
    sun.castShadow = true;
    const sky = new THREE.HemisphereLight(0xffffff, 0xa8a8a8, 1.2);
    this.lights.add(sun, sky);
  }

  /** The reflections glass and its frames show; see MaterialCache.setEnvironment. */
  setEnvironment(texture: THREE.Texture | null): void {
    this.materials.setEnvironment(texture);
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
    // The outline is edges of the selected meshes as they were when it was built, and a change replaces
    // those meshes: without this it went on tracing the old shape. Any change, not only one to a selected
    // id, because a neighbour's change reshapes a selected wall's mitred corner too.
    if (this.selection.length > 0) this.dirty.layers.add("overlay");
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
        const instances = buildItems(dirtyItems, {
          level,
          sizes,
          ...(this.assets ? { assets: this.assets } : {}),
        });
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
      const meshes: THREE.Mesh[] = [];
      if (inst && size) {
        // One mesh per part, each with its part's material. Geometry is shared by every item drawn from the
        // same recipe; the material is shared by every part with the same finish. So a chair given its own
        // fabric gets a different material on that one mesh, and no other chair is touched.
        const parts = inst.recipe
          ? this.recipeGeometries(inst.assetKey, inst.recipe).map(({ slot, geometry }) => ({
              slot,
              geometry,
              materialKey: inst.materials.find((m) => m.slot === slot)?.materialKey ?? "item",
            }))
          : [
              {
                slot: null,
                geometry: this.placeholderGeometry(inst.assetKey, size),
                materialKey: "placeholder",
              },
            ];
        for (const part of parts) {
          const mesh = new THREE.Mesh(part.geometry, this.materials.get(part.materialKey));
          mesh.name = part.slot ? `${item.id}:item:${part.slot}` : `${item.id}:item`;
          mesh.userData = { entityId: item.id, part: "item", ...(part.slot ? { slot: part.slot } : {}) };
          mesh.matrix.fromArray(inst.matrix);
          mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
          mesh.updateMatrixWorld(true);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          // S-047: rendered only when the item and its level are visible
          mesh.visible = inst.visible && level.viewable;
          this.items.add(mesh);
          meshes.push(mesh);
        }
      }
      this.drop(item.id);
      if (meshes.length > 0) this.objects.set(item.id, meshes);
    }
  }

  /** A recipe's parts, built once per recipe and shared by every item drawn from it. */
  private recipeGeometries(
    assetKey: string,
    recipe: NonNullable<ItemInstance["recipe"]>,
  ): { slot: string; geometry: THREE.BufferGeometry }[] {
    const slots = derive.recipeSlots(recipe.kind);
    const cached = slots.map((slot) => ({ slot, geometry: this.geometries.get(`${assetKey}#${slot}`) }));
    if (cached.every((c) => c.geometry)) return cached as { slot: string; geometry: THREE.BufferGeometry }[];
    return buildRecipeParts(recipe).map((part) => {
      const name = `${assetKey}#${part.slot}`;
      const known = this.geometries.get(name);
      if (known) return { slot: part.slot, geometry: known };
      const geometry = toGeometry(part);
      geometry.name = name;
      this.geometries.set(name, geometry);
      return { slot: part.slot, geometry };
    });
  }

  /**
   * S-042: a white box standing in for a model asset this viewer has not loaded. It is built at the asset's
   * own size where the registry knows it, because the item's matrix scales from that size to the item's.
   */
  private placeholderGeometry(
    assetKey: string,
    size: { w: number; d: number; h: number },
  ): THREE.BufferGeometry {
    const bbox = this.assets?.bbox(assetKey);
    const at = bbox ? { w: bbox.w * 1000, d: bbox.d * 1000, h: bbox.h * 1000 } : size;
    const name = `placeholder:${assetKey}:${at.w}x${at.d}x${at.h}`;
    let g = this.geometries.get(name);
    if (g) return g;
    g = toGeometry(buildRecipe({ kind: "box", size: at, label: assetKey }));
    g.name = name;
    this.geometries.set(name, g);
    return g;
  }

  /**
   * The chain being drawn, shown in 3D as it is drawn rather than only once it commits.
   *
   * The points go through `defaultWall` and the real `buildWalls`, so what you see growing is the same
   * geometry the command will produce — mitred joins and all — instead of an approximation that drifts
   * from the result. Pass null to clear.
   *
   * Deliberately NOT routed through replaceParts: that registers meshes in `this.objects`, which is the
   * map picking, selection and `drop` all work from, and a half-drawn wall is not an entity. It has no
   * id to select, nothing should pick it, and a patch arriving mid-draw must not be able to delete it.
   */
  setWallPreview(
    points: readonly Point[],
    options: { levelId: string; thickness: number; kind?: string } | null = null,
  ): void {
    this.clearPreview("wall");
    if (!this.project || !options || points.length < 2) return;
    const level = this.project.levels.find((l) => l.id === options.levelId);
    if (!level) return;

    const walls = [];
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1] as Point;
      const b = points[i] as Point;
      if (a.x === b.x && a.y === b.y) continue; // a zero-length segment builds nothing and warns
      walls.push(
        defaultWall(`preview_${i}`, options.levelId, a, b, {
          thickness: Math.max(1, Math.round(options.thickness)),
          ...(options.kind ? { kind: options.kind as Wall["kind"] } : {}),
        }),
      );
    }
    if (walls.length === 0) return;

    const levels = [...this.project.levels].sort(derive.compareLevels);
    const parts = buildWalls(walls, [], {
      level,
      isLowest: levels[0]?.id === level.id,
      isHighest: levels[levels.length - 1]?.id === level.id,
    });
    for (const part of parts) {
      const mesh = new THREE.Mesh(toGeometry(part), this.materials.get(part.materialKey));
      mesh.name = `preview:${part.part}`;
      mesh.userData = { preview: "wall" };
      mesh.castShadow = false; // a wall that is not there yet should not darken the ones that are
      mesh.receiveShadow = false;
      mesh.raycast = () => {}; // never pickable: it has no entity to select
      this.preview.add(mesh);
    }
  }

  /**
   * The room ring being drawn, shown as its floor before it is committed.
   *
   * Same contract as setWallPreview and the same group, so starting one preview clears the other: only
   * one tool draws at a time, and a stale floor left under a wall chain would be worse than no preview.
   * buildRooms already skips a polygon under three points (R-061), so a half-drawn ring previews as
   * nothing without a guard here.
   */
  setRoomPreview(polygon: readonly Point[], options: { levelId: string } | null = null): void {
    this.clearPreview("room");
    if (!this.project || !options || polygon.length < 3) return;
    const level = this.project.levels.find((l) => l.id === options.levelId);
    if (!level) return;

    const levels = [...this.project.levels].sort(derive.compareLevels);
    const room = defaultRoom("preview_room", options.levelId, [...polygon]);
    const parts = buildRooms([room], { level, isLowest: levels[0]?.id === level.id });
    for (const part of parts) {
      const mesh = new THREE.Mesh(toGeometry(part), this.materials.get(part.materialKey));
      mesh.name = `preview:${part.part}`;
      mesh.userData = { preview: "room", ownMaterial: true };
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.raycast = () => {}; // never pickable: it has no entity to select
      // The floor sits exactly on the ground slab's top face — buildRooms uses level.elevation and so
      // does buildGround — so without this the two coplanar surfaces z-fight into stripes. polygonOffset
      // pushes the preview forward in depth only, leaving its real position alone.
      //
      // On a CLONE, never on the material MaterialCache returned. That cache hands the same instance to
      // every mesh sharing a key, so setting the offset on it would silently leave every committed room's
      // floor offset too, for the rest of the session — a global change to shared render state, made by a
      // preview, and subtle enough that nothing would look obviously wrong. clearPreview disposes it.
      const offset = (mesh.material as THREE.Material).clone();
      offset.polygonOffset = true;
      offset.polygonOffsetFactor = -1;
      offset.polygonOffsetUnits = -1;
      mesh.material = offset;
      this.preview.add(mesh);
    }
  }

  /**
   * Drop the drawing preview and its geometry. Safe to call when there is none.
   *
   * `kind` matters because both drawing tools are bound at once and share this group: clearing all of it
   * from either tool meant whichever moved last wiped the other's preview, non-deterministically. Omit it
   * only to clear everything, as teardown does.
   */
  clearPreview(kind?: "wall" | "room"): void {
    for (const o of [...this.preview.children]) {
      if (kind && o.userData?.preview !== kind) continue;
      o.removeFromParent();
      if (!(o instanceof THREE.Mesh)) continue;
      (o.geometry as THREE.BufferGeometry).dispose();
      // Only a material this preview cloned for itself. A cached one belongs to MaterialCache and is
      // shared with the committed geometry, so disposing it here would blank real meshes.
      if (o.userData?.ownMaterial) (o.material as THREE.Material).dispose();
    }
  }

  /**
   * Bounds from the visible objects' geometry (S-048 reversed: one visibility rule for bounds and rendering).
   *
   * The preview group is not among them, and that matters: bounds drive the camera, so counting a growing
   * preview here would widen the view on every pointer move and the 3D scene would drift outward as you
   * drew rather than holding still.
   */
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

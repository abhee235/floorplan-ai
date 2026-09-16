// Reducer context, change-set builder, and lookup helpers shared by all reducers.
import type { IdGenerator, Item, Level, Opening, Project, Room, Size3, Wall, Zone } from "@fpv/ir";
import { derive } from "@fpv/ir";
import { missingRef, precondition } from "./errors.js";

export type EntityType = "level" | "wall" | "opening" | "room" | "item" | "zone" | "annotation" | "meta";

export interface Ref {
  type: EntityType;
  id: string;
  /**
   * Set when only how the entity is drawn on the plan changed, so nothing built from it in 3D needs
   * rebuilding: a wall's pattern (W-121, S-011). Absent for every other change.
   */
  aspect?: "plan";
}

export interface ChangeSet {
  commandType: string;
  added: Ref[];
  updated: Ref[];
  removed: Ref[];
}

/** Product snapshot lookup used by commands to copy a snapshot into catalogRefs on first use. */
export interface CatalogSource {
  product(productId: string): Record<string, unknown> | null;
  /** A texture record by id, to copy into a project the first time a finish uses it (spec 02 section 2). */
  texture?(textureId: string): Record<string, unknown> | null;
}

export interface Ctx {
  ids: IdGenerator;
  now(): string;
  catalog?: CatalogSource;
}

export class Changes implements ChangeSet {
  readonly added: Ref[] = [];
  readonly updated: Ref[] = [];
  readonly removed: Ref[] = [];
  readonly warnings: string[] = [];
  constructor(readonly commandType: string) {}

  private has(list: Ref[], type: EntityType, id: string): boolean {
    return list.some((r) => r.type === type && r.id === id);
  }
  add(type: EntityType, id: string): void {
    if (!this.has(this.added, type, id)) this.added.push({ type, id });
  }
  /** Records an update; `aspect` narrows it to the plan, and any unnarrowed update of the same entity wins. */
  update(type: EntityType, id: string, aspect?: "plan"): void {
    if (this.has(this.added, type, id) || this.has(this.removed, type, id)) return;
    const i = this.updated.findIndex((r) => r.type === type && r.id === id);
    if (i < 0) this.updated.push(aspect ? { type, id, aspect } : { type, id });
    else if (!aspect) this.updated[i] = { type, id };
  }
  remove(type: EntityType, id: string): void {
    const i = this.added.findIndex((r) => r.type === type && r.id === id);
    if (i >= 0) this.added.splice(i, 1);
    const j = this.updated.findIndex((r) => r.type === type && r.id === id);
    if (j >= 0) this.updated.splice(j, 1);
    if (!this.has(this.removed, type, id)) this.removed.push({ type, id });
  }
  warn(message: string): void {
    this.warnings.push(message);
  }
  toChangeSet(): ChangeSet {
    return {
      commandType: this.commandType,
      added: [...this.added],
      updated: [...this.updated],
      removed: [...this.removed],
    };
  }
}

// ---- lookups (throw ref.missing) -----------------------------------------

export function levelById(p: Project, id: string): Level {
  const l = p.levels.find((x) => x.id === id);
  if (!l) throw missingRef("level", id);
  return l;
}
export function wallById(p: Project, id: string): Wall {
  const w = p.walls.find((x) => x.id === id);
  if (!w) throw missingRef("wall", id);
  return w;
}
export function openingById(p: Project, id: string): Opening {
  const o = p.openings.find((x) => x.id === id);
  if (!o) throw missingRef("opening", id);
  return o;
}
export function roomById(p: Project, id: string): Room {
  const r = p.rooms.find((x) => x.id === id);
  if (!r) throw missingRef("room", id);
  return r;
}
export function itemById(p: Project, id: string): Item {
  const i = p.items.find((x) => x.id === id);
  if (!i) throw missingRef("item", id);
  return i;
}
export function zoneById(p: Project, id: string): Zone {
  const z = p.zones.find((x) => x.id === id);
  if (!z) throw missingRef("zone", id);
  return z;
}

/** Items whose parent chain includes `rootId`, in breadth-first order. */
export function descendantsOf(p: Project, rootId: string): Item[] {
  const out: Item[] = [];
  const queue = [rootId];
  const seen = new Set<string>();
  while (queue.length) {
    const cur = queue.shift() as string;
    for (const it of p.items) {
      if (it.parentId === cur && !seen.has(it.id)) {
        seen.add(it.id);
        out.push(it);
        queue.push(it.id);
      }
    }
  }
  return out;
}

/** Item size from override, recipe, or the project's product snapshot; throws when unknown. */
export function sizeOf(p: Project, item: Item): Size3 {
  const s = derive.itemSize(item, derive.snapshotSizeSource(p));
  if (!s)
    throw missingRef(
      "product snapshot",
      item.ref.kind === "product" ? item.ref.productId : "recipe",
      item.id,
    );
  return s;
}

/** Copy a product snapshot into catalogRefs on first use (ADR-008 D5). */
/**
 * Copy into the project every texture these finishes name that it does not hold yet, as products are
 * copied on first use; refuse a texture the catalog does not have either, since validation would.
 */
export function requireTextures(
  p: Project,
  ctx: Ctx,
  finishes: readonly ({ textureId: string | null } | null | undefined)[],
  entityId: string | null,
): void {
  for (const f of finishes) {
    const id = f?.textureId;
    if (!id || id in p.textures) continue;
    const snap = ctx.catalog?.texture?.(id);
    if (!snap)
      throw precondition(
        "catalog.missing-texture",
        `texture "${id}" is not in the catalog`,
        entityId,
        "pick one of the catalog's textures",
      );
    p.textures[id] = { ...snap, id };
  }
}

export function ensureSnapshot(p: Project, ctx: Ctx, productId: string): boolean {
  if (productId in p.catalogRefs) return true;
  const snap = ctx.catalog?.product(productId);
  if (!snap) return false;
  p.catalogRefs[productId] = { ...snap, id: productId, snapshotAt: ctx.now() };
  return true;
}

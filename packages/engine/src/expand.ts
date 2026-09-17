// Invalidation: change sets in, rebuild sets out (ADR-015, spec 05 section 7).
// The table below is the whole dependency graph. Adding an entity kind means adding a row and a test.

import type { ChangeSet, Ref } from "@fpv/commands";
import { descendantsOf } from "@fpv/commands";
import type { Project } from "@fpv/ir";

export type Layer = "static" | "structure" | "items" | "overlay";

export interface RebuildSet {
  walls: Set<string>;
  rooms: Set<string>;
  items: Set<string>;
  /** Entities that no longer exist; the viewer drops their objects. */
  removed: Ref[];
  ground: boolean;
  bounds: boolean;
  layers: Set<Layer>;
}

export function emptyRebuildSet(): RebuildSet {
  return {
    walls: new Set(),
    rooms: new Set(),
    items: new Set(),
    removed: [],
    ground: false,
    bounds: false,
    layers: new Set(),
  };
}

function lowestLevelId(project: Project): string | null {
  let best: { id: string; elevation: number; index: number } | null = null;
  for (const l of project.levels) {
    if (!best || l.elevation < best.elevation || (l.elevation === best.elevation && l.index < best.index))
      best = l;
  }
  return best?.id ?? null;
}

/** Expand one change set into the entities and layers to rebuild. Pure; safe to union across changes. */
export function expand(
  changes: ChangeSet,
  project: Project,
  into: RebuildSet = emptyRebuildSet(),
): RebuildSet {
  const walls = new Map(project.walls.map((w) => [w.id, w]));
  const openings = new Map(project.openings.map((o) => [o.id, o]));
  const rooms = new Map(project.rooms.map((r) => [r.id, r]));
  const items = new Map(project.items.map((i) => [i.id, i]));
  const zones = new Map(project.zones.map((z) => [z.id, z]));
  const lowest = lowestLevelId(project);
  const levels = new Map(project.levels.map((l) => [l.id, l]));
  // S-010, S-021: anything on an underground level shows through the ground, so the ground follows it.
  const underground = (levelId: string | undefined) =>
    levelId ? (levels.get(levelId)?.elevation ?? 0) < 0 : false;

  // Commands already list joined neighbours in their change sets (their joins are rewritten), so a wall
  // ref expands to itself only; expanding again here would walk to neighbours-of-neighbours (W-119).
  const touchWall = (id: string) => {
    into.walls.add(id);
    into.layers.add("structure");
    into.bounds = true;
    if (underground(walls.get(id)?.levelId)) into.ground = true;
  };
  // An opening change touches only its wall; the wall's neighbours share mitred corners with it,
  // so their side polylines are rebuilt too (O-107).
  const touchWallOfOpening = (id: string) => {
    touchWall(id);
    const w = walls.get(id);
    if (!w) return;
    for (const end of ["start", "end"] as const) {
      const j = w.joins[end];
      if (j) into.walls.add(j.wallId);
    }
  };

  const rows = (ref: Ref, removed: boolean) => {
    switch (ref.type) {
      case "wall":
        // How the plan fills the wall is the plan's alone: redraw it, build nothing (W-121, S-011).
        if (ref.aspect === "plan" && !removed) {
          into.layers.add("structure");
          break;
        }
        touchWall(ref.id);
        if (removed) into.layers.add("structure");
        break;
      case "opening": {
        const o = openings.get(ref.id);
        if (o) touchWallOfOpening(o.wallId);
        into.layers.add("structure");
        break;
      }
      case "room": {
        const r = rooms.get(ref.id);
        into.rooms.add(ref.id);
        into.layers.add("structure");
        if (r && r.levelId === lowest) into.ground = true;
        if (removed) into.ground = true;
        break;
      }
      case "item": {
        into.items.add(ref.id);
        into.layers.add("items");
        into.bounds = true;
        if (underground(items.get(ref.id)?.levelId)) into.ground = true;
        if (items.has(ref.id)) for (const d of descendantsOf(project, ref.id)) into.items.add(d.id);
        break;
      }
      case "zone": {
        const z = zones.get(ref.id);
        for (const id of z?.generatedItemIds ?? []) into.items.add(id);
        into.layers.add("items");
        // The plan draws the zone's own ring and name on the overlay (P3-6), so moving or renaming one
        // has to redraw that layer as well as rebuilding whatever it generated.
        into.layers.add("overlay");
        break;
      }
      case "level": {
        for (const w of project.walls) if (w.levelId === ref.id) into.walls.add(w.id);
        for (const r of project.rooms) if (r.levelId === ref.id) into.rooms.add(r.id);
        for (const i of project.items) if (i.levelId === ref.id) into.items.add(i.id);
        into.ground = true;
        into.bounds = true;
        for (const l of ["static", "structure", "items", "overlay"] as const) into.layers.add(l);
        break;
      }
      case "annotation":
        into.layers.add("overlay");
        break;
      case "meta":
        into.layers.add("overlay");
        break;
    }
  };

  for (const ref of changes.added) rows(ref, false);
  for (const ref of changes.updated) rows(ref, false);
  for (const ref of changes.removed) {
    rows(ref, true);
    into.removed.push(ref);
    // a removed entity is not rebuilt
    if (ref.type === "wall") into.walls.delete(ref.id);
    if (ref.type === "room") into.rooms.delete(ref.id);
    if (ref.type === "item") into.items.delete(ref.id);
  }
  return into;
}

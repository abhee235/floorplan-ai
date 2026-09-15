// Level reducers (spec 03 section 2; ledger R-103..R-112, R-119..R-121; R-101/R-102 reversed: one level always).
import type { Level, Project } from "@fpv/ir";
import { DEFAULTS, defaultLevel } from "@fpv/ir";
import { type Changes, type Ctx, levelById } from "../context.js";
import { precondition } from "../errors.js";
import type { PayloadOf } from "../types.js";

function sortLevels(p: Project): void {
  p.levels.sort((a, b) => a.elevation - b.elevation || a.index - b.index);
}

function nextIndexAt(p: Project, elevation: number, excludeId?: string): number {
  let max = -1;
  for (const l of p.levels)
    if (l.id !== excludeId && l.elevation === elevation && l.index > max) max = l.index;
  return max + 1;
}

/** R-103, R-104, R-105: elevation from the top level plus its height and floor thickness, or a copy of `sameAs`. */
export function levelAdd(p: Project, payload: PayloadOf<"level.add">, ctx: Ctx, changes: Changes): Level {
  let elevation: number;
  let height: number;
  let floorThickness: number;
  if (payload.sameAs) {
    const ref = levelById(p, payload.sameAs);
    elevation = payload.elevation ?? ref.elevation;
    height = payload.height ?? ref.height;
    floorThickness = payload.floorThickness ?? ref.floorThickness;
  } else {
    const top = [...p.levels].sort((a, b) => b.elevation - a.elevation || b.index - a.index)[0];
    height = payload.height ?? DEFAULTS.levelHeight;
    floorThickness = payload.floorThickness ?? DEFAULTS.floorThickness;
    elevation = payload.elevation ?? (top ? top.elevation + top.height + floorThickness : 0);
  }
  const level = defaultLevel(ctx.ids.next("level"), {
    name: payload.name ?? `Level ${p.levels.length + 1}`,
    elevation,
    height,
    floorThickness,
    index: nextIndexAt(p, elevation),
  });
  p.levels.push(level);
  sortLevels(p);
  changes.add("level", level.id);
  return levelById(p, level.id);
}

/** Elevation or index changes re-index siblings at the old and new elevations (R-119, R-120). */
export function levelModify(
  p: Project,
  payload: PayloadOf<"level.modify">,
  _ctx: Ctx,
  changes: Changes,
): Level {
  const l = levelById(p, payload.levelId);
  const c = payload.changes;
  const oldElevation = l.elevation;
  const oldIndex = l.index;
  if (c.name !== undefined) l.name = c.name;
  if (c.height !== undefined) l.height = c.height;
  if (c.floorThickness !== undefined) l.floorThickness = c.floorThickness;
  if (c.viewable !== undefined) l.viewable = c.viewable;
  if (c.elevation !== undefined && c.elevation !== oldElevation) {
    l.elevation = c.elevation;
    l.index = nextIndexAt(p, c.elevation, l.id);
    for (const s of p.levels) {
      if (s.id !== l.id && s.elevation === oldElevation && s.index > oldIndex) {
        s.index -= 1;
        changes.update("level", s.id);
      }
    }
  }
  if (c.index !== undefined && c.index !== l.index) {
    const from = l.index;
    const to = c.index;
    for (const s of p.levels) {
      if (s.id === l.id || s.elevation !== l.elevation) continue;
      if (from < to && s.index > from && s.index <= to) s.index -= 1;
      else if (from > to && s.index >= to && s.index < from) s.index += 1;
      else continue;
      changes.update("level", s.id);
    }
    l.index = to;
  }
  sortLevels(p);
  changes.update("level", l.id);
  return l;
}

/** Cascade delete (R-108); the last level cannot be deleted (R-110 reversed: nothing to normalise). */
export function levelDelete(
  p: Project,
  payload: PayloadOf<"level.delete">,
  _ctx: Ctx,
  changes: Changes,
): void {
  const l = levelById(p, payload.levelId);
  if (p.levels.length <= 1) throw precondition("level.last", "the last level cannot be deleted", l.id);
  const wallIds = new Set(p.walls.filter((w) => w.levelId === l.id).map((w) => w.id));
  for (const w of p.walls) {
    if (wallIds.has(w.id)) continue;
    for (const end of ["start", "end"] as const) {
      const j = w.joins[end];
      if (j && wallIds.has(j.wallId)) {
        w.joins[end] = null;
        changes.update("wall", w.id);
      }
    }
  }
  const drop = <T extends { id: string; levelId: string }>(
    list: T[],
    type: Parameters<Changes["remove"]>[0],
  ) => {
    for (const e of [...list]) {
      if (e.levelId === l.id) {
        list.splice(list.indexOf(e), 1);
        changes.remove(type, e.id);
      }
    }
  };
  drop(p.openings, "opening");
  drop(p.walls, "wall");
  drop(p.rooms, "room");
  drop(p.items, "item");
  drop(p.zones, "zone");
  drop(p.annotations, "annotation");
  p.levels.splice(p.levels.indexOf(l), 1);
  changes.remove("level", l.id);
  for (const s of p.levels) {
    if (s.elevation === l.elevation && s.index > l.index) {
      s.index -= 1;
      changes.update("level", s.id);
    }
  }
}

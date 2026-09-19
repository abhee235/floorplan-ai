// apply(project, command, ctx): dispatch to a reducer on an Immer draft, normalise, validate, return patches (ADR-004 D1).
import type { Author, Authorship, Project } from "@fpv/ir";
import {
  normalizeItem,
  normalizeOpening,
  normalizeRoom,
  normalizeWall,
  type Problem,
  validate,
} from "@fpv/ir";
import { enablePatches, type Patch, produceWithPatches } from "immer";
import { type ChangeSet, Changes, type Ctx } from "./context.js";
import { CommandError, type CommandErrorShape } from "./errors.js";
import * as items from "./reducers/items.js";
import * as levels from "./reducers/levels.js";
import * as misc from "./reducers/misc.js";
import * as openings from "./reducers/openings.js";
import * as rooms from "./reducers/rooms.js";
import * as walls from "./reducers/walls.js";
import * as zones from "./reducers/zones.js";
import type { Origin } from "./store.js";
import { Command, type Command as CommandT } from "./types.js";

enablePatches();

export interface ApplyOk {
  ok: true;
  project: Project;
  changes: ChangeSet;
  forward: Patch[];
  inverse: Patch[];
  warnings: string[];
  problems: Problem[];
  /** Reducer return value, echoed for tools (created entities, etc.). */
  result: unknown;
}
export interface ApplyFail {
  ok: false;
  error: CommandErrorShape;
  warnings: string[];
}
export type ApplyResult = ApplyOk | ApplyFail;

type Reducer = (p: Project, payload: never, ctx: Ctx, changes: Changes) => unknown;

const REDUCERS: Record<CommandT["type"], Reducer> = {
  "wall.create": walls.wallCreate,
  "wall.createChain": walls.wallCreateChain,
  "wall.modify": walls.wallModify,
  "wall.move": walls.wallMove,
  "wall.split": walls.wallSplit,
  "wall.join": walls.wallJoin,
  "wall.reverse": walls.wallReverse,
  "wall.delete": walls.wallDelete,
  "opening.add": openings.openingAdd,
  "opening.modify": openings.openingModify,
  "opening.move": openings.openingMove,
  "opening.delete": openings.openingDelete,
  "room.create": rooms.roomCreate,
  "room.detectAll": rooms.roomDetectAll,
  "room.modify": rooms.roomModify,
  "room.setPolygon": rooms.roomSetPolygon,
  "room.addPoint": rooms.roomAddPoint,
  "room.movePoint": rooms.roomMovePoint,
  "room.removePoint": rooms.roomRemovePoint,
  "room.delete": rooms.roomDelete,
  "level.add": levels.levelAdd,
  "level.modify": levels.levelModify,
  "level.delete": levels.levelDelete,
  "item.place": items.itemPlace,
  "item.move": items.itemMove,
  "item.rotate": items.itemRotate,
  "item.resize": items.itemResize,
  "item.setElevation": items.itemSetElevation,
  "item.setParent": items.itemSetParent,
  "item.setProduct": items.itemSetProduct,
  "item.mirror": items.itemMirror,
  "item.setFinish": items.itemSetFinish,
  "item.duplicate": items.itemDuplicate,
  "item.delete": items.itemDelete,
  "item.align": items.itemAlign,
  "item.distribute": items.itemDistribute,
  "item.arrange": zones.itemArrange,
  "zone.create": zones.zoneCreate,
  "zone.modify": zones.zoneModify,
  "zone.regenerate": zones.zoneRegenerate,
  "zone.delete": zones.zoneDelete,
  "annotation.add": misc.annotationAdd,
  "annotation.modify": misc.annotationModify,
  "annotation.delete": misc.annotationDelete,
  "project.setMeta": misc.projectSetMeta,
  "project.setProvenance": misc.projectSetProvenance,
  "catalog.refresh": misc.catalogRefresh,
};

/** Normalise the entities a command touched, inside the same draft so patches stay accurate. */
function normalizeTouched(draft: Project, changes: Changes): void {
  const touched = [...changes.added, ...changes.updated];
  for (const ref of touched) {
    if (ref.type === "wall") {
      const i = draft.walls.findIndex((w) => w.id === ref.id);
      if (i >= 0) draft.walls[i] = normalizeWall(draft.walls[i] as Project["walls"][number]);
    } else if (ref.type === "room") {
      const i = draft.rooms.findIndex((r) => r.id === ref.id);
      if (i >= 0) draft.rooms[i] = normalizeRoom(draft.rooms[i] as Project["rooms"][number]);
    } else if (ref.type === "item") {
      const i = draft.items.findIndex((x) => x.id === ref.id);
      if (i >= 0) draft.items[i] = normalizeItem(draft.items[i] as Project["items"][number]);
    } else if (ref.type === "opening") {
      const i = draft.openings.findIndex((o) => o.id === ref.id);
      if (i >= 0) draft.openings[i] = normalizeOpening(draft.openings[i] as Project["openings"][number]);
    }
  }
}

/** The command layer's origins as authors (ADR-023 D2). */
const AUTHOR_OF: Readonly<Record<Origin, Author | null>> = {
  editor: "person",
  agent: "agent",
  import: "import",
  // A replay is not an author. The patches being replayed carry whoever made the change, so undoing
  // an agent's move of a person's sofa restores the person's own stamp without anyone writing it.
  undo: null,
  redo: null,
  restore: null,
};

/**
 * Stamp who did this on everything the command made or changed (ADR-023 D2).
 *
 * Here rather than in the forty reducers, because this is the one place that already knows every
 * entity a command touched, and forty places is forty places to forget. Tools cannot write the
 * field: no payload schema accepts it.
 */
function stampAuthorship(draft: Project, changes: Changes, origin: Origin, at: string): void {
  const author = AUTHOR_OF[origin];
  if (!author) return;
  const made = new Set(changes.added.map((r) => `${r.type}:${r.id}`));
  const lists: Record<string, { id: string; by?: Authorship }[]> = {
    level: draft.levels,
    wall: draft.walls,
    opening: draft.openings,
    room: draft.rooms,
    item: draft.items,
    zone: draft.zones,
    annotation: draft.annotations,
  };
  for (const ref of [...changes.added, ...changes.updated]) {
    const entity = lists[ref.type]?.find((e) => e.id === ref.id);
    if (!entity) continue;
    const fresh = made.has(`${ref.type}:${ref.id}`) || !entity.by;
    entity.by = {
      createdBy: fresh ? author : (entity.by?.createdBy ?? "unknown"),
      editedBy: author,
      editedAt: at,
      touchedByPerson: (entity.by?.touchedByPerson ?? false) || author === "person",
    };
  }
}

const problemKey = (p: Problem) => `${p.code}|${p.entityId ?? ""}`;

/**
 * Apply one command. Fails, leaving the project untouched, when the payload is invalid, a
 * precondition fails, or the command introduces a validation error that was not already present.
 */
export function apply(project: Project, command: unknown, ctx: Ctx): ApplyResult {
  const parsed = Command.safeParse(command);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return {
      ok: false,
      error: { code: "command.payload", message: issues.join("; "), entityId: null, hint: null },
      warnings: [],
    };
  }
  const cmd = parsed.data;
  const changes = new Changes(cmd.type);
  let result: unknown;
  let next: Project;
  let forward: Patch[];
  let inverse: Patch[];
  try {
    [next, forward, inverse] = produceWithPatches(project, (draft) => {
      const reducer = REDUCERS[cmd.type];
      result = reducer(draft as Project, cmd.payload as never, ctx, changes);
      normalizeTouched(draft as Project, changes);
      stampAuthorship(draft as Project, changes, ctx.origin ?? "editor", ctx.now());
      // reducers return draft references; expose plain copies of the created entities instead
      result = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    });
  } catch (e) {
    if (e instanceof CommandError) return { ok: false, error: e.toJSON(), warnings: changes.warnings };
    throw e;
  }
  const before = new Set(
    validate(project)
      .filter((p) => p.severity === "error")
      .map(problemKey),
  );
  const problems = validate(next);
  const introduced = problems.filter((p) => p.severity === "error" && !before.has(problemKey(p)));
  const first = introduced[0];
  if (first) {
    return {
      ok: false,
      error: { code: first.code, message: first.message, entityId: first.entityId, hint: first.hint },
      warnings: changes.warnings,
    };
  }
  return {
    ok: true,
    project: next,
    changes: changes.toChangeSet(),
    forward,
    inverse,
    warnings: changes.warnings,
    problems,
    result,
  };
}

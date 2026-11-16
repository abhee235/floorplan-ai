// Opening reducers (spec 03 section 2; ledger O-038..O-050 reversed: openings are bound by wall id).
import type { Opening, Project } from "@fpv/ir";
import { defaultOpening, derive, normalizeOpening } from "@fpv/ir";
import {
  type Changes,
  type Ctx,
  ensureSnapshot,
  openingById,
  requireTextures,
  wallById,
} from "../context.js";
import { precondition } from "../errors.js";
import type { PayloadOf } from "../types.js";

function resolvePosition(
  p: Project,
  wallId: string,
  position: number | undefined,
  atMm: number | undefined,
  entityId: string | null,
): number {
  if ((position === undefined) === (atMm === undefined)) {
    throw precondition("command.payload", "give exactly one of position (0..1) or atMm", entityId);
  }
  if (position !== undefined) return position;
  const w = wallById(p, wallId);
  const len = derive.wallLength(w);
  if (len === 0) throw precondition("wall.zero-length", "wall has zero length", wallId);
  return (atMm as number) / len;
}

function requireSnapshot(
  p: Project,
  ctx: Ctx,
  productId: string | null | undefined,
  entityId: string | null,
): void {
  if (!productId) return;
  if (!ensureSnapshot(p, ctx, productId)) {
    throw precondition(
      "catalog.missing-snapshot",
      `productId "${productId}" is not in the catalog`,
      entityId,
      "use search_catalog or verify_product first",
    );
  }
}

export function openingAdd(
  p: Project,
  payload: PayloadOf<"opening.add">,
  ctx: Ctx,
  changes: Changes,
): Opening {
  const w = wallById(p, payload.wallId);
  const position = resolvePosition(p, w.id, payload.position, payload.atMm, null);
  requireSnapshot(p, ctx, payload.productId, null);
  const o = defaultOpening(ctx.ids.next("opening"), w.levelId, w.id, payload.kind, {
    position,
    ...(payload.width !== undefined ? { width: payload.width } : {}),
    ...(payload.height !== undefined ? { height: payload.height } : {}),
    ...(payload.sill !== undefined ? { sill: payload.sill } : {}),
    ...(payload.swing !== undefined ? { swing: payload.swing } : {}),
    ...(payload.mirrored !== undefined ? { mirrored: payload.mirrored } : {}),
    ...(payload.productId !== undefined ? { productId: payload.productId } : {}),
    ...(payload.recipe !== undefined ? { recipe: payload.recipe } : {}),
  });
  p.openings.push(normalizeOpening(o));
  changes.add("opening", o.id);
  changes.update("wall", w.id);
  return openingById(p, o.id);
}

export function openingModify(
  p: Project,
  payload: PayloadOf<"opening.modify">,
  ctx: Ctx,
  changes: Changes,
): Opening {
  const o = openingById(p, payload.openingId);
  const c = payload.changes;
  if (c.productId !== undefined) requireSnapshot(p, ctx, c.productId, o.id);
  if (c.finishes) requireTextures(p, ctx, [c.finishes.frame, c.finishes.leaf], o.id);
  Object.assign(o, c);
  Object.assign(o, normalizeOpening(o));
  changes.update("opening", o.id);
  changes.update("wall", o.wallId);
  return o;
}

export function openingMove(
  p: Project,
  payload: PayloadOf<"opening.move">,
  _ctx: Ctx,
  changes: Changes,
): Opening {
  const o = openingById(p, payload.openingId);
  const oldWall = o.wallId;
  const targetWallId = payload.wallId ?? o.wallId;
  const w = wallById(p, targetWallId);
  if (w.levelId !== o.levelId)
    throw precondition("opening.level-mismatch", `wall ${w.id} is on another level`, o.id);
  if (payload.position !== undefined || payload.atMm !== undefined) {
    o.position = resolvePosition(p, w.id, payload.position, payload.atMm, o.id);
  }
  o.wallId = w.id;
  changes.update("opening", o.id);
  changes.update("wall", oldWall);
  changes.update("wall", w.id);
  return o;
}

export function openingDelete(
  p: Project,
  payload: PayloadOf<"opening.delete">,
  _ctx: Ctx,
  changes: Changes,
): void {
  for (const id of payload.openingIds) {
    const o = openingById(p, id);
    p.openings.splice(p.openings.indexOf(o), 1);
    changes.remove("opening", id);
    changes.update("wall", o.wallId);
  }
}

// Annotation, project meta, provenance, and catalog refresh reducers (spec 03 section 4).
import type { Annotation, Project } from "@fpv/ir";
import { Annotation as AnnotationSchema, normalizeDeg, UNKNOWN_AUTHOR } from "@fpv/ir";
import { type Changes, type Ctx, levelById } from "../context.js";
import { missingRef, precondition } from "../errors.js";
import type { PayloadOf } from "../types.js";

export function annotationAdd(
  p: Project,
  payload: PayloadOf<"annotation.add">,
  ctx: Ctx,
  changes: Changes,
): Annotation {
  levelById(p, payload.annotation.levelId);
  // the stamp is the command layer's to write, so the payload never carries one (ADR-023 D2)
  const a = {
    ...payload.annotation,
    id: ctx.ids.next("annot"),
    by: { ...UNKNOWN_AUTHOR },
  } as Annotation;
  const parsed = AnnotationSchema.safeParse(a);
  if (!parsed.success)
    throw precondition(
      "command.payload",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  p.annotations.push(parsed.data);
  changes.add("annotation", parsed.data.id);
  return parsed.data;
}

export function annotationModify(
  p: Project,
  payload: PayloadOf<"annotation.modify">,
  _ctx: Ctx,
  changes: Changes,
): Annotation {
  const idx = p.annotations.findIndex((a) => a.id === payload.annotationId);
  if (idx < 0) throw missingRef("annotation", payload.annotationId);
  const current = p.annotations[idx] as Annotation;
  const merged = {
    ...current,
    ...payload.changes,
    id: current.id,
    kind: current.kind,
    levelId: current.levelId,
  } as Record<string, unknown>;
  if (typeof merged.angle === "number") merged.angle = normalizeDeg(merged.angle);
  const parsed = AnnotationSchema.safeParse(merged);
  if (!parsed.success)
    throw precondition(
      "command.payload",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      current.id,
    );
  p.annotations[idx] = parsed.data;
  changes.update("annotation", current.id);
  return parsed.data;
}

export function annotationDelete(
  p: Project,
  payload: PayloadOf<"annotation.delete">,
  _ctx: Ctx,
  changes: Changes,
): void {
  for (const id of payload.annotationIds) {
    const idx = p.annotations.findIndex((a) => a.id === id);
    if (idx < 0) throw missingRef("annotation", id);
    p.annotations.splice(idx, 1);
    changes.remove("annotation", id);
  }
}

export function projectSetMeta(
  p: Project,
  payload: PayloadOf<"project.setMeta">,
  _ctx: Ctx,
  changes: Changes,
): void {
  const c = payload.changes;
  if (c.name !== undefined) p.meta.name = c.name;
  if (c.currency !== undefined) p.meta.currency = c.currency;
  if (c.north !== undefined) p.meta.north = normalizeDeg(c.north);
  changes.update("meta", "meta");
}

export function projectSetProvenance(
  p: Project,
  payload: PayloadOf<"project.setProvenance">,
  _ctx: Ctx,
  changes: Changes,
): void {
  p.provenance = { ...payload.provenance };
  changes.update("meta", "provenance");
}

/** Refresh catalog snapshots from the live catalog; items and openings whose product dims changed are touched (spec 03). */
export function catalogRefresh(
  p: Project,
  payload: PayloadOf<"catalog.refresh">,
  ctx: Ctx,
  changes: Changes,
): string[] {
  if (!ctx.catalog) throw precondition("catalog.unavailable", "no catalog is configured for this session");
  const ids = payload.productIds ?? Object.keys(p.catalogRefs);
  const refreshed: string[] = [];
  for (const id of ids) {
    const live = ctx.catalog.product(id);
    if (!live) continue;
    const before = JSON.stringify(p.catalogRefs[id]?.dims ?? null);
    p.catalogRefs[id] = { ...live, id, snapshotAt: ctx.now() };
    refreshed.push(id);
    if (JSON.stringify(live.dims ?? null) !== before) {
      for (const it of p.items)
        if (it.ref.kind === "product" && it.ref.productId === id) changes.update("item", it.id);
      for (const o of p.openings) if (o.productId === id) changes.update("opening", o.id);
    }
  }
  changes.update("meta", "catalogRefs");
  return refreshed;
}

// Normalisation on write (spec 01 section 6). Commands call these before validation.

import * as poly from "./poly.js";
import type { Item, Opening, Project, Room, Wall } from "./schema.js";
import { normalizeDeg } from "./schema.js";

export interface NormalizeNote {
  entityId: string;
  code: string;
  message: string;
}

export function normalizeWall(w: Wall): Wall {
  const out: Wall = { ...w };
  if (out.arcExtent === 0) out.arcExtent = null; // W-050 reversed
  if (out.heightAtEnd !== null && out.heightAtEnd === out.height) out.heightAtEnd = null; // W-094
  if (out.heightAtEnd !== null && out.height === null) {
    // heightAtEnd without a start height is meaningless; keep the value as the wall height instead
    out.height = out.heightAtEnd;
    out.heightAtEnd = null;
  }
  return out;
}

export function normalizeOpening(o: Opening): Opening {
  const out: Opening = { ...o };
  if (out.kind !== "door") out.swing = null;
  if (out.kind !== "window" && out.sill !== 0) out.sill = 0;
  return out;
}

/**
 * Rooms: consecutive duplicates and a closing point are removed (R-011 tolerated on input, never stored),
 * a merely reversed polygon is reoriented counter-clockwise and holes clockwise, with a note so
 * importers learn. Non-simple polygons are left for validation to reject.
 */
export function normalizeRoom(r: Room, notes: NormalizeNote[] = []): Room {
  let polygon = poly.dedupe(r.polygon);
  if (polygon.length !== r.polygon.length) {
    notes.push({
      entityId: r.id,
      code: "room.points-deduped",
      message: "consecutive duplicate points removed",
    });
  }
  if (polygon.length >= 3 && poly.isClockwise(polygon)) {
    polygon = poly.reversed(polygon);
    notes.push({ entityId: r.id, code: "room.reoriented", message: "polygon reoriented counter-clockwise" });
  }
  const holes = r.holes.map((h) => {
    let ring = poly.dedupe(h);
    if (ring.length >= 3 && poly.isCounterClockwise(ring)) {
      ring = poly.reversed(ring);
      notes.push({ entityId: r.id, code: "room.hole-reoriented", message: "hole reoriented clockwise" });
    }
    return ring;
  });
  return { ...r, polygon, holes, label: { ...r.label, angle: normalizeDeg(r.label.angle) } };
}

export function normalizeItem(i: Item): Item {
  return { ...i, rotation: normalizeDeg(i.rotation) };
}

export function normalizeProject(p: Project, notes: NormalizeNote[] = []): Project {
  return {
    ...p,
    meta: { ...p.meta, north: normalizeDeg(p.meta.north) },
    levels: [...p.levels].sort((a, b) => a.elevation - b.elevation || a.index - b.index),
    walls: p.walls.map(normalizeWall),
    openings: p.openings.map(normalizeOpening),
    rooms: p.rooms.map((r) => normalizeRoom(r, notes)),
    items: p.items.map(normalizeItem),
    annotations: p.annotations.map((a) =>
      a.kind === "north" || a.kind === "label" ? { ...a, angle: normalizeDeg(a.angle) } : a,
    ),
  };
}

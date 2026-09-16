// What the selection is, and what can be done to it (P3-4; ledger F-133, F-138, F-140, F-141).
//
// Free of the DOM and of the canvas so it can be tested. The shell and the properties panel both read
// from here rather than each working the selection out for themselves.

import type { Item, Opening, Project, Room, Wall } from "@fpv/ir";
import { derive } from "@fpv/ir";

/** The entity kinds the editor can select and delete today. */
export type EntityKind = "wall" | "room" | "item" | "opening";

const DELETE_COMMAND: Record<EntityKind, { type: string; key: string }> = {
  wall: { type: "wall.delete", key: "wallIds" },
  room: { type: "room.delete", key: "roomIds" },
  item: { type: "item.delete", key: "itemIds" },
  opening: { type: "opening.delete", key: "openingIds" },
};

/**
 * The kind an id names, or null.
 *
 * Ids are `<kind>_<six chars>` and @fpv/ir has no classifier for them — `idOf` there is a private zod
 * regex factory, not something that maps back. This reads the prefix.
 *
 * Deliberately soft on anything unrecognised: a selection could hold an id for a kind the UI does not
 * handle yet (a zone, an annotation), and throwing on Delete would be far worse than leaving one entity
 * alone. The caller sees it missing from the grouping rather than an exception.
 */
export function kindOf(id: string): EntityKind | null {
  const prefix = id.slice(0, id.indexOf("_"));
  return prefix === "wall" || prefix === "room" || prefix === "item" || prefix === "opening" ? prefix : null;
}

export interface DeleteCommand {
  type: string;
  payload: Record<string, string[]>;
}

/**
 * One delete command per kind in the selection (F-141 applies to what is selected, not to this).
 *
 * A mixed selection cannot be one command: every delete payload names its own id array and validates
 * `.min(1)`, so walls and rooms travel separately. They are returned in a stable order so the history
 * reads the same way twice.
 */
export function deleteCommands(ids: readonly string[]): DeleteCommand[] {
  const byKind = new Map<EntityKind, string[]>();
  for (const id of ids) {
    const kind = kindOf(id);
    if (!kind) continue;
    const list = byKind.get(kind) ?? [];
    list.push(id);
    byKind.set(kind, list);
  }
  // Openings before walls: deleting a wall takes its openings with it, so the reverse order would name
  // ids that no longer exist by the time the second command ran. Items and rooms go ahead of walls for
  // the same reason.
  const order: EntityKind[] = ["opening", "item", "room", "wall"];
  const out: DeleteCommand[] = [];
  for (const kind of order) {
    const list = byKind.get(kind);
    if (!list?.length) continue;
    const spec = DELETE_COMMAND[kind];
    out.push({ type: spec.type, payload: { [spec.key]: list } });
  }
  return out;
}

/** Openings before walls: deleting a wall takes its openings with it, so the reverse order would
 *  delete ids that no longer exist. Same reasoning puts items and rooms ahead of the walls they sit in. */

export interface SelectedEntity {
  id: string;
  kind: EntityKind;
  /** What to call it in the panel: a name where the entity has one, else the kind and its id. */
  title: string;
  /** Rows for the properties panel: a label and an already-formatted value. */
  facts: { label: string; value: string }[];
}

/** Everything the panel needs about one selected id, or null when the id is not in the project. */
export function describeEntity(project: Project, id: string): SelectedEntity | null {
  const kind = kindOf(id);
  if (!kind) return null;
  if (kind === "wall") {
    const w = project.walls.find((x) => x.id === id);
    return w ? { id, kind, title: "Wall", facts: wallFacts(w) } : null;
  }
  if (kind === "room") {
    const r = project.rooms.find((x) => x.id === id);
    return r ? { id, kind, title: r.name ?? "Room", facts: roomFacts(r) } : null;
  }
  if (kind === "item") {
    const it = project.items.find((x) => x.id === id);
    return it ? { id, kind, title: itemTitle(it), facts: itemFacts(it) } : null;
  }
  const o = project.openings.find((x) => x.id === id);
  return o ? { id, kind, title: openingTitle(o), facts: openingFacts(o) } : null;
}

function wallFacts(w: Wall): { label: string; value: string }[] {
  return [
    { label: "Length", value: `${Math.round(derive.wallLength(w))} mm` },
    { label: "Thickness", value: `${Math.round(w.thickness)} mm` },
    { label: "Kind", value: w.kind },
  ];
}

function roomFacts(r: Room): { label: string; value: string }[] {
  // Square metres: square millimetres is a number nobody reads. roomArea is already absolute and already
  // subtracts the holes (R-006), so there is nothing to correct for here.
  const areaM2 = derive.roomArea(r) / 1_000_000;
  return [
    { label: "Corners", value: String(r.polygon.length) },
    { label: "Area", value: `${areaM2.toFixed(2)} m²` },
    { label: "Purpose", value: r.purpose },
  ];
}

/** An Item carries no name: it is named by what it refers to. ItemRef is a union of a catalogue product
 *  and a generated primitive, so a product item reads as its product id and a recipe item as its kind. */
function itemTitle(it: Item): string {
  return it.ref.kind === "product" ? it.ref.productId : it.ref.recipe.kind;
}

function itemFacts(it: Item): { label: string; value: string }[] {
  return [
    { label: "Position", value: `${Math.round(it.position.x)}, ${Math.round(it.position.y)} mm` },
    { label: "Rotation", value: `${Math.round(it.rotation)}°` },
  ];
}

function openingTitle(o: Opening): string {
  return o.kind === "door" ? "Door" : o.kind === "window" ? "Window" : "Passage";
}

function openingFacts(o: Opening): { label: string; value: string }[] {
  return [
    { label: "Width", value: `${Math.round(o.width)} mm` },
    { label: "In wall", value: o.wallId },
  ];
}

/**
 * The next selection after a click (F-138, F-140, F-141).
 *
 * - Shift held: the id toggles in or out, so a second shift-click removes it again.
 * - No shift, something hit: that id alone, which is what collapses a multi-selection to one (F-141).
 * - No shift, nothing hit: empty, so pressing on bare plan clears (F-138).
 */
export function nextSelection(current: readonly string[], hit: string | null, shiftHeld: boolean): string[] {
  if (!hit) return shiftHeld ? [...current] : [];
  if (!shiftHeld) return [hit];
  return current.includes(hit) ? current.filter((id) => id !== hit) : [...current, hit];
}

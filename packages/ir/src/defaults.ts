// Factories producing valid entities with the defaults from spec 01 and spec 03.
// Commands use these so every entity starts complete (no omitted fields, ADR-012 D2).

import type { z } from "zod";
import type {
  Authorship,
  FinishRef,
  Item,
  ItemRef,
  Level,
  Opening,
  OpeningKind,
  Point,
  Room,
  RoomPurpose,
  Wall,
  WallKind,
} from "./schema.js";

export const DEFAULTS = {
  levelHeight: 2700,
  floorThickness: 300,
  wallThickness: { interior: 120, partition: 100, exterior: 300, glass: 12 } as const,
  door: { width: 900, height: 2100, sill: 0 },
  window: { width: 1200, height: 1200, sill: 900 },
  passage: { width: 1000, height: 2100, sill: 0 },
  roomLabelYOffset: 0,
} as const;

/**
 * The stamp a new entity starts with (ADR-023 D1).
 *
 * "unknown" rather than a guess: `apply` writes the real author over it in the same pass that runs
 * the reducer, and a factory called from a test or a migration has no way of knowing who is asking.
 * The timestamp is the epoch for the same reason -- it is always replaced, and a fake "now" in a
 * pure factory would make two identical projects differ.
 */
export const UNKNOWN_AUTHOR: Authorship = {
  createdBy: "unknown",
  editedBy: "unknown",
  editedAt: "1970-01-01T00:00:00.000Z",
  touchedByPerson: false,
};

export function defaultLevel(id: string, over: Partial<Level> = {}): Level {
  return {
    id,
    name: "Level",
    elevation: 0,
    height: DEFAULTS.levelHeight,
    floorThickness: DEFAULTS.floorThickness,
    index: 0,
    viewable: true,
    backgroundImage: null,
    by: { ...UNKNOWN_AUTHOR },
    ...over,
  };
}

export function defaultWall(
  id: string,
  levelId: string,
  start: Point,
  end: Point,
  over: Partial<Omit<Wall, "id" | "levelId" | "start" | "end">> = {},
): Wall {
  const kind: z.infer<typeof WallKind> = over.kind ?? "interior";
  return {
    id,
    levelId,
    start,
    end,
    thickness: DEFAULTS.wallThickness[kind],
    height: null,
    heightAtEnd: null,
    arcExtent: null,
    kind,
    pattern: "solid",
    joins: { start: null, end: null },
    finishes: { left: null, right: null, top: null },
    skirting: { left: null, right: null },
    properties: {},
    by: { ...UNKNOWN_AUTHOR },
    ...over,
  };
}

export function defaultOpening(
  id: string,
  levelId: string,
  wallId: string,
  kind: z.infer<typeof OpeningKind>,
  over: Partial<Omit<Opening, "id" | "levelId" | "wallId" | "kind">> = {},
): Opening {
  const size = kind === "door" ? DEFAULTS.door : kind === "window" ? DEFAULTS.window : DEFAULTS.passage;
  return {
    id,
    levelId,
    wallId,
    kind,
    position: 0.5,
    width: size.width,
    height: size.height,
    sill: size.sill,
    swing: kind === "door" ? { hinge: "start", direction: "left" } : null,
    mirrored: false,
    productId: null,
    recipe:
      kind === "window" ? { style: "glazed" } : kind === "door" ? { style: "single" } : { style: "plain" },
    finishes: { frame: null, leaf: null },
    properties: {},
    by: { ...UNKNOWN_AUTHOR },
    ...over,
  };
}

/** R-002 adapted: a new room shows floor, ceiling and area; label sits on the anchor with no offset. */
export function defaultRoom(
  id: string,
  levelId: string,
  polygon: Point[],
  over: Partial<Omit<Room, "id" | "levelId" | "polygon">> = {},
): Room {
  const purpose: z.infer<typeof RoomPurpose> = over.purpose ?? "other";
  return {
    id,
    levelId,
    name: null,
    polygon,
    holes: [],
    purpose,
    capacity: null,
    ceilingHeight: null,
    finishes: { floor: null, ceiling: null },
    floorVisible: true,
    ceilingVisible: true,
    label: { offset: { x: 0, y: DEFAULTS.roomLabelYOffset }, angle: 0, showArea: true },
    source: "manual",
    boundingWallIds: [],
    properties: {},
    by: { ...UNKNOWN_AUTHOR },
    ...over,
  };
}

/** F-008 adapted: a placed item is visible, unmirrored, floor mounted, with no overrides. */
export function defaultItem(
  id: string,
  levelId: string,
  ref: z.infer<typeof ItemRef>,
  position: Point,
  over: Partial<Omit<Item, "id" | "levelId" | "ref" | "position">> = {},
): Item {
  return {
    id,
    levelId,
    ref,
    position,
    rotation: 0,
    elevation: 0,
    size: null,
    mirrored: false,
    mount: { kind: "floor", targetId: null, height: null },
    parentId: null,
    roomId: null,
    finish: null,
    materials: {},
    pose: null,
    visible: true,
    tags: [],
    properties: {},
    by: { ...UNKNOWN_AUTHOR },
    ...over,
  };
}

export function colorFinish(
  color: string,
  over: Partial<z.infer<typeof FinishRef>> = {},
): z.infer<typeof FinishRef> {
  return { color, textureId: null, placement: null, mirrorForLeftSide: false, shininess: null, ...over };
}

/** F-186: shininess presets. */
export function shininessPreset(preset: "shiny" | "matt" | "default"): number | null {
  if (preset === "shiny") return 0.5;
  if (preset === "matt") return 0;
  return null;
}

// Placing an item from the catalog (P3-5; the item tool of ADR-017 D2). The rules live here, free of the
// DOM and of the canvas: where the piece would land, which way it would face, what is said about it, and
// the one item.place a placement sends.
//
// The preview runs the same placement pipeline the host runs on item.place (spec 05 section 5), so the
// ghost on the plan stands where the piece will actually be: against a wall, on a table, or where it was
// put. What differs is only that the host has the product's snapshot and this has the catalog's size.
import { clearanceOf, placeItem } from "@fpv/geometry";
import { derive, normalizeDeg, type Point, type PrimitiveRecipe, type Project, type Size3 } from "@fpv/ir";

/** A piece the catalog found: a product, or one of the generic recipe shapes. */
export interface Placeable {
  /** The product id, or the recipe's catalog id ("recipe:table:rect:2400x1200x750"). */
  id: string;
  name: string;
  category: string;
  size: Size3;
  ref: { kind: "product"; productId: string } | { kind: "recipe"; recipe: PrimitiveRecipe };
}

/** Arrows move the piece a grid step; with Shift, a finer one (ADR-017 D4). */
export const NUDGE_MM = 100;
export const FINE_NUDGE_MM = 10;
/** Brackets turn it by this much (ADR-017 D4). */
export const TURN_DEG = 15;

export interface ItemAim {
  position: Point;
  rotation: number;
  elevation: number;
  /** What the piece settled against, in words, or "" when it stands free. */
  note: string;
  footprint: Point[];
}

export interface PlaceCommand {
  type: "item.place";
  payload: {
    levelId: string;
    ref: Placeable["ref"];
    position: Point;
    rotation?: number;
    magnetism?: boolean;
  };
}

export interface PlaceSettings {
  /** The snapping preference, already inverted by Alt (W-082). */
  magnetism: boolean;
  /**
   * The rotation asked for in degrees. Zero leaves it to the placement: a piece dropped against a wall
   * turns to face away from it (F-075), and one in the open stands square.
   */
  rotation: number;
}

export class ItemPlacer {
  private at: Point;

  constructor(
    readonly piece: Placeable,
    readonly levelId: string,
    start: Point,
  ) {
    this.at = { ...start };
  }

  get point(): Point {
    return { ...this.at };
  }

  moveTo(raw: Point): void {
    this.at = { ...raw };
  }

  nudge(dx: number, dy: number): void {
    this.at = { x: this.at.x + dx, y: this.at.y + dy };
  }

  /** Where the piece would stand if placed now, and what it settled against. */
  aim(project: Project | null, settings: PlaceSettings): ItemAim {
    const turned = settings.rotation !== 0 ? normalizeDeg(settings.rotation) : null;
    const size = this.piece.size;
    const free = (): ItemAim => {
      const position = rounded(this.at);
      const rotation = turned ?? 0;
      return {
        position,
        rotation,
        elevation: 0,
        note: "",
        footprint: derive.itemFootprint({ position, rotation }, size),
      };
    };
    if (!project || !settings.magnetism) return free();
    const productId = this.piece.ref.kind === "product" ? this.piece.ref.productId : null;
    const placed = placeItem(
      {
        id: null,
        levelId: this.levelId,
        position: rounded(this.at),
        rotation: turned ?? 0,
        elevation: 0,
        size,
        mountKind: "floor",
        parentId: null,
      },
      { project, sizes: derive.snapshotSizeSource(project) },
      // as item.place runs it: turned only when no rotation was asked for, lifted onto what is below
      { forceOrientation: turned === null, adjustElevation: true, adjustOnlyNullElevation: false },
      clearanceOf(project, productId),
    );
    const note = placed.surfaceId
      ? `on ${nameOf(project, placed.surfaceId)}`
      : placed.wallId
        ? "against the wall"
        : placed.neighbourId
          ? `beside ${nameOf(project, placed.neighbourId)}`
          : "";
    const position = rounded(placed.position);
    return {
      position,
      rotation: placed.rotation,
      elevation: placed.elevation,
      note,
      footprint: derive.itemFootprint({ position, rotation: placed.rotation }, size),
    };
  }

  /**
   * The command for a placement here. The host runs the placement again from the raw point, rather than
   * being handed the preview's result, so a project that changed in between is placed against as it is now.
   */
  command(settings: PlaceSettings): PlaceCommand {
    return {
      type: "item.place",
      payload: {
        levelId: this.levelId,
        ref: this.piece.ref,
        position: rounded(this.at),
        ...(settings.rotation !== 0 ? { rotation: normalizeDeg(settings.rotation) } : {}),
        ...(settings.magnetism ? {} : { magnetism: false }),
      },
    };
  }
}

/** A catalog hit as the search tool returns it, turned into something to place; null when it cannot be. */
export function placeableOf(hit: {
  id: string;
  name: string;
  category: string;
  dims: Size3;
  recipe?: unknown;
}): Placeable | null {
  if (!(hit.dims.w > 0 && hit.dims.d > 0 && hit.dims.h > 0)) return null;
  const ref: Placeable["ref"] = hit.recipe
    ? { kind: "recipe", recipe: hit.recipe as PrimitiveRecipe }
    : { kind: "product", productId: hit.id };
  return { id: hit.id, name: hit.name, category: hit.category, size: hit.dims, ref };
}

/** The angle after a bracket: the asked-for rotation turned by `delta`, where zero is "as placed". */
export function turned(rotation: number, current: number, delta: number): number {
  const from = rotation !== 0 ? rotation : current;
  const next = normalizeDeg(from + delta);
  // a full turn back to square is still a rotation someone asked for, so it must not read as zero
  return next === 0 ? 360 : next;
}

const rounded = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) });

function nameOf(project: Project, itemId: string): string {
  const it = project.items.find((i) => i.id === itemId);
  if (!it) return "an item";
  if (it.ref.kind === "recipe") return `the ${it.ref.recipe.kind}`;
  const name = (project.catalogRefs[it.ref.productId] as { name?: unknown } | undefined)?.name;
  return typeof name === "string" ? name : it.ref.productId;
}

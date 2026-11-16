// The handles on a selected item, and what dragging each one means (P3-3; ledger F-100 anchor).
//
// Free of the DOM and of the canvas, like wall-handles.ts. Eight resize handles sit on the footprint's
// corners and edge middles; dragging one moves that side and keeps the opposite one where it is, which is
// what a person expects from a box with handles. A turn handle stands off the front, since the front is
// the side an item is faced by.
//
// The model resizes about the centre or the back left corner only (item.resize), so keeping the opposite
// side put is a resize about the centre and a move of half the growth, sent together as one transaction.
import type { Item, Point, Size3 } from "@fpv/ir";
import { derive, normalizeDeg } from "@fpv/ir";

export type Side = -1 | 0 | 1;

/** A resize handle names the sides it moves, in the item's own frame: x to its right, y to its back. */
export type ItemHandle = { kind: "resize"; sx: Side; sy: Side } | { kind: "rotate" };

/** How far the turn handle stands off the front edge, and how close a press has to be, in screen pixels. */
export const ROTATE_OFFSET_PX = 26;
export const HANDLE_REACH_PX = 7;

/** The smallest side a drag leaves an item with, and the step a snapped size moves in. */
export const MIN_SIDE_MM = 10;
export const SIZE_STEP_MM = 10;
/** A snapped turn moves in steps of this many degrees, as the brackets do. */
export const TURN_STEP_DEG = 15;

const RESIZE: readonly { sx: Side; sy: Side }[] = [
  { sx: -1, sy: 1 },
  { sx: 1, sy: 1 },
  { sx: 1, sy: -1 },
  { sx: -1, sy: -1 },
  { sx: -1, sy: 0 },
  { sx: 1, sy: 0 },
  { sx: 0, sy: 1 },
  { sx: 0, sy: -1 },
];

/** The item's own axes in plan space: x to its right, y to its back (derive.itemFootprint's frame). */
function axes(rotation: number): { x: Point; y: Point } {
  const r = (rotation * Math.PI) / 180;
  return { x: { x: Math.cos(r), y: Math.sin(r) }, y: { x: -Math.sin(r), y: Math.cos(r) } };
}

const toPlan = (it: Pick<Item, "position" | "rotation">, lx: number, ly: number): Point => {
  const a = axes(it.rotation);
  return { x: it.position.x + lx * a.x.x + ly * a.y.x, y: it.position.y + lx * a.x.y + ly * a.y.y };
};

export interface ItemHandleAnchor {
  handle: ItemHandle;
  at: Point;
}

/**
 * Where every handle sits, in plan millimetres. `mmPerPx` places the turn handle a fixed distance off the
 * front on screen, whatever the zoom. Resize handles are left out for an item that cannot change size.
 */
export function itemHandleAnchors(
  it: Pick<Item, "position" | "rotation">,
  size: Size3,
  mmPerPx: number,
  resizable: boolean,
): ItemHandleAnchor[] {
  const out: ItemHandleAnchor[] = resizable
    ? RESIZE.map(({ sx, sy }) => ({
        handle: { kind: "resize", sx, sy },
        at: toPlan(it, (sx * size.w) / 2, (sy * size.d) / 2),
      }))
    : [];
  // the front is local -y
  out.push({ handle: { kind: "rotate" }, at: toPlan(it, 0, -size.d / 2 - ROTATE_OFFSET_PX * mmPerPx) });
  return out;
}

/** The handle under a plan point, or null; the turn handle first, then corners before edges. */
export function itemHandleAt(
  it: Pick<Item, "position" | "rotation">,
  size: Size3,
  p: Point,
  mmPerPx: number,
  resizable: boolean,
): ItemHandle | null {
  const reach = HANDLE_REACH_PX * mmPerPx;
  const anchors = itemHandleAnchors(it, size, mmPerPx, resizable);
  const ordered = [
    ...anchors.filter((a) => a.handle.kind === "rotate"),
    ...anchors.filter((a) => a.handle.kind !== "rotate"),
  ];
  for (const a of ordered) if (Math.hypot(p.x - a.at.x, p.y - a.at.y) <= reach) return a.handle;
  return null;
}

/** The CSS cursor for a handle: a resize arrow along the direction the handle pulls, or a grab to turn. */
export function itemHandleCursor(handle: ItemHandle, rotation: number): string {
  if (handle.kind === "rotate") return "grab";
  const angle = rotation + (Math.atan2(handle.sy, handle.sx) * 180) / Math.PI;
  const CURSORS = ["ew-resize", "nesw-resize", "ns-resize", "nwse-resize"] as const;
  return CURSORS[Math.round(normalizeDeg(angle) / 45) % 4] as string;
}

export interface ItemCommand {
  type: string;
  payload: Record<string, unknown>;
}

export interface ResizeOptions {
  /** Round each side to SIZE_STEP_MM; Alt turns it off (W-082). */
  snap: boolean;
  /** Keep the proportions when a corner is dragged (Shift). */
  keepRatio: boolean;
}

/**
 * The commands a resize drag from `from` to `to` asks for, measured from the item as it was when the drag
 * began: a resize about the centre, and a move of half the growth so the opposite side stays put. Empty
 * when the size does not change.
 */
export function resizeCommands(
  it: Pick<Item, "id" | "position" | "rotation">,
  size: Size3,
  handle: { sx: Side; sy: Side },
  from: Point,
  to: Point,
  options: ResizeOptions,
): ItemCommand[] {
  const a = axes(it.rotation);
  const d = { x: to.x - from.x, y: to.y - from.y };
  const lx = d.x * a.x.x + d.y * a.x.y;
  const ly = d.x * a.y.x + d.y * a.y.y;
  let w = handle.sx === 0 ? size.w : size.w + handle.sx * lx;
  let depth = handle.sy === 0 ? size.d : size.d + handle.sy * ly;
  if (options.keepRatio && handle.sx !== 0 && handle.sy !== 0) {
    const k = Math.max(w / size.w, depth / size.d);
    w = size.w * k;
    depth = size.d * k;
  }
  const settle = (v: number): number =>
    Math.max(MIN_SIDE_MM, options.snap ? Math.round(v / SIZE_STEP_MM) * SIZE_STEP_MM : Math.round(v));
  const nw = handle.sx === 0 ? size.w : settle(w);
  const nd = handle.sy === 0 ? size.d : settle(depth);
  if (nw === size.w && nd === size.d) return [];
  // the centre moves half the growth toward the dragged side
  const cx = (handle.sx * (nw - size.w)) / 2;
  const cy = (handle.sy * (nd - size.d)) / 2;
  const dx = Math.round(cx * a.x.x + cy * a.y.x);
  const dy = Math.round(cx * a.x.y + cy * a.y.y);
  const commands: ItemCommand[] = [
    { type: "item.resize", payload: { itemId: it.id, size: { w: nw, d: nd, h: size.h }, anchor: "center" } },
  ];
  if (dx !== 0 || dy !== 0)
    commands.push({ type: "item.move", payload: { itemIds: [it.id], dx, dy, magnetism: false } });
  return commands;
}

/**
 * The turn a drag of the turn handle asks for: the item's front toward the pointer, in steps of
 * TURN_STEP_DEG when snapping. Null when that is the rotation it already has.
 */
export function rotateCommand(
  it: Pick<Item, "id" | "position" | "rotation">,
  to: Point,
  snap: boolean,
): ItemCommand | null {
  const vx = to.x - it.position.x;
  const vy = to.y - it.position.y;
  if (vx === 0 && vy === 0) return null;
  // the front is local -y, which a rotation r turns to (sin r, -cos r)
  const raw = (Math.atan2(vx, -vy) * 180) / Math.PI;
  const angle = normalizeDeg(
    snap ? Math.round(raw / TURN_STEP_DEG) * TURN_STEP_DEG : Math.round(raw * 10) / 10,
  );
  if (Math.abs(normalizeDeg(angle - it.rotation)) < 1e-9) return null;
  return { type: "item.rotate", payload: { itemIds: [it.id], angle } };
}

/** The footprint of an item, for drawing its handles against. */
export const footprintOf = (it: Pick<Item, "position" | "rotation">, size: Size3): Point[] =>
  derive.itemFootprint(it, size);

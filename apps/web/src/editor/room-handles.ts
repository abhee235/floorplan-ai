// The handles on a selected room's outline, and what each gesture on them means (P3-2; ledger R-050..
// R-058).
//
// Free of the DOM and of the canvas, like wall-handles.ts: the renderer draws the anchors this returns
// and the shell turns a press near one into a drag. Neither works the geometry out for itself.
//
// Until this existed a room's shape was fixed the moment it was drawn. A room that came out of a plan
// read slightly wrong — a corner a hundred millimetres into a wall, a recess the reader missed — could
// only be deleted and drawn again, which threw away its name, its purpose, its capacity and everything
// placed in it. That is the common case for this project, not a rare one: rooms arrive from a drawing
// nobody here controls and they arrive imperfect.
//
// Three gestures, three commands, all of which the model already had:
//   drag a corner        room.movePoint
//   drag an edge's dot   room.addPoint, then room.movePoint on the corner it created
//   double-click a corner room.removePoint
//
// ADR-016 D4 wrote all three as `room.setPolygon`. The finer commands say what happened rather than
// restating the whole ring, so the history reads "a corner moved" and a refusal names the point it was
// about; they carry the same rules (R-056 projection, R-057 minimum) inside the reducer, where both the
// panel and the agent's tools meet them too.

import { alignToAxesWithSources, SELECTION_PX, snapToPoints } from "@fpv/geometry";
import type { Point, Room, Wall } from "@fpv/ir";
import { poly } from "@fpv/ir";
import { MIN_CORNERS } from "./room-tool.js";

/** What is under the pointer on a selected room. */
export type RoomHandle = { kind: "corner"; index: number } | { kind: "edge"; index: number; at: Point };

// The same three corners the drawing tool insists on (R-041), which is the same rule the reducer
// enforces when a corner is removed (R-057 reversed). One constant, so the two can never drift apart.
export { MIN_CORNERS };

/**
 * How far a handle catches, in screen pixels, and how big it is drawn.
 *
 * One number for both, as the wall handles learnt the hard way: when the glyph was drawn larger than the
 * region that caught it, pressing exactly what was drawn missed and panned the view instead.
 */
export const CORNER_PX = 5;
export const EDGE_DOT_PX = 4;

/** Hit margin in plan millimetres: pixels over the zoom, tripled for touch (R-050, F-130). */
export function cornerMarginMm(scale: number, touch = false): number {
  return ((touch ? 3 : 1) * SELECTION_PX) / scale;
}

/** The middle of each edge, in edge order: edge i runs from corner i to corner i+1. */
export function edgeMidpoints(r: Room): Point[] {
  const n = r.polygon.length;
  return r.polygon.map((a, i) => {
    const b = r.polygon[(i + 1) % n] as Point;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  });
}

/**
 * The handle under a plan point, or null.
 *
 * Corners are tested before edges. On a short edge the two lie within a few pixels of each other, and
 * moving a corner that exists is both the commoner intent and the one whose mistake is more annoying:
 * adding a corner by accident leaves a corner to find and remove, where missing a corner only means
 * pressing again.
 */
export function roomHandleAt(r: Room, p: Point, marginMm: number): RoomHandle | null {
  const corner = poly.pointIndexAt(r.polygon, p, marginMm);
  if (corner >= 0) return { kind: "corner", index: corner };
  const mids = edgeMidpoints(r);
  for (let i = 0; i < mids.length; i += 1) {
    const m = mids[i] as Point;
    if (Math.hypot(m.x - p.x, m.y - p.y) <= marginMm) return { kind: "edge", index: i, at: m };
  }
  return null;
}

export interface CornerAimOptions {
  /** The magnetism switch from the tool options bar. */
  magnetism: boolean;
  /** Alt bypasses snapping, as it does everywhere else (W-082). */
  altHeld?: boolean;
  /** Plan millimetres in one screen pixel, so a tolerance in pixels holds at every zoom. */
  pixelMm: number;
  /** The walls of the level being edited; a room's corners should meet the structure exactly. */
  walls: readonly Wall[];
}

/** A guide line to draw while a corner is aligned with something, from the corner to what it met. */
export interface CornerGuide {
  from: Point;
  to: Point;
}

export interface AimedCorner {
  point: Point;
  /** What it caught, for the status bar: "corner", "aligned" or "". */
  note: string;
  guides: CornerGuide[];
}

/**
 * The corners a dragged point may meet: every wall end on the level, and the room's own other corners.
 *
 * The dragged corner itself is excluded (R-051) — a point cannot snap to where it already is, and
 * leaving it in would freeze the drag the moment it started.
 */
export function snapCandidates(r: Room, index: number, walls: readonly Wall[]): Point[] {
  const out: Point[] = [];
  for (const w of walls) {
    if (w.levelId !== r.levelId) continue;
    out.push(w.start, w.end);
  }
  for (let i = 0; i < r.polygon.length; i += 1) if (i !== index) out.push(r.polygon[i] as Point);
  return out;
}

/**
 * Where a dragged corner lands, and what to say about it.
 *
 * A corner within reach wins outright (R-051); otherwise each axis may align on its own with a nearby
 * corner's x or y (R-053), which is what makes a wall's line easy to hold while the other end moves.
 * Whole millimetres, because the schema stores integers and a preview drawn at a fraction would settle
 * somewhere else when it was committed.
 */
export function aimCorner(raw: Point, r: Room, index: number, options: CornerAimOptions): AimedCorner {
  const magnet = options.magnetism && !options.altHeld;
  if (!magnet) return { point: { x: Math.round(raw.x), y: Math.round(raw.y) }, note: "", guides: [] };
  const tolerance = SELECTION_PX * options.pixelMm;
  const candidates = snapCandidates(r, index, options.walls);
  const corner = snapToPoints(raw, candidates, tolerance);
  if (corner)
    return { point: { x: Math.round(corner.x), y: Math.round(corner.y) }, note: "corner", guides: [] };
  const aligned = alignToAxesWithSources(raw, candidates, tolerance);
  const point = { x: Math.round(aligned.point.x), y: Math.round(aligned.point.y) };
  const guides: CornerGuide[] = [];
  if (aligned.x) guides.push({ from: point, to: aligned.x });
  if (aligned.y) guides.push({ from: point, to: aligned.y });
  return { point, note: guides.length ? "aligned" : "", guides };
}

/** The polygon a room would have with one corner moved: what a drag previews. */
export function withCornerAt(r: Room, index: number, to: Point): Point[] {
  const polygon = r.polygon.map((q) => ({ x: q.x, y: q.y }));
  if (index >= 0 && index < polygon.length) polygon[index] = { x: to.x, y: to.y };
  return polygon;
}

/**
 * Whether a shape is still a room: three corners and no edge crossing another (R-150 reversed).
 *
 * The reducer accepts a crossed ring and the validator reports it afterwards, which is right for a file
 * that arrives crossed — but while a corner is under the pointer there is somewhere better to say it
 * than a count in the status bar, so the drag says it as it happens and the outline is drawn as a
 * problem. The gesture is not refused: a corner sometimes has to pass through a bad shape to reach a
 * good one, and a drag that stopped dead at the crossing would make that impossible.
 */
export function crossed(polygon: readonly Point[]): boolean {
  return polygon.length >= MIN_CORNERS && !poly.isSimple(polygon);
}

/** True while a corner can still be taken away (R-057 reversed). */
export function removable(r: Room): boolean {
  return r.polygon.length > MIN_CORNERS;
}

/** Why a corner cannot be removed, for the person who just tried. */
export const TOO_FEW = `A room needs at least ${MIN_CORNERS} corners.`;

export interface RoomCommand {
  type: string;
  payload: Record<string, unknown>;
}

export function moveCornerCommand(roomId: string, index: number, to: Point): RoomCommand {
  return { type: "room.movePoint", payload: { roomId, index, point: { x: to.x, y: to.y } } };
}

/**
 * Add a corner on an edge, then move it where the drag ended: the two commands of one gesture.
 *
 * The new corner's index is the edge's own index plus one, because the reducer inserts after the nearest
 * edge's first point (R-056) and the point given here is the middle of that edge, which no other edge is
 * nearer to. Predicting it is what lets the whole gesture be one transaction and one undo, rather than
 * an add the person has to notice before they can drag it.
 */
export function addCornerCommands(roomId: string, edgeIndex: number, at: Point, to: Point): RoomCommand[] {
  const index = edgeIndex + 1;
  const add: RoomCommand = {
    type: "room.addPoint",
    payload: { roomId, point: { x: Math.round(at.x), y: Math.round(at.y) } },
  };
  if (Math.round(to.x) === Math.round(at.x) && Math.round(to.y) === Math.round(at.y)) return [add];
  return [add, moveCornerCommand(roomId, index, to)];
}

export function removeCornerCommand(roomId: string, index: number): RoomCommand {
  return { type: "room.removePoint", payload: { roomId, index } };
}

/** What the status bar says while a corner is being dragged. */
export function describeCorner(index: number, total: number, aimed: AimedCorner, bad: boolean): string {
  const where = `Corner ${index + 1} of ${total}`;
  const caught = aimed.note === "corner" ? " · on a corner" : aimed.note === "aligned" ? " · aligned" : "";
  const warn = bad ? " · this shape crosses itself" : "";
  return `${where} at ${Math.round(aimed.point.x)}, ${Math.round(aimed.point.y)} mm${caught}${warn}`;
}

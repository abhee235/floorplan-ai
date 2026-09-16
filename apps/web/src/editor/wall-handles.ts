// The handles on a selected wall, and what dragging each one means (P3-4; ledger W-060, W-085, W-091).
//
// Free of the DOM and of the canvas so it can be tested. The renderer draws the anchors this returns and
// the shell turns a press near a region into a drag; neither works the geometry out for itself.
//
// Sub-part identity is carried by WHICH handle matched, rather than by widening the hit test. hitTest
// answers "which entity", and that stays true: handles exist only for a single selected wall, so there is
// never a question of which wall one belongs to, and the dragged sub-part is recovered once when the drag
// begins. The alternative — returning {id, partIndex} from every hit test — would complicate the common
// case to serve a rare one.

import { INDICATOR_PX } from "@fpv/geometry";
import type { Point, Wall } from "@fpv/ir";
import { derive, normalizeDeg, poly } from "@fpv/ir";

/** The three things that can be dragged on a selected wall. */
export type WallHandle = "start" | "end" | "arc";

/** Arc extent is stored in degrees and clamped to three quarters of a turn (W-060). */
export const MAX_ARC_EXTENT_DEG = 270;

/**
 * How far a handle's glyph reaches from its anchor, in screen pixels.
 *
 * The hit test unions this with the wall's own region, and the painter must not draw past it. They were
 * allowed to disagree once: the arrow was drawn out to twelve pixels while the catch radius reached five,
 * so pressing exactly what was drawn missed the handle and panned the view instead.
 */
export const GLYPH_REACH_PX = 24;

/**
 * Hit margin in plan millimetres.
 *
 * Screen pixels divided by the scale, so a handle stays the same size on screen at every zoom, and
 * tripled for touch because a fingertip covers far more than a cursor does (W-091).
 */
export function indicatorMarginMm(scale: number, touch = false): number {
  return ((touch ? 3 : 1) * INDICATOR_PX) / scale;
}

/**
 * The middle of each side surface: the two ends of the wall's mid cross-section.
 *
 * A footprint runs [one side start to end, then the other side end back to start] (W-003), so a quarter
 * of the way round the ring is the middle of the first side and the mirrored index is the middle of the
 * other. When the ring divides evenly into quarters there is no single middle point on either side and
 * the two straddling it are averaged instead — which is the usual case, since a straight wall is four
 * points and each side is a single segment with no midpoint of its own.
 *
 * Both the anchor and the hit region come from here so that the handle is drawn exactly where it can be
 * pressed.
 */
function sideMiddles(fp: readonly Point[]): [Point, Point] {
  const n = fp.length;
  const i = Math.floor(n / 4);
  const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  if (n % 4 !== 0) return [fp[i] as Point, fp[n - 1 - i] as Point];
  return [mid(fp[i - 1] as Point, fp[i] as Point), mid(fp[n - 1 - i] as Point, fp[n - i] as Point)];
}

function degOf(from: Point, to: Point): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

/**
 * Which way a wall runs at one of its ends, in degrees.
 *
 * Straight walls run along the chord. An arc leaves its ends along the tangent, which is the radius
 * turned a quarter circle — the direction of travel, so against the sweep for a positive extent, which
 * turns clockwise about the centre.
 */
function tangentDeg(w: Wall, end: "start" | "end"): number {
  const arc = derive.arcParams(w);
  const here = end === "start" ? w.start : w.end;
  if (!arc) return degOf(w.start, w.end);
  const radial = degOf(arc.centre, here);
  return (w.arcExtent as number) > 0 ? radial - 90 : radial + 90;
}

export interface HandleAnchor {
  /** Where the glyph sits, in plan millimetres. */
  at: Point;
  /** The direction it points, in degrees, away from the wall. */
  angleDeg: number;
}

/**
 * Where each handle sits on a selected wall, or null for a footprint too small to have sides.
 *
 * The two endpoint handles sit on the centreline, at the wall's own ends, because that is the point the
 * drag moves. The arc handle sits out on a side surface instead: putting it on the centreline would bury
 * it in the wall's own ink on a thin wall, and the side is where the bulge appears.
 */
export function handleAnchors(w: Wall, fp: readonly Point[]): Record<WallHandle, HandleAnchor> | null {
  if (fp.length < 4) return null;
  const chord = degOf(w.start, w.end);
  return {
    start: { at: w.start, angleDeg: normalizeDeg(tangentDeg(w, "start") + 180) },
    end: { at: w.end, angleDeg: normalizeDeg(tangentDeg(w, "end")) },
    arc: { at: sideMiddles(fp)[0], angleDeg: normalizeDeg(chord + 90) },
  };
}

/**
 * The handle under a plan point, or null.
 *
 * Two regions per handle, unioned: the part of the WALL the handle acts on, and the GLYPH drawn for it.
 * The wall regions are segments rather than discs — the end caps across the full thickness, and the
 * cross-section at the middle — because a cap is what the eye reads as "the end of the wall", and on a
 * thick wall a disc round the centreline would miss most of it.
 *
 * The glyph region matters just as much: the arrow and the bow are drawn OUTWARD from the anchor, so
 * without it the handle you can see is not the handle you can press.
 *
 * Endpoints are tested before the arc so that a short wall, where the regions overlap, still resizes
 * rather than bends — resizing is the commoner intent and the harder one to reach by other means.
 */
export function handleAt(
  w: Wall,
  fp: readonly Point[],
  p: Point,
  marginMm: number,
  mmPerPx: number,
): WallHandle | null {
  if (fp.length < 4) return null;
  const n = fp.length;
  const anchors = handleAnchors(w, fp);
  const near = (a: Point, b: Point) => poly.distancePointSegment(p, a, b) <= marginMm;
  const onGlyph = (kind: WallHandle): boolean => {
    if (!anchors) return false;
    const { at, angleDeg } = anchors[kind];
    const reach = GLYPH_REACH_PX * mmPerPx;
    const rad = (angleDeg * Math.PI) / 180;
    return near(at, { x: at.x + Math.cos(rad) * reach, y: at.y + Math.sin(rad) * reach });
  };
  if (near(fp[0] as Point, fp[n - 1] as Point) || onGlyph("start")) return "start";
  if (near(fp[n / 2 - 1] as Point, fp[n / 2] as Point) || onGlyph("end")) return "end";
  const [leftMiddle, rightMiddle] = sideMiddles(fp);
  if (near(leftMiddle, rightMiddle) || onGlyph("arc")) return "arc";
  return null;
}

/**
 * The CSS cursor for a handle, so hovering says what a press will do before it does it.
 *
 * Resize cursors come in four directions only, so a wall's angle rounds to the nearest of them; they are
 * symmetric about a half turn, which is why the four cover every angle. The bend handle takes a grab
 * cursor instead, because no resize arrow describes bending.
 */
export function handleCursor(handle: WallHandle, angleDeg: number): string {
  if (handle === "arc") return "grab";
  const CURSORS = ["ew-resize", "nesw-resize", "ns-resize", "nwse-resize"] as const;
  return CURSORS[Math.round(normalizeDeg(angleDeg) / 45) % 4] as string;
}

/** Centre of the circle through three points, or null when they are collinear. */
function circumcentre(a: Point, b: Point, c: Point): Point | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const sa = a.x * a.x + a.y * a.y;
  const sb = b.x * b.x + b.y * b.y;
  const sc = c.x * c.x + c.y * c.y;
  return {
    x: (sa * (b.y - c.y) + sb * (c.y - a.y) + sc * (a.y - b.y)) / d,
    y: (sa * (c.x - b.x) + sb * (a.x - c.x) + sc * (b.x - a.x)) / d,
  };
}

/**
 * The arc extent, in degrees, of the arc from start to end passing through a dragged point (W-060).
 *
 * Null when the three are collinear or the wall has no length: that is a straight wall, which is stored
 * as a null extent rather than a zero one.
 *
 * Worked in angles about the centre rather than from the chord, because the chord cannot tell the two
 * arcs apart. Sagitta and side of the chord are both the same for an arc and its complement — a quarter
 * turn and a three-quarter turn put the centre on one side and the bulge on the other either way — so
 * the only thing that says which arc the user means is which one the drag is actually on. Taking the
 * sweep from start to end that contains the dragged point says exactly that, and gets a turn past the
 * half automatically.
 *
 * A positive extent sweeps clockwise about the centre, so the stored value is the opposite sign to the
 * sweep. The magnitude is clamped to three quarters of a turn so an arc can never close on itself, and
 * `snap` rounds to whole degrees, which is what magnetism asks for (W-062).
 */
export function arcExtentThrough(start: Point, end: Point, through: Point, snap = false): number | null {
  if (start.x === end.x && start.y === end.y) return null;
  const centre = circumcentre(start, end, through);
  if (!centre) return null;

  const angleAt = (p: Point) => Math.atan2(p.y - centre.y, p.x - centre.x);
  const turn = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const from = angleAt(start);
  const anticlockwise = turn(angleAt(end) - from);
  const sweep = turn(angleAt(through) - from) < anticlockwise ? anticlockwise : anticlockwise - 2 * Math.PI;

  const signed = (-sweep * 180) / Math.PI;
  const clamped = Math.max(-MAX_ARC_EXTENT_DEG, Math.min(MAX_ARC_EXTENT_DEG, signed));
  const out = snap ? Math.round(clamped) : clamped;
  return out === 0 ? null : out;
}

/**
 * The wall as it would be after this drag, for drawing a live preview.
 *
 * Returned as a whole Wall so the caller can hand it straight to the footprint routines and draw the
 * real shape rather than an approximation of it. Endpoint drags change the shape, not the position, so
 * the translated outline a move uses cannot serve here.
 *
 * Null when the drag would produce a wall the host will refuse: the two ends may not coincide.
 */
export function previewWall(w: Wall, handle: WallHandle, to: Point, snap = false): Wall | null {
  if (handle === "arc") return { ...w, arcExtent: arcExtentThrough(w.start, w.end, to, snap) };
  const at = { x: Math.round(to.x), y: Math.round(to.y) };
  const other = handle === "start" ? w.end : w.start;
  if (at.x === other.x && at.y === other.y) return null;
  return handle === "start" ? { ...w, start: at } : { ...w, end: at };
}

export interface WallHandleCommand {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * The command that commits a handle drag, or null when nothing changed.
 *
 * Null rather than a no-op command on purpose: a drag that ends where it started should leave no entry
 * in the history to undo. Endpoint coordinates round to whole millimetres because Mm is an integer and a
 * fractional point is refused by the schema.
 */
export function handleCommand(w: Wall, handle: WallHandle, preview: Wall): WallHandleCommand | null {
  if (handle === "arc") {
    if (preview.arcExtent === w.arcExtent) return null;
    return { type: "wall.modify", payload: { wallId: w.id, changes: { arcExtent: preview.arcExtent } } };
  }
  const before = handle === "start" ? w.start : w.end;
  const after = handle === "start" ? preview.start : preview.end;
  if (after.x === before.x && after.y === before.y) return null;
  return { type: "wall.modify", payload: { wallId: w.id, changes: { [handle]: after } } };
}

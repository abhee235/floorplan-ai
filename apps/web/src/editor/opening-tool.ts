// Putting a door, a window or a passage in a wall (the opening tool of ADR-017 D2). The rules live here,
// free of the DOM and of the canvas: which wall is under the pointer, where along it the opening lands,
// whether it fits, and the one `opening.add` a placement sends.
//
// The tool has been on the rail since the rail was written and was wired to nothing: picking it, setting
// a width and pressing on a wall did nothing at all. An imported drawing could be corrected, because the
// properties panel edits an opening that already exists, but a plan drawn by hand could not have a door
// in it. Openings are also the weakest thing every reader extracts, so this is the tool a person reaches
// for most after an import.

import { defaultOpening, derive, type Opening, type Point, type Project, type Wall } from "@fpv/ir";

export type OpeningKind = "door" | "window" | "passage";

export interface OpeningSettings {
  kind: OpeningKind;
  widthMm: number;
  /** Alt is held: place it where the pointer is rather than snapping to the middle of the wall. */
  freehand: boolean;
}

/** How near the pointer must be to a wall's centreline, beyond its own half-thickness, to catch it. */
export const REACH_MM = 250;
/** Within this of the middle of a wall, the opening is pulled to the middle (ADR-017 D4). */
export const MIDDLE_SNAP_MM = 300;
/** A door is never flush with the end of a wall; it needs a jamb. */
export const END_MARGIN_MM = 50;
/** Arrows slide it along the wall; with Shift, more finely. */
export const SLIDE_MM = 100;
export const FINE_SLIDE_MM = 10;

export interface OpeningAim {
  wallId: string;
  /** Along the wall, 0 to 1. */
  position: number;
  widthMm: number;
  /** The opening as it would be, for drawing the ghost and for the panel to read. */
  preview: Opening;
  footprint: Point[];
  /** What the status bar says. */
  note: string;
  /** Why it cannot go here, or null when it can. */
  refusal: string | null;
  /** Whether the centre was pulled to the middle of the wall. */
  snapped: boolean;
}

export interface AddOpeningCommand {
  type: "opening.add";
  payload: { wallId: string; kind: OpeningKind; position: number; width: number };
}

/**
 * Where a point falls along a wall, as a fraction, and how far it is from the centreline.
 *
 * The fraction is measured along the CHORD even for a curved wall, because that is what the rest of the
 * IR does: `pointAlongWall`, and so `openingCentre`, `openingAlongInterval` and `openingFootprint`, all
 * ignore `arcExtent` and treat a wall as the straight line between its ends. Measuring along the arc
 * here would put the ghost in one place and the opening the host builds in another, which is worse than
 * sharing the existing limitation. (The engine does build arc walls in real path space, so an opening
 * in a curved wall is already drawn and modelled in two different places — a defect that predates this
 * tool and wants fixing in the IR, not here.)
 *
 * Distance from the centreline IS arc-aware, because it only decides which wall the pointer caught, and
 * a curved wall is unreachable without it.
 */
export function alongWall(w: Wall, at: Point): { fraction: number; awayMm: number } {
  const arc = derive.arcParams(w);
  if (arc) {
    const radial = Math.hypot(at.x - arc.centre.x, at.y - arc.centre.y);
    return { fraction: chordFraction(w, at), awayMm: Math.abs(radial - arc.radius) };
  }
  const dx = w.end.x - w.start.x;
  const dy = w.end.y - w.start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return { fraction: 0, awayMm: Math.hypot(at.x - w.start.x, at.y - w.start.y) };
  const t = ((at.x - w.start.x) * dx + (at.y - w.start.y) * dy) / lengthSq;
  const foot = { x: w.start.x + dx * t, y: w.start.y + dy * t };
  return { fraction: clamp01(t), awayMm: Math.hypot(at.x - foot.x, at.y - foot.y) };
}

/**
 * The wall under the pointer on this level, or null.
 *
 * Nearest centreline wins rather than first found, so a pointer in the corner where two walls meet
 * takes the one it is actually on.
 */
export function wallUnder(project: Project, levelId: string, at: Point): Wall | null {
  let best: { wall: Wall; away: number } | null = null;
  for (const w of project.walls) {
    if (w.levelId !== levelId) continue;
    const { awayMm } = alongWall(w, at);
    const reach = w.thickness / 2 + REACH_MM;
    if (awayMm > reach) continue;
    if (!best || awayMm < best.away) best = { wall: w, away: awayMm };
  }
  return best?.wall ?? null;
}

/** What would happen if the opening were placed here; null when the pointer is on no wall. */
export function aimOpening(
  project: Project,
  levelId: string,
  at: Point,
  settings: OpeningSettings,
): OpeningAim | null {
  const wall = wallUnder(project, levelId, at);
  if (!wall) return null;
  return aimOnWall(project, wall, alongWall(wall, at).fraction, settings);
}

/** The same, on a wall already chosen — what Tab-to-a-wall and the arrow keys use. */
export function aimOnWall(
  project: Project,
  wall: Wall,
  wanted: number,
  settings: OpeningSettings,
): OpeningAim {
  // Chord length, to match where the opening will actually be put (see `alongWall`).
  const lengthMm = derive.wallLength(wall);
  const width = Math.max(1, settings.widthMm);
  const describe = KIND_WORDS[settings.kind];

  // Too narrow a wall cannot hold it at all, and saying so beats silently shrinking the opening.
  const needed = width + END_MARGIN_MM * 2;
  if (lengthMm < needed) {
    const aim = previewOf(project, wall, 0.5, width, settings.kind);
    return {
      ...aim,
      note: `${describe} ${round(width)} mm`,
      refusal: `This wall is ${round(lengthMm)} mm long; a ${round(width)} mm ${describe.toLowerCase()} needs ${round(needed)} mm`,
      snapped: false,
    };
  }

  // Snap to the middle of the wall unless Alt says otherwise.
  const middle = 0.5;
  const fromMiddleMm = Math.abs(wanted - middle) * lengthMm;
  const snapped = !settings.freehand && fromMiddleMm <= MIDDLE_SNAP_MM;
  let position = snapped ? middle : wanted;

  // Keep the whole opening on the wall, with a jamb at each end.
  const halfFraction = (width / 2 + END_MARGIN_MM) / lengthMm;
  position = Math.min(1 - halfFraction, Math.max(halfFraction, position));

  const aim = previewOf(project, wall, position, width, settings.kind);
  const clash = overlapping(project, wall, aim.preview);
  return {
    ...aim,
    note: snapped
      ? `${describe} ${round(width)} mm, middle of the wall`
      : `${describe} ${round(width)} mm, ${round(position * lengthMm)} mm along`,
    refusal: clash ? `There is already a ${KIND_WORDS[clash.kind].toLowerCase()} here` : null,
    snapped,
  };
}

/** The command a placement sends, or null when the aim refuses. */
export function addCommand(aim: OpeningAim): AddOpeningCommand | null {
  if (aim.refusal) return null;
  return {
    type: "opening.add",
    payload: {
      wallId: aim.wallId,
      kind: aim.preview.kind as OpeningKind,
      position: aim.position,
      width: aim.widthMm,
    },
  };
}

/** Slide an aim along its wall by a distance in millimetres, keeping every rule. */
export function slide(
  project: Project,
  wall: Wall,
  aim: OpeningAim,
  byMm: number,
  settings: OpeningSettings,
): OpeningAim {
  const lengthMm = derive.wallLength(wall);
  const moved = aim.position + byMm / Math.max(1, lengthMm);
  // Sliding is deliberate, so it never re-snaps to the middle and fights the arrow key.
  return aimOnWall(project, wall, clamp01(moved), { ...settings, freehand: true });
}

const KIND_WORDS: Record<OpeningKind, string> = {
  door: "Door",
  window: "Window",
  passage: "Passage",
};

function previewOf(
  project: Project,
  wall: Wall,
  position: number,
  width: number,
  kind: OpeningKind,
): Omit<OpeningAim, "note" | "refusal" | "snapped"> {
  // `defaultOpening` gives the kind its own height, sill and swing, which is what the host will do too,
  // so the ghost is the opening rather than an approximation of it.
  const preview = defaultOpening("opening_preview", wall.levelId, wall.id, kind, { position, width });
  void project;
  return {
    wallId: wall.id,
    position,
    widthMm: width,
    preview,
    footprint: derive.openingFootprint(preview, wall),
  };
}

/** An opening already in this wall that the new one would sit on top of. */
function overlapping(project: Project, wall: Wall, wanted: Opening): Opening | null {
  const want = derive.openingAlongInterval(wanted, wall);
  for (const o of project.openings) {
    if (o.wallId !== wall.id) continue;
    const have = derive.openingAlongInterval(o, wall);
    if (want.from < have.to && have.from < want.to) return o;
  }
  return null;
}

/** How far along the straight line between the wall's ends a point falls. */
function chordFraction(w: Wall, at: Point): number {
  const dx = w.end.x - w.start.x;
  const dy = w.end.y - w.start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return 0;
  return clamp01(((at.x - w.start.x) * dx + (at.y - w.start.y) * dy) / lengthSq);
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const round = (v: number): number => Math.round(v);

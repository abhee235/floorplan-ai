// Measuring a distance on the plan (the measure tool of ADR-017 D2). The rules live here, free of the
// DOM and of the canvas: where each end lands, what the distance is, and how it reads.
//
// The tool has been on the rail since the rail was written and was wired to nothing. It matters more
// than it looks: every imported plan carries a scale that came from a dimension string a model read, or
// worse, from a guess — and a scale that is wrong by a fifth makes every area, every quantity and every
// line of the bill of materials wrong by a fifth, with nothing downstream able to notice. A person with
// a measuring tool can check a door against a known width in one gesture.
//
// It changes nothing. There is no command here, and that is the whole point: it is the one tool that
// can be used on a drawing nobody wants to disturb.

import type { Point, Project } from "@fpv/ir";

export type Units = "mm" | "m" | "ft";

export interface MeasureSettings {
  units: Units;
  /** Shift: hold the line to an axis. */
  axisLocked: boolean;
  /** Snap the ends to the corners of walls. */
  magnetism: boolean;
}

/** How near a wall end must be, in screen pixels, to catch the measuring end. */
export const SNAP_PX = 12;

export interface Measurement {
  from: Point;
  to: Point;
  /** Straight-line distance in millimetres. */
  distanceMm: number;
  /** Difference along each axis, for the two thin guides a measurement draws. */
  dxMm: number;
  dyMm: number;
  /** Clockwise from east, 0 to 360. */
  angleDeg: number;
  /** The distance as the options ask for it. */
  text: string;
  /** What each end caught, for the status bar: "corner", "axis" or "". */
  note: string;
}

/**
 * A distance, written the way the chosen units are read.
 *
 * Millimetres are grouped with a narrow space rather than a comma, as every other number in this
 * editor is: a comma is a decimal point in half the world, and a plan is read in both.
 */
export function formatDistance(mm: number, units: Units): string {
  if (units === "m") return `${(mm / 1000).toFixed(3).replace(/\.?0+$/, "")} m`;
  if (units === "ft") {
    const totalInches = mm / 25.4;
    const feet = Math.floor(totalInches / 12);
    const inches = totalInches - feet * 12;
    // Eighths, which is how a tape is read; a bare decimal inch is nobody's measurement.
    const eighths = Math.round(inches * 8);
    const whole = Math.floor(eighths / 8);
    const part = eighths - whole * 8;
    const carry = whole === 12;
    const shownFeet = feet + (carry ? 1 : 0);
    const shownInches = carry ? 0 : whole;
    const fraction = part === 0 ? "" : ` ${part}/8`;
    return `${shownFeet}' ${shownInches}${fraction}"`;
  }
  return `${Math.round(mm).toLocaleString("en-GB").replace(/,/g, " ")} mm`;
}

/** The point an end of the measurement lands on, and what it caught. */
export function aimEnd(
  raw: Point,
  project: Project | null,
  levelId: string | null,
  settings: MeasureSettings,
  pixelMm: number,
  from: Point | null,
): { point: Point; note: string } {
  // A corner wins over an axis: it is an exact place on the drawing, where an axis is only a direction.
  if (settings.magnetism && project) {
    const corner = nearestCorner(raw, project, levelId, SNAP_PX * pixelMm);
    if (corner) return { point: corner, note: "corner" };
  }
  if (settings.axisLocked && from) {
    // Whichever axis the pointer has travelled further along is the one it is held to.
    const dx = raw.x - from.x;
    const dy = raw.y - from.y;
    return Math.abs(dx) >= Math.abs(dy)
      ? { point: { x: raw.x, y: from.y }, note: "axis" }
      : { point: { x: from.x, y: raw.y }, note: "axis" };
  }
  return { point: raw, note: "" };
}

/**
 * The nearest end of any wall on this level, or null.
 *
 * Every end, not only the unjoined ones the wall tool snaps to: the corners worth measuring between
 * are exactly the joined ones, because that is what the corners of a room are.
 */
export function nearestCorner(
  at: Point,
  project: Project,
  levelId: string | null,
  toleranceMm: number,
): Point | null {
  let best: { point: Point; away: number } | null = null;
  for (const w of project.walls) {
    if (levelId && w.levelId !== levelId) continue;
    for (const p of [w.start, w.end]) {
      const away = Math.hypot(p.x - at.x, p.y - at.y);
      if (away > toleranceMm) continue;
      if (!best || away < best.away) best = { point: p, away };
    }
  }
  return best?.point ?? null;
}

/** The measurement between two points, as the status bar and the canvas both need it. */
export function measure(from: Point, to: Point, units: Units, note = ""): Measurement {
  const dxMm = to.x - from.x;
  const dyMm = to.y - from.y;
  const distanceMm = Math.hypot(dxMm, dyMm);
  const angleDeg = ((((Math.atan2(dyMm, dxMm) * 180) / Math.PI) % 360) + 360) % 360;
  return {
    from,
    to,
    distanceMm,
    dxMm,
    dyMm,
    angleDeg,
    text: formatDistance(distanceMm, units),
    note,
  };
}

/**
 * What the status bar says about a measurement in progress.
 *
 * The two axis differences are given as well as the distance, because on a floor plan the useful
 * question is as often "how far across" as "how far".
 */
export function describe(m: Measurement, units: Units): string {
  const across = formatDistance(Math.abs(m.dxMm), units);
  const up = formatDistance(Math.abs(m.dyMm), units);
  const caught = m.note ? `, ${m.note}` : "";
  return `${m.text}  ·  ${across} across, ${up} up  ·  ${m.angleDeg.toFixed(1)}°${caught}`;
}

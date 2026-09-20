// A design into commands (ADR-022 D4): the walls, openings and rooms a checked design asks for, as
// one atomic batch.
//
// The churn in the first three-bedroom run came from a model drawing walls one at a time and finding
// out afterwards that they did not meet. Rectangles do not have that problem: two rooms side by side
// share one wall, and which wall that is can be worked out rather than discovered. So the whole
// shell goes down in one transaction, and the model's job afterwards is furnishing and fixing, not
// geometry.
//
// Deterministic: the same design always gives the same commands, in the same order, so a design that
// built once builds the same way again.
import { type Design, type DesignRoom, OUTSIDE, onOutsideWall, sharedEdge } from "@fpv/ir";

/** Room edges and shell faces within this of each other are the same wall. */
const SNAP_MM = 400;
/** Doors and windows are at least this far from the end of the wall they sit in. */
const MARGIN_MM = 250;
const DOOR_MM = 900;
const ENTRANCE_MM = 1000;
const WET_DOOR_MM = 750;
const WINDOW_MM = 1200;
const WINDOW_SILL_MM = 900;
const DOOR_HEIGHT_MM = 2100;

type Axis = "h" | "v";

interface Run {
  axis: Axis;
  /** y for a horizontal run, x for a vertical one: where its centreline sits. */
  at: number;
  from: number;
  to: number;
  thickness: number;
  kind: "exterior" | "interior";
}

export interface BuildPlan {
  commands: unknown[];
  warnings: string[];
  counts: { walls: number; doors: number; windows: number; rooms: number };
}

const wet = (purpose: string) => purpose === "bathroom" || purpose === "toilet";

/** The line a wall's centre sits on between two facing room edges, or on a shell face. */
function centreOf(edge: number, facing: number | null, shellFace: number | null, wallMm: number): number {
  if (shellFace !== null) return shellFace;
  if (facing !== null) return (edge + facing) / 2;
  return edge;
}

/**
 * Every wall the design implies, merged so one wall serves every room along it.
 *
 * Each room contributes its four edges. An edge on the outside of the building becomes part of a
 * shell wall; an edge facing another room becomes an interior wall on the line between them, which
 * is the same line the other room computes, so the two agree and the wall is drawn once.
 */
export function wallRuns(design: Design): Run[] {
  const { shell } = design;
  const half = shell.wallMm / 2;
  // the shell's centrelines: the rectangle the outside walls are drawn on
  const shellLine = {
    west: shell.x + half,
    east: shell.x + shell.w - half,
    south: shell.y + half,
    north: shell.y + shell.d - half,
  };
  const near = (a: number, b: number) => Math.abs(a - b) <= shell.wallMm + SNAP_MM;

  const segments: Run[] = [];
  const push = (axis: Axis, at: number, from: number, to: number, thickness: number, kind: Run["kind"]) => {
    if (to - from > 1) segments.push({ axis, at: Math.round(at), from, to, thickness, kind });
  };

  for (const r of design.rooms) {
    const { x, y, w, d } = r.rect;
    // the nearest edge of another room facing this one, if there is one
    const facingVertical = (edge: number, y0: number, y1: number, side: "west" | "east") => {
      let best: number | null = null;
      for (const other of design.rooms) {
        if (other.key === r.key) continue;
        const theirs = side === "west" ? other.rect.x + other.rect.w : other.rect.x;
        if (Math.abs(theirs - edge) > shell.interiorWallMm + SNAP_MM) continue;
        if (Math.min(y1, other.rect.y + other.rect.d) - Math.max(y0, other.rect.y) <= 1) continue;
        if (best === null || Math.abs(theirs - edge) < Math.abs(best - edge)) best = theirs;
      }
      return best;
    };
    const facingHorizontal = (edge: number, x0: number, x1: number, side: "south" | "north") => {
      let best: number | null = null;
      for (const other of design.rooms) {
        if (other.key === r.key) continue;
        const theirs = side === "south" ? other.rect.y + other.rect.d : other.rect.y;
        if (Math.abs(theirs - edge) > shell.interiorWallMm + SNAP_MM) continue;
        if (Math.min(x1, other.rect.x + other.rect.w) - Math.max(x0, other.rect.x) <= 1) continue;
        if (best === null || Math.abs(theirs - edge) < Math.abs(best - edge)) best = theirs;
      }
      return best;
    };

    for (const side of ["west", "east"] as const) {
      const edge = side === "west" ? x : x + w;
      const onShell = near(edge, side === "west" ? shell.x : shell.x + shell.w);
      const at = centreOf(
        edge,
        onShell ? null : facingVertical(edge, y, y + d, side),
        onShell ? (side === "west" ? shellLine.west : shellLine.east) : null,
        shell.wallMm,
      );
      push(
        "v",
        at,
        y,
        y + d,
        onShell ? shell.wallMm : shell.interiorWallMm,
        onShell ? "exterior" : "interior",
      );
    }
    for (const side of ["south", "north"] as const) {
      const edge = side === "south" ? y : y + d;
      const onShell = near(edge, side === "south" ? shell.y : shell.y + shell.d);
      const at = centreOf(
        edge,
        onShell ? null : facingHorizontal(edge, x, x + w, side),
        onShell ? (side === "south" ? shellLine.south : shellLine.north) : null,
        shell.wallMm,
      );
      push(
        "h",
        at,
        x,
        x + w,
        onShell ? shell.wallMm : shell.interiorWallMm,
        onShell ? "exterior" : "interior",
      );
    }
  }

  // the shell itself, so the building is closed even where no room reaches the edge
  push("h", shellLine.south, shellLine.west, shellLine.east, shell.wallMm, "exterior");
  push("h", shellLine.north, shellLine.west, shellLine.east, shell.wallMm, "exterior");
  push("v", shellLine.west, shellLine.south, shellLine.north, shell.wallMm, "exterior");
  push("v", shellLine.east, shellLine.south, shellLine.north, shell.wallMm, "exterior");

  // merge what lies on the same line: one wall along a row of rooms, not one per room
  const byLine = new Map<string, Run[]>();
  for (const s of segments) {
    const key = `${s.axis}:${s.at}:${s.kind}`;
    byLine.set(key, [...(byLine.get(key) ?? []), s]);
  }
  const runs: Run[] = [];
  for (const group of byLine.values()) {
    const sorted = [...group].sort((a, b) => a.from - b.from);
    let current = { ...(sorted[0] as Run) };
    for (const s of sorted.slice(1)) {
      if (s.from <= current.to + SNAP_MM) {
        current.to = Math.max(current.to, s.to);
        current.thickness = Math.max(current.thickness, s.thickness);
      } else {
        runs.push(current);
        current = { ...s };
      }
    }
    runs.push(current);
  }
  // drop an interior run that an exterior one already covers: a room against the shell says both
  return runs
    .filter(
      (r) =>
        r.kind === "exterior" ||
        !runs.some(
          (e) =>
            e.kind === "exterior" &&
            e.axis === r.axis &&
            Math.abs(e.at - r.at) <= shell.wallMm &&
            e.from - SNAP_MM <= r.from &&
            e.to + SNAP_MM >= r.to,
        ),
    )
    .sort(
      (a, b) =>
        (a.kind === b.kind ? 0 : a.kind === "exterior" ? -1 : 1) ||
        a.axis.localeCompare(b.axis) ||
        a.at - b.at ||
        a.from - b.from,
    );
}

const runPoints = (r: Run) =>
  r.axis === "h"
    ? [
        { x: Math.round(r.from), y: r.at },
        { x: Math.round(r.to), y: r.at },
      ]
    : [
        { x: r.at, y: Math.round(r.from) },
        { x: r.at, y: Math.round(r.to) },
      ];

/**
 * Where a door between two rooms goes: the middle of the wall they share.
 *
 * Returned in plan coordinates; the tool turns it into a position along whichever wall the store
 * gave that line, because a wall's id is not known until it has been drawn.
 */
function doorBetween(a: DesignRoom, b: DesignRoom, gapMm: number): { x: number; y: number } | null {
  if (sharedEdge(a.rect, b.rect, gapMm) < 1) return null;
  const vertical =
    Math.abs(a.rect.x + a.rect.w - b.rect.x) <= gapMm || Math.abs(b.rect.x + b.rect.w - a.rect.x) <= gapMm;
  if (vertical) {
    const x =
      Math.abs(a.rect.x + a.rect.w - b.rect.x) <= gapMm
        ? (a.rect.x + a.rect.w + b.rect.x) / 2
        : (b.rect.x + b.rect.w + a.rect.x) / 2;
    const from = Math.max(a.rect.y, b.rect.y);
    const to = Math.min(a.rect.y + a.rect.d, b.rect.y + b.rect.d);
    return { x: Math.round(x), y: Math.round((from + to) / 2) };
  }
  const y =
    Math.abs(a.rect.y + a.rect.d - b.rect.y) <= gapMm
      ? (a.rect.y + a.rect.d + b.rect.y) / 2
      : (b.rect.y + b.rect.d + a.rect.y) / 2;
  const from = Math.max(a.rect.x, b.rect.x);
  const to = Math.min(a.rect.x + a.rect.w, b.rect.x + b.rect.w);
  return { x: Math.round((from + to) / 2), y: Math.round(y) };
}

/** The middle of the room's longest side that lies on the outside of the building. */
function outsideSpot(
  room: DesignRoom,
  shell: Design["shell"],
  gapMm: number,
): { x: number; y: number } | null {
  const { x, y, w, d } = room.rect;
  const sides: { at: { x: number; y: number }; length: number }[] = [];
  if (Math.abs(x - shell.x) <= gapMm)
    sides.push({ at: { x: shell.x + shell.wallMm / 2, y: y + d / 2 }, length: d });
  if (Math.abs(shell.x + shell.w - (x + w)) <= gapMm)
    sides.push({ at: { x: shell.x + shell.w - shell.wallMm / 2, y: y + d / 2 }, length: d });
  if (Math.abs(y - shell.y) <= gapMm)
    sides.push({ at: { x: x + w / 2, y: shell.y + shell.wallMm / 2 }, length: w });
  if (Math.abs(shell.y + shell.d - (y + d)) <= gapMm)
    sides.push({ at: { x: x + w / 2, y: shell.y + shell.d - shell.wallMm / 2 }, length: w });
  const best = sides.sort((a, b) => b.length - a.length)[0];
  return best ? { x: Math.round(best.at.x), y: Math.round(best.at.y) } : null;
}

export interface OpeningWanted {
  kind: "door" | "window";
  /** Where on the plan it goes; the tool finds the wall whose line passes through it. */
  at: { x: number; y: number };
  width: number;
  height: number;
  sill: number;
  /** For the warning when no wall is found. */
  between: string;
}

/** Every opening the design asks for, as points the tool matches to the walls it drew. */
export function openingsWanted(design: Design): { wanted: OpeningWanted[]; warnings: string[] } {
  const gap = design.shell.interiorWallMm + SNAP_MM;
  const byKey = new Map(design.rooms.map((r) => [r.key, r]));
  const wanted: OpeningWanted[] = [];
  const warnings: string[] = [];
  const done = new Set<string>();
  for (const r of design.rooms)
    for (const to of r.doorsTo) {
      const pair = [r.key, to].sort().join("|");
      if (done.has(pair)) continue;
      done.add(pair);
      if (to === OUTSIDE) {
        const at = outsideSpot(r, design.shell, gap);
        if (!at) {
          warnings.push(`${r.name} has a door to the outside but no wall on the outside of the building`);
          continue;
        }
        wanted.push({
          kind: "door",
          at,
          width: ENTRANCE_MM,
          height: DOOR_HEIGHT_MM,
          sill: 0,
          between: `${r.name} and the outside`,
        });
        continue;
      }
      const other = byKey.get(to);
      if (!other) continue;
      const at = doorBetween(r, other, gap);
      if (!at) {
        warnings.push(`${r.name} and ${other.name} have a door between them but do not share a wall`);
        continue;
      }
      wanted.push({
        kind: "door",
        at,
        width: wet(r.purpose) || wet(other.purpose) ? WET_DOOR_MM : DOOR_MM,
        height: DOOR_HEIGHT_MM,
        sill: 0,
        between: `${r.name} and ${other.name}`,
      });
    }
  for (const r of design.rooms) {
    if (!r.window) continue;
    if (!onOutsideWall(r, design.shell, gap)) {
      warnings.push(`${r.name} wants a window but has no wall on the outside of the building`);
      continue;
    }
    const at = outsideSpot(r, design.shell, gap);
    if (at)
      wanted.push({
        kind: "window",
        at,
        width: WINDOW_MM,
        height: WINDOW_MM,
        sill: WINDOW_SILL_MM,
        between: r.name,
      });
  }
  return { wanted, warnings };
}

/** A room's polygon: its rectangle, which is the clear inside the design was measured on. */
export function roomPolygon(r: DesignRoom): { x: number; y: number }[] {
  const { x, y, w, d } = r.rect;
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + d },
    { x, y: y + d },
  ];
}

export type { Run };
export { MARGIN_MM, runPoints, SNAP_MM };

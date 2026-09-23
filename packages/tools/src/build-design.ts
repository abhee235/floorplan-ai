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
import {
  type Design,
  type DesignRoom,
  enclosureOf,
  isSharedFloor,
  mustBeWalled,
  OUTSIDE,
  onGlazedSide,
  onOutsideWall,
  outsideSides,
  sharedEdge,
} from "@fpv/ir";

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
  kind: "exterior" | "interior" | "glass";
  /** On the outside of the building, whatever it is made of. */
  shell?: boolean;
}

type Side = "north" | "south" | "east" | "west";

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
/**
 * What stands between two rooms, by rule and not by which was listed first (ADR-028 D3, D12).
 *
 * Solid if either must be (a restroom, a store, a server room); nothing when both are open floor;
 * glass where a glass box faces the shared floor, open or circulation; else solid. `null` is no wall
 * at all. A room facing unaccounted space is treated as facing open floor. The builder used to keep
 * whichever room came first, and a transcribed plan with the open workspace listed first lost every
 * glass wall it had.
 *
 * Two glass rooms side by side are parted by plaster. A row of glass meeting rooms drawn with glass
 * between them had no wall a screen could hang on, and a room is not private from the room next to
 * it through a sheet of glass; glass is for being seen from the floor.
 */
export function wallBetween(a: DesignRoom, b: DesignRoom | null): Run["kind"] | null {
  if (mustBeWalled(a) || (b && mustBeWalled(b))) return "interior";
  const ea = enclosureOf(a);
  const eb = b ? enclosureOf(b) : "open";
  if (ea === "open" && eb === "open") return null;
  const bShared = b === null || isSharedFloor(b);
  if (ea === "glass" && bShared) return "glass";
  if (eb === "glass" && isSharedFloor(a)) return "glass";
  return "interior";
}

/**
 * A side of the building, or the stretch of it behind one room: glass when the facade says glazed,
 * except behind a room that must be walled, where it is a solid outside wall (ADR-028 D12).
 */
function shellKind(design: Design, side: Side, room?: DesignRoom): Run["kind"] {
  if (design.shell.facade[side] !== "glazed") return "exterior";
  return room && mustBeWalled(room) ? "exterior" : "glass";
}

/**
 * A whole side of the shell as stretches of glass and solid wall: solid behind every room that must
 * be walled, glass elsewhere. One glass wall the length of a side ran straight past a toilet.
 */
function shellSide(
  design: Design,
  side: Side,
  from: number,
  to: number,
): { from: number; to: number; kind: Run["kind"] }[] {
  const kind = shellKind(design, side);
  if (kind !== "glass") return [{ from, to, kind }];
  const gap = design.shell.interiorWallMm + SNAP_MM;
  const half = design.shell.interiorWallMm / 2;
  const along = side === "north" || side === "south";
  // Within the shell's own thickness of an end, the solid stretch takes the end: a service room in
  // the corner of a glazed side used to leave a 58 mm stub of glass beside it, which is a wall
  // entity nobody wants and a blue tick in the picture.
  const snap = (x: { from: number; to: number }) => ({
    from: x.from - from <= design.shell.wallMm ? from : x.from,
    to: to - x.to <= design.shell.wallMm ? to : x.to,
  });
  const solid = design.rooms
    .filter((r) => mustBeWalled(r) && outsideSides(r, design.shell, gap).includes(side))
    .map((r) =>
      snap(
        along
          ? { from: Math.max(from, r.rect.x - half), to: Math.min(to, r.rect.x + r.rect.w + half) }
          : { from: Math.max(from, r.rect.y - half), to: Math.min(to, r.rect.y + r.rect.d + half) },
      ),
    )
    .filter((x) => x.to > x.from)
    .sort((a, b) => a.from - b.from);
  const out: { from: number; to: number; kind: Run["kind"] }[] = [];
  let cursor = from;
  for (const x of solid) {
    if (x.from > cursor) out.push({ from: cursor, to: x.from, kind: "glass" });
    out.push({ from: Math.max(cursor, x.from), to: x.to, kind: "exterior" });
    cursor = Math.max(cursor, x.to);
  }
  if (to > cursor) out.push({ from: cursor, to, kind: "glass" });
  return out;
}

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
  const push = (
    axis: Axis,
    at: number,
    from: number,
    to: number,
    thickness: number,
    kind: Run["kind"],
    onShell = false,
  ) => {
    if (to - from > 1) segments.push({ axis, at: Math.round(at), from, to, thickness, kind, shell: onShell });
  };

  for (const r of design.rooms) {
    const { x, y, w, d } = r.rect;
    // Every other room whose edge faces this one along part of it, with the part. An edge that
    // faces three rooms is three walls, each of its own kind: the open workspace's north edge in
    // the rendering faces a glass suite, a solid server room and an open cafe, and one wall of
    // one kind along the whole of it was wrong twice over.
    type Facing = { edge: number; room: DesignRoom; from: number; to: number };
    const facingAll = (edge: number, lo: number, hi: number, side: Side): Facing[] => {
      const out: Facing[] = [];
      for (const other of design.rooms) {
        if (other.key === r.key) continue;
        const vertical = side === "west" || side === "east";
        const theirs = vertical
          ? side === "west"
            ? other.rect.x + other.rect.w
            : other.rect.x
          : side === "south"
            ? other.rect.y + other.rect.d
            : other.rect.y;
        if (Math.abs(theirs - edge) > shell.interiorWallMm + SNAP_MM) continue;
        const from = Math.max(lo, vertical ? other.rect.y : other.rect.x);
        const to = Math.min(hi, vertical ? other.rect.y + other.rect.d : other.rect.x + other.rect.w);
        if (to - from <= 1) continue;
        out.push({ edge: theirs, room: other, from, to });
      }
      return out.sort((a, b) => a.from - b.from);
    };
    // The edge as a sequence of stretches: facing a room, or facing nothing.
    const stretches = (edge: number, lo: number, hi: number, side: Side) => {
      const parts: { from: number; to: number; facing: Facing | null }[] = [];
      let cursor = lo;
      for (const f of facingAll(edge, lo, hi, side)) {
        if (f.from > cursor + 1) parts.push({ from: cursor, to: f.from, facing: null });
        parts.push({ from: Math.max(f.from, cursor), to: f.to, facing: f });
        cursor = Math.max(cursor, f.to);
      }
      if (hi > cursor + 1) parts.push({ from: cursor, to: hi, facing: null });
      return parts;
    };

    for (const side of ["west", "east"] as const) {
      const edge = side === "west" ? x : x + w;
      const onShell = near(edge, side === "west" ? shell.x : shell.x + shell.w);
      if (onShell) {
        const at = side === "west" ? shellLine.west : shellLine.east;
        push("v", at, y, y + d, shell.wallMm, shellKind(design, side, r), true);
        continue;
      }
      for (const part of stretches(edge, y, y + d, side)) {
        const kind = wallBetween(r, part.facing?.room ?? null);
        if (kind === null) continue;
        const at = centreOf(edge, part.facing?.edge ?? null, null, shell.wallMm);
        push("v", at, part.from, part.to, shell.interiorWallMm, kind);
      }
    }
    for (const side of ["south", "north"] as const) {
      const edge = side === "south" ? y : y + d;
      const onShell = near(edge, side === "south" ? shell.y : shell.y + shell.d);
      if (onShell) {
        const at = side === "south" ? shellLine.south : shellLine.north;
        push("h", at, x, x + w, shell.wallMm, shellKind(design, side, r), true);
        continue;
      }
      for (const part of stretches(edge, x, x + w, side)) {
        const kind = wallBetween(r, part.facing?.room ?? null);
        if (kind === null) continue;
        const at = centreOf(edge, part.facing?.edge ?? null, null, shell.wallMm);
        push("h", at, part.from, part.to, shell.interiorWallMm, kind);
      }
    }
  }

  // the shell itself, so the building is closed even where no room reaches the edge
  for (const part of shellSide(design, "south", shellLine.west, shellLine.east))
    push("h", shellLine.south, part.from, part.to, shell.wallMm, part.kind, true);
  for (const part of shellSide(design, "north", shellLine.west, shellLine.east))
    push("h", shellLine.north, part.from, part.to, shell.wallMm, part.kind, true);
  for (const part of shellSide(design, "west", shellLine.south, shellLine.north))
    push("v", shellLine.west, part.from, part.to, shell.wallMm, part.kind, true);
  for (const part of shellSide(design, "east", shellLine.south, shellLine.north))
    push("v", shellLine.east, part.from, part.to, shell.wallMm, part.kind, true);

  // merge what lies on the same line: one wall along a row of rooms, not one per room
  const byLine = new Map<string, Run[]>();
  for (const s of segments) {
    const key = `${s.axis}:${s.at}:${s.kind}:${s.shell ? "shell" : "in"}`;
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
  // drop an inside run that a shell run already covers: a room against the shell says both
  return runs
    .filter(
      (r) =>
        r.shell ||
        !runs.some(
          (e) =>
            e.shell &&
            e.axis === r.axis &&
            Math.abs(e.at - r.at) <= shell.wallMm &&
            e.from - SNAP_MM <= r.from &&
            e.to + SNAP_MM >= r.to,
        ),
    )
    .sort(
      (a, b) =>
        (Boolean(a.shell) === Boolean(b.shell) ? 0 : a.shell ? -1 : 1) ||
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

/** The middle of the room's longest side that lies on the outside of the building, and which side. */
function outsideSpot(
  room: DesignRoom,
  shell: Design["shell"],
  gapMm: number,
  allowed: (side: Side) => boolean = () => true,
): { at: { x: number; y: number }; side: Side; length: number } | null {
  const { x, y, w, d } = room.rect;
  const sides: { at: { x: number; y: number }; length: number; side: Side }[] = [];
  if (Math.abs(x - shell.x) <= gapMm)
    sides.push({ at: { x: shell.x + shell.wallMm / 2, y: y + d / 2 }, length: d, side: "west" });
  if (Math.abs(shell.x + shell.w - (x + w)) <= gapMm)
    sides.push({ at: { x: shell.x + shell.w - shell.wallMm / 2, y: y + d / 2 }, length: d, side: "east" });
  if (Math.abs(y - shell.y) <= gapMm)
    sides.push({ at: { x: x + w / 2, y: shell.y + shell.wallMm / 2 }, length: w, side: "south" });
  if (Math.abs(shell.y + shell.d - (y + d)) <= gapMm)
    sides.push({ at: { x: x + w / 2, y: shell.y + shell.d - shell.wallMm / 2 }, length: w, side: "north" });
  const best = sides.filter((x) => allowed(x.side)).sort((a, b) => b.length - a.length)[0];
  return best
    ? { at: { x: Math.round(best.at.x), y: Math.round(best.at.y) }, side: best.side, length: best.length }
    : null;
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
  /** Which side of the building each room's entrance is on, so its window keeps clear of the door. */
  const entrances = new Map<string, Side>();
  for (const r of design.rooms)
    for (const to of r.doorsTo) {
      const pair = [r.key, to].sort().join("|");
      if (done.has(pair)) continue;
      done.add(pair);
      if (to === OUTSIDE) {
        const spot = outsideSpot(r, design.shell, gap);
        if (!spot) {
          warnings.push(`${r.name} has a door to the outside but no wall on the outside of the building`);
          continue;
        }
        entrances.set(r.key, spot.side);
        wanted.push({
          kind: "door",
          at: spot.at,
          width: ENTRANCE_MM,
          height: DOOR_HEIGHT_MM,
          sill: 0,
          between: `${r.name} and the outside`,
        });
        continue;
      }
      const other = byKey.get(to);
      if (!other) continue;
      // Two open rooms have no wall between them to hang a door in; they are one floor.
      if (wallBetween(r, other) === null) continue;
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
    // A glazed side is one window the length of the building: nothing to punch (ADR-028 D3). A
    // solid side takes none, so the window goes on a side that has windows, or nowhere (D12).
    if (onGlazedSide(r, design.shell, gap)) continue;
    const spot = outsideSpot(r, design.shell, gap, (side) => design.shell.facade[side] === "windows");
    if (!spot) {
      warnings.push(`${r.name} wants a window but its outside walls take none; the window is left out`);
      continue;
    }
    let at = spot.at;
    if (entrances.get(r.key) === spot.side) {
      // The entrance is centred on this side already. The window moves a quarter of the way along,
      // or is dropped when the side is too short for both; two openings centred on one wall was
      // how a transcribed reception refused to build (ADR-028 D4).
      const shift = spot.length / 4;
      if (shift < (ENTRANCE_MM + WINDOW_MM) / 2 + MARGIN_MM) {
        warnings.push(`${r.name}'s side is too short for its entrance and a window; the window is left out`);
        continue;
      }
      at =
        spot.side === "south" || spot.side === "north"
          ? { x: at.x + shift, y: at.y }
          : { x: at.x, y: at.y + shift };
    }
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

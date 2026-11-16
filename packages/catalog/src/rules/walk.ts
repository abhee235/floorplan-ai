// The walk (ADR-028 D11): what a person walking the plan from the front door would report.
//
// Facts, not rules. The checker says what cannot be built or used; this says what the plan is like
// to walk through -- the route to every room, the rooms reached only through another room, what
// stands along each side of the building -- so a model can judge it, whether or not it can see. A
// model that never saw its plan drew meeting rooms along two sides and left the other two blank, and
// nothing it had been told said so.
import { type Design, type DesignRoom, isSharedFloor, OUTSIDE, outsideSides } from "@fpv/ir";
import { doorGraph } from "./layout.js";

export type WalkSide = "north" | "south" | "east" | "west";

export interface DesignWalk {
  /** Rooms with a door to outside, in the order the design lists them. */
  entrances: string[];
  /** Each room's route from the way in, as the rooms walked through to reach it. */
  routes: Record<string, string>;
  /** Rooms reached only by walking through a room that is not shared floor, and which room. */
  through: string[];
  /** Rooms nobody walking in reaches at all. */
  unreached: string[];
  /**
   * Each side of the building: its facade; how much of its length has a room against it that is
   * neither open floor nor circulation, from 0 to 1; how much has no room against it at all, which is
   * what reads as a blank side; and what stands along it, in order.
   */
  sides: Record<WalkSide, { facade: string; enclosed: number; empty: number; along: string[] }>;
}

/** The gap the checker allows between a room's rectangle and what it touches. */
const TOUCH_MM = 400;

/** Floor anyone may walk across: open zones, corridors, a foyer, and the reception you come in by. */
const passable = (r: DesignRoom | undefined): boolean =>
  r !== undefined && (isSharedFloor(r) || r.purpose === "reception");

/**
 * Walk the design from the way in.
 *
 * Routes prefer shared floor: stepping out of a room that is not shared costs as much as fifty
 * doors, so a room behind a meeting room is reported as reached through it only when there is no
 * other way. Without an entrance the walk starts where the checker's does, at the reception, a foyer
 * or the busiest open floor.
 */
export function walkDesign(design: Design): DesignWalk {
  const rooms = design.rooms;
  const byKey = new Map(rooms.map((r) => [r.key, r]));
  const doors = doorGraph(design);
  const entrances = rooms.filter((r) => r.doorsTo.includes(OUTSIDE)).map((r) => r.key);
  const start =
    entrances.length > 0
      ? OUTSIDE
      : (rooms.find((r) => r.purpose === "reception" || r.purpose === "foyer")?.key ??
        [...rooms]
          .filter((r) => isSharedFloor(r))
          .sort((a, b) => (doors.get(b.key)?.size ?? 0) - (doors.get(a.key)?.size ?? 0))[0]?.key ??
        rooms[0]?.key ??
        OUTSIDE);

  // Dijkstra over a few dozen rooms: plain arrays are enough.
  const cost = new Map<string, number>([[start, 0]]);
  const parent = new Map<string, string>();
  const done = new Set<string>();
  for (;;) {
    let here: string | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const [k, v] of cost)
      if (!done.has(k) && v < best) {
        best = v;
        here = k;
      }
    if (here === null) break;
    done.add(here);
    const leaving = here === start || passable(byKey.get(here)) ? 1 : 50;
    for (const next of doors.get(here) ?? []) {
      if (next === OUTSIDE || done.has(next)) continue;
      const c = best + leaving;
      if (c < (cost.get(next) ?? Number.POSITIVE_INFINITY)) {
        cost.set(next, c);
        parent.set(next, here);
      }
    }
  }

  const routes: Record<string, string> = {};
  const through: string[] = [];
  const unreached: string[] = [];
  for (const r of rooms) {
    if (!cost.has(r.key)) {
      unreached.push(r.key);
      continue;
    }
    const path: string[] = [];
    for (let k: string | undefined = r.key; k !== undefined && k !== OUTSIDE; k = parent.get(k))
      path.unshift(k);
    routes[r.key] = path.join(" > ");
    const via = path.slice(0, -1).filter((k) => k !== start && !passable(byKey.get(k)));
    if (via.length > 0) through.push(`${r.key} through ${via.join(", ")}`);
  }

  const { shell } = design;
  const gap = shell.interiorWallMm + TOUCH_MM;
  const sides = {} as DesignWalk["sides"];
  for (const side of ["north", "east", "south", "west"] as const) {
    const along = side === "north" || side === "south";
    const length = (along ? shell.w : shell.d) - 2 * shell.wallMm;
    const against = rooms
      .filter((r) => outsideSides(r, shell, gap).includes(side))
      .sort((a, b) => (along ? a.rect.x - b.rect.x : a.rect.y - b.rect.y));
    const enclosed = against
      .filter((r) => !isSharedFloor(r))
      .reduce((n, r) => n + (along ? r.rect.w : r.rect.d), 0);
    // covered at all: each room's stretch of the side, widened by half an inside wall so two
    // neighbours leave no gap between them, merged, and clipped to the side
    const lo = (along ? shell.x : shell.y) + shell.wallMm;
    const hi = (along ? shell.x + shell.w : shell.y + shell.d) - shell.wallMm;
    const half = shell.interiorWallMm / 2 + 1;
    const spans = against
      .map((r) =>
        along ? [r.rect.x - half, r.rect.x + r.rect.w + half] : [r.rect.y - half, r.rect.y + r.rect.d + half],
      )
      .map(([a, b]) => [Math.max(lo, a as number), Math.min(hi, b as number)] as const)
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let reach = lo;
    for (const [a, b] of spans) {
      if (b > Math.max(a, reach)) covered += b - Math.max(a, reach);
      reach = Math.max(reach, b);
    }
    const ratio = (n: number) =>
      length > 0 ? Math.round(Math.min(1, Math.max(0, n / length)) * 100) / 100 : 0;
    sides[side] = {
      facade: shell.facade[side],
      enclosed: ratio(enclosed),
      empty: ratio(length - covered),
      along: against.map((r) => (isSharedFloor(r) ? `${r.key} (open)` : r.key)),
    };
  }
  return { entrances, routes, through, unreached, sides };
}

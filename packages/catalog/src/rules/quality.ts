// How good a layout is, as distinct from whether it is correct (ADR-022 D2, amended).
//
// `checkLayout` answers a different question: does this plan hold together. It can say yes about a
// plan nobody would work in, and it did. An office for a hundred people came back with no errors,
// a clean route from the front door, every room reachable -- and fifteen rooms 2.7 m wide and
// 11.2 m deep in one comb along the top of the plate. Every one of them was above its minimum
// width. The checker had nothing to complain about because none of this is correctness.
//
// So these are the measures a person applies by eye in the second they look at a drawing, written
// down so they can be compared between two algorithms rather than argued about. Nothing here
// refuses a design. It scores one, and the score is for us, not for the model: what a model needs
// is the list of what is wrong, which the checker already gives it.

import { type Design, type DesignRoom, designRoomArea, onOutsideWall, sharedEdge } from "@fpv/ir";

/** Longer than this against its own width and a room has stopped being a room. */
export const MAX_ASPECT = 2.5;

/** Rooms that are the way to other rooms rather than somewhere to be. */
const CIRCULATION = new Set(["corridor", "foyer", "lobby", "stair"]);

/** Rooms people spend time in, which want daylight. */
const HABITABLE = new Set([
  "bedroom",
  "living",
  "dining",
  "kitchen",
  "study",
  "meeting",
  "boardroom",
  "training",
  "open-office",
  "focus",
  "reception",
  "cafeteria",
  "huddle",
]);

/** What a building of this kind must have, however small the brief was. */
const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  dwelling: ["kitchen", "bathroom", "living"],
  workplace: ["restroom"],
  mixed: ["restroom"],
};

export interface Sliver {
  key: string;
  name: string;
  /** Long side over short side. */
  ratio: number;
}

export interface LayoutQuality {
  rooms: number;
  /** Rooms longer than MAX_ASPECT against their own width, worst first. */
  slivers: Sliver[];
  /** Share of rooms in sane proportion, 0 to 1. */
  proportion: number;
  /** Share of habitable rooms with an outside wall to put a window in, 0 to 1. */
  daylight: number;
  /** Circulation as a share of the floor. Too little is a maze; too much is wasted rent. */
  circulation: number;
  /** Share of the adjacencies the brief asked for that the plan actually gives, 0 to 1. */
  adjacency: number;
  /** Rooms a building of this kind must have and this one has not. */
  missing: string[];
  /** The whole thing in one number, 0 to 1, for comparing two algorithms on one brief. */
  score: number;
}

/** What the brief asked to be beside what, if the caller still has it. */
export interface QualityContext {
  nextTo?: Record<string, readonly string[]>;
  /** How much two rooms must share before they count as neighbours (default one door's worth). */
  touchMm?: number;
}

const ratioOf = (r: DesignRoom) => Math.max(r.rect.w, r.rect.d) / Math.max(1, Math.min(r.rect.w, r.rect.d));

/**
 * Circulation that is neither a maze nor a waste.
 *
 * Real buildings run about a tenth to a fifth of their floor as circulation. Below that people are
 * walking through rooms to reach rooms; above it the rent is being spent on corridor. Scored as a
 * distance from that band rather than as less-is-better, because less is not better.
 */
const CIRCULATION_BAND = { low: 0.08, high: 0.22 };

export function layoutQuality(design: Design, context: QualityContext = {}): LayoutQuality {
  const touchMm = context.touchMm ?? 900;
  const rooms = design.rooms;
  const scored = rooms.filter((r) => !CIRCULATION.has(r.purpose));

  const slivers = scored
    .map((r) => ({ key: r.key, name: r.name, ratio: ratioOf(r) }))
    .filter((r) => r.ratio > MAX_ASPECT)
    .sort((a, b) => b.ratio - a.ratio);
  const proportion = scored.length === 0 ? 1 : 1 - slivers.length / scored.length;

  const wantDaylight = scored.filter((r) => r.window || HABITABLE.has(r.purpose));
  const lit = wantDaylight.filter((r) => onOutsideWall(r, design.shell, touchMm));
  const daylight = wantDaylight.length === 0 ? 1 : lit.length / wantDaylight.length;

  const floor = rooms.reduce((n, r) => n + designRoomArea(r), 0);
  const circulationM2 = rooms
    .filter((r) => CIRCULATION.has(r.purpose))
    .reduce((n, r) => n + designRoomArea(r), 0);
  const circulation = floor === 0 ? 0 : circulationM2 / floor;

  // Adjacency is only measurable when the caller still has what was asked for; a design on its own
  // cannot tell a pair that was wanted from a pair that happened.
  const asked = Object.entries(context.nextTo ?? {}).flatMap(([from, list]) =>
    list.map((to) => [from, to] as const),
  );
  const byKey = new Map(rooms.map((r) => [r.key, r]));
  const met = asked.filter(([from, to]) => {
    const a = byKey.get(from);
    const b = byKey.get(to);
    return a && b ? sharedEdge(a.rect, b.rect, design.shell.interiorWallMm) >= touchMm : false;
  });
  const adjacency = asked.length === 0 ? 1 : met.length / asked.length;

  const have = new Set<string>(rooms.map((r) => r.purpose));
  const missing = (REQUIRED[design.kind] ?? []).filter((p) => !have.has(p));

  // Weighted the way a person looks at a plan: the shape of the rooms first, because that is what
  // is wrong at a glance, then whether they have windows, then the rest.
  const circulationScore =
    circulation < CIRCULATION_BAND.low
      ? circulation / CIRCULATION_BAND.low
      : circulation > CIRCULATION_BAND.high
        ? Math.max(0, 1 - (circulation - CIRCULATION_BAND.high) / CIRCULATION_BAND.high)
        : 1;
  const missingScore = missing.length === 0 ? 1 : Math.max(0, 1 - missing.length / 3);
  const score =
    0.4 * proportion + 0.25 * daylight + 0.15 * circulationScore + 0.1 * adjacency + 0.1 * missingScore;

  return {
    rooms: scored.length,
    slivers,
    proportion,
    daylight,
    circulation,
    adjacency,
    missing,
    score: Math.round(score * 1000) / 1000,
  };
}

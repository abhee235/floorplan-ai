// The checker: a design measured by arithmetic, before anything is drawn (ADR-022 D3).
//
// Everything here is a distance, an area, an overlap or a walk through a graph. That is the whole
// argument for it being code: a program gets these exactly right every time for nothing, and a model
// asked to judge them from a description gets them roughly right sometimes and costs a call each.
// The model's job is to fix what this finds, not to decide whether it is true.
//
// The other half of the argument is that a model checking a model is the thing people wrongly
// trust. It sounds like verification and is another opinion. The critic pass that follows this one
// is bounded and advisory for exactly that reason.
//
// Note on the two functions called "check" in this package: `checkDesign` (rules/design.ts) checks a
// project that has been DRAWN, against the pack's per-room design rules. `checkLayout` here checks a
// design that has only been PROPOSED. The tool a model calls is `check_design`; both feed it.
import {
  type Design,
  type DesignRoom,
  designRoomArea,
  designShortSide,
  OUTSIDE,
  onOutsideWall,
  type Problem,
  RESIDENTIAL_PURPOSES,
  rectOverlap,
  sharedEdge,
} from "@fpv/ir";
import type { RulesPack } from "./schema.js";

/** Rooms a route to somewhere else may not pass through. */
const PRIVATE: ReadonlySet<string> = new Set(["bedroom", "bathroom", "toilet"]);
/** Purposes that are circulation whatever the design says. */
const CIRCULATION: ReadonlySet<string> = new Set(["corridor", "foyer"]);
/** Rooms a dwelling has to have, however the brief was worded. */
const DWELLING_NEEDS: readonly { purposes: readonly string[]; called: string }[] = [
  { purposes: ["kitchen"], called: "a kitchen" },
  { purposes: ["bathroom", "toilet"], called: "a bathroom or a toilet" },
  { purposes: ["living"], called: "a living room" },
];
/**
 * Above this a room of that purpose is not generous but a mistake, as an absolute and as a share of
 * the building.
 *
 * Both, because largeness is relative. A 4.2 m² cloakroom in a 142 m² house is three per cent of the
 * floor and perfectly ordinary; the same room in a 40 m² flat is a tenth of it and somebody has
 * mismeasured. The first version had the absolute alone and called the ordinary one a mistake.
 */
const SENSIBLE_MAX: Readonly<Record<string, { m2: number; share: number }>> = {
  toilet: { m2: 4, share: 0.04 },
  bathroom: { m2: 9, share: 0.09 },
  foyer: { m2: 10, share: 0.1 },
};
/**
 * A corridor is judged by its width and not its area.
 *
 * An eleven-metre hallway 1150 wide is 12.7 m², and it is eleven metres long because the flat is.
 * The first version capped its area, and so refused every correct plan of a long building.
 */
/**
 * The floor one person needs in a room of this purpose, in m2, before it stops working.
 *
 * Not the comfortable figure -- the floor below which the room is a lie. An open office at 8 m2 a
 * person is dense and real; at 6 it is a call centre and at 1.3 it is a drawing. A model asked for
 * an office for a hundred people and wrote a 131 m2 open workspace, which is thirteen desks, and
 * nothing refused it because nothing had ever compared a room with the number of people in it.
 */
const M2_PER_PERSON: Readonly<Record<string, number>> = {
  "open-office": 8,
  focus: 4,
  meeting: 1.8,
  boardroom: 2.5,
  huddle: 1.8,
  training: 1.8,
  cafeteria: 1.3,
  reception: 1.5,
  // Deliberately no bedroom, living room or dining room. A bedroom's size is set by a bed, a
  // wardrobe and the room to walk round them, not by a rate per head: a double at 11.4 m2 is
  // ordinary and a rule of thumb per person calls it too small. Where furniture decides the size,
  // the furnishing rules already check it.
};

const CORRIDOR_MAX_WIDE_MM = 2000;
/** Room edges within this of each other are the same wall. */
const TOUCH_MM = 400;
/** A door needs this much shared wall to sit in. */
const DOOR_WALL_MM = 1000;
/**
 * Floor inside the shell that no room accounts for, as a share of the shell.
 *
 * Measured rather than guessed: a 94 m² flat with 230 mm outside walls and seven internal ones loses
 * about 16 m² to them, which is 17 per cent. This check is here to catch a forgotten room, and a
 * forgotten room is five square metres, so the line goes above the walls and below the smallest room.
 */
const VOID_SHARE = 0.22;
/** The minimum width of anything the design calls circulation. */
const CORRIDOR_MIN_MM = 1000;

const m2 = (mm2: number) => Math.round((mm2 / 1e6) * 10) / 10;

function problem(
  code: string,
  severity: "error" | "warning",
  key: string | null,
  message: string,
  hint: string | null = null,
  related: string[] = [],
): Problem {
  return { code: `design.${code}`, severity, entityId: key, message, hint, related };
}

/**
 * How much of a penalty each problem carries when the report is reduced to one number (ADR-024 D4).
 *
 * Errors weigh an order more than warnings because they are the difference between a plan and a
 * drawing nobody can use. The exact weights matter less than that they are fixed: the score exists
 * to rank two designs and to notice a change, not to be a measurement of quality in itself.
 */
const ERROR_WEIGHT = 0.12;
const WARNING_WEIGHT = 0.02;

export interface LayoutReport {
  problems: Problem[];
  /**
   * One minus what the problems cost, in [0, 1]. One is a design with nothing against it.
   *
   * For ranking and for noticing a change, never for handing to a model in place of the problems:
   * a list of what is wrong is of use to something trying to fix it and a number is not.
   */
  score: number;
  /** What the design adds up to, so a model can see the arithmetic it was meant to do itself. */
  totals: {
    shellM2: number;
    roomsM2: number;
    /** Shell area no room accounts for: walls, circulation and anything forgotten. */
    unaccountedM2: number;
    rooms: number;
    byPurpose: Record<string, number>;
  };
}

/**
 * Measure a proposed design.
 *
 * Errors are what a person would call broken and the builder may not draw: rooms on top of each
 * other, a room nobody can reach, a bedroom you walk through to get to another. Warnings are what a
 * person would call poor: a small living room, a long thin hall.
 */
export function checkLayout(design: Design, pack: RulesPack | null = null): LayoutReport {
  const out: Problem[] = [];
  const facts = pack?.facts ?? {};
  const fact = (name: string, fallback: number): number => {
    const v = facts[name];
    return typeof v === "number" ? v : fallback;
  };
  const rooms = design.rooms;
  const byKey = new Map<string, DesignRoom>();

  // ---- the design has to be well formed before anything else means anything ----
  for (const r of rooms) {
    if (byKey.has(r.key))
      out.push(problem("duplicate-key", "error", r.key, `two rooms are both called "${r.key}"`));
    byKey.set(r.key, r);
  }
  for (const r of rooms)
    for (const to of r.doorsTo)
      if (to !== OUTSIDE && !byKey.has(to))
        out.push(
          problem("door-to-nowhere", "error", r.key, `${r.name} has a door to "${to}", which is not a room`),
        );

  // ---- geometry ------------------------------------------------------------
  const shell = design.shell;
  const shellM2 = (shell.w * shell.d) / 1e6;
  for (const r of rooms) {
    const { x, y, w, d } = r.rect;
    if (
      x < shell.x - TOUCH_MM ||
      y < shell.y - TOUCH_MM ||
      x + w > shell.x + shell.w + TOUCH_MM ||
      y + d > shell.y + shell.d + TOUCH_MM
    )
      out.push(
        problem(
          "outside-shell",
          "error",
          r.key,
          `${r.name} lies outside the building: it runs from (${x}, ${y}) to (${x + w}, ${y + d}) and the shell is (${shell.x}, ${shell.y}) to (${shell.x + shell.w}, ${shell.y + shell.d})`,
          "move the room inside, or make the shell bigger",
        ),
      );
  }
  for (let i = 0; i < rooms.length; i += 1)
    for (let j = i + 1; j < rooms.length; j += 1) {
      const a = rooms[i] as DesignRoom;
      const b = rooms[j] as DesignRoom;
      const overlap = rectOverlap(a.rect, b.rect);
      if (overlap > 0)
        out.push(
          problem(
            "rooms-overlap",
            "error",
            a.key,
            `${a.name} and ${b.name} are on top of each other over ${m2(overlap)} m²`,
            "give them separate rectangles; two rooms may share a wall but not a floor",
            [b.key],
          ),
        );
    }

  const roomsM2 = rooms.reduce((n, r) => n + designRoomArea(r), 0);
  const unaccounted = shellM2 - roomsM2;
  if (unaccounted > shellM2 * VOID_SHARE)
    out.push(
      problem(
        "unexplained-space",
        "warning",
        null,
        `${m2(unaccounted * 1e6)} m² of the ${m2(shellM2 * 1e6)} m² shell is not in any room, which is more than walls and circulation account for`,
        "put the space in a room, add a corridor for it, or make the shell smaller",
      ),
    );
  // A room against the number of people it says it holds. The capacity is the model's own claim,
  // so this is not second-guessing it: it is holding it to what it said.
  for (const r of rooms) {
    const per = M2_PER_PERSON[r.purpose];
    if (!per || !r.capacity || r.capacity <= 0) continue;
    const needs = per * r.capacity;
    const has = designRoomArea(r);
    if (has + 0.05 < needs)
      out.push(
        problem(
          "too-small-for-capacity",
          "error",
          r.key,
          `${r.name} is ${m2(has * 1e6)} m² and says it holds ${r.capacity}, which needs at least ${Math.round(needs)} m² at ${per} m² a person`,
          `make it ${Math.round(needs)} m² or more, or say it holds ${Math.floor(has / per)}`,
        ),
      );
  }
  if (roomsM2 > shellM2 + 1)
    out.push(
      problem(
        "rooms-exceed-shell",
        "error",
        null,
        `the rooms come to ${m2(roomsM2 * 1e6)} m² and the shell holds ${m2(shellM2 * 1e6)} m²`,
        "the rooms have to fit, with room over for the walls between them",
      ),
    );

  // ---- room sizes by what the room is for ----------------------------------
  const MIN: Readonly<Record<string, [string, string]>> = {
    bedroom: ["bedroomMinM2", "bedroomMinSideMm"],
    living: ["livingMinM2", "livingMinSideMm"],
    kitchen: ["kitchenMinM2", "kitchenMinSideMm"],
    dining: ["diningMinM2", "diningMinSideMm"],
    bathroom: ["bathroomMinM2", "bathroomMinSideMm"],
    toilet: ["toiletMinM2", "toiletMinSideMm"],
  };
  const DEFAULTS: Readonly<Record<string, [number, number]>> = {
    bedroom: [9, 2400],
    living: [12, 3000],
    kitchen: [5, 1800],
    dining: [7, 2400],
    bathroom: [3, 1500],
    toilet: [1.2, 900],
  };
  for (const r of rooms) {
    const names = MIN[r.purpose];
    const fallback = DEFAULTS[r.purpose];
    if (names && fallback) {
      const minM2 = fact(names[0], fallback[0]);
      const minSide = fact(names[1], fallback[1]);
      const area = designRoomArea(r);
      const side = designShortSide(r);
      if (area < minM2 || side < minSide)
        out.push(
          problem(
            "too-small",
            "error",
            r.key,
            `${r.name} is ${area.toFixed(1)} m² and ${side} mm across; a ${r.purpose} needs ${minM2} m² and ${minSide} mm`,
            "take the space from a room that has more than it needs",
          ),
        );
    }
    const cap = SENSIBLE_MAX[r.purpose];
    const max = cap ? Math.max(cap.m2, cap.share * shellM2) : undefined;
    if (max !== undefined && designRoomArea(r) > max)
      out.push(
        problem(
          "too-large",
          "error",
          r.key,
          `${r.name} is ${designRoomArea(r).toFixed(1)} m², which is not a generous ${r.purpose} but a mistake; ${max.toFixed(1)} m² is plenty in a building this size`,
          "give the space to the living room or a bedroom",
        ),
      );
    const isCirculation = design.circulation.includes(r.key) || CIRCULATION.has(r.purpose);
    if (isCirculation && r.purpose !== "foyer") {
      if (designShortSide(r) < CORRIDOR_MIN_MM)
        out.push(
          problem(
            "corridor-narrow",
            "error",
            r.key,
            `${r.name} is ${designShortSide(r)} mm wide and circulation needs ${CORRIDOR_MIN_MM}`,
          ),
        );
      if (designShortSide(r) > CORRIDOR_MAX_WIDE_MM)
        out.push(
          problem(
            "corridor-wide",
            "warning",
            r.key,
            `${r.name} is ${designShortSide(r)} mm wide, which is a room rather than a way through`,
            "narrow it and give the floor to the rooms either side",
          ),
        );
    }
  }

  // ---- the programme: what the building has to have ------------------------
  const purposes = new Set(rooms.map((r) => r.purpose));
  if (design.kind === "dwelling" || design.kind === "mixed")
    for (const need of DWELLING_NEEDS)
      if (!need.purposes.some((p) => purposes.has(p as never)))
        out.push(
          problem(
            "missing-room",
            "error",
            null,
            `a home needs ${need.called}, and this design has none`,
            "add it, or say in your answer why this building does without one",
          ),
        );
  if (design.kind === "dwelling" && !rooms.some((r) => r.doorsTo.includes(OUTSIDE)))
    out.push(problem("no-way-in", "error", null, "no room has a door to the outside"));

  // ---- doors: a door needs a wall, and some doors should not exist ----------
  const gap = shell.interiorWallMm + TOUCH_MM;
  for (const r of rooms)
    for (const to of r.doorsTo) {
      if (to === OUTSIDE) {
        if (!onOutsideWall(r, shell, gap))
          out.push(
            problem(
              "door-outside-inside",
              "error",
              r.key,
              `${r.name} has a door to the outside but no wall on the outside of the building`,
            ),
          );
        continue;
      }
      const other = byKey.get(to);
      if (!other) continue;
      const shared = sharedEdge(r.rect, other.rect, gap);
      if (shared < DOOR_WALL_MM)
        out.push(
          problem(
            "door-without-wall",
            "error",
            r.key,
            `${r.name} and ${other.name} have a door between them but share only ${Math.round(shared)} mm of wall`,
            `a door needs ${DOOR_WALL_MM} mm; move the rooms together or take the door out`,
            [other.key],
          ),
        );
      if (PRIVATE.has(r.purpose) && PRIVATE.has(other.purpose) && r.purpose === other.purpose)
        out.push(
          problem(
            "private-to-private",
            "error",
            r.key,
            `${r.name} opens into ${other.name}; one ${r.purpose} should not be the way into another`,
            "put both doors onto the hall or a corridor",
            [other.key],
          ),
        );
      if (
        (r.purpose === "kitchen" && (other.purpose === "bathroom" || other.purpose === "toilet")) ||
        (other.purpose === "kitchen" && (r.purpose === "bathroom" || r.purpose === "toilet"))
      )
        out.push(
          problem(
            "wet-into-kitchen",
            "error",
            r.key,
            `${r.name} opens directly into ${other.name}; a bathroom or toilet must not open into a kitchen`,
            "put a lobby or a corridor between them",
            [other.key],
          ),
        );
    }

  // ---- circulation: can you get there, and what do you walk through --------
  const doors = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!doors.has(a)) doors.set(a, new Set());
    (doors.get(a) as Set<string>).add(b);
  };
  for (const r of rooms)
    for (const to of r.doorsTo) {
      link(r.key, to);
      link(to, r.key);
    }
  /** Rooms reachable from outside without passing THROUGH a private room. */
  const reachable = new Set<string>();
  const queue: string[] = [OUTSIDE];
  const seen = new Set<string>([OUTSIDE]);
  while (queue.length > 0) {
    const here = queue.shift() as string;
    for (const next of doors.get(here) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      reachable.add(next);
      // you may end in a bedroom; you may not walk through one to get somewhere else
      const room = byKey.get(next);
      if (room && PRIVATE.has(room.purpose)) continue;
      queue.push(next);
    }
  }
  for (const r of rooms)
    if (!reachable.has(r.key))
      out.push(
        problem(
          "unreachable",
          "error",
          r.key,
          doors.has(r.key)
            ? `${r.name} can only be reached by walking through a bedroom or a bathroom`
            : `${r.name} has no door at all`,
          "give it a door onto the hall, a corridor or another shared room",
        ),
      );

  // ---- windows -------------------------------------------------------------
  const HABITABLE = new Set(["bedroom", "living", "dining", "kitchen", "study", "meeting", "boardroom"]);
  for (const r of rooms) {
    if (r.window && !onOutsideWall(r, shell, gap))
      out.push(
        problem(
          "window-inside",
          "error",
          r.key,
          `${r.name} wants a window but is in the middle of the plan`,
          "move it to an outside wall, or take the window away",
        ),
      );
    if (!r.window && HABITABLE.has(r.purpose))
      out.push(
        problem(
          "no-window",
          "warning",
          r.key,
          `${r.name} is a room people spend time in and has no window`,
          onOutsideWall(r, shell, gap)
            ? "it has an outside wall; set window: true"
            : "move it to an outside wall",
        ),
      );
  }

  const byPurpose: Record<string, number> = {};
  for (const r of rooms) byPurpose[r.purpose] = (byPurpose[r.purpose] ?? 0) + 1;
  const penalty = out.reduce((n, p) => n + (p.severity === "error" ? ERROR_WEIGHT : WARNING_WEIGHT), 0);
  return {
    problems: out,
    // Saturating rather than going negative: a hopeless design and a slightly worse hopeless
    // design do not need to be told apart, and a score below zero would rank them anyway.
    score: Math.round(Math.max(0, 1 - penalty) * 1000) / 1000,
    totals: {
      shellM2: Math.round(shellM2 * 10) / 10,
      roomsM2: Math.round(roomsM2 * 10) / 10,
      unaccountedM2: Math.round(unaccounted * 10) / 10,
      rooms: rooms.length,
      byPurpose,
    },
  };
}

/** Whether a design may be built: the checker's errors are what stops it (ADR-022 D3). */
export function layoutIsBuildable(report: LayoutReport): boolean {
  return !report.problems.some((p) => p.severity === "error");
}

/** The residential purposes, for a caller deciding whether a design is a dwelling. */
export const HOME_PURPOSES = RESIDENTIAL_PURPOSES;

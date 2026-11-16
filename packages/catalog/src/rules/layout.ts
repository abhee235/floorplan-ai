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
  canBeDaylit,
  type Design,
  type DesignRoom,
  designRoomArea,
  designShortSide,
  enclosureOf,
  mustBeWalled,
  OUTSIDE,
  onGlazedSide,
  onOutsideWall,
  type Problem,
  RESIDENTIAL_PURPOSES,
  rectOverlap,
  sharedEdge,
  windowSides,
} from "@fpv/ir";
import type { RulesPack } from "./schema.js";

/** Rooms a route to somewhere else may not pass through. */
const PRIVATE: ReadonlySet<string> = new Set(["bedroom", "bathroom", "toilet"]);
/** Purposes that are circulation whatever the design says. */
const CIRCULATION: ReadonlySet<string> = new Set(["corridor", "foyer"]);
/** Rooms a dwelling has to have, however the brief was worded. */
/** People, summed over the rooms' capacities, from which a workplace without toilets is refused. */
const WORKPLACE_WC_FROM = 20;
const WC_PURPOSES: ReadonlySet<string> = new Set(["restroom", "toilet", "bathroom"]);
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
  // The desk zone, not the floor: benched desks with their aisles are 5.5 to 6 m² each. 8 to 12 is a
  // whole floor's figure with meeting rooms and cafeteria in it, and belongs to the skill (ADR-028 D5).
  "open-office": 6,
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
/**
 * The smallest move that clears an overlap, as a rectangle the model can paste into revise_design.
 *
 * "A and B are on top of each other over 7.5 m²" leaves the arithmetic to the model, and a live run
 * drawing fifteen rooms by hand made fourteen overlaps and could not work out which way to move
 * anything. The smaller room moves, along whichever axis needs the shorter move, to the far side of
 * the other with one inside wall between; shrinking it by the same amount is offered too. It is a
 * suggestion: the checker does not move anything.
 */
function clearOverlap(a: DesignRoom, b: DesignRoom, wallMm: number): string {
  const [big, small] = a.rect.w * a.rect.d >= b.rect.w * b.rect.d ? [a, b] : [b, a];
  const B = big.rect;
  const S = small.rect;
  const options = [
    // push the small room off each side of the big one
    {
      axis: "y",
      rect: { ...S, y: B.y + B.d + wallMm },
      cut: { ...S, y: B.y + B.d + wallMm, d: S.y + S.d - (B.y + B.d + wallMm) },
    },
    { axis: "y", rect: { ...S, y: B.y - wallMm - S.d }, cut: { ...S, d: B.y - wallMm - S.y } },
    {
      axis: "x",
      rect: { ...S, x: B.x + B.w + wallMm },
      cut: { ...S, x: B.x + B.w + wallMm, w: S.x + S.w - (B.x + B.w + wallMm) },
    },
    { axis: "x", rect: { ...S, x: B.x - wallMm - S.w }, cut: { ...S, w: B.x - wallMm - S.x } },
  ].map((o) => ({ ...o, distance: Math.abs(o.rect.x - S.x) + Math.abs(o.rect.y - S.y) }));
  const best = options.sort((p, q) => p.distance - q.distance)[0] as (typeof options)[number];
  const r = (x: { x: number; y: number; w: number; d: number }) =>
    `{ x: ${Math.round(x.x)}, y: ${Math.round(x.y)}, w: ${Math.round(x.w)}, d: ${Math.round(x.d)} }`;
  const cutOk = best.cut.w >= 1000 && best.cut.d >= 1000;
  return (
    `move ${small.key} clear of ${big.key}: revise_design rooms: [{ key: "${small.key}", rect: ${r(best.rect)} }]` +
    (cutOk ? `, or shrink it instead: rect: ${r(best.cut)}` : "") +
    // The tool that does this arithmetic, named where the arithmetic is failing: a live architect
    // spent six rounds on one overlap with tidy_design sitting unused in its prompt (ADR-028 D10).
    "; or tidy_design with this design's id moves them apart for you. Two rooms may share a wall but not a floor"
  );
}

/**
 * The nearest way to make a room touch shared floor, as the two edits that would do it: the room
 * moved against the nearest corridor or open room, or that room stretched to meet it.
 *
 * "It touches no corridor or open room: move its rect against one" was true and no use. A live
 * architect left a band of meeting rooms five metres from the open floor, was told that for ten
 * rounds, and never found the number; this gives it.
 */
function meetHint(room: DesignRoom, shared: readonly DesignRoom[], wallMm: number): string | null {
  const r = room.rect;
  const ro = (a: number, b: number, c: number, d: number) => Math.min(b, d) - Math.max(a, c);
  const options: {
    distance: number;
    other: DesignRoom;
    move: DesignRoom["rect"];
    stretch: DesignRoom["rect"];
  }[] = [];
  for (const o of shared) {
    const q = o.rect;
    if (ro(r.x, r.x + r.w, q.x, q.x + q.w) >= DOOR_WALL_MM) {
      if (r.y >= q.y + q.d)
        options.push({
          distance: r.y - (q.y + q.d + wallMm),
          other: o,
          move: { ...r, y: q.y + q.d + wallMm },
          stretch: { ...q, d: r.y - wallMm - q.y },
        });
      else if (r.y + r.d <= q.y)
        options.push({
          distance: q.y - wallMm - (r.y + r.d),
          other: o,
          move: { ...r, y: q.y - wallMm - r.d },
          stretch: { ...q, y: r.y + r.d + wallMm, d: q.y + q.d - (r.y + r.d + wallMm) },
        });
    }
    if (ro(r.y, r.y + r.d, q.y, q.y + q.d) >= DOOR_WALL_MM) {
      if (r.x >= q.x + q.w)
        options.push({
          distance: r.x - (q.x + q.w + wallMm),
          other: o,
          move: { ...r, x: q.x + q.w + wallMm },
          stretch: { ...q, w: r.x - wallMm - q.x },
        });
      else if (r.x + r.w <= q.x)
        options.push({
          distance: q.x - wallMm - (r.x + r.w),
          other: o,
          move: { ...r, x: q.x - wallMm - r.w },
          stretch: { ...q, x: r.x + r.w + wallMm, w: q.x + q.w - (r.x + r.w + wallMm) },
        });
    }
  }
  const best = options.filter((o) => o.distance > 0).sort((a, b) => a.distance - b.distance)[0];
  if (!best) return null;
  const txt = (x: DesignRoom["rect"]) =>
    `{ x: ${Math.round(x.x)}, y: ${Math.round(x.y)}, w: ${Math.round(x.w)}, d: ${Math.round(x.d)} }`;
  return `it is ${Math.round(best.distance)} mm from ${best.other.key}. Move it to meet it: revise_design rooms: [{ key: "${room.key}", rect: ${txt(best.move)} }], or stretch ${best.other.key} to meet it: [{ key: "${best.other.key}", rect: ${txt(best.stretch)} }]`;
}

/**
 * Who opens onto whom: every door the design lists, both ways, and each open room onto the open
 * rooms it touches, which have no wall between them to hang a door in (ADR-028 D2). The checker's
 * reachability walks this, and so does the walk a model is shown (D11).
 */
export function doorGraph(design: Design): Map<string, Set<string>> {
  const gap = design.shell.interiorWallMm + TOUCH_MM;
  const doors = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!doors.has(a)) doors.set(a, new Set());
    (doors.get(a) as Set<string>).add(b);
  };
  for (const r of design.rooms)
    for (const to of r.doorsTo) {
      link(r.key, to);
      link(to, r.key);
    }
  // An open room has no wall to put a door in: whatever it touches, it opens onto (ADR-028 D2).
  // The desks, the cafe and the breakout in a modern office are one floor, and the checker used to
  // say each of them "has no door at all".
  for (const r of design.rooms) {
    if (enclosureOf(r) !== "open") continue;
    for (const other of design.rooms) {
      if (other.key === r.key || enclosureOf(other) !== "open") continue;
      if (sharedEdge(r.rect, other.rect, gap) >= DOOR_WALL_MM) {
        link(r.key, other.key);
        link(other.key, r.key);
      }
    }
  }
  return doors;
}

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
            clearOverlap(a, b, shell.interiorWallMm),
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
        // The size it would have to be, because a live architect chose a 1,470 m² shell for a
        // 1,604 m² programme and then spent ten rounds on the overlaps that followed from it.
        `grow the shell to about ${Math.ceil(Math.sqrt((roomsM2 * 1.15 * shell.w) / shell.d) / 100) / 10} by ${Math.ceil(Math.sqrt((roomsM2 * 1.15 * shell.d) / shell.w) / 100) / 10} m, keeping its proportions, or take ${m2((roomsM2 - shellM2) * 1e6)} m² of rooms out; the rooms have to fit with room over for the walls between them`,
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
          // A warning: a generous room is a choice, and a rule about what to build is not the
          // checker's to enforce (ADR-028 D2). It stays because a 14 m² toilet is worth a word.
          "too-large",
          "warning",
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
  // A workplace with people in it has toilets. Twenty is about where a building stops being a room
  // with a desk in it. A hundred-person office came out of a real run with none: the checker had
  // listed "restroom" under missing, in a report nobody reads, and the building was built.
  if (design.kind !== "dwelling") {
    const people = rooms.reduce((n, r) => n + (r.capacity ?? 0), 0);
    if (people >= WORKPLACE_WC_FROM && !rooms.some((r) => WC_PURPOSES.has(r.purpose)))
      out.push(
        problem(
          "missing-room",
          "error",
          null,
          `a workplace for ${people} people needs toilets, and this design has none`,
          "add a restroom of about 12 m² for every fifty people",
        ),
      );
  }
  // Every building has a way in. This used to be asked of homes only, and a workplace with no
  // entrance got seventeen rooms "reachable only through a bedroom" and not a word about the door.
  const wayIn = rooms.some((r) => r.doorsTo.includes(OUTSIDE));
  if (!wayIn)
    out.push(
      problem(
        "no-way-in",
        "error",
        null,
        "no room has a door to the outside",
        'give the entrance room doorsTo: ["outside", ...]; every other room is reached from there',
      ),
    );

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
  const doors = doorGraph(design);
  // Without an entrance, the plan still has to hang together, and saying nothing about it until
  // the door was added hid ten real errors behind "no room has a door to the outside": a live run
  // read 0.74 and two errors, added the door, and got twelve. So the walk starts from the room an
  // entrance would open onto -- a reception, a foyer, else the corridor or open floor with the
  // most doors -- as if it had one, and no-way-in says the rest.
  const start: string = wayIn
    ? OUTSIDE
    : (rooms.find((r) => r.purpose === "reception" || r.purpose === "foyer")?.key ??
      [...rooms]
        .filter((r) => CIRCULATION.has(r.purpose) || enclosureOf(r) === "open")
        .sort((a, b) => (doors.get(b.key)?.size ?? 0) - (doors.get(a.key)?.size ?? 0))[0]?.key ??
      rooms[0]?.key ??
      OUTSIDE);
  /** Rooms reachable from outside without passing THROUGH a private room. */
  const reachable = new Set<string>(start === OUTSIDE ? [] : [start]);
  const queue: string[] = [start];
  const seen = new Set<string>([start]);
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
  // Reachable at all, through any room: the difference between a room behind a bedroom and a room
  // cut off from the entrance altogether. The message used to say "only through a bedroom or a
  // bathroom" for both, and an office with no bedrooms in it was told that about seven rooms.
  const anyway = new Set<string>(start === OUTSIDE ? [] : [start]);
  {
    const q: string[] = [start];
    const s2 = new Set<string>([start]);
    while (q.length > 0) {
      const here = q.shift() as string;
      for (const next of doors.get(here) ?? []) {
        if (s2.has(next)) continue;
        s2.add(next);
        anyway.add(next);
        q.push(next);
      }
    }
  }
  const circulationLike = (x: DesignRoom) => CIRCULATION.has(x.purpose) || enclosureOf(x) === "open";
  // shared floor the walk reaches, to move an unreached room against; any shared floor if none is
  const sharedReached = rooms.filter((o) => circulationLike(o) && reachable.has(o.key));
  const sharedFloor = sharedReached.length > 0 ? sharedReached : rooms.filter(circulationLike);
  // With no entrance nothing is reachable, and no-way-in has said so once; saying it per room
  // would be seventeen ways of not naming the door.
  for (const r of rooms) {
    if (reachable.has(r.key)) continue;
    const touching = rooms.filter(
      (o) => o.key !== r.key && circulationLike(o) && sharedEdge(r.rect, o.rect, gap) >= DOOR_WALL_MM,
    );
    let message: string;
    let hint: string;
    if (!doors.has(r.key)) {
      message = `${r.name} has no door at all`;
      // The field is named, because a model was told "give it a door" twice and sent the same
      // design twice: it did not know where a door goes in the JSON.
      hint =
        touching.length > 0
          ? `list what it opens onto in doorsTo, e.g. doorsTo: ["${touching[0]?.key}"]; a zone with no walls of its own says enclosure: "open" instead and needs no door`
          : (meetHint(r, sharedFloor, shell.interiorWallMm) ??
            `it touches no corridor or open room at all: move its rect against one (a door needs ${DOOR_WALL_MM} mm of shared wall), or give it enclosure: "open"`);
    } else if (anyway.has(r.key)) {
      message = `${r.name} can only be reached by walking through a bedroom or a bathroom`;
      hint = 'give it a door onto the hall, a corridor or another shared room: doorsTo: ["corridor"]';
    } else {
      const via = [...(doors.get(r.key) ?? [])].filter((k) => k !== OUTSIDE);
      const from = wayIn ? "the entrance" : (byKey.get(start)?.name ?? "the rest of the plan");
      message = `${r.name} is cut off from ${from}: it opens onto ${via.join(", ") || "nothing"}, and none of that connects back`;
      hint =
        touching.length > 0
          ? `connect it to what the entrance reaches: a door onto ${touching
              .map((t) => t.key)
              .slice(0, 3)
              .join(" or ")}, or make the rooms between open floor with enclosure: "open"`
          : (meetHint(r, sharedFloor, shell.interiorWallMm) ??
            "move it against a corridor or an open room the entrance reaches");
    }
    out.push(problem("unreachable", "error", r.key, message, hint));
  }

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
    else if (r.window && !canBeDaylit(r, shell, gap))
      out.push(
        problem(
          "window-solid",
          "warning",
          r.key,
          mustBeWalled(r)
            ? `${r.name} wants a window, but it keeps a solid outside wall on a glazed side and its other outside walls take none`
            : `${r.name} wants a window, but its outside walls are solid`,
          "move it to a side with windows or glass, or take the window away",
        ),
      );
    // A glazed side of the building is daylight without a window (ADR-028 D3), and an open room
    // borrows the floor's.
    if (!r.window && HABITABLE.has(r.purpose) && !onGlazedSide(r, shell, gap) && enclosureOf(r) !== "open")
      out.push(
        problem(
          "no-window",
          "warning",
          r.key,
          `${r.name} is a room people spend time in and has no window`,
          windowSides(r, shell, gap).length > 0
            ? "it has an outside wall; set window: true"
            : onOutsideWall(r, shell, gap)
              ? "its outside wall is solid; move it to a side with windows or glass"
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

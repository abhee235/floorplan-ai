// A programme into a plan (ADR-022 D2, amended): rooms with purposes and rough sizes, packed into
// rectangles that pass the checker by construction.
//
// This exists because the architect could not do it. Given six rounds it produced 12, 11, 14, 14, 14
// and 13 problems -- flailing, not converging -- because it was being asked to solve
// two-dimensional rectangle packing: nine rooms, none overlapping, filling a shell, with eight named
// pairs each sharing a metre of wall. A model is worst at exactly that and a program finds it easy.
//
// The layout is the one flats are actually built with: a circulation band across the middle, rooms
// in strips either side, each room running the full depth of its strip. That single decision gives,
// for nothing: every room touching the corridor along its whole width (so every door has a wall),
// every room reachable from the front door, and every room with the outside wall behind it (so every
// habitable room can have a window).
import {
  type Design,
  type DesignInput,
  type DesignRect,
  purposeFromWord,
  RESIDENTIAL_PURPOSES,
} from "@fpv/ir";

/** A room's purpose as the schema has it, whatever the programme called it. */
type Purpose = NonNullable<DesignInput["rooms"]>[number]["purpose"];
const asPurpose = (word: string): Purpose => (purposeFromWord(word) ?? "other") as Purpose;

/** One room as the architect asks for it: what it is for and roughly how big, never where. */
export interface ProgrammeRoom {
  key: string;
  name: string;
  purpose: string;
  /** Floor area wanted, m². Left out, the purpose decides. */
  targetM2?: number;
  /** A room people spend time in wants one; the packer puts it on an outside wall. */
  window?: boolean;
  capacity?: number | null;
  /** Keys this room should be beside, beyond the circulation everything opens onto. */
  nextTo?: string[];
}

export interface Programme {
  brief: string;
  kind: "dwelling" | "workplace" | "mixed";
  rooms: ProgrammeRoom[];
  /** The building's outside size, mm. Left out, the packer works one out from the areas. */
  shell?: { w: number; d: number } | null;
  assumptions?: string[];
  wallMm?: number;
  interiorWallMm?: number;
}

export interface PackResult {
  design: DesignInput;
  /** What the packer decided that the programme did not say. */
  notes: string[];
  /** Rooms it could not fit, and why; the architect changes the programme, not the coordinates. */
  unplaced: { key: string; why: string }[];
}

/** Floor area a room of this purpose gets when the programme does not say, m². */
const DEFAULT_M2: Readonly<Record<string, number>> = {
  bedroom: 12,
  living: 20,
  kitchen: 10,
  dining: 10,
  bathroom: 5,
  toilet: 2.2,
  foyer: 4,
  study: 8,
  laundry: 3,
  storage: 2,
  balcony: 4,
  garage: 18,
  corridor: 8,
  meeting: 20,
  boardroom: 35,
  huddle: 8,
  training: 50,
  "open-office": 60,
  focus: 6,
  reception: 15,
  cafeteria: 30,
  utility: 4,
  restroom: 5,
  other: 8,
};
/** Below this a room of that purpose does not work; the checker refuses it and so do we. */
const MIN_M2: Readonly<Record<string, number>> = {
  bedroom: 9,
  living: 12,
  kitchen: 5,
  dining: 7,
  bathroom: 3,
  toilet: 1.3,
  // A seat in a meeting wants 1.8 to 2.3 m2, and more in a boardroom, where the table is wider and
  // people are expected to be waited on.
  meeting: 8,
  boardroom: 20,
  huddle: 4.5,
  training: 20,
  "open-office": 20,
  focus: 3.5,
  reception: 6,
  cafeteria: 12,
  restroom: 2,
  utility: 1.5,
};
/**
 * The narrowest a room of each purpose may be, in mm, clear inside the walls.
 *
 * Shape, not area, and the difference is the whole point of this table. An office for a hundred
 * people came back with four-person meeting rooms 1.1 m wide and 11.2 m deep. Their area was
 * reasonable; you could not get a table into one. The cause was that this table had six rows, all
 * of them residential, so every workplace room fell through to the width of a door wall.
 *
 * The workplace numbers are what space planning actually requires: a meeting room is a 900 table
 * with 900 clear on both sides, which is 2,700 and not a millimetre less; an open office is two
 * back-to-back desk clusters, about 2,400 edge to edge, plus an aisle; a training room is rows of
 * tables with a gangway.
 */
const MIN_SIDE: Readonly<Record<string, number>> = {
  bedroom: 2400,
  living: 3000,
  kitchen: 1800,
  dining: 2400,
  bathroom: 1500,
  toilet: 900,
  study: 2100,
  laundry: 1500,
  meeting: 2700,
  boardroom: 3600,
  huddle: 2100,
  training: 4800,
  "open-office": 4800,
  focus: 1800,
  reception: 2400,
  cafeteria: 3600,
  restroom: 1500,
  utility: 1200,
};
/**
 * What a room with no row of its own gets.
 *
 * A door wall, 1,000 mm, was the old answer and it is the wrong shape of answer: it is the width a
 * door needs, not the width a room needs. Anything somebody stands up in wants more.
 */
const MIN_SIDE_FALLBACK = 1800;
/** Above this a room of that purpose is a mistake rather than a luxury. */
const MAX_M2: Readonly<Record<string, number>> = { toilet: 3.6, bathroom: 8, foyer: 9 };

/** Purposes that are the way to other rooms rather than somewhere to be. */
const CIRCULATION = new Set(["corridor", "foyer"]);
/** Rooms people spend time in, which want an outside wall. */
const HABITABLE = new Set([
  "bedroom",
  "living",
  "dining",
  "kitchen",
  "study",
  "meeting",
  "boardroom",
  "open-office",
]);
/** Wet rooms, kept together so their drainage is. */
const WET = new Set(["bathroom", "toilet", "kitchen", "laundry"]);

/**
 * The corridor is this wide, and it depends on what the building is.
 *
 * A home's hallway at 1,050 is normal and a workplace's at 1,050 is illegal: a corridor serving
 * fifty or more occupants has a floor of 1,118 mm, and where it is also the way out it wants 1,500
 * to 2,000. The single 1,150 that used to be here gave a hundred-person office a 1.1 m hallway,
 * while the prompt the model reads was telling it 1,500 all along.
 */
const CORRIDOR_MM: Readonly<Record<string, number>> = {
  dwelling: 1050,
  workplace: 1500,
  mixed: 1500,
};
const CORRIDOR_FALLBACK = 1200;

/** How wide this building's circulation is, from what kind of building it is. */
export function corridorFor(kind: string | undefined): number {
  return CORRIDOR_MM[kind ?? ""] ?? CORRIDOR_FALLBACK;
}
const DOOR_WALL_MM = 1000;
/** Walls take about this much of a building's floor, so the shell is bigger than the rooms. */
const WALL_SHARE = 1.06;
/**
 * How much deeper than it is wide a room would like to be.
 *
 * A hotel bedroom is 4 m by 6.5, a classroom 7 by 9, a bedroom at home 3 by 3.6: rooms are a
 * little deeper than they are wide, and almost never square or long. This is the number the shell
 * is derived from, and every room in the building is shaped by it.
 */
const IDEAL_DEPTH_RATIO = 1.4;

const round100 = (n: number) => Math.round(n / 100) * 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

function areaOf(room: ProgrammeRoom): number {
  const asked = room.targetM2 ?? DEFAULT_M2[room.purpose] ?? 8;
  const min = MIN_M2[room.purpose] ?? 0;
  const max = MAX_M2[room.purpose] ?? Number.POSITIVE_INFINITY;
  return clamp(asked, min, max);
}

/**
 * Order the rooms of a strip so the ones that should be together are.
 *
 * Wet rooms first, in a block, because they share drainage; then whatever else the programme asked
 * to be beside something; then the rest in the order they were given, because that is usually the
 * order the person said them in.
 */
function orderStrip(rooms: ProgrammeRoom[]): ProgrammeRoom[] {
  const wet = rooms.filter((r) => WET.has(r.purpose));
  const dry = rooms.filter((r) => !WET.has(r.purpose));
  const out = [...wet, ...dry];
  // one pass of pulling a room next to what it asked to be next to
  for (let i = 0; i < out.length; i += 1) {
    const room = out[i] as ProgrammeRoom;
    for (const want of room.nextTo ?? []) {
      const at = out.findIndex((r) => r.key === want);
      if (at < 0 || Math.abs(at - i) <= 1) continue;
      const [moved] = out.splice(at, 1);
      if (moved) out.splice(at > i ? i + 1 : i, 0, moved);
    }
  }
  return out;
}

/**
 * Pack a programme into a design.
 *
 * The shape is fixed and deliberate: a circulation band across the building with the rooms in a
 * strip on each side. Every strip room runs the full depth of its strip, so it touches the corridor
 * along its whole width and the outside wall along the other side. What varies is how the rooms are
 * shared between the strips and how wide each one is.
 */
/**
 * A rectangle of floor a layout is written into, and which way round it runs.
 *
 * Everything below works in two local measurements: `u` runs along the hallway and `v` across it.
 * A frame turns those into real coordinates, and `turned` swaps the axes. Today nothing turns one,
 * and the mapping is the identity plus an offset. It exists because a zone of small rooms beside a
 * very large one is a tall narrow plate, and a hallway across a tall narrow plate is the wrong way
 * round: the same layout, turned, is the right one.
 */
interface Frame {
  x: number;
  y: number;
  /** Along the hallway. */
  length: number;
  /** Across it, hallway included. */
  depth: number;
  turned: boolean;
}

/** Local (u along, v across) into a real rectangle. */
function place(f: Frame, u: number, v: number, alongU: number, acrossV: number): DesignRect {
  return f.turned
    ? { x: f.x + v, y: f.y + u, w: acrossV, d: alongU }
    : { x: f.x + u, y: f.y + v, w: alongU, d: acrossV };
}

export function packProgramme(programme: Programme): PackResult {
  const notes: string[] = [];
  const unplaced: { key: string; why: string }[] = [];
  const wallMm = programme.wallMm ?? 230;
  const interiorWallMm = programme.interiorWallMm ?? 115;
  // A hallway at home and a corridor at work are not the same thing, and one number for both gave a
  // hundred-person office a 1.1 m escape route.
  const corridorMm = corridorFor(programme.kind);

  // Circulation is ours to place, so a corridor in the programme is read as a request for one and
  // otherwise dropped. A foyer is kept and placed like any other room, because the thing it has to
  // do -- touch the hallway AND an outside wall for the front door -- is what the strips already do.
  const given = programme.rooms.filter((r) => r.purpose !== "corridor");
  if (given.length === 0) return { design: emptyDesign(programme, wallMm, interiorWallMm), notes, unplaced };

  const areas = new Map(given.map((r) => [r.key, areaOf(r)]));
  const roomsM2 = [...areas.values()].reduce((a, b) => a + b, 0);

  // Which strip each room goes in, decided before the building is sized, because how deep the
  // strips have to be depends on what is in them: a living room needs 3 m across its short side and
  // a bathroom 1.5, and a strip is as deep as its deepest requirement.
  const foyer = given.find((r) => r.purpose === "foyer") ?? null;
  const sorted = [...given]
    .filter((r) => r !== foyer)
    .sort((a, b) => (areas.get(b.key) as number) - (areas.get(a.key) as number));
  const south: ProgrammeRoom[] = foyer ? [foyer] : [];
  const north: ProgrammeRoom[] = [];
  let southM2 = foyer ? (areas.get(foyer.key) as number) : 0;
  let northM2 = 0;
  for (const room of sorted) {
    const m2 = areas.get(room.key) as number;
    if (southM2 <= northM2) {
      south.push(room);
      southM2 += m2;
    } else {
      north.push(room);
      northM2 += m2;
    }
  }
  const deepEnough = (strip: ProgrammeRoom[]) =>
    strip.reduce((n, r) => Math.max(n, MIN_SIDE[r.purpose] ?? MIN_SIDE_FALLBACK), 1800);
  const southMinD = deepEnough(south);
  const northMinD = deepEnough(north);
  const acrossTheBuilding = 2 * wallMm + 2 * interiorWallMm + corridorMm;
  const minShellD = southMinD + northMinD + acrossTheBuilding;

  // The shell: what was asked for, or one that holds the rooms and the walls and is deep enough for
  // both strips. Depth comes first and the width follows from the area, because a building too
  // shallow for its rooms cannot be fixed by making it longer.
  let shellW: number;
  let shellD: number;
  if (programme.shell) {
    shellW = programme.shell.w;
    shellD = programme.shell.d;
    if (shellD < minShellD)
      notes.push(
        `the plot is ${shellD} mm deep and these rooms need ${minShellD} mm across the building; some may not fit`,
      );
  } else {
    // The building follows from the rooms, not the other way round.
    //
    // This used to take the total area, apply a fixed proportion to one side, and divide whatever
    // frontage fell out by the number of rooms. Whatever shape the arithmetic produced was the
    // shape the rooms got. On a hotel floor of twenty bedrooms that gave a 29.4 by 21.0 m building
    // with guest rooms 2.6 m wide and 9.3 m deep: the right area, and twenty filing cabinets.
    //
    // A guest room is about 4 m by 6.5 m because that is a bed, a bathroom and a window. Ten of
    // them a side is a 40 m frontage; two of them either side of a corridor is 14.5 m across. The
    // building is 40 by 14.5 because the rooms are what they are. So: every room says how deep it
    // would like to be, a strip takes the depth its rooms want, and the frontage is what holds
    // them. The typology was never wrong -- a corridor with rooms either side is exactly what a
    // hotel floor is -- the dimensions were being taken from the wrong end.
    const frontageWanted = (strip: ProgrammeRoom[], minD: number) => {
      const m2 = strip.reduce((n, r) => n + (areas.get(r.key) as number), 0);
      if (m2 <= 0) return 0;
      // Area-weighted, so a big room has its say without a cupboard outvoting it.
      const depth = Math.max(
        minD,
        strip.reduce((n, r) => {
          const a = areas.get(r.key) as number;
          return n + a * Math.sqrt(a * 1e6 * IDEAL_DEPTH_RATIO);
        }, 0) / m2,
      );
      return (m2 * 1e6) / depth;
    };
    const wantS = frontageWanted(south, southMinD);
    const wantN = frontageWanted(north, northMinD);
    // One frontage has to serve both strips, and it is the wider of the two that decides.
    //
    // Sharing it by floor area was the first answer and it lets one enormous room set the shape of
    // the whole building: an open office of a thousand square metres wants a deep plate, the strip
    // of meeting rooms opposite wants a shallow one, and the average of the two is a building that
    // suits neither. The wider frontage suits both -- the small rooms get the shallow strip they
    // need, and the big room simply becomes a long open floor, which is what an open floor is.
    const share = Math.max(wantS, wantN);
    // A strip's rooms stand side by side, so the frontage has to hold all of them added up, not
    // the widest one. Taking the widest was how a shell came out too narrow for its own rooms and
    // started dropping them.
    const sideBySide = (strip: ProgrammeRoom[]) =>
      strip.reduce((n, r) => n + (MIN_SIDE[r.purpose] ?? MIN_SIDE_FALLBACK), 0) +
      Math.max(0, strip.length - 1) * interiorWallMm;
    const minFrontage = Math.max(sideBySide(south), sideBySide(north));
    shellW = round100(Math.max(share, minFrontage) + 2 * wallMm);
    const across = shellW - 2 * wallMm;
    shellD =
      acrossTheBuilding +
      round100(Math.max(southMinD, (southM2 * 1e6) / across)) +
      round100(Math.max(northMinD, (northM2 * 1e6) / across));
    notes.push(
      `no plot was given, so the building is ${(shellW / 1000).toFixed(1)} by ${(shellD / 1000).toFixed(1)} m, a shape that suits the rooms, holding ${Math.round(roomsM2)} m² of them plus walls and a hallway`,
    );
  }

  // The strips: deep enough for what is in them, and otherwise sharing the depth by area.
  const usableD = shellD - acrossTheBuilding;
  const southD = round100(
    clamp(
      (usableD * southM2) / Math.max(1, southM2 + northM2),
      southMinD,
      Math.max(southMinD, usableD - northMinD),
    ),
  );
  const northD = usableD - southD;
  const frame: Frame = {
    x: wallMm,
    y: wallMm,
    length: shellW - 2 * wallMm,
    depth: shellD - 2 * wallMm,
    turned: false,
  };
  const southV = 0;
  const corridorV = southV + southD + interiorWallMm;
  const northV = corridorV + corridorMm + interiorWallMm;

  const rooms: NonNullable<DesignInput["rooms"]> = [];
  const corridorKey = "hallway";

  /**
   * One strip: each room the full depth of the strip and a width from its share of the area.
   *
   * Full depth is the whole trick. It puts one long side of every room against the hallway, so the
   * door has a wall, and the other against the outside of the building, so the window has one too.
   */
  const placeStrip = (strip: ProgrammeRoom[], v: number, depth: number) => {
    const ordered = orderStrip(strip);
    if (ordered.length === 0) return;
    // The narrowest this room may be in a strip of this depth: its own minimum side, a door's worth
    // of wall, and whatever width its minimum AREA needs at this depth. The third is easy to forget
    // and is what left a 2700 mm bedroom at 8.9 m² in a 3300 mm strip, a hundredth short of legal.
    const minOf = (room: ProgrammeRoom) => {
      const byArea = MIN_M2[room.purpose] ? ((MIN_M2[room.purpose] as number) * 1e6) / depth : 0;
      return Math.max(
        MIN_SIDE[room.purpose] ?? MIN_SIDE_FALLBACK,
        DOOR_WALL_MM,
        Math.ceil(byArea / 100) * 100,
      );
    };
    const gaps = (ordered.length - 1) * interiorWallMm;
    const usableW = frame.length - gaps;

    // Widths by share of area, then pushed up to each room's minimum, then the excess taken back
    // from whatever has slack above its own minimum. An earlier version rounded before it did this
    // and rounded a room below its minimum, which dropped it from the plan and gave its floor to
    // whatever happened to be last -- a nineteen square metre toilet, in the run that found it.
    const total = ordered.reduce((n, r) => n + (areas.get(r.key) as number), 0);
    const widths = ordered.map((r) => Math.max(usableW * ((areas.get(r.key) as number) / total), minOf(r)));
    for (let pass = 0; pass < 4; pass += 1) {
      const over = widths.reduce((a, b) => a + b, 0) - usableW;
      if (over <= 1) break;
      const slack = widths.map((w, i) => Math.max(0, w - minOf(ordered[i] as ProgrammeRoom)));
      const totalSlack = slack.reduce((a, b) => a + b, 0);
      if (totalSlack <= 1) break;
      for (let i = 0; i < widths.length; i += 1)
        widths[i] = (widths[i] as number) - (over * (slack[i] as number)) / totalSlack;
    }

    // Round to whole hundreds without losing or inventing millimetres: floor everything, then give
    // the remainder back a hundred at a time to the rooms the rounding took most from.
    const floored = widths.map((w) => Math.floor(w / 100) * 100);
    let spare = Math.round((usableW - floored.reduce((a, b) => a + b, 0)) / 100);
    const byRemainder = widths
      .map((w, i) => ({ i, rest: w - (floored[i] as number) }))
      .sort((a, b) => b.rest - a.rest);
    for (const { i } of byRemainder) {
      if (spare <= 0) break;
      floored[i] = (floored[i] as number) + 100;
      spare -= 1;
    }

    let u = 0;
    ordered.forEach((room, i) => {
      const w = floored[i] as number;
      const min = minOf(room);
      // width against width, depth against the room's own minimum side; comparing a width with a
      // depth is how a 6.7 m living room was dropped from a 2.2 m strip for being "too narrow"
      const minSide = MIN_SIDE[room.purpose] ?? MIN_SIDE_FALLBACK;
      if (w < min || depth < minSide) {
        unplaced.push({
          key: room.key,
          why: `${room.name} needs ${min} mm along the hallway and ${minSide} mm deep for ${areaOf(room).toFixed(1)} m²; this strip offers ${Math.max(0, w)} mm by ${depth} mm`,
        });
        return;
      }
      rooms.push({
        key: room.key,
        name: room.name,
        purpose: asPurpose(room.purpose),
        rect: place(frame, u, v, w, depth),
        capacity: room.capacity ?? null,
        doorsTo: room.purpose === "foyer" ? ["outside", corridorKey] : [corridorKey],
        window: room.window ?? HABITABLE.has(room.purpose),
      });
      u += w + interiorWallMm;
    });
  };

  placeStrip(south, southV, southD);
  placeStrip(north, northV, northD);

  rooms.push({
    key: corridorKey,
    name: "Hallway",
    purpose: "corridor",
    rect: place(frame, 0, corridorV, frame.length, corridorMm),
    capacity: null,
    doorsTo: foyer ? [] : ["outside"],
    window: false,
  });

  const design: DesignInput = {
    brief: programme.brief,
    kind: programme.kind,
    levelId: null,
    shell: { x: 0, y: 0, w: shellW, d: shellD, wallMm, interiorWallMm },
    rooms,
    circulation: [corridorKey, ...(foyer ? [foyer.key] : [])],
    assumptions: [...(programme.assumptions ?? []), ...notes],
  };
  return { design, notes, unplaced };
}

function emptyDesign(programme: Programme, wallMm: number, interiorWallMm: number): DesignInput {
  return {
    brief: programme.brief,
    kind: programme.kind,
    levelId: null,
    shell: { x: 0, y: 0, w: 6000, d: 5000, wallMm, interiorWallMm },
    rooms: [
      {
        key: "room1",
        name: "Room",
        purpose: "other",
        rect: { x: wallMm, y: wallMm, w: 6000 - 2 * wallMm, d: 5000 - 2 * wallMm },
        capacity: null,
        doorsTo: ["outside"],
        window: true,
      },
    ],
    circulation: [],
    assumptions: programme.assumptions ?? [],
  };
}

/** The rooms a building of this kind has to have, for a programme that forgot one. */
export function missingFromProgramme(programme: Programme): string[] {
  if (programme.kind === "workplace") return [];
  const purposes = new Set(programme.rooms.map((r) => r.purpose));
  const out: string[] = [];
  if (!purposes.has("kitchen")) out.push("kitchen");
  if (!purposes.has("bathroom") && !purposes.has("toilet")) out.push("bathroom");
  if (!purposes.has("living")) out.push("living");
  return out;
}

/** Whether a purpose belongs to a dwelling, for a caller deciding what kind of building this is. */
export const isResidential = (purpose: string): boolean => RESIDENTIAL_PURPOSES.has(purpose as never);

export type { Design };
export { CIRCULATION, CORRIDOR_MM, DEFAULT_M2, MIN_SIDE };

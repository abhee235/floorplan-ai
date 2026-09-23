// A design: what the architect decides before anything is drawn (ADR-022 D2).
//
// The point of writing a design down as data is that a program can measure it. A model that plans in
// a paragraph can say "three good-sized bedrooms off a central hall" and be wrong about every part
// of it, and nothing can tell; a model that says bed1 is 3000 by 3600 at (0, 4200) with a door to
// the hall has said something that adds up or does not.
//
// Rooms are rectangles. A room a person can name is a rectangle nearly always, a rectangle is
// checkable in arithmetic the model can also do, and drawing a set of rectangles is deterministic.
// An L-shaped room is two keys with a door between them and no wall, which the builder merges.

import { z } from "zod";
import { Mm, MmNonNegative, MmPositive, RoomPurpose } from "./schema.js";

/** A name the model gives a room and keeps: "bed1", "hall". Stable across rounds of correction. */
export const RoomKey = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/);

/**
 * A room key from whatever a model called the room.
 *
 * The key is an identifier the design refers to itself by, and a model given a field called "key"
 * writes "Open Workspace" or "ws-1" about as often as it writes "ws1". Refusing those is defensible
 * and useless: the name it meant is unambiguous, and the alternative is a run that dies three steps
 * later on a schema it was never shown. So it is normalised, and only a word with no letters and no
 * digits in it at all has nothing left to normalise.
 */
export function roomKey(word: string, fallback = "room"): string {
  const slug = word
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "")
    .slice(0, 24);
  return slug || fallback;
}

/** The same, over a list, keeping every key different from the others. */
export function roomKeys(words: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return words.map((w, i) => {
    const base = roomKey(w, `room${i + 1}`);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    if (n === 0) return base;
    // Room "1" and room "2" both slugged to "room": the second gets a number rather than the first.
    return `${base.slice(0, 22)}_${n + 1}`;
  });
}

/** The world outside the building, as somewhere a door can lead. */
export const OUTSIDE = "outside" as const;

/**
 * What stands between a room and the rest of the floor (ADR-028 D3).
 *
 * `walled` is plaster; `glass` is a glass box, which a meeting room in a modern office is; `open`
 * is no wall at all, a zone on the floor with a name -- the desks, the cafe, the breakout. A
 * cafeteria open to the workspace was in the picture the owner drew from, and the design had no
 * way to say it.
 */
export const Enclosure = z.enum(["walled", "glass", "open"]);
export type Enclosure = z.infer<typeof Enclosure>;

/** Rooms that keep solid walls whatever the design says, for privacy, security and fire separation. */
export const WALLED_ALWAYS: ReadonlySet<string> = new Set([
  "restroom",
  "toilet",
  "bathroom",
  "utility",
  "storage",
  "laundry",
  "garage",
]);

/**
 * A side of the building: punched windows, one glass wall the length of it, or `solid`, no opening
 * but a door: a side against a neighbouring building, or against the core of the tower the floor is
 * in, which is where an office floor's entrance usually is (ADR-028 D12).
 */
export const Facade = z.enum(["windows", "glazed", "solid"]);
export type Facade = z.infer<typeof Facade>;
type SideName = "north" | "south" | "east" | "west";

/**
 * What a side the design leaves unsaid is: glass for a workplace, windows for a home.
 *
 * An office drawn with the old default, punched windows on every side, was the first thing its owner
 * objected to: a modern office is glass. A home is not.
 */
export function defaultFacade(kind: "dwelling" | "workplace" | "mixed"): Facade {
  return kind === "workplace" ? "glazed" : "windows";
}

/** Rooms that are the way between others. */
export const CIRCULATION_PURPOSES: ReadonlySet<string> = new Set(["corridor", "foyer"]);

export const DesignRect = z.object({
  /** South-west corner of the clear inside, in mm. */
  x: Mm,
  y: Mm,
  w: MmPositive,
  d: MmPositive,
});

/**
 * What a model called a room, as a purpose the enum has (ADR-022 D2).
 *
 * The first live run of the architect spent six of its rounds being told that "living room",
 * "Master bedroom" and "entrance foyer" are not purposes. They are, of course; they are what the
 * rooms are called. A schema that knows the words people use for rooms costs a lookup table and
 * saves a round trip to a model each time, so it is not a kindness, it is the cheaper answer.
 */
const PURPOSE_WORDS: Readonly<Record<string, string>> = {
  "living room": "living",
  "sitting room": "living",
  "drawing room": "living",
  lounge: "living",
  hall: "living",
  "master bedroom": "bedroom",
  "double bedroom": "bedroom",
  "single bedroom": "bedroom",
  "guest bedroom": "bedroom",
  bed: "bedroom",
  "dining room": "dining",
  "entrance foyer": "foyer",
  entrance: "foyer",
  lobby: "foyer",
  vestibule: "foyer",
  porch: "foyer",
  "bathroom with shower": "bathroom",
  bath: "bathroom",
  ensuite: "bathroom",
  "en-suite": "bathroom",
  shower: "bathroom",
  wc: "toilet",
  cloakroom: "toilet",
  "powder room": "toilet",
  "water closet": "toilet",
  kitchenette: "kitchen",
  passage: "corridor",
  hallway: "corridor",
  landing: "corridor",
  circulation: "corridor",
  "utility room": "utility",
  "laundry room": "laundry",
  "store room": "storage",
  store: "storage",
  cupboard: "storage",
  office: "open-office",
  "home office": "study",
  den: "study",
  terrace: "balcony",
  veranda: "balcony",
  verandah: "balcony",
  "car port": "garage",
  carport: "garage",
};

/**
 * A purpose from whatever a model wrote, or null when nothing sensible matches.
 *
 * Tried in order, and the order matters: the word exactly as the enum has it first, because
 * "open-office" is a purpose and collapsing its hyphen would lose it; then with the separators
 * collapsed, for "dining_room"; then with them removed, for "hall-way" which is one word; then the
 * first word alone, for "Bedroom 1" and "bathroom (family)".
 */
export function purposeFromWord(word: string): string | null {
  const raw = word.trim().toLowerCase();
  const known = (w: string): string | null =>
    RoomPurpose.options.includes(w as never) ? w : (PURPOSE_WORDS[w] ?? null);
  for (const candidate of [raw, raw.replace(/[\s_-]+/g, " "), raw.replace(/[\s_-]+/g, "")]) {
    const found = known(candidate);
    if (found) return found;
  }
  const head = raw.replace(/[\s_-]+/g, " ").split(/[\s(0-9]/)[0] ?? "";
  return head ? known(head) : null;
}

export const DesignRoom = z.object({
  key: RoomKey,
  name: z.string().min(1),
  purpose: RoomPurpose,
  /** The clear inside of the room; walls go outside it. */
  rect: DesignRect,
  capacity: z.number().int().min(0).nullable().default(null),
  /** Keys of the rooms this one opens onto, or "outside" for a door to the world. */
  doorsTo: z.array(z.string()).default([]),
  /** This room wants a window, so it needs a wall on the outside of the building. */
  window: z.boolean().default(false),
  /**
   * Its walls onto the rest of the building are glass rather than plaster.
   *
   * A meeting room in a modern office is a glass box: it needs to be quiet, not hidden, and a
   * floor of sealed plaster cells is what an office looked like in 1985. The model may say so per
   * room; left unsaid, the packer decides from what the room is for.
   */
  glazed: z.boolean().default(false),
  /**
   * What stands between this room and the floor: walls, glass, or nothing. Left unsaid, `glazed`
   * decides, so a design written before this field existed still reads the same way.
   */
  enclosure: Enclosure.optional(),
});

/**
 * The room's enclosure, with the older `glazed` flag read as glass.
 *
 * A corridor or a foyer left unsaid is open: it is floor, and the walls along it belong to the rooms
 * on either side. Walled by default, a corridor was plastered off from the open office it ran into,
 * and two hallways meeting got a wall and a door between them that the builder could not fit.
 */
export function enclosureOf(room: {
  enclosure?: Enclosure | undefined;
  glazed?: boolean;
  purpose?: string;
}): Enclosure {
  if (room.enclosure) return room.enclosure;
  if (room.glazed) return "glass";
  // Circulation is open, and so are the desks: an open office is the floor, not a room behind a door.
  return room.purpose === "corridor" || room.purpose === "foyer" || room.purpose === "open-office"
    ? "open"
    : "walled";
}

/**
 * Whether the room must keep solid walls: a service room, whatever the design asked for. A model
 * asked for an open-plan restroom once; nobody else needs to.
 */
export const mustBeWalled = (room: { purpose: string }): boolean => WALLED_ALWAYS.has(room.purpose);

export const Design = z
  .object({
    /** The words this was designed for, so a later round can tell whether the brief changed. */
    brief: z.string(),
    kind: z.enum(["dwelling", "workplace", "mixed"]),
    /** The level it will be drawn on; the lowest one when the architect does not say. */
    levelId: z.string().nullable().default(null),
    shell: z.object({
      x: Mm,
      y: Mm,
      w: MmPositive,
      d: MmPositive,
      /** Outside wall thickness; 230 to 300 for a building. */
      wallMm: MmPositive.default(230),
      /** Inside wall thickness; 100 to 120. */
      interiorWallMm: MmPositive.default(115),
      /**
       * Each side of the building: punched `windows`; `glazed`, a glass wall the length of the side
       * with no separate windows, which counts as daylight for every room along it; or `solid`. A side
       * left unsaid is glazed in a workplace and windows in a home.
       */
      facade: z
        .object({
          north: Facade.optional(),
          south: Facade.optional(),
          east: Facade.optional(),
          west: Facade.optional(),
        })
        .default({}),
    }),
    rooms: z.array(DesignRoom).min(1),
    /** Keys of the rooms that are circulation: a hall, a corridor, a landing. */
    circulation: z.array(RoomKey).default([]),
    /** What the brief did not say and the architect decided. */
    assumptions: z.array(z.string()).default([]),
  })
  // Every side has a facade once parsed, so nothing downstream decides the default again.
  .transform((d) => ({
    ...d,
    shell: {
      ...d.shell,
      facade: {
        north: d.shell.facade.north ?? defaultFacade(d.kind),
        south: d.shell.facade.south ?? defaultFacade(d.kind),
        east: d.shell.facade.east ?? defaultFacade(d.kind),
        west: d.shell.facade.west ?? defaultFacade(d.kind),
      } satisfies Record<SideName, Facade>,
    },
  }));

export type DesignRect = z.infer<typeof DesignRect>;
export type DesignRoom = z.infer<typeof DesignRoom>;
export type Design = z.infer<typeof Design>;
export type DesignInput = z.input<typeof Design>;

export const designRoomArea = (r: DesignRoom): number => (r.rect.w * r.rect.d) / 1e6;
export const designShortSide = (r: DesignRoom): number => Math.min(r.rect.w, r.rect.d);

/** Overlap of two rectangles in mm², 0 when they only touch. */
export function rectOverlap(a: DesignRect, b: DesignRect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const d = Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y);
  return w > 0 && d > 0 ? w * d : 0;
}

/**
 * How much wall two rooms share, in mm: the length of their common edge.
 *
 * A door needs a wall to sit in, so two rooms that meet at a corner or not at all cannot have a
 * door between them however much the design says they do. The gap allows for the wall between them.
 */
export function sharedEdge(a: DesignRect, b: DesignRect, gapMm: number): number {
  const touchesVertically = Math.abs(a.x + a.w - b.x) <= gapMm || Math.abs(b.x + b.w - a.x) <= gapMm;
  const touchesHorizontally = Math.abs(a.y + a.d - b.y) <= gapMm || Math.abs(b.y + b.d - a.y) <= gapMm;
  if (touchesVertically) {
    const overlap = Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y);
    return Math.max(0, overlap);
  }
  if (touchesHorizontally) {
    const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    return Math.max(0, overlap);
  }
  return 0;
}

/** The sides of the building this room's rectangle lies against. */
export function outsideSides(
  room: { rect: DesignRect },
  shell: Pick<Design["shell"], "x" | "y" | "w" | "d">,
  gapMm: number,
): ("north" | "south" | "east" | "west")[] {
  const { rect } = room;
  const out: ("north" | "south" | "east" | "west")[] = [];
  if (Math.abs(rect.x - shell.x) <= gapMm) out.push("west");
  if (Math.abs(rect.y - shell.y) <= gapMm) out.push("south");
  if (Math.abs(shell.x + shell.w - (rect.x + rect.w)) <= gapMm) out.push("east");
  if (Math.abs(shell.y + shell.d - (rect.y + rect.d)) <= gapMm) out.push("north");
  return out;
}

/**
 * True when a side of the room is on a glazed side of the building: daylight without a window.
 *
 * Not for a room that must be walled: a toilet on a glazed side keeps a solid outside wall.
 */
export function onGlazedSide(room: DesignRoom, shell: Design["shell"], gapMm: number): boolean {
  if (mustBeWalled(room)) return false;
  return outsideSides(room, shell, gapMm).some((side) => shell.facade[side] === "glazed");
}

/** The room's outside sides that can take a punched window: on a side of the building with windows. */
export function windowSides(room: DesignRoom, shell: Design["shell"], gapMm: number): SideName[] {
  return outsideSides(room, shell, gapMm).filter((side) => shell.facade[side] === "windows");
}

/** True when the room can have daylight: a glazed side, or a side that can take a window. */
export function canBeDaylit(room: DesignRoom, shell: Design["shell"], gapMm: number): boolean {
  return onGlazedSide(room, shell, gapMm) || windowSides(room, shell, gapMm).length > 0;
}

/**
 * Floor everyone walks on: an open zone, a corridor, a foyer. Glass faces it; between two rooms
 * with doors of their own the wall is plaster (ADR-028 D12).
 */
export const isSharedFloor = (room: DesignRoom): boolean =>
  enclosureOf(room) === "open" || CIRCULATION_PURPOSES.has(room.purpose);

/** True when the room has a side on the outside of the building, so a window is possible. */
export function onOutsideWall(room: DesignRoom, shell: Design["shell"], gapMm: number): boolean {
  const { rect } = room;
  return (
    Math.abs(rect.x - shell.x) <= gapMm ||
    Math.abs(rect.y - shell.y) <= gapMm ||
    Math.abs(shell.x + shell.w - (rect.x + rect.w)) <= gapMm ||
    Math.abs(shell.y + shell.d - (rect.y + rect.d)) <= gapMm
  );
}

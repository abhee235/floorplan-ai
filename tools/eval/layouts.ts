// Briefs that are hard, for measuring a layout algorithm against (ADR-022 D2, amended).
//
// The one-bedroom flat everything has been tested on until now is the easy case: six rooms of
// similar size, all of which want daylight, in a building whose proportions suit a single corridor.
// It cannot tell two algorithms apart, and it said nothing at all about the office that produced
// fifteen rooms in a comb.
//
// So: one dominant room among small ones, many rooms of one size, rooms that must stack, rooms that
// must be beside each other, and a house as the control. Whatever replaces the packer has to be
// better on these and no worse on the house.

import type { Programme } from "@fpv/catalog";

export interface LayoutBrief {
  id: string;
  /** What makes this one hard, in one line; it appears in the results table. */
  hard: string;
  programme: Programme;
}

const room = (
  key: string,
  name: string,
  purpose: string,
  targetM2: number,
  extra: { nextTo?: string[]; window?: boolean; capacity?: number } = {},
) => ({ key, name, purpose, targetM2, ...extra });

/** n rooms of one kind, numbered, for the briefs that are mostly repetition. */
const many = (n: number, prefix: string, name: string, purpose: string, targetM2: number, from = 1) =>
  Array.from({ length: n }, (_, i) => room(`${prefix}${from + i}`, `${name} ${from + i}`, purpose, targetM2));

export const LAYOUT_BRIEFS: LayoutBrief[] = [
  {
    id: "office-100",
    hard: "one room is 73% of the floor and the rest are small",
    programme: {
      brief: "an office for a hundred IT people with meeting rooms, a cafeteria and pantries",
      kind: "workplace",
      rooms: [
        room("open", "Open office", "open-office", 1000),
        room("caf", "Cafeteria", "cafeteria", 120, { nextTo: ["pantry1"] }),
        room("train", "Training room", "training", 80),
        room("board", "Boardroom", "boardroom", 40),
        room("rec", "Reception", "reception", 30, { nextTo: ["open"] }),
        room("pantry1", "Pantry", "kitchen", 25),
        room("wc", "Toilets", "restroom", 24),
        ...many(2, "m8", "Meeting room 8 seat", "meeting", 23),
        ...many(3, "m6", "Meeting room 6 seat", "meeting", 18),
        ...many(3, "m4", "Meeting room 4 seat", "meeting", 12),
      ],
    },
  },
  {
    id: "hotel-floor",
    hard: "twenty identical rooms and almost nothing else",
    programme: {
      brief: "a hotel floor of twenty bedrooms with a linen store and a lift lobby",
      // A commercial building rather than somebody's home: called mixed, the checker asks it for a
      // kitchen, a bathroom and a living room, which a hotel floor does not have and should not.
      kind: "workplace",
      rooms: [
        ...many(20, "r", "Guest room", "bedroom", 26),
        room("linen", "Linen store", "storage", 8),
        room("lobby", "Lift lobby", "foyer", 20),
        room("wc", "Staff toilet", "restroom", 6),
      ],
    },
  },
  {
    id: "clinic",
    hard: "many small rooms that must be beside one waiting area",
    programme: {
      brief: "a clinic with eight consulting rooms around a waiting area",
      kind: "workplace",
      rooms: [
        room("wait", "Waiting", "reception", 60),
        ...many(8, "c", "Consulting room", "meeting", 14).map((r) => ({
          ...r,
          nextTo: ["wait"],
        })),
        room("recep", "Reception desk", "reception", 14, { nextTo: ["wait"] }),
        room("store", "Store", "storage", 8),
        room("wc", "Toilets", "restroom", 12),
        room("staff", "Staff room", "cafeteria", 20),
      ],
    },
  },
  {
    id: "school-wing",
    hard: "large rooms of one size, all of which need daylight",
    programme: {
      brief: "a school wing of eight classrooms, a staff room and toilets",
      kind: "workplace",
      rooms: [
        ...many(8, "cls", "Classroom", "training", 60),
        room("staff", "Staff room", "cafeteria", 40),
        room("head", "Head of year", "focus", 12),
        room("store", "Store", "storage", 10),
        room("wc", "Toilets", "restroom", 30),
      ],
    },
  },
  {
    id: "mixed-floor",
    hard: "a workplace and a home on one plate",
    programme: {
      brief: "a shop with a flat above it on the same floor plate",
      kind: "mixed",
      rooms: [
        room("shop", "Shop floor", "open-office", 120),
        room("stock", "Stock room", "storage", 30, { nextTo: ["shop"] }),
        room("living", "Living room", "living", 24),
        room("kitchen", "Kitchen", "kitchen", 12, { nextTo: ["living"] }),
        ...many(2, "bed", "Bedroom", "bedroom", 13),
        room("bath", "Bathroom", "bathroom", 5),
        room("wc", "Shop toilet", "restroom", 4),
      ],
    },
  },
  {
    id: "four-bed-house",
    hard: "the control: this must not get worse",
    programme: {
      brief: "a four bedroom house with a study and a utility room",
      kind: "dwelling",
      rooms: [
        room("living", "Living room", "living", 24),
        room("kitchen", "Kitchen", "kitchen", 14, { nextTo: ["dining"] }),
        room("dining", "Dining room", "dining", 12),
        room("main", "Main bedroom", "bedroom", 16),
        ...many(3, "bed", "Bedroom", "bedroom", 11, 2),
        room("study", "Study", "study", 9),
        room("bath", "Bathroom", "bathroom", 6),
        room("wc", "Cloakroom", "toilet", 2),
        room("util", "Utility", "laundry", 5, { nextTo: ["kitchen"] }),
      ],
    },
  },
];

/** The adjacencies a brief asked for, in the shape the quality measure wants. */
export function askedAdjacency(programme: Programme): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const r of programme.rooms) if (r.nextTo?.length) out[r.key] = r.nextTo;
  return out;
}

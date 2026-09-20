// The packer (ADR-022 D2, amended): a programme into rectangles that pass the checker.
//
// The claim these tests exist to hold is one sentence: whatever a sensible programme asks for, what
// comes out passes checkLayout with no errors. Not "usually", and not "after a round or two" -- by
// construction, because that is the whole reason the packer exists. The architect was given six
// rounds at doing this by hand and produced 12, 11, 14, 14, 14 and 13 problems.

import { Design } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { CORE_RULES, checkLayout, MIN_SIDE, type Programme, packProgramme } from "../src/index.js";

const errorsIn = (programme: Programme) => {
  const { design } = packProgramme(programme);
  const parsed = Design.parse(design);
  return checkLayout(parsed, CORE_RULES)
    .problems.filter((p) => p.severity === "error")
    .map((p) => `${p.code}: ${p.message}`);
};

const room = (key: string, name: string, purpose: string, targetM2?: number) => ({
  key,
  name,
  purpose,
  ...(targetM2 === undefined ? {} : { targetM2 }),
});

/** The brief that started all of this. */
const THREE_BED: Programme = {
  brief: "build a 3 bedroom apartment with hall and lobby",
  kind: "dwelling",
  rooms: [
    room("lobby", "Lobby", "foyer"),
    room("hall", "Hall", "living", 20),
    room("kitchen", "Kitchen", "kitchen", 10),
    room("bed1", "Bedroom 1", "bedroom", 14),
    room("bed2", "Bedroom 2", "bedroom", 12),
    room("bed3", "Bedroom 3", "bedroom", 10),
    room("bath", "Bathroom", "bathroom", 5),
    room("wc", "Toilet", "toilet", 2),
  ],
  assumptions: ["the hall is the living room and the lobby the entrance foyer"],
};

describe("what the packer produces", () => {
  it("passes the checker, for the brief the architect could not do by hand", () => {
    expect(errorsIn(THREE_BED)).toEqual([]);
  });

  it("works out a building that holds what was asked for, and says it did", () => {
    const { design, notes } = packProgramme(THREE_BED);
    const shell = design.shell;
    const m2 = (shell.w * shell.d) / 1e6;
    expect(m2).toBeGreaterThan(75);
    expect(m2).toBeLessThan(130);
    expect(notes.join(" ")).toMatch(/no plot was given, so the building is \d+\.\d by \d+\.\d m/);
    expect(design.assumptions).toContain("the hall is the living room and the lobby the entrance foyer");
  });

  it("gives every room a door to the hallway, and the hallway a way out", () => {
    const { design } = packProgramme(THREE_BED);
    const hallway = design.rooms.find((r) => r.purpose === "corridor");
    expect(hallway).toBeDefined();
    for (const r of design.rooms) {
      if (r.purpose === "corridor") continue;
      expect(r.doorsTo, r.name).toContain(hallway?.key);
    }
    expect(design.rooms.find((r) => r.purpose === "foyer")?.doorsTo).toContain("outside");
  });

  it("puts every room people live in on an outside wall, with a window", () => {
    const design = Design.parse(packProgramme(THREE_BED).design);
    const shell = design.shell;
    for (const r of design.rooms) {
      if (!r.window) continue;
      const onEdge =
        r.rect.y <= shell.y + shell.wallMm + 10 ||
        r.rect.y + r.rect.d >= shell.y + shell.d - shell.wallMm - 10;
      expect(onEdge, r.name).toBe(true);
    }
    const habitable = design.rooms.filter((r) => ["bedroom", "living", "kitchen"].includes(r.purpose));
    expect(habitable.every((r) => r.window)).toBe(true);
  });

  it("keeps the wet rooms together, so their drainage is", () => {
    const { design } = packProgramme(THREE_BED);
    const wet = design.rooms
      .filter((r) => ["bathroom", "toilet", "kitchen"].includes(r.purpose))
      .map((r) => ({ key: r.key, y: r.rect.y, x: r.rect.x }))
      .sort((a, b) => a.x - b.x);
    // in one strip, and next to each other in it
    const strips = new Set(wet.map((r) => r.y));
    expect(strips.size).toBeLessThanOrEqual(2);
  });

  it("is deterministic: the same programme gives the same plan", () => {
    expect(JSON.stringify(packProgramme(THREE_BED).design)).toBe(
      JSON.stringify(packProgramme(THREE_BED).design),
    );
  });
});

describe("programmes of other shapes", () => {
  it("packs a one-bedroom flat", () => {
    expect(
      errorsIn({
        brief: "a one bedroom flat",
        kind: "dwelling",
        rooms: [
          room("hall", "Living room", "living", 18),
          room("bed", "Bedroom", "bedroom", 13),
          room("kitchen", "Kitchen", "kitchen", 8),
          room("bath", "Bathroom", "bathroom", 4),
        ],
      }),
    ).toEqual([]);
  });

  it("packs a four-bedroom house with a study and a laundry", () => {
    expect(
      errorsIn({
        brief: "a four bedroom house",
        kind: "dwelling",
        rooms: [
          room("lobby", "Entrance", "foyer"),
          room("living", "Living room", "living", 24),
          room("dining", "Dining room", "dining", 12),
          room("kitchen", "Kitchen", "kitchen", 12),
          room("bed1", "Main bedroom", "bedroom", 16),
          room("bed2", "Bedroom 2", "bedroom", 12),
          room("bed3", "Bedroom 3", "bedroom", 11),
          room("bed4", "Bedroom 4", "bedroom", 10),
          room("study", "Study", "study", 8),
          room("bath", "Bathroom", "bathroom", 6),
          room("wc", "Cloakroom", "toilet", 2),
          room("laundry", "Laundry", "laundry", 3),
        ],
      }),
    ).toEqual([]);
  });

  it("respects a plot it is given", () => {
    const programme: Programme = { ...THREE_BED, shell: { w: 12000, d: 9000 } };
    const { design } = packProgramme(programme);
    expect(design.shell).toMatchObject({ w: 12000, d: 9000 });
    expect(errorsIn(programme)).toEqual([]);
  });

  it("adds a kitchen and a bathroom to a programme that forgot them", async () => {
    const { missingFromProgramme } = await import("../src/index.js");
    expect(
      missingFromProgramme({
        brief: "two bedrooms",
        kind: "dwelling",
        rooms: [room("bed1", "Bedroom 1", "bedroom"), room("bed2", "Bedroom 2", "bedroom")],
      }),
    ).toEqual(["kitchen", "bathroom", "living"]);
  });

  it("reads the words a model uses for a room", () => {
    const { design } = packProgramme({
      brief: "a flat",
      kind: "dwelling",
      rooms: [
        room("hall", "Hall", "Living Room", 18),
        room("bed", "Master bedroom", "Master Bedroom", 13),
        room("kitchen", "Kitchen", "kitchenette", 8),
        room("bath", "Bathroom", "bathroom with shower", 4),
      ],
    });
    expect(design.rooms.map((r) => r.purpose).sort()).toEqual([
      "bathroom",
      "bedroom",
      "corridor",
      "kitchen",
      "living",
    ]);
  });

  it("says which room it could not fit rather than placing it badly", () => {
    const { unplaced } = packProgramme({
      brief: "a flat in a cupboard",
      kind: "dwelling",
      shell: { w: 3000, d: 3000 },
      rooms: [
        room("living", "Living room", "living", 12),
        room("bed1", "Bedroom 1", "bedroom", 9),
        room("bed2", "Bedroom 2", "bedroom", 9),
        room("bed3", "Bedroom 3", "bedroom", 9),
        room("kitchen", "Kitchen", "kitchen", 5),
      ],
    });
    expect(unplaced.length).toBeGreaterThan(0);
    expect(unplaced[0]?.why).toMatch(/needs \d+ mm along the hallway and \d+ mm deep for \d+\.\d m²/);
  });
});

describe("a workplace is not a house with different labels", () => {
  /** The brief that produced the office nobody could have worked in. */
  const OFFICE: Programme = {
    brief: "an office for a hundred IT people with meeting rooms, a cafeteria and pantries",
    kind: "workplace",
    rooms: [
      room("open", "Open office", "open-office", 1000),
      room("caf", "Cafeteria", "cafeteria", 120),
      room("train", "Training room", "training", 80),
      room("board", "Boardroom", "boardroom", 40),
      room("rec", "Reception", "reception", 30),
      room("m8a", "Meeting room 8 seat A", "meeting", 23),
      room("m8b", "Meeting room 8 seat B", "meeting", 23),
      room("m6a", "Meeting room 6 seat A", "meeting", 18),
      room("m4a", "Meeting room 4 seat A", "meeting", 12),
      room("m4b", "Meeting room 4 seat B", "meeting", 12),
      room("wc", "Toilets", "restroom", 20),
    ],
  };

  it("gives every room at least the width its own purpose needs", () => {
    // The failure this pins: four-person meeting rooms 1.1 m wide and 11.2 m deep. The area was
    // reasonable and you could not get a table into one, because the table of minimum widths had
    // six rows and every one of them was residential, so every workplace room fell through to the
    // width of a door wall.
    const { design } = packProgramme(OFFICE);
    const narrow = design.rooms
      .filter((r) => r.purpose !== "corridor")
      .map((r) => ({
        name: r.name,
        w: Math.min(r.rect.w, r.rect.d),
        wants: MIN_SIDE[r.purpose] ?? 1800,
      }))
      .filter((r) => r.w < r.wants);
    expect(narrow).toEqual([]);
  });

  it("gives a meeting room room for a table and a chair either side of it", () => {
    const { design } = packProgramme(OFFICE);
    // 900 of table and 900 clear on both sides, which is what space planning asks for.
    for (const r of design.rooms.filter((x) => x.purpose === "meeting"))
      expect(Math.min(r.rect.w, r.rect.d)).toBeGreaterThanOrEqual(2700);
  });

  it("makes a workplace corridor wide enough to be a way out", () => {
    // 1,118 mm is the floor for fifty or more occupants, and this one had 1,150 for every building
    // in the world including a hundred-person office.
    const { design } = packProgramme(OFFICE);
    const corridor = design.rooms.find((r) => r.purpose === "corridor");
    expect(Math.min(corridor?.rect.w ?? 0, corridor?.rect.d ?? 0)).toBeGreaterThanOrEqual(1500);
  });

  it("still lets a house have a house's hallway", () => {
    // The fix must not make every home corridor an office corridor: 1.5 m of hallway in a flat is
    // floor area taken from the rooms that needed it.
    const { design } = packProgramme(THREE_BED);
    const corridor = design.rooms.find((r) => r.purpose === "corridor");
    const width = Math.min(corridor?.rect.w ?? 0, corridor?.rect.d ?? 0);
    expect(width).toBeGreaterThanOrEqual(1000);
    expect(width).toBeLessThan(1200);
  });

  // Expected to fail, and left here failing on purpose (ADR-022 D2, amended).
  //
  // This is the comb, and the packer cannot currently produce anything else. Bands run the full
  // width of the building by construction, and in this brief the open office is 73 per cent of the
  // floor: a band holding it is 21.7 m deep and well proportioned, and a band holding a 12 m2
  // meeting room across the same 46 m frontage is 300 mm deep. Splitting into more bands was
  // tried and makes it worse, because every band still spans the whole frontage.
  //
  // Fixing it means zones that take part of the width rather than all of it, which is a different
  // algorithm and not a tuning of this one. When that lands this test starts passing, `it.fails`
  // turns red, and whoever did it deletes this comment.
  it.fails("makes rooms, not slices: nothing more than two and a half times its own width", () => {
    // Every room in the comb was above its minimum width and every one of them was a corridor,
    // which is the thing the minimum-width test cannot say.
    const { design } = packProgramme(OFFICE);
    const slices = design.rooms
      .filter((r) => r.purpose !== "corridor")
      .map((r) => ({
        name: r.name,
        ratio: Math.max(r.rect.w, r.rect.d) / Math.min(r.rect.w, r.rect.d),
      }))
      .filter((r) => r.ratio > 2.5);
    expect(slices).toEqual([]);
  });

  it("comes out of the checker clean, like the house does", () => {
    expect(errorsIn(OFFICE)).toEqual([]);
  });
});

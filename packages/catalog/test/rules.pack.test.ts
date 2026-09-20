// The packer (ADR-022 D2, amended): a programme into rectangles that pass the checker.
//
// The claim these tests exist to hold is one sentence: whatever a sensible programme asks for, what
// comes out passes checkLayout with no errors. Not "usually", and not "after a round or two" -- by
// construction, because that is the whole reason the packer exists. The architect was given six
// rounds at doing this by hand and produced 12, 11, 14, 14, 14 and 13 problems.

import { Design } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { CORE_RULES, checkLayout, type Programme, packProgramme } from "../src/index.js";

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

// The checker (ADR-022 D3): a design measured before anything is drawn.
//
// The fixture is a three-bedroom flat that passes every check, and each test breaks exactly one
// thing about it. That shape matters: a checker that can only say "something is wrong with this" is
// no use to a model that has to fix it, so every test asserts which check fired and what it said.
import { type Design, type DesignInput, Design as DesignSchema } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { CORE_RULES, checkLayout, layoutIsBuildable } from "../src/index.js";

/**
 * A three-bedroom flat with a hall, a lobby and a corridor: 99 m² of shell, 90.7 m² of rooms.
 *
 * Laid out as a real one is, which is the point -- an east-west corridor across the middle with the
 * bedrooms and bathroom off it, the living room and kitchen to the south, and the front door in a
 * lobby. Every room touches what it has a door to.
 */
const FLAT: DesignInput = {
  brief: "3 bedroom apartment with hall and lobby",
  kind: "dwelling",
  levelId: null,
  shell: { x: 0, y: 0, w: 11000, d: 9000, wallMm: 230, interiorWallMm: 115 },
  rooms: [
    {
      key: "lobby",
      name: "Lobby",
      purpose: "foyer",
      rect: { x: 0, y: 0, w: 1800, d: 2000 },
      doorsTo: ["outside", "hall"],
    },
    {
      key: "hall",
      name: "Hall",
      purpose: "living",
      rect: { x: 1900, y: 0, w: 4000, d: 4000 },
      doorsTo: ["lobby", "corridor", "kitchen"],
      window: true,
    },
    {
      key: "kitchen",
      name: "Kitchen",
      purpose: "kitchen",
      rect: { x: 6000, y: 0, w: 2400, d: 4000 },
      doorsTo: ["hall"],
      window: true,
    },
    {
      key: "dining",
      name: "Dining",
      purpose: "dining",
      rect: { x: 8500, y: 0, w: 2500, d: 4000 },
      doorsTo: ["corridor"],
      window: true,
    },
    {
      key: "corridor",
      name: "Corridor",
      purpose: "corridor",
      rect: { x: 1000, y: 4000, w: 9000, d: 1200 },
      doorsTo: [],
    },
    {
      key: "bed1",
      name: "Bedroom 1",
      purpose: "bedroom",
      rect: { x: 0, y: 5200, w: 3000, d: 3800 },
      doorsTo: ["corridor"],
      window: true,
      capacity: 2,
    },
    {
      key: "bed2",
      name: "Bedroom 2",
      purpose: "bedroom",
      rect: { x: 3100, y: 5200, w: 3000, d: 3800 },
      doorsTo: ["corridor"],
      window: true,
      capacity: 2,
    },
    {
      key: "bath",
      name: "Bathroom",
      purpose: "bathroom",
      rect: { x: 6200, y: 5200, w: 1900, d: 3800 },
      doorsTo: ["corridor"],
    },
    {
      key: "bed3",
      name: "Bedroom 3",
      purpose: "bedroom",
      rect: { x: 8200, y: 5200, w: 2800, d: 3800 },
      doorsTo: ["corridor"],
      window: true,
      capacity: 1,
    },
  ],
  circulation: ["corridor", "lobby"],
  assumptions: ["the hall is the living room and the lobby the entrance foyer"],
};

const flat = (change: (d: Design) => void = () => {}): Design => {
  const d = DesignSchema.parse(JSON.parse(JSON.stringify(FLAT)));
  change(d);
  return d;
};
const room = (d: Design, key: string) => d.rooms.find((r) => r.key === key) as Design["rooms"][number];
const codes = (d: Design) => checkLayout(d, CORE_RULES).problems.map((p) => p.code);
const errors = (d: Design) =>
  checkLayout(d, CORE_RULES)
    .problems.filter((p) => p.severity === "error")
    .map((p) => p.code);
const find = (d: Design, code: string) =>
  checkLayout(d, CORE_RULES).problems.find((p) => p.code === `design.${code}`);

describe("a design that is sound", () => {
  it("passes every check and may be built", () => {
    const report = checkLayout(flat(), CORE_RULES);
    expect(report.problems).toEqual([]);
    expect(layoutIsBuildable(report)).toBe(true);
  });

  it("does the arithmetic the model was meant to do itself", () => {
    const { totals } = checkLayout(flat(), CORE_RULES);
    expect(totals).toMatchObject({ shellM2: 99, roomsM2: 90.7, rooms: 9 });
    expect(totals.unaccountedM2).toBeCloseTo(8.3, 1);
    expect(totals.byPurpose).toMatchObject({ bedroom: 3, living: 1, kitchen: 1, bathroom: 1 });
  });
});

describe("geometry", () => {
  it("catches two rooms on the same floor, and says how much they share", () => {
    const d = flat((x) => {
      room(x, "kitchen").rect.w = 3000; // now runs into the dining room
    });
    expect(find(d, "rooms-overlap")?.message).toMatch(
      /Kitchen and Dining are on top of each other over 2 m²/,
    );
    expect(layoutIsBuildable(checkLayout(d, CORE_RULES))).toBe(false);
  });

  it("catches a room outside the building", () => {
    const d = flat((x) => {
      room(x, "bed3").rect.x = 9500; // runs past the east wall
    });
    expect(find(d, "outside-shell")?.message).toMatch(/Bedroom 3 lies outside the building/);
  });

  it("catches rooms that add up to more than the shell holds", () => {
    const d = flat((x) => {
      x.shell.w = 6000;
    });
    expect(errors(d)).toContain("design.rooms-exceed-shell");
  });

  it("warns about floor no room accounts for, which is how a plan loses a room", () => {
    // walls take about a fifth of a flat this size, so the line is drawn above them; losing the
    // dining room AND a bedroom is what it takes to be sure a room has gone missing
    const d = flat((x) => {
      x.rooms = x.rooms.filter((r) => r.key !== "dining" && r.key !== "bed3");
      room(x, "corridor").doorsTo = [];
    });
    expect(find(d, "unexplained-space")?.message).toMatch(
      /29 m² of the 99 m² shell is not in any room, which is more than walls and circulation account for/,
    );
  });
});

describe("what a room has to be to be that room", () => {
  it("refuses an 8 m² bedroom, which is the room the first run drew three of", () => {
    const d = flat((x) => {
      room(x, "bed1").rect.w = 2100;
    });
    expect(find(d, "too-small")?.message).toMatch(
      /Bedroom 1 is 8.0 m² and 2100 mm across; a bedroom needs 9 m² and 2400 mm/,
    );
  });

  it("refuses a 14 m² toilet, which is the room the second run drew", () => {
    const d = flat((x) => {
      room(x, "bath").purpose = "toilet";
    });
    expect(find(d, "too-large")?.message).toMatch(
      /Bathroom is 7.2 m², which is not a generous toilet but a mistake; 4.0 m² is plenty in a building this size/,
    );
  });

  it("refuses a corridor nobody can walk down", () => {
    const d = flat((x) => {
      room(x, "corridor").rect.d = 800;
    });
    expect(find(d, "corridor-narrow")?.message).toMatch(/Corridor is 800 mm wide and circulation needs 1000/);
  });

  it("takes its numbers from the pack, so a user's own pack moves them", () => {
    const strict = { ...CORE_RULES, facts: { ...CORE_RULES.facts, bedroomMinM2: 14 } };
    const problems = checkLayout(flat(), strict).problems.filter((p) => p.code === "design.too-small");
    expect(problems).toHaveLength(3);
    expect(problems[0]?.message).toMatch(/a bedroom needs 14 m²/);
  });
});

describe("the programme: what a home has to have", () => {
  it("names the room a dwelling is missing", () => {
    const d = flat((x) => {
      x.rooms = x.rooms.filter((r) => r.key !== "kitchen");
      room(x, "hall").doorsTo = ["lobby", "corridor"];
    });
    expect(find(d, "missing-room")?.message).toMatch(/a home needs a kitchen, and this design has none/);
  });

  it("accepts a toilet where there is no bathroom, because either will do", () => {
    const d = flat((x) => {
      room(x, "bath").purpose = "toilet";
      room(x, "bath").rect = { x: 6200, y: 5200, w: 1900, d: 2000 };
    });
    expect(codes(d)).not.toContain("design.missing-room");
  });

  it("catches a flat with no way in", () => {
    const d = flat((x) => {
      room(x, "lobby").doorsTo = ["hall"];
    });
    expect(errors(d)).toContain("design.no-way-in");
  });

  it("asks nothing of a workplace that a home needs", () => {
    const d = flat((x) => {
      x.kind = "workplace";
      x.rooms = x.rooms.filter((r) => r.key !== "kitchen");
      room(x, "hall").doorsTo = ["lobby", "corridor"];
    });
    expect(codes(d)).not.toContain("design.missing-room");
  });
});

describe("doors", () => {
  it("catches a door between rooms that barely touch", () => {
    const d = flat((x) => {
      room(x, "kitchen").doorsTo = ["hall", "dining"];
      room(x, "dining").rect.y = 3800; // now only 200 mm of the kitchen's edge is beside it
    });
    expect(find(d, "door-without-wall")?.message).toMatch(
      /Kitchen and Dining have a door between them but share only \d+ mm of wall/,
    );
  });

  it("catches a door to a room that does not exist", () => {
    const d = flat((x) => {
      room(x, "hall").doorsTo.push("study");
    });
    expect(find(d, "door-to-nowhere")?.message).toMatch(/Hall has a door to "study", which is not a room/);
  });

  it("catches a bedroom you get to through another bedroom", () => {
    const d = flat((x) => {
      room(x, "bed2").doorsTo = ["bed1"];
      room(x, "bed1").doorsTo = ["corridor", "bed2"];
    });
    expect(find(d, "private-to-private")?.message).toMatch(
      /Bedroom 1 opens into Bedroom 2; one bedroom should not be the way into another/,
    );
  });

  it("catches a bathroom opening into a kitchen", () => {
    const d = flat((x) => {
      room(x, "bath").rect = { x: 6000, y: 4100, w: 2400, d: 1000 };
      room(x, "bath").doorsTo = ["kitchen"];
    });
    expect(find(d, "wet-into-kitchen")?.message).toMatch(/must not open into a kitchen/);
  });

  it("catches a front door on a room in the middle of the plan", () => {
    const d = flat((x) => {
      room(x, "corridor").doorsTo = ["outside"];
    });
    expect(find(d, "door-outside-inside")?.message).toMatch(
      /Corridor has a door to the outside but no wall on the outside/,
    );
  });
});

describe("getting there from the front door", () => {
  it("catches a room with no door at all", () => {
    const d = flat((x) => {
      room(x, "bed3").doorsTo = [];
    });
    expect(find(d, "unreachable")?.message).toMatch(/Bedroom 3 has no door at all/);
  });

  it("catches a room you can only reach through a bedroom", () => {
    const d = flat((x) => {
      room(x, "bath").doorsTo = ["bed3"];
      room(x, "bed3").doorsTo = ["corridor", "bath"];
    });
    expect(find(d, "unreachable")?.message).toMatch(
      /Bathroom can only be reached by walking through a bedroom or a bathroom/,
    );
  });

  it("lets a route pass through the hall, which is what a hall is for", () => {
    const d = flat((x) => {
      room(x, "corridor").doorsTo = [];
      room(x, "hall").doorsTo = ["lobby", "corridor", "kitchen"];
    });
    expect(codes(d)).not.toContain("design.unreachable");
  });
});

describe("windows", () => {
  it("catches a window on a room with no outside wall", () => {
    const d = flat((x) => {
      room(x, "corridor").window = true;
    });
    expect(find(d, "window-inside")?.message).toMatch(
      /Corridor wants a window but is in the middle of the plan/,
    );
  });

  it("warns about a room people live in with no window, and says whether one is possible", () => {
    const d = flat((x) => {
      room(x, "bed1").window = false;
    });
    const p = find(d, "no-window");
    expect(p?.severity).toBe("warning");
    expect(p?.hint).toBe("it has an outside wall; set window: true");
    expect(layoutIsBuildable(checkLayout(d, CORE_RULES))).toBe(true);
  });

  it("says nothing about a bathroom or a corridor without one", () => {
    expect(codes(flat())).not.toContain("design.no-window");
  });
});

describe("the score (ADR-024 D4)", () => {
  it("is one for a design with nothing against it", () => {
    expect(checkLayout(flat(), CORE_RULES).score).toBe(1);
  });

  it("falls further for an error than for a warning", () => {
    const warned = flat((x) => {
      room(x, "bed1").window = false;
    });
    const errored = flat((x) => {
      room(x, "bed1").rect.w = 2100;
    });
    const a = checkLayout(warned, CORE_RULES);
    const b = checkLayout(errored, CORE_RULES);
    expect(a.score).toBeLessThan(1);
    expect(b.score).toBeLessThan(a.score);
    expect(a.problems.every((p) => p.severity === "warning")).toBe(true);
  });

  it("ranks two broken designs by how broken they are", () => {
    const one = flat((x) => {
      room(x, "bed1").rect.w = 2100;
    });
    const many = flat((x) => {
      room(x, "bed1").rect.w = 2100;
      room(x, "bed2").rect.w = 2100;
      room(x, "bed3").doorsTo = [];
    });
    expect(checkLayout(many, CORE_RULES).score).toBeLessThan(checkLayout(one, CORE_RULES).score);
  });

  it("stops at zero rather than going negative, so two hopeless designs are not ranked", () => {
    const hopeless = flat((x) => {
      for (const r of x.rooms) {
        r.rect.w = 900;
        r.rect.d = 900;
        r.doorsTo = [];
      }
    });
    expect(checkLayout(hopeless, CORE_RULES).score).toBe(0);
  });
});

describe("a room against the number of people it says it holds", () => {
  // The drawing that prompted this: an office for a hundred people whose open workspace was
  // 131.2 m2, which is thirteen desks. The prompt had been saying 10 m2 a person all along and
  // nothing compared the two, so nothing refused it.
  const office = (m2PerRoom: number, capacity: number) =>
    DesignSchema.parse({
      brief: "an office",
      kind: "workplace",
      levelId: null,
      shell: { x: 0, y: 0, w: 40000, d: 20000, wallMm: 230, interiorWallMm: 115 },
      rooms: [
        {
          key: "open",
          name: "Open workspace",
          purpose: "open-office",
          rect: { x: 230, y: 230, w: Math.round((m2PerRoom * 1e6) / 10000), d: 10000 },
          doorsTo: ["hall"],
          window: true,
          capacity,
        },
        {
          key: "hall",
          name: "Hallway",
          purpose: "corridor",
          rect: { x: 230, y: 10500, w: 39540, d: 1500 },
          doorsTo: ["outside"],
        },
      ],
      circulation: ["hall"],
      assumptions: [],
    });

  const codes = (d: Design) =>
    checkLayout(d, null)
      .problems.filter((p) => p.severity === "error")
      .map((p) => p.code);

  it("refuses a hundred desks in a hundred and thirty square metres", () => {
    expect(codes(office(131.2, 100))).toContain("design.too-small-for-capacity");
  });

  it("accepts the same hundred people in a thousand", () => {
    expect(codes(office(1000, 100))).not.toContain("design.too-small-for-capacity");
  });

  it("says nothing when the room never claimed a number", () => {
    expect(codes(office(131.2, 0))).not.toContain("design.too-small-for-capacity");
  });

  it("offers the number it would believe, so the model can fix it either way", () => {
    const hint = checkLayout(office(131.2, 100), null).problems.find(
      (p) => p.code === "design.too-small-for-capacity",
    )?.hint;
    expect(hint).toContain("16");
  });
});

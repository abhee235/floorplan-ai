// A plan the architect drew itself, put through the checker and the builder (ADR-028).
//
// The fixture is the office in the rendering the owner brought: enclosed rooms on all four sides of
// the building, an open workspace in the middle that is also the only circulation, an open cafe, a
// glass executive suite, glass meeting rooms and pods, and a glazed west side. The packer cannot
// produce this shape; the point of the decision is that nothing else should refuse it either.
import { inflateSync } from "node:zlib";
import { AV_CORE, CORE_RULES, checkLayout } from "@fpv/catalog";
import { Design, type DesignInput } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { wallBetween } from "../src/build-design.js";
import { PLAN_COLOURS } from "../src/plan-picture.js";
import { LOOK_HEADINGS, lookMissing } from "../src/tools/design.js";
import { harness } from "./helpers.js";

const W = 42000;
const D = 32000;
type Extra = Partial<Omit<DesignInput["rooms"][number], "key" | "name" | "purpose" | "rect" | "doorsTo">>;
const r = (
  key: string,
  name: string,
  purpose: string,
  x: number,
  y: number,
  w: number,
  d: number,
  doorsTo: string[],
  extra: Extra = {},
): DesignInput["rooms"][number] => ({
  key,
  name,
  purpose: purpose as never,
  rect: { x, y, w, d },
  doorsTo,
  ...extra,
});

/** The rendering, as rectangles. y is north; the entrance is on the south side. */
export const RENDERED_OFFICE: DesignInput = {
  brief:
    "the office in the rendering: rooms on every side, desks in the middle, open floor as the circulation",
  kind: "workplace",
  levelId: null,
  shell: {
    x: 0,
    y: 0,
    w: W,
    d: D,
    wallMm: 230,
    interiorWallMm: 115,
    facade: { west: "glazed", north: "windows", south: "windows", east: "windows" },
  },
  rooms: [
    r("open", "Open workspace", "open-office", 6345, 6345, 29310, 19310, [], {
      capacity: 90,
      enclosure: "open",
    }),
    r("mr3", "Meeting Room 3", "meeting", 230, 6345, 6000, 6000, ["open"], {
      capacity: 10,
      enclosure: "glass",
    }),
    r("mr2", "Meeting Room 2", "meeting", 230, 12460, 6000, 5000, ["open"], {
      capacity: 6,
      enclosure: "glass",
    }),
    r("mr1", "Meeting Room 1", "meeting", 230, 17575, 6000, 8080, ["open"], {
      capacity: 8,
      enclosure: "glass",
    }),
    r("exec", "Executive suite", "boardroom", 230, 25770, 10000, 6000, ["open"], {
      capacity: 8,
      enclosure: "glass",
    }),
    r("server", "IT server room", "utility", 12000, 25770, 9000, 6000, ["open"]),
    r("cafe", "Pantry and cafeteria", "cafeteria", 22115, 25770, 13540, 6000, [], {
      capacity: 40,
      window: true,
      enclosure: "open",
    }),
    r("svc", "Service", "storage", 35770, 25770, 6000, 6000, ["breakout"]),
    r("breakout", "Entertainment and breakout", "other", 35770, 12460, 6000, 13195, ["open"], {
      window: true,
      enclosure: "glass",
    }),
    r("print", "Print and store", "storage", 35770, 6345, 6000, 6000, ["open"]),
    r("lounge", "Waiting lounge", "other", 230, 230, 9000, 6000, [], { window: true, enclosure: "open" }),
    r("reception", "Reception", "reception", 13000, 230, 9000, 6000, ["outside", "open"], {
      window: true,
      enclosure: "glass",
    }),
    r("pod1", "Focus pod 1", "focus", 26000, 3230, 2400, 3000, ["open"], { capacity: 1, enclosure: "glass" }),
    r("pod2", "Focus pod 2", "focus", 28515, 3230, 2400, 3000, ["open"], { capacity: 1, enclosure: "glass" }),
    r("wc", "Restrooms", "restroom", 31000, 230, 10770, 6000, ["open"]),
  ],
  circulation: [],
  assumptions: [],
};

describe("the rendering, drawn by hand (ADR-028 D7)", () => {
  it("passes the checker: the shape is not the checker's business", () => {
    const report = checkLayout(Design.parse(RENDERED_OFFICE), CORE_RULES);
    expect(report.problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(report.score).toBeGreaterThanOrEqual(0.9);
    // an open cafe with no door is reached across the open floor; a walled one would not be
    const walled = Design.parse({
      ...RENDERED_OFFICE,
      rooms: RENDERED_OFFICE.rooms.map((x) =>
        x.key === "cafe" ? { ...x, enclosure: "walled" as const } : x,
      ),
    });
    expect(
      checkLayout(walled, CORE_RULES).problems.find((p) => p.code === "design.unreachable")?.entityId,
    ).toBe("cafe");
  });

  it("builds exactly: glass where the design says, no wall where both sides are open, both openings on the reception", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const checked = await h.ok<{ designId: string; buildable: boolean }>("check_design", {
      design: RENDERED_OFFICE,
    });
    expect(checked.result.buildable).toBe(true);
    const built = await h.ok<{ walls: number; doors: number; windows: number; unplaced: string[] }>(
      "build_design",
      {
        designId: checked.result.designId,
      },
    );
    expect(built.result.unplaced).toEqual([]);
    const p = h.ctx.store.project;
    const kinds = Object.fromEntries(
      ["exterior", "interior", "glass"].map((k) => [k, p.walls.filter((w) => w.kind === k).length]),
    );
    expect(kinds.glass).toBeGreaterThanOrEqual(4);
    // the west side is one glass wall with no windows punched in it
    const west = p.walls.filter((w) => w.start.x === 115 && w.end.x === 115);
    expect(west.length).toBeGreaterThanOrEqual(1);
    expect(west.every((w) => w.kind === "glass")).toBe(true);
    const westIds = new Set(west.map((w) => w.id));
    expect(p.openings.filter((o) => o.kind === "window" && westIds.has(o.wallId))).toHaveLength(0);
    // no wall on the line between the open workspace and the open cafe
    const cafeSouth = p.walls.filter(
      (w) =>
        Math.abs(w.start.y - 25712) <= 60 &&
        Math.abs(w.end.y - 25712) <= 60 &&
        Math.min(w.start.x, w.end.x) < 30000 &&
        Math.max(w.start.x, w.end.x) > 26000,
    );
    expect(cafeSouth).toHaveLength(0);
    // the reception has its entrance and its window, side by side on the south wall
    const south = p.walls.find((w) => w.start.y === 115 && w.end.y === 115 && w.kind === "exterior");
    const onSouth = p.openings.filter((o) => o.wallId === south?.id);
    expect(onSouth.filter((o) => o.kind === "door")).toHaveLength(1);
    expect(onSouth.filter((o) => o.kind === "window").length).toBeGreaterThanOrEqual(1);
    expect(built.result.doors).toBeGreaterThanOrEqual(12);
  });
});

describe("what stands between two rooms, by rule (ADR-028 D3)", () => {
  const room = (purpose: string, enclosure?: "walled" | "glass" | "open") =>
    Design.parse({
      ...RENDERED_OFFICE,
      rooms: [
        {
          key: "a",
          name: "A",
          purpose,
          rect: { x: 0, y: 0, w: 3000, d: 3000 },
          doorsTo: [],
          ...(enclosure ? { enclosure } : {}),
        },
      ],
    }).rooms[0] as Parameters<typeof wallBetween>[0];

  it("solid for a service room, glass for a glass box, nothing between two open zones", () => {
    expect(wallBetween(room("meeting", "glass"), room("open-office", "open"))).toBe("glass");
    expect(wallBetween(room("open-office", "open"), room("meeting", "glass"))).toBe("glass");
    expect(wallBetween(room("open-office", "open"), room("cafeteria", "open"))).toBeNull();
    expect(wallBetween(room("restroom", "glass"), room("meeting", "glass"))).toBe("interior");
    expect(wallBetween(room("open-office", "open"), null)).toBeNull();
    expect(wallBetween(room("meeting", "glass"), null)).toBe("glass");
    expect(wallBetween(room("other"), room("open-office", "open"))).toBe("interior");
    // the older flag still reads as glass
    expect(wallBetween(room("meeting"), room("other"))).toBe("interior");
  });
});

describe("query_design (ADR-028 D8)", () => {
  it("answers the architect's own questions of its design", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const checked = await h.ok<{ designId: string }>("check_design", { design: RENDERED_OFFICE });
    const far = await h.ok<{ count: number; rows: { key: string; values: Record<string, unknown> }[] }>(
      "query_design",
      {
        designId: checked.result.designId,
        where: "purpose == 'open-office' and gapNorth > 5000 and gapSouth > 5000",
        select: ["area", "w / d", "gapNorth", "enclosure"],
      },
    );
    expect(far.result.count).toBe(1);
    expect(far.result.rows[0]).toMatchObject({
      key: "open",
      values: { area: 565.98, gapNorth: 6345, enclosure: "open" },
    });
    expect(far.result.rows[0]?.values["w / d"]).toBeCloseTo(1.52, 2);
    const touching = await h.ok<{ rows: { key: string }[] }>("query_design", {
      designId: checked.result.designId,
      where: "has(touches, 'open')",
      select: ["name"],
    });
    expect(touching.result.rows.map((x) => x.key)).toContain("cafe");
    expect(touching.result.rows.map((x) => x.key)).not.toContain("svc");
    const wrong = await h.ok<{ count: number; errors: string[] }>("query_design", {
      designId: checked.result.designId,
      where: "daylight > 3",
    });
    expect(wrong.result.count).toBe(0);
    expect(wrong.result.errors[0]).toContain('unknown name "daylight"');
  });
});

describe("revise_design (ADR-028 D10)", () => {
  it("patches a checked design by key and checks it again, so the model never re-sends the page", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    // the run's failure: a sound plan with no doorsTo on any room
    const noDoors = {
      ...RENDERED_OFFICE,
      rooms: RENDERED_OFFICE.rooms.map((r) => ({ ...r, doorsTo: [], enclosure: "walled" as const })),
    };
    const first = await h.ok<{ designId: string; buildable: boolean; errors: { code: string }[] }>(
      "check_design",
      {
        design: noDoors,
      },
    );
    expect(first.result.buildable).toBe(false);
    // the door named once, and the rooms the reception cannot reach named as well: hiding them
    // until the door was added made a plan with twelve errors read as two
    const codes = first.result.errors.map((e) => e.code);
    expect(codes.filter((c) => c === "design.no-way-in")).toHaveLength(1);
    expect(codes.filter((c) => c === "design.unreachable").length).toBeGreaterThan(5);
    const patch = RENDERED_OFFICE.rooms.map((r) => ({
      key: r.key,
      doorsTo: r.doorsTo,
      ...(r.enclosure ? { enclosure: r.enclosure } : {}),
    }));
    const second = await h.ok<{ designId: string; buildable: boolean; errors: unknown[] }>("revise_design", {
      designId: first.result.designId,
      rooms: patch,
    });
    expect(second.result.buildable).toBe(true);
    expect(second.result.errors).toEqual([]);
    expect(second.result.designId).not.toBe(first.result.designId);
    // and the revised design is the one build_design draws
    const built = await h.ok<{ walls: number; doors: number }>("build_design", {
      designId: second.result.designId,
    });
    expect(built.result.doors).toBeGreaterThanOrEqual(12);
    // a wrong key names the right ones
    const wrong = await h.call("revise_design", {
      designId: second.result.designId,
      rooms: [{ key: "lobby", window: true }],
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.hint).toContain("reception");
  });
});

describe("the obvious door is assumed (ADR-028 D10)", () => {
  it("gives a room with no doors one onto the corridor it touches, and says so", async () => {
    // the live run's plan, rooms and corridor only, with not a door written
    const design = {
      brief: "the run's plan",
      kind: "workplace" as const,
      shell: { x: 0, y: 0, w: 20000, d: 12000 },
      rooms: [
        { key: "meet1", name: "Meeting 1", purpose: "meeting", rect: { x: 0, y: 0, w: 5000, d: 5000 } },
        { key: "meet2", name: "Meeting 2", purpose: "meeting", rect: { x: 5115, y: 0, w: 5000, d: 5000 } },
        {
          key: "corridor",
          name: "Corridor",
          purpose: "corridor",
          rect: { x: 0, y: 5115, w: 20000, d: 1500 },
          doorsTo: ["outside"],
        },
        {
          key: "desks",
          name: "Desks",
          purpose: "open-office",
          rect: { x: 0, y: 6730, w: 14000, d: 5270 },
          enclosure: "open",
        },
        { key: "wc", name: "Toilets", purpose: "restroom", rect: { x: 14115, y: 6730, w: 5885, d: 5270 } },
      ],
    };
    const h = harness(undefined, { rules: AV_CORE });
    const r = await h.ok<{ buildable: boolean; errors: { code: string }[] }>("check_design", { design });
    expect(r.result.errors).toEqual([]);
    expect(r.result.buildable).toBe(true);
    expect(
      r.warnings.some((w) => w.includes("Meeting 1 opens onto Corridor") && w.includes("Toilets opens onto")),
    ).toBe(true);
  });
});

describe("a re-sent design is told what changed (ADR-028 D10)", () => {
  it("says nothing moved and the errors are the same, and names revise_design", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    // the run's design, in small: an overlap the model said it would fix and did not
    const design = {
      brief: "a floor",
      kind: "workplace" as const,
      shell: { x: 0, y: 0, w: 20000, d: 12000 },
      rooms: [
        {
          key: "hall",
          name: "Hall",
          purpose: "corridor",
          rect: { x: 0, y: 5000, w: 20000, d: 1500 },
          doorsTo: ["outside"],
        },
        {
          key: "pod",
          name: "Pod",
          purpose: "focus",
          rect: { x: 0, y: 4000, w: 3000, d: 3000 },
          enclosure: "glass" as const,
        },
        {
          key: "desks",
          name: "Desks",
          purpose: "open-office",
          rect: { x: 0, y: 6615, w: 20000, d: 5385 },
          enclosure: "open" as const,
        },
      ],
    };
    const first = await h.ok<{ designId: string; errors: { code: string }[] }>("check_design", { design });
    expect(first.result.errors.map((e) => e.code)).toContain("design.rooms-overlap");
    // the same design again, with the enclosure dropped as the model dropped it
    const again = {
      ...design,
      rooms: design.rooms.map(({ enclosure: _e, ...r }) => r),
    };
    const second = await h.ok("check_design", { design: again });
    const note = second.warnings.find((w) => w.startsWith(`compared with ${first.result.designId}`));
    expect(note).toBeDefined();
    expect(note).toContain("changed the enclosure of");
    expect(note).not.toContain("moved");
    expect(note).toContain("still here, word for word");
    expect(note).toContain(`revise_design { designId: "${first.result.designId}"`);
  });
});

describe("the checker says why a room cannot be reached (ADR-028 D10)", () => {
  it("tells a room cut off from the entrance from one behind a bedroom, and one touching nothing", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const design = {
      brief: "a floor",
      kind: "workplace" as const,
      shell: { x: 0, y: 0, w: 20000, d: 14000 },
      rooms: [
        {
          key: "hall",
          name: "Hall",
          purpose: "corridor",
          rect: { x: 0, y: 0, w: 20000, d: 1500 },
          doorsTo: ["outside"],
        },
        // opens onto a corridor nothing reaches
        {
          key: "back",
          name: "Back corridor",
          purpose: "corridor",
          rect: { x: 0, y: 12500, w: 20000, d: 1500 },
          enclosure: "walled" as const,
        },
        {
          key: "desks",
          name: "Desks",
          purpose: "open-office",
          rect: { x: 0, y: 6000, w: 20000, d: 6385 },
          doorsTo: ["back"],
          // walled on purpose: this case is a room behind a door, which an open office is not by default
          enclosure: "walled" as const,
        },
        // touches nothing it could have a door onto
        {
          key: "pod",
          name: "Pod",
          purpose: "focus",
          rect: { x: 0, y: 3500, w: 2500, d: 2000 },
          enclosure: "glass" as const,
        },
      ],
    };
    const r = await h.ok<{ errors: { code: string; entityId: string; message: string; hint: string }[] }>(
      "check_design",
      { design },
    );
    const by = (k: string) =>
      r.result.errors.find((e) => e.code === "design.unreachable" && e.entityId === k);
    expect(by("desks")?.message).toContain("is cut off from the entrance: it opens onto back");
    expect(by("desks")?.message).not.toContain("bedroom");
    // the move that would reach shared floor, not "touches no corridor or open room"
    expect(by("pod")?.hint).toContain("1885 mm from hall");
    expect(by("pod")?.hint).toContain('revise_design rooms: [{ key: "pod"');
  });

  it("revise_design says when a change changed nothing, and refuses one that changes none", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const first = await h.ok<{ designId: string }>("check_design", { design: RENDERED_OFFICE });
    // one field already right and one that moves it: a warning, and the move lands
    const some = await h.ok("revise_design", {
      designId: first.result.designId,
      rooms: [
        { key: "pod1", rect: { x: 26000, y: 3230, w: 2400, d: 3000 } },
        { key: "pod2", rect: { x: 28515, y: 3230, w: 2400, d: 2800 } },
      ],
    });
    expect(some.warnings.some((w) => w.includes("changed nothing: pod1.rect"))).toBe(true);
    // nothing but fields that are already what they say: refused, and costs no round
    const none = await h.call("revise_design", {
      designId: first.result.designId,
      rooms: [{ key: "pod1", rect: { x: 26000, y: 3230, w: 2400, d: 3000 } }],
    });
    expect(none.ok).toBe(false);
  });
});

describe("a plan with no entrance is still checked for hanging together (ADR-028 D10)", () => {
  it("names the rooms cut off from the reception before the door exists", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const design = {
      brief: "a floor",
      kind: "workplace" as const,
      shell: { x: 0, y: 0, w: 20000, d: 12000 },
      rooms: [
        {
          key: "reception",
          name: "Reception",
          purpose: "reception",
          rect: { x: 0, y: 0, w: 5000, d: 4000 },
          doorsTo: ["hall"],
        },
        { key: "hall", name: "Hall", purpose: "corridor", rect: { x: 5115, y: 0, w: 1500, d: 12000 } },
        // on the far side of a room that opens onto nothing
        {
          key: "store",
          name: "Store",
          purpose: "storage",
          rect: { x: 15000, y: 0, w: 5000, d: 4000 },
          doorsTo: ["back"],
        },
        {
          key: "back",
          name: "Back room",
          purpose: "other",
          rect: { x: 15000, y: 4115, w: 5000, d: 4000 },
          doorsTo: ["store"],
        },
      ],
    };
    const r = await h.ok<{ errors: { code: string; entityId: string | null; message: string }[] }>(
      "check_design",
      { design },
    );
    expect(r.result.errors.some((e) => e.code === "design.no-way-in")).toBe(true);
    const cut = r.result.errors.filter((e) => e.code === "design.unreachable").map((e) => e.entityId);
    expect(cut).toContain("store");
    expect(cut).not.toContain("hall");
    expect(r.result.errors.find((e) => e.entityId === "store")?.message).toContain("cut off from Reception");
  });
});

describe("a design is handed on, not thrown away (ADR-028 D10)", () => {
  it("gives the next architect the closest design and its errors, and says so to the designer", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const seen: { brief: string; from?: { designId: string; errors: readonly string[] } }[] = [];
    h.ctx.subagent = {
      async run(request) {
        seen.push(request);
        return {
          designId: null,
          text: "ran out of rounds",
          unresolved: [
            "Focus Booth 6 and South Corridor have a door between them but share only 0 mm of wall",
          ],
          lastDesignId: "design_x",
          steps: 10,
          rounds: 10,
          reason: "done",
        };
      },
    };
    const first = await h.ok<{ lastDesignId: string | null }>("design_layout", { brief: "an office" });
    expect(first.result.lastDesignId).toBe("design_x");
    expect(first.warnings.some((w) => w.includes('Call design_layout again with designId: "design_x"'))).toBe(
      true,
    );
    expect(first.warnings.some((w) => w.includes("do not draw the building by hand"))).toBe(true);

    // continue from a design this session checked
    const checked = await h.ok<{ designId: string }>("check_design", {
      design: { ...RENDERED_OFFICE, rooms: RENDERED_OFFICE.rooms.filter((r) => r.key !== "reception") },
    });
    await h.call("design_layout", { brief: "an office", designId: checked.result.designId });
    expect(seen[1]?.from?.designId).toBe(checked.result.designId);
    expect(seen[1]?.from?.errors.some((e) => e.includes("no room has a door to the outside"))).toBe(true);
  });
});

/** Three glass meeting rooms in a row off a corridor, desks and a toilet across it, every side unsaid. */
const GLASS_ROW: DesignInput = {
  brief: "a small glass office",
  kind: "workplace",
  levelId: null,
  shell: { x: 0, y: 0, w: 20000, d: 10000, wallMm: 230, interiorWallMm: 115 },
  rooms: [
    r("desks", "Desks", "open-office", 230, 230, 13000, 2885, [], { enclosure: "open", capacity: 6 }),
    r("wc", "Toilets", "restroom", 13345, 230, 6425, 2885, ["hall"]),
    r("hall", "Corridor", "corridor", 230, 3230, 19540, 1500, ["outside"]),
    r("m1", "Meeting 1", "meeting", 230, 4845, 6000, 4925, ["hall"], { enclosure: "glass", capacity: 6 }),
    r("m2", "Meeting 2", "meeting", 6345, 4845, 6000, 4925, ["hall"], { enclosure: "glass", capacity: 6 }),
    r("m3", "Meeting 3", "meeting", 12460, 4845, 7310, 4925, ["hall"], { enclosure: "glass", capacity: 6 }),
  ],
  circulation: [],
  assumptions: [],
};

describe("glass faces the floor, and a screen never hangs on glass or a window (ADR-028 D12)", () => {
  it("a workplace is glazed unless it says otherwise, a home has windows, and a revision keeps the other sides", async () => {
    expect(Design.parse(GLASS_ROW).shell.facade).toEqual({
      north: "glazed",
      south: "glazed",
      east: "glazed",
      west: "glazed",
    });
    expect(Design.parse({ ...GLASS_ROW, kind: "dwelling" }).shell.facade.north).toBe("windows");
    const h = harness(undefined, { rules: AV_CORE });
    const first = await h.ok<{ designId: string }>("check_design", { design: GLASS_ROW });
    const revised = await h.ok<{ designId: string }>("revise_design", {
      designId: first.result.designId,
      shell: { facade: { north: "windows" } },
    });
    // the built building says it: north has windows now, the other three sides are still glass
    await h.ok("build_design", { designId: revised.result.designId });
    const p = h.ctx.store.project;
    const onLine = (y: number) => p.walls.filter((w) => w.start.y === y && w.end.y === y);
    expect(onLine(9885).every((w) => w.kind === "exterior")).toBe(true);
    expect(onLine(115).some((w) => w.kind === "glass")).toBe(true);
  });

  it("parts two glass rooms with plaster, keeps a toilet walled on a glazed side, and hangs every screen on plaster", async () => {
    const room = (purpose: string, enclosure?: "walled" | "glass" | "open") =>
      Design.parse({
        ...GLASS_ROW,
        rooms: [
          {
            key: "a",
            name: "A",
            purpose,
            rect: { x: 230, y: 230, w: 3000, d: 3000 },
            doorsTo: [],
            ...(enclosure ? { enclosure } : {}),
          },
        ],
      }).rooms[0] as Parameters<typeof wallBetween>[0];
    expect(wallBetween(room("meeting", "glass"), room("meeting", "glass"))).toBe("interior");
    expect(wallBetween(room("meeting", "glass"), room("corridor"))).toBe("glass");
    expect(wallBetween(room("meeting", "glass"), room("other", "walled"))).toBe("interior");

    const h = harness(undefined, { rules: AV_CORE });
    const checked = await h.ok<{ designId: string; errors: unknown[] }>("check_design", {
      design: GLASS_ROW,
    });
    expect(checked.result.errors).toEqual([]);
    const built = await h.ok<{ rooms: { id: string; name: string | null }[] }>("build_design", {
      designId: checked.result.designId,
    });
    const p0 = h.ctx.store.project;
    // the south side is glass except behind the toilets, which have a solid wall
    const south = p0.walls.filter((w) => w.start.y === 115 && w.end.y === 115);
    const solid = south.filter((w) => w.kind === "exterior");
    expect(solid).toHaveLength(1);
    const xs = solid.flatMap((w) => [w.start.x, w.end.x]);
    expect(Math.min(...xs)).toBeLessThanOrEqual(13345);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(19770);
    expect(south.some((w) => w.kind === "glass")).toBe(true);

    for (const name of ["Meeting 1", "Meeting 2", "Meeting 3"]) {
      const id = built.result.rooms.find((x) => x.name === name)?.id;
      const f = await h.ok<{ counts: Record<string, number>; items: { id: string; category: string }[] }>(
        "furnish_room",
        { roomId: id },
      );
      expect(f.result.counts.display).toBe(1);
      const p = h.ctx.store.project;
      // the screen and the bar under it; a booking panel beside the door is glass-mounted as a rule
      const screens = new Set(
        f.result.items.filter((i) => i.category === "display" || i.category === "video-bar").map((i) => i.id),
      );
      const onWalls = p.items.filter((i) => screens.has(i.id) && i.mount.kind === "wall");
      expect(onWalls.length).toBeGreaterThan(0);
      for (const item of onWalls) {
        const wall = p.walls.find((w) => w.id === item.mount.targetId);
        expect(wall?.kind).not.toBe("glass");
        expect(p.openings.some((o) => o.wallId === wall?.id && o.kind === "window")).toBe(false);
      }
    }
  });

  it("a solid side takes no window, and the checker says so before the builder does", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const design = {
      brief: "a room against its neighbours",
      kind: "workplace" as const,
      shell: {
        x: 0,
        y: 0,
        w: 8000,
        d: 6000,
        facade: {
          north: "solid" as const,
          east: "solid" as const,
          west: "solid" as const,
          south: "solid" as const,
        },
      },
      rooms: [
        {
          key: "room",
          name: "Meeting",
          purpose: "meeting",
          capacity: 6,
          rect: { x: 230, y: 230, w: 7540, d: 5540 },
          doorsTo: ["outside"],
          window: true,
        },
      ],
    };
    const r1 = await h.ok<{ warnings: { code: string }[]; designId: string }>("check_design", { design });
    expect(r1.result.warnings.map((w) => w.code)).toContain("design.window-solid");
    const built = await h.ok<{ windows: number }>("build_design", { designId: r1.result.designId });
    expect(built.result.windows).toBe(0);
    expect(built.warnings.some((w) => w.includes("outside walls take none"))).toBe(true);
  });
});

/** The pixels of a PNG this repo wrote: RGB, one IDAT, no filter on any row. */
function pixels(b64: string) {
  const png = Buffer.from(b64, "base64");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idat: Buffer[] = [];
  for (let off = 8; off < png.length; ) {
    const len = png.readUInt32BE(off);
    if (png.toString("ascii", off + 4, off + 8) === "IDAT") idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const where = (c: readonly number[]) => {
    const out: { x: number; y: number }[] = [];
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const i = y * (width * 3 + 1) + 1 + x * 3;
        if (raw[i] === c[0] && raw[i + 1] === c[1] && raw[i + 2] === c[2]) out.push({ x, y });
      }
    return out;
  };
  return { width, height, where };
}

describe("a design is looked at before it is called done (ADR-028 D11)", () => {
  it("draws a checked design as build_design will: glass on the glazed west, the entrance green on the south", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const checked = await h.ok<{ designId: string }>("check_design", { design: RENDERED_OFFICE });
    const look = await h.ok<{
      caption: string;
      ask: string;
      legend: string[];
      images: { pngBase64: string }[];
    }>("preview_design", { designId: checked.result.designId });
    expect(look.result.legend).toHaveLength(RENDERED_OFFICE.rooms.length);
    expect(look.result.caption).toContain("Rooms by number: 1 open");
    expect(look.result.ask).toContain(`LOOK ${checked.result.designId}`);
    // nothing is drawn into the project: a preview is a scratch copy
    expect(h.ctx.store.project.walls).toHaveLength(0);
    const img = pixels(look.result.images[0]?.pngBase64 ?? "");
    const green = img.where(PLAN_COLOURS.entrance);
    expect(green.length).toBeGreaterThan(0);
    expect(green.every((q) => q.y > img.height * 0.8)).toBe(true);
    const blue = img.where(PLAN_COLOURS.glass);
    expect(blue.some((q) => q.x < img.width * 0.06 && q.y > img.height * 0.3 && q.y < img.height * 0.7)).toBe(
      true,
    );
    expect(img.where(PLAN_COLOURS.door).length).toBeGreaterThan(0);
    expect(img.where(PLAN_COLOURS.window).length).toBeGreaterThan(0);
    expect(img.where(PLAN_COLOURS.open).length).toBeGreaterThan(0);
  });

  it("walks the design from the entrance, says what is along each side, and where each screen goes", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const checked = await h.ok<{
      walk: {
        entrances: string[];
        routes: Record<string, string>;
        through: string[];
        unreached: string[];
        sides: Record<string, { facade: string; enclosed: number; along: string[] }>;
        displays: Record<string, string>;
      };
    }>("check_design", { design: RENDERED_OFFICE });
    const walk = checked.result.walk;
    expect(walk.entrances).toEqual(["reception"]);
    expect(walk.routes.mr1).toBe("reception > open > mr1");
    expect(walk.routes.svc).toBe("reception > open > breakout > svc");
    expect(walk.through).toEqual(["svc through breakout"]);
    expect(walk.unreached).toEqual([]);
    expect(walk.sides.west?.facade).toBe("glazed");
    expect(walk.sides.west?.along).toEqual(["lounge (open)", "mr3", "mr2", "mr1", "exec"]);
    expect(walk.sides.north?.enclosed).toBeGreaterThan(0.5);
    // three glass meeting rooms in a row: plaster between them, which is where their screens go
    for (const k of ["mr1", "mr2", "mr3"]) expect(walk.displays[k], k).toMatch(/plaster/);
  });

  it("draws what was built, furniture and screens included", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const checked = await h.ok<{ designId: string }>("check_design", { design: GLASS_ROW });
    const built = await h.ok<{ rooms: { id: string; name: string | null }[] }>("build_design", {
      designId: checked.result.designId,
    });
    await h.ok("furnish_room", { roomId: built.result.rooms.find((r) => r.name === "Meeting 2")?.id });
    const look = await h.ok<{ legend: string[]; images: { pngBase64: string }[] }>("preview_design", {});
    expect(look.result.legend.some((l) => l.includes("Meeting 2"))).toBe(true);
    expect(pixels(look.result.images[0]?.pngBase64 ?? "").where(PLAN_COLOURS.display).length).toBeGreaterThan(
      0,
    );
  });

  it("tells the designer when the architect handed a design on without looking at it", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    h.ctx.subagent = {
      async run() {
        return {
          designId: "design_z",
          text: "done",
          unresolved: [],
          lastDesignId: "design_z",
          looked: false,
          verdict: null,
          steps: 3,
          rounds: 1,
          reason: "done",
        };
      },
    };
    const r = await h.ok<{ looked: boolean }>("design_layout", { brief: "an office" });
    expect(r.result.looked).toBe(false);
    expect(r.warnings.some((w) => w.includes('preview_design { designId: "design_z" }'))).toBe(true);
  });
});

describe("a failing design is still a picture (ADR-028 D11)", () => {
  it("shows two rooms drawn over each other in orange, and says nothing is built", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const overlapping = {
      ...GLASS_ROW,
      rooms: GLASS_ROW.rooms.map((x) => (x.key === "wc" ? { ...x, rect: { ...x.rect, x: 12000 } } : x)),
    };
    const checked = await h.ok<{ designId: string; errors: { code: string }[] }>("check_design", {
      design: overlapping,
    });
    expect(checked.result.errors.map((e) => e.code)).toContain("design.rooms-overlap");
    const look = await h.ok<{ caption: string; images: { pngBase64: string }[] }>("preview_design", {
      designId: checked.result.designId,
    });
    expect(look.result.caption).toContain("orange is two rooms drawn over each other");
    expect(pixels(look.result.images[0]?.pngBase64 ?? "").where(PLAN_COLOURS.overlap).length).toBeGreaterThan(
      100,
    );
    expect(h.ctx.store.project.rooms).toHaveLength(0);
  });
});

describe("the same design twice is refused, not checked again (ADR-028 D10)", () => {
  it("gives a passing design its own id back, and says so", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const first = await h.ok<{ designId: string; buildable: boolean }>("check_design", {
      design: GLASS_ROW,
    });
    expect(first.result.buildable).toBe(true);
    const again = await h.ok<{ designId: string }>("check_design", { design: GLASS_ROW });
    expect(again.result.designId).toBe(first.result.designId);
    expect(again.warnings.some((w) => w.includes("again, and it passes"))).toBe(true);
  });

  it("names the design it repeats and costs no round", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    // a design with an error in it: the toilets moved off the corridor they open onto
    const broken = {
      ...GLASS_ROW,
      rooms: GLASS_ROW.rooms.map((x) => (x.key === "wc" ? { ...x, doorsTo: ["m3"] } : x)),
    };
    const first = await h.ok<{ designId: string; buildable: boolean }>("check_design", { design: broken });
    expect(first.result.buildable).toBe(false);
    const again = await h.call("check_design", { design: broken });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe("design.unchanged");
    expect(again.error.message).toContain(first.result.designId);
    expect(again.error.hint).toContain("revise_design");
  });
});

describe("a room that touches no shared floor is told the move that would (ADR-028 D10)", () => {
  it("names the distance and both edits, as revise_design lines", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    // one meeting room, 1,155 mm north of the corridor, with no door of its own
    const design = {
      ...GLASS_ROW,
      rooms: GLASS_ROW.rooms
        .filter((x) => x.key !== "m2" && x.key !== "m3")
        .map((x) =>
          x.key === "m1" ? { ...x, doorsTo: [], rect: { x: 230, y: 6000, w: 6000, d: 3770 } } : x,
        ),
    };
    const r = await h.ok<{ errors: { code: string; entityId: string | null; hint: string | null }[] }>(
      "check_design",
      { design },
    );
    const m1 = r.result.errors.find((e) => e.code === "design.unreachable" && e.entityId === "m1");
    expect(m1?.hint).toContain("1155 mm from hall");
    expect(m1?.hint).toContain(
      'revise_design rooms: [{ key: "m1", rect: { x: 230, y: 4845, w: 6000, d: 3770 } }]',
    );
    expect(m1?.hint).toContain("or stretch hall to meet it");
  });
});

describe("a revision has to revise, and a key is read as one (ADR-028 D10)", () => {
  it("refuses a revision whose every field is already what it says", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const first = await h.ok<{ designId: string }>("check_design", { design: GLASS_ROW });
    const nothing = await h.call("revise_design", {
      designId: first.result.designId,
      rooms: [{ key: "m1", rect: { x: 230, y: 4845, w: 6000, d: 4925 } }],
    });
    expect(nothing.ok).toBe(false);
    if (nothing.ok) return;
    expect(nothing.error.code).toBe("design.unchanged");
    expect(nothing.error.message).toContain("m1.rect");
  });

  it("reads meetA as meeta, and the doors that name it with it", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const design = {
      ...GLASS_ROW,
      rooms: GLASS_ROW.rooms.map((x) =>
        x.key === "m1" ? { ...x, key: "meetA" } : x.key === "hall" ? { ...x, doorsTo: ["outside"] } : x,
      ),
    };
    const r = await h.ok<{ walk: { routes: Record<string, string> } }>("check_design", { design });
    expect(r.warnings.some((w) => w.includes("meetA as meeta"))).toBe(true);
    expect(Object.keys(r.result.walk.routes)).toContain("meeta");
  });
});

describe("the arithmetic done for a drawn plan (ADR-028 D10)", () => {
  it("moves the smaller room clear, keeps everything inside, and says what it moved", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const bent = {
      ...GLASS_ROW,
      rooms: GLASS_ROW.rooms.map((x) =>
        // m2 shoved onto m1, and m3 run past the east wall
        x.key === "m2"
          ? { ...x, rect: { x: 3000, y: 4845, w: 6000, d: 4925 } }
          : x.key === "m3"
            ? { ...x, rect: { x: 16000, y: 4845, w: 7310, d: 4925 } }
            : x,
      ),
    };
    const first = await h.ok<{ designId: string; errors: { code: string }[] }>("check_design", {
      design: bent,
    });
    expect(first.result.errors.map((e) => e.code)).toContain("design.rooms-overlap");
    const tidy = await h.ok<{ designId: string; errors: { code: string }[] }>("tidy_design", {
      designId: first.result.designId,
    });
    expect(tidy.warnings.some((w) => /^m2 moved \d+ mm (east|west)/.test(w))).toBe(true);
    expect(tidy.result.errors.map((e) => e.code)).not.toContain("design.rooms-overlap");
    expect(tidy.result.errors.map((e) => e.code)).not.toContain("design.outside-shell");
    // the arrangement is the model's: the rooms keep their purposes, doors and order along the side
    const walked = await h.ok<{ walk: { sides: Record<string, { along: string[] }> } }>("revise_design", {
      designId: tidy.result.designId,
    });
    expect(walked.result.walk.sides.north?.along).toContain("m1");
  });

  it("says so when there is nothing to move", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const first = await h.ok<{ designId: string }>("check_design", { design: GLASS_ROW });
    const tidy = await h.ok("tidy_design", { designId: first.result.designId });
    expect(tidy.warnings.some((w) => w.includes("nothing moved"))).toBe(true);
  });
});

describe("a revision meets the model where it writes (ADR-028 D10)", () => {
  it("moves a room with part of a rect, and finds a room whose key was run together", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const first = await h.ok<{ designId: string }>("check_design", { design: GLASS_ROW });
    const moved = await h.ok<{ designId: string }>("revise_design", {
      designId: first.result.designId,
      // "m1" written as "M1", and only the y of its rect
      rooms: [{ key: "M1", rect: { y: 5000 } }],
    });
    expect(moved.warnings.some((w) => w.includes('read "M1" as m1'))).toBe(true);
    const rows = await h.ok<{ rows: { values: Record<string, unknown> }[] }>("query_design", {
      designId: moved.result.designId,
      where: "key == 'm1'",
      select: ["y", "w", "d"],
    });
    // the y moved and the size it did not mention is the size it had
    expect(rows.result.rows[0]?.values).toMatchObject({ y: 5000, w: 6000, d: 4925 });
  });
});

describe("reading a LOOK verdict (ADR-028 D11)", () => {
  const lines = [
    "Way in: from the west",
    "Every room reached: all of them",
    "Sides: rooms on three",
    "Zones: the desks are open floor",
    "Doors outside: only the entrance",
    "Drawn over: nothing",
    "Left over: 12 m2 by the store",
    "Displays: on plaster",
    "Brief: three meeting rooms, a cafe",
  ];
  it("finds the headings however the model writes them", () => {
    expect(lookMissing(`LOOK design_1\n${lines.map((l) => `- ${l}`).join("\n")}\nVerdict: DONE`)).toEqual([]);
    // bold, as a model writes it as often as not
    const bold = lines.map((l) => `- **${l.replace(":", ":**")}`).join("\n");
    expect(lookMissing(`LOOK design_1\n${bold}\nVerdict: DONE`)).toEqual([]);
    // and all on one line, which is what a chat card shows
    expect(lookMissing(`LOOK design_1 - ${lines.join(" - ")} - Verdict: DONE`)).toEqual([]);
    // numbered, and in another case
    expect(lookMissing(lines.map((l, i) => `${i + 1}. ${l.toUpperCase()}`).join("\n"))).toEqual([]);
  });

  it("names what a bare verdict leaves out", () => {
    expect(lookMissing("Verdict: DONE")).toHaveLength(LOOK_HEADINGS.length);
    expect(lookMissing(`- ${lines[0]}\n- ${lines[1]}\nVerdict: DONE`)).toContain("Sides");
  });
});

describe("an open zone drawn over a room (ADR-028 D10)", () => {
  it("cuts the zone back instead of flinging the room across the building", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    // the desks drawn over the whole floor, with the reception inside them
    const over = {
      ...GLASS_ROW,
      rooms: [
        {
          key: "desks",
          name: "Desks",
          purpose: "open-office",
          rect: { x: 230, y: 230, w: 19540, d: 9540 },
          doorsTo: [],
          capacity: 6,
        },
        {
          key: "rec",
          name: "Reception",
          purpose: "reception",
          rect: { x: 230, y: 230, w: 5000, d: 4000 },
          doorsTo: ["outside"],
          window: true,
        },
      ],
    };
    const first = await h.ok<{ designId: string; errors: { code: string }[] }>("check_design", {
      design: over,
    });
    expect(first.result.errors.map((e) => e.code)).toContain("design.rooms-overlap");
    const tidy = await h.ok<{ designId: string; errors: { code: string }[] }>("tidy_design", {
      designId: first.result.designId,
    });
    expect(tidy.result.errors.map((e) => e.code)).not.toContain("design.rooms-overlap");
    // the reception stayed where it was put; the desks gave way
    expect(tidy.warnings.some((w) => w.startsWith("desks moved"))).toBe(true);
    expect(tidy.warnings.some((w) => w.startsWith("rec moved"))).toBe(false);
    const rows = await h.ok<{ rows: { values: Record<string, unknown> }[] }>("query_design", {
      designId: tidy.result.designId,
      where: "key == 'rec'",
      select: ["x", "y"],
    });
    expect(rows.result.rows[0]?.values).toMatchObject({ x: 230, y: 230 });
  });
});

describe("a design to continue from that is gone (ADR-028 D10)", () => {
  it("designs from the brief and says so, rather than refusing", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const asked: { from?: unknown }[] = [];
    h.ctx.subagent = {
      async run(request) {
        asked.push(request as { from?: unknown });
        return {
          designId: "design_new",
          text: "designed from the brief",
          unresolved: [],
          lastDesignId: "design_new",
          looked: true,
          verdict: "LOOK design_new Verdict: DONE",
          steps: 4,
          rounds: 2,
          reason: "done",
        };
      },
    };
    const r = await h.ok<{ designId: string | null }>("design_layout", {
      brief: "an office",
      designId: "design_gone",
    });
    expect(r.result.designId).toBe("design_new");
    expect(asked[0]?.from).toBeUndefined();
    expect(r.warnings.some((w) => w.includes('no design called "design_gone" is held'))).toBe(true);
  });
});

describe("rooms that do not fit the building (ADR-028 D10)", () => {
  it("says how big the shell would have to be, and how much would have to go", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const tooMany = {
      brief: "a floor of rooms that do not fit",
      kind: "workplace" as const,
      shell: { x: 0, y: 0, w: 20000, d: 10000 },
      rooms: [
        {
          key: "a",
          name: "A",
          purpose: "open-office",
          rect: { x: 250, y: 250, w: 19500, d: 9500 },
          doorsTo: ["outside"],
          capacity: 20,
        },
        {
          key: "b",
          name: "B",
          purpose: "meeting",
          rect: { x: 250, y: 250, w: 12000, d: 8000 },
          doorsTo: ["a"],
          capacity: 8,
        },
      ],
    };
    const r = await h.ok<{ errors: { code: string; hint: string | null }[] }>("check_design", {
      design: tooMany,
    });
    const over = r.result.errors.find((e) => e.code === "design.rooms-exceed-shell");
    expect(over?.hint).toMatch(/grow the shell to about [\d.]+ by [\d.]+ m/);
    expect(over?.hint).toContain("m² of rooms out");
  });

  it("cuts the larger open zone when two of them overlap, and moves neither room", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const both = {
      brief: "two open zones over each other",
      kind: "workplace" as const,
      shell: { x: 0, y: 0, w: 30000, d: 14000 },
      rooms: [
        {
          key: "desks",
          name: "Desks",
          purpose: "open-office",
          rect: { x: 230, y: 230, w: 29540, d: 13540 },
          doorsTo: [],
          capacity: 40,
        },
        {
          key: "rec",
          name: "Reception",
          purpose: "reception",
          rect: { x: 230, y: 230, w: 7000, d: 5000 },
          doorsTo: ["outside"],
          enclosure: "open" as const,
        },
      ],
    };
    const first = await h.ok<{ designId: string }>("check_design", { design: both });
    const tidy = await h.ok<{ designId: string }>("tidy_design", { designId: first.result.designId });
    expect(tidy.warnings.some((w) => w.startsWith("desks moved"))).toBe(true);
    expect(tidy.warnings.some((w) => w.startsWith("rec moved"))).toBe(false);
  });
});

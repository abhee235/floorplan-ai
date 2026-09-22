// A plan the architect drew itself, put through the checker and the builder (ADR-028).
//
// The fixture is the office in the rendering the owner brought: enclosed rooms on all four sides of
// the building, an open workspace in the middle that is also the only circulation, an open cafe, a
// glass executive suite, glass meeting rooms and pods, and a glazed west side. The packer cannot
// produce this shape; the point of the decision is that nothing else should refuse it either.
import { AV_CORE, CORE_RULES, checkLayout } from "@fpv/catalog";
import { Design, type DesignInput } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { wallBetween } from "../src/build-design.js";
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
  shell: { x: 0, y: 0, w: W, d: D, wallMm: 230, interiorWallMm: 115, facade: { west: "glazed" } },
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
    expect(by("pod")?.hint).toContain("touches no corridor or open room");
  });

  it("revise_design says when a change changed nothing", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const first = await h.ok<{ designId: string }>("check_design", { design: RENDERED_OFFICE });
    const same = await h.ok("revise_design", {
      designId: first.result.designId,
      rooms: [{ key: "pod1", rect: { x: 26000, y: 3230, w: 2400, d: 3000 } }],
    });
    expect(same.warnings.some((w) => w.includes("changed nothing: pod1.rect"))).toBe(true);
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

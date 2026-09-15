// import_plan and commitDraft (spec 06 A2, PRD P2-3): review first, commit only with a confirmed scale.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type PlanDraft, readPlanText } from "@fpv/importers";
import { derive, type Opening, type Wall } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { buildChains, type DraftPresentation, type PlanReader, ToolError } from "../src/index.js";
import { harness } from "./helpers.js";

const DIR = fileURLToPath(new URL("../../../tools/fixtures/plans/", import.meta.url));
const fixture = (name: string) => readFileSync(`${DIR}${name}.dxf`, "utf8");

/** A reader over the fixture directory plus in-memory content, like the host's without the file system. */
function reader(files: Record<string, string> = {}): PlanReader & { reads: number } {
  const r = {
    reads: 0,
    async read(req: { path?: string; content?: string; fileName?: string }) {
      r.reads += 1;
      const fileName = req.fileName ?? req.path ?? "plan.dxf";
      const text =
        req.content ?? files[req.path ?? ""] ?? (req.path ? fixture(req.path.replace(/\.dxf$/, "")) : "");
      try {
        return { ...readPlanText(fileName, text), fileName };
      } catch (e) {
        const err = e as { code: string; message: string; hint: string | null };
        throw new ToolError(err.code, err.message, null, err.hint);
      }
    },
  };
  return r;
}

interface ReviewOut {
  status: string;
  draftId: string;
  scale: { confirmed: boolean; source: string; mmPerUnit: number | null; reason: string };
  counts: { walls: number; openings: number; rooms: number };
  questions: { id: string; kind: string; text: string; answer: string | null }[];
  draft: PlanDraft;
  committed?: {
    wallIds: string[];
    openingIds: string[];
    roomIds: string[];
    labelIds: string[];
    skipped: { reason: string }[];
    openQuestions: string[];
  };
}

describe("import_plan", () => {
  it("a first call reviews without changing the project and shows the draft in the viewer", async () => {
    const shown: (DraftPresentation | null)[] = [];
    const viewer = {
      render: async () => ({ images: [] }),
      presentDraft: (d: DraftPresentation | null) => shown.push(d),
    };
    const h = harness(undefined, { plans: reader(), viewer });
    const r = await h.ok<ReviewOut>("import_plan", { path: "office-mm.dxf" });
    expect(r.result).toMatchObject({
      status: "review",
      scale: { confirmed: true, source: "dimension-text", mmPerUnit: 1 },
      counts: { walls: 6, openings: 8, rooms: 3 },
    });
    expect(h.ctx.store.project.walls).toHaveLength(0);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.draftId).toBe(r.result.draftId);
    expect(shown[0]?.preview?.segments.length).toBeGreaterThan(20);
  });

  it("confirm commits walls, openings, rooms and provenance as one undoable step", async () => {
    const shown: (DraftPresentation | null)[] = [];
    const viewer = {
      render: async () => ({ images: [] }),
      presentDraft: (d: DraftPresentation | null) => shown.push(d),
    };
    const h = harness(undefined, { plans: reader(), viewer });
    const review = await h.ok<ReviewOut>("import_plan", { path: "office-mm.dxf" });
    const r = await h.ok<ReviewOut>("import_plan", { draftId: review.result.draftId, confirm: true });
    const p = h.ctx.store.project;
    expect(r.result.status).toBe("committed");
    expect(r.result.committed?.skipped).toEqual([]);
    expect(p.walls).toHaveLength(6);
    expect(p.openings).toHaveLength(8);
    expect(p.rooms.map((x) => [x.name, x.purpose, x.capacity])).toEqual([
      ["BOARDROOM", "boardroom", 12],
      ["OPEN OFFICE", "open-office", null],
      ["MEETING ROOM", "meeting", 6],
    ]);
    expect(p.provenance).toMatchObject({
      sourceFile: "office-mm.dxf",
      reader: "dxf:deterministic",
      questions: [],
    });
    // the exterior ring is one closed chain: every exterior wall is joined at both ends
    const exterior = p.walls.filter((w) => w.kind === "exterior");
    expect(exterior).toHaveLength(4);
    expect(exterior.every((w) => w.joins.start !== null && w.joins.end !== null)).toBe(true);
    expect(p.walls.every((w) => Number.isInteger(w.start.x) && Number.isInteger(w.end.y))).toBe(true);
    expect(shown.at(-1)).toBeNull();
    expect(h.ctx.store.undo()).not.toBeNull();
    expect(h.ctx.store.project.walls).toHaveLength(0);
    expect(h.ctx.store.project.rooms).toHaveLength(0);
  });

  it("door hinges and swing sides survive a wall whose chain runs the other way", async () => {
    const h = harness(undefined, { plans: reader() });
    await h.ok("import_plan", { path: "office-mm.dxf", confirm: true });
    const p = h.ctx.store.project;
    // the entrance on the south wall: hinge at x = 8000, the leaf opens north (+y), 1000 wide
    const door = p.openings.find((o) => o.width === 1000) as Opening;
    const wall = p.walls.find((w) => w.id === door.wallId) as Wall;
    const iv = derive.openingAlongInterval(door, wall);
    const len = derive.wallLength(wall);
    const hinge = derive.pointAlongWall(wall, (door.swing?.hinge === "start" ? iv.from : iv.to) / len);
    expect(Math.round(hinge.x)).toBe(8000);
    const dx = (wall.end.x - wall.start.x) / len;
    const dy = (wall.end.y - wall.start.y) / len;
    const normal = door.swing?.direction === "left" ? { x: -dy, y: dx } : { x: dy, y: -dx };
    expect(Math.round(normal.y)).toBe(1);
  });

  it("no draft commits without a confirmed scale; an answer confirms it", async () => {
    // without dimension entities only the header gives the scale, which a person must confirm
    const headerOnly = fixture("office-mm").replace(/\r\nDIMENSION\r\n/g, "\r\nXDIMENSION\r\n");
    const h = harness(undefined, { plans: reader({ "header.dxf": headerOnly }) });
    const review = await h.ok<ReviewOut>("import_plan", { path: "header.dxf" });
    expect(review.result.scale).toMatchObject({ confirmed: false, source: "header" });
    const q = review.result.questions.find((x) => x.kind === "scale");
    expect(q).toBeDefined();
    const refused = await h.call("import_plan", { draftId: review.result.draftId, confirm: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("import.scale-unconfirmed");
    expect(h.ctx.store.project.walls).toHaveLength(0);
    const done = await h.ok<ReviewOut>("import_plan", {
      draftId: review.result.draftId,
      confirm: true,
      answers: { [q?.id as string]: "mm" },
    });
    expect(done.result.scale).toMatchObject({ confirmed: true, source: "user", mmPerUnit: 1 });
    expect(h.ctx.store.project.walls).toHaveLength(6);
  });

  it("a known length sets the scale of a drawing without units", async () => {
    const noUnits = fixture("lshape-metres").replace(/\r\nDIMENSION\r\n/g, "\r\nXDIMENSION\r\n");
    const h = harness(undefined, { plans: reader({ "plain.dxf": noUnits }) });
    const review = await h.ok<ReviewOut>("import_plan", { path: "plain.dxf" });
    expect(review.result.scale).toMatchObject({ confirmed: false, source: "guess" });
    // the south wall is 14 drawing units long and really 14 m
    const r = await h.ok<ReviewOut>("import_plan", {
      draftId: review.result.draftId,
      confirm: true,
      scale: { measuredUnits: 14, lengthMm: 14000 },
    });
    expect(r.result.scale.mmPerUnit).toBe(1000);
    const xs = h.ctx.store.project.walls.flatMap((w) => [w.start.x, w.end.x]);
    expect(Math.max(...xs)).toBe(14000);
  });

  it("labels without outlines become detected rooms; an L-shaped plan with mixed thicknesses commits", async () => {
    const h = harness(undefined, { plans: reader() });
    const r = await h.ok<ReviewOut>("import_plan", { path: "lshape-metres.dxf", confirm: true });
    const p = h.ctx.store.project;
    expect(r.result.committed?.skipped).toEqual([]);
    expect(p.walls).toHaveLength(8);
    expect(p.openings).toHaveLength(7);
    expect(p.rooms.map((x) => [x.name, x.source])).toEqual([
      ["Meeting Room", "detected"],
      ["Open Office", "detected"],
      ["Reception", "detected"],
    ]);
  });

  it("the rotated imperial plan commits with every opening on a wall", async () => {
    const h = harness(undefined, { plans: reader() });
    const r = await h.ok<ReviewOut>("import_plan", { path: "rotated-inches.dxf", confirm: true });
    expect(r.result.committed?.skipped).toEqual([]);
    expect(h.ctx.store.project.openings).toHaveLength(7);
    expect(h.ctx.store.project.rooms).toHaveLength(4);
  });

  it("an edited draft replaces the stored one; an unknown draft id and a missing reader are clear errors", async () => {
    const h = harness(undefined, { plans: reader() });
    const review = await h.ok<ReviewOut>("import_plan", { path: "office-mm.dxf", detail: "full" });
    const edited: PlanDraft = {
      ...review.result.draft,
      walls: review.result.draft.walls.slice(0, 5),
      openings: [],
      rooms: [],
    };
    await h.ok("import_plan", { draftId: review.result.draftId, draft: edited, confirm: true });
    expect(h.ctx.store.project.walls).toHaveLength(5);

    const unknown = await h.call("import_plan", { draftId: "draft_nope", confirm: true });
    expect(unknown.ok || unknown.error.code).toBe("import.draft-unknown");
    const bare = harness();
    const none = await bare.call("import_plan", { path: "office-mm.dxf" });
    expect(none.ok || none.error.code).toBe("unavailable");
  });

  it("DWG files are refused with a way forward", async () => {
    const h = harness(undefined, { plans: reader({ "plan.dwg": "" }) });
    const r = await h.call("import_plan", { path: "plan.dwg" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: "import.format", hint: expect.stringContaining("DXF") });
  });
});

describe("buildChains", () => {
  const wall = (idx: number, a: [number, number], b: [number, number], thickness = 100) => ({
    idx,
    points: [
      { x: a[0], y: a[1] },
      { x: b[0], y: b[1] },
    ],
    thickness,
    kind: null,
  });

  it("four walls drawn in any direction around a square close one chain; ends within 20 mm meet", () => {
    const chains = buildChains([
      wall(0, [0, 0], [4000, 0]),
      wall(1, [4000, 4000], [4010, 5]), // drawn backwards, 10 mm off the corner
      wall(2, [4000, 4000], [0, 4000]),
      wall(3, [0, 0], [0, 4000]),
    ]);
    expect(chains).toHaveLength(1);
    expect(chains[0]?.closed).toBe(true);
    expect(chains[0]?.points).toHaveLength(4);
    expect(chains[0]?.segmentWall.slice().sort()).toEqual([0, 1, 2, 3]);
  });

  it("a T-junction and a thickness change keep walls apart", () => {
    const chains = buildChains([
      wall(0, [0, 0], [4000, 0]),
      wall(1, [4000, 0], [8000, 0], 250),
      wall(2, [2000, 0], [2000, 3000]),
    ]);
    expect(chains.map((c) => c.segmentWall)).toEqual([[0], [1], [2]]);
  });
});

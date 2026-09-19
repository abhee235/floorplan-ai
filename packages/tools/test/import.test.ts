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
    async read(req: { path?: string; content?: string; contentBase64?: string; fileName?: string }) {
      r.reads += 1;
      const fileName = req.fileName ?? req.path ?? "plan.dxf";
      const text =
        req.content ??
        (req.contentBase64 ? Buffer.from(req.contentBase64, "base64").toString("utf8") : undefined) ??
        files[req.path ?? ""] ??
        (req.path ? fixture(req.path.replace(/\.dxf$/, "")) : "");
      try {
        return { ...readPlanText(fileName, text), image: null, fileName };
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
    // rooms are created from the enclosures top to bottom, then left to right
    expect(p.rooms.map((x) => [x.name, x.source])).toEqual([
      ["Reception", "detected"],
      ["Meeting Room", "detected"],
      ["Open Office", "detected"],
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

describe("room detection on imported plans (P2-4)", () => {
  const REAL = fileURLToPath(new URL("../../../tools/fixtures/plans-real/", import.meta.url));
  const real = (name: string) => readFileSync(`${REAL}${name}.dxf`, "utf8");

  it("a space holding several labels becomes one room named by the central label; the others stay as labels", async () => {
    const h = harness(undefined, { plans: reader({ "apartment.dxf": real("apartment-metres") }) });
    const r = await h.ok<ReviewOut>("import_plan", { path: "apartment.dxf", confirm: true });
    const p = h.ctx.store.project;
    // four enclosed spaces: BEDROOM 2 and BATH are drawn in one space with no wall between them
    expect(p.rooms).toHaveLength(4);
    expect(p.rooms.every((room) => room.source === "detected")).toBe(true);
    const names = p.rooms.map((room) => room.name);
    expect(names).toEqual(expect.arrayContaining(["KITCHEN", "LIVING", "BEDROOM 1"]));
    const shared = ["BEDROOM 2", "BATH"];
    expect(shared.filter((n) => names.includes(n))).toHaveLength(1);
    const labels = p.annotations.filter((a) => a.kind === "label").map((a) => (a as { text: string }).text);
    expect(shared.filter((n) => labels.includes(n))).toHaveLength(1);
    expect(r.result.committed?.openQuestions.some((q) => q.includes("share one enclosed space"))).toBe(true);
    expect(p.rooms.find((room) => room.name === "KITCHEN")?.purpose).toBe("cafeteria");
  });

  it("enclosures without labels become unnamed detected rooms", async () => {
    const h = harness(undefined, { plans: reader() });
    const review = await h.ok<ReviewOut>("import_plan", { path: "office-mm.dxf", detail: "full" });
    await h.ok("import_plan", {
      draftId: review.result.draftId,
      draft: { ...review.result.draft, rooms: [] },
      confirm: true,
    });
    const rooms = h.ctx.store.project.rooms;
    expect(rooms).toHaveLength(3);
    expect(rooms.every((room) => room.name === null && room.source === "detected")).toBe(true);
    expect(rooms.every((room) => room.boundingWallIds.length > 0)).toBe(true);
  });

  it("a label outside every enclosure stays a label and says why", async () => {
    const h = harness(undefined, { plans: reader({ "courtyard.dxf": real("courtyard-house") }) });
    const r = await h.ok<ReviewOut>("import_plan", {
      path: "courtyard.dxf",
      confirm: true,
      scale: { units: "mm" },
    });
    const p = h.ctx.store.project;
    expect(p.rooms.map((room) => room.name)).not.toContain("GROUND FLOOR PLAN");
    const labels = p.annotations.filter((a) => a.kind === "label").map((a) => (a as { text: string }).text);
    expect(labels).toContain("GROUND FLOOR PLAN");
    expect(
      r.result.committed?.skipped.some((s) =>
        s.reason.startsWith("room GROUND FLOOR PLAN: no walls enclose its label"),
      ),
    ).toBe(true);
    // every room label of the drawing ends up inside a room
    const inRoom = (name: string) => {
      const room = p.rooms.find((x) => x.name === name);
      const label = p.annotations.find((a) => a.kind === "label" && (a as { text: string }).text === name) as
        | { position: { x: number; y: number } }
        | undefined;
      return (
        room !== undefined ||
        (label !== undefined && p.rooms.some((x) => derive.roomContains(x, label.position)))
      );
    };
    for (const name of ["COURTYARD", "LIVING / LOUNGE", "KITCHEN / DINING", "BEDROOM", "BATH", "STUDIO"])
      expect(inRoom(name), name).toBe(true);
  });

  it("the gap tolerance for room detection can be set on the import", async () => {
    const h = harness(undefined, { plans: reader() });
    const bad = await h.call("import_plan", { path: "office-mm.dxf", confirm: true, gapToleranceMm: 500 });
    expect(bad.ok).toBe(false);
    await h.ok("import_plan", { path: "office-mm.dxf", confirm: true, gapToleranceMm: 100 });
    expect(h.ctx.store.project.rooms).toHaveLength(3);
  });
});

// An attachment is how a plan reaches the agent: the person drops a file into the chat, the host
// keeps the bytes, and the model names an id. Bytes inside a tool call would be echoed back through
// the conversation on every turn, which is a context window spent on something the host already has.
describe("import_plan from an attachment (P4-6)", () => {
  const attached = (name: string, text: string) => ({
    get: (id: string) =>
      id === "a1" ? { id, name, mime: "application/dxf", bytes: new TextEncoder().encode(text) } : null,
    list: () => [{ id: "a1", name, mime: "application/dxf", size: text.length }],
  });

  it("reads the attached file, and the draft is the one the path gives", async () => {
    const text = fixture("office-mm");
    const viaPath = harness(undefined, { plans: reader() });
    const byPath = await viaPath.ok<ReviewOut>("import_plan", { path: "office-mm.dxf" });

    const h = harness(undefined, { plans: reader(), attachments: attached("office-mm.dxf", text) });
    const byAttachment = await h.ok<ReviewOut>("import_plan", { attachmentId: "a1" });
    expect(byAttachment.result.counts).toEqual(byPath.result.counts);
    expect(byAttachment.result.status).toBe("review");
  });

  it("names what is attached when the id is not one of them", async () => {
    const h = harness(undefined, { plans: reader(), attachments: attached("office-mm.dxf", "") });
    const r = await h.call("import_plan", { attachmentId: "nope" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("import.attachment-unknown");
    expect(r.error.hint).toContain("a1");
  });

  it("says so when nothing is attached to the conversation", async () => {
    const h = harness(undefined, { plans: reader() });
    const r = await h.call("import_plan", { attachmentId: "a1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.hint).toContain("nothing is attached");
  });
});

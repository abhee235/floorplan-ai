import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readPlanText } from "@fpv/importers";
import { describe, expect, it } from "vitest";
import type { Ctx2D, PlanView } from "../src/plan/plan.js";
import { DraftReview, niceLength } from "../src/plan/review.js";

const PLANS = fileURLToPath(new URL("../../../tools/fixtures/plans/", import.meta.url));

function openFixture(name: string, strip = false) {
  let text = readFileSync(`${PLANS}${name}.dxf`, "utf8");
  if (strip) text = text.replace(/\r\nDIMENSION\r\n/g, "\r\nXDIMENSION\r\n");
  const { draft, preview } = readPlanText(`${name}.dxf`, text);
  const review = new DraftReview();
  review.open({ draftId: "draft_test", draft, preview, warnings: [] });
  return review;
}

function recorder(): Ctx2D & { calls: string[] } {
  const calls: string[] = [];
  const rec = (name: string) => () => {
    calls.push(name);
  };
  return {
    calls,
    save: rec("save"),
    restore: rec("restore"),
    setTransform: rec("setTransform"),
    clearRect: rec("clearRect"),
    beginPath: rec("beginPath"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    arc: rec("arc"),
    closePath: rec("closePath"),
    fill: rec("fill"),
    stroke: rec("stroke"),
    fillText: (t: string) => {
      calls.push(`text:${t}`);
    },
    setLineDash: rec("setLineDash"),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
  };
}

const VIEW: PlanView = { scale: 0.05, offsetX: 400, offsetY: 300, width: 800, height: 600 };

describe("DraftReview", () => {
  it("opens and closes from draft messages and reports the scale status", () => {
    const review = openFixture("office-mm");
    expect(review.active).toBe(true);
    expect(review.status.confirmed).toBe(true);
    const seen: boolean[] = [];
    review.subscribe(() => seen.push(review.active));
    review.open({ draftId: null, draft: null, preview: null, warnings: [] });
    expect(review.active).toBe(false);
    expect(seen).toEqual([false]);
  });

  it("a known length on a selected wall sets and confirms the scale; the commit sends the edited draft", () => {
    const review = openFixture("lshape-metres", true);
    expect(review.status.confirmed).toBe(false);
    const south = review.draft?.walls.find((w) => w.points.every((p) => Math.abs(p.y) < 1e-6)) as {
      idx: number;
    };
    // a click on the wall at the scale the view draws it
    review.setScale({ units: "m" });
    expect(review.hitWall({ x: 7000, y: 30 }, VIEW.scale)).toBe(south.idx);
    review.select(south.idx);
    review.setKnownLength(14000);
    expect(review.status.confirmed).toBe(true);
    expect(review.draft?.units.mmPerUnit).toBeCloseTo(1000, 6);
    expect(review.wallLengthMm(south.idx)).toBeCloseTo(14000, 3);
    const args = review.commitArgs("level_000000");
    expect(args).toMatchObject({ draftId: "draft_test", confirm: true, levelId: "level_000000" });
    expect(args.draft).toBeDefined();
  });

  it("an unedited review commits by draft id alone", () => {
    const review = openFixture("office-mm");
    expect(review.commitArgs()).toEqual({ draftId: "draft_test", confirm: true });
  });

  it("deleting a wall drops the openings on it; thickness is set in millimetres at the current scale", () => {
    const review = openFixture("rotated-inches");
    const d = review.draft;
    if (!d) throw new Error("no draft");
    const withDoor = d.openings.find((o) => o.wallIdx !== null)?.wallIdx as number;
    const onIt = d.openings.filter((o) => o.wallIdx === withDoor).length;
    review.setThickness(withDoor, 254);
    expect(review.draft?.walls.find((w) => w.idx === withDoor)?.thickness).toBeCloseTo(10, 6);
    review.deleteWall(withDoor);
    expect(review.draft?.walls.some((w) => w.idx === withDoor)).toBe(false);
    expect(review.draft?.openings.length).toBe(d.openings.length - onIt);
    expect(review.edited).toBe(true);
  });

  it("a scale answer is applied; an unreadable one is reported", () => {
    const review = openFixture("office-mm", true);
    const q = review.draft?.questions.find((x) => x.kind === "scale");
    expect(q).toBeDefined();
    expect(review.answer(q?.id as string, "a lot")).toEqual([q?.id]);
    expect(review.status.confirmed).toBe(false);
    expect(review.answer(q?.id as string, "yes")).toEqual([]);
    expect(review.status.confirmed).toBe(true);
  });

  it("draws source, walls, openings, wall lengths and a scale bar; hidden layers are skipped", () => {
    const review = openFixture("office-mm");
    const ctx = recorder();
    review.draw(ctx, VIEW);
    expect(ctx.calls.filter((c) => c === "arc").length).toBe(8);
    expect(ctx.calls).toContain("text:12000");
    expect(ctx.calls.some((c) => c === "text:5 m" || c === "text:2 m" || c === "text:10 m")).toBe(true);
    const hidden = recorder();
    for (const layer of ["source", "walls", "openings", "rooms", "lengths"] as const) review.toggle(layer);
    review.draw(hidden, VIEW);
    expect(hidden.calls.filter((c) => c === "arc")).toHaveLength(0);
    expect(hidden.calls.some((c) => c === "text:12000")).toBe(false);
  });

  it("nice scale bar lengths", () => {
    expect([niceLength(1), niceLength(1300), niceLength(2400), niceLength(7000)]).toEqual([
      1, 2000, 5000, 10000,
    ]);
  });
});

describe("raster draft review", () => {
  it("draws the source image under the draft in the box frame once it has loaded", () => {
    const review = new DraftReview();
    const draft = {
      source: { kind: "image", file: "p.png", page: null, pixelSize: { w: 2000, h: 1000 } },
      units: { detected: "unknown", mmPerUnit: 10, scaleSource: "user", checks: [] },
      levelName: null,
      walls: [
        {
          idx: 0,
          points: [
            { x: 100, y: 100 },
            { x: 900, y: 100 },
          ],
          thickness: 10,
          kind: null,
          confidence: 0.6,
          sourceRef: null,
        },
      ],
      openings: [],
      rooms: [],
      texts: [],
      confidence: 0.5,
      questions: [],
      reader: null,
    };
    review.open({
      draftId: "d1",
      draft,
      preview: null,
      warnings: [],
      image: { dataUrl: "data:image/png;base64,x", width: 2000, height: 1000 },
    });
    const images: number[][] = [];
    const ctx = {
      ...recorder(),
      globalAlpha: 1,
      drawImage: (_img: unknown, x: number, y: number, w: number, h: number) => {
        images.push([x, y, w, h]);
      },
    };
    review.draw(ctx, VIEW);
    expect(images).toEqual([]);
    const seen: boolean[] = [];
    review.subscribe(() => seen.push(true));
    review.setImage({ fake: "image" });
    expect(seen).toEqual([true]);
    review.draw(ctx, VIEW);
    // the box is 1000 by 500 units at 10 mm per unit, drawn at 0.05 px per mm with y up from offsetY
    expect(images).toEqual([[400, 300 - 500 * 10 * 0.05, 1000 * 10 * 0.05, 500 * 10 * 0.05]]);
  });
});

import { describe, expect, it } from "vitest";
import { AV_CORE, AV_CORE_INPUT, checkDesign, mergePacks, RulesPack } from "../src/index.js";
import { boardroomItems, item, project } from "./rules.helpers.js";

const codes = (p = project()) => checkDesign(p, AV_CORE).map((x) => x.code);
const edit = (id: string, change: (i: ReturnType<typeof boardroomItems>[number]) => object) =>
  boardroomItems().map((i) => (i.id === id ? { ...i, ...change(i) } : i));

describe("core design rules (spec 07 section 4)", () => {
  it("the reference boardroom passes every rule", () => {
    expect(checkDesign(project(), AV_CORE)).toEqual([]);
  });

  it("display-size-detail: a 20 inch display cannot serve seats nearly 4 m away", () => {
    const p = project();
    const refs = {
      ...p.catalogRefs,
      "disp-75": { ...(p.catalogRefs["disp-75"] as object), specs: { diagonalIn: 20, vesa: "400x400" } },
    };
    const problems = checkDesign({ ...p, catalogRefs: refs as unknown as typeof p.catalogRefs }, AV_CORE);
    expect(problems.map((x) => x.code)).toEqual(["design.display-size-detail"]);
    expect(problems[0]).toMatchObject({
      severity: "warning",
      entityId: "room_000001",
      hint: "use a larger display or bring the seating closer",
    });
    expect(problems[0]?.message).toMatch(/^Boardroom: the largest display is too small/);
  });

  it("camera-fov: a 20 degree camera does not cover the table and chairs", () => {
    const p = project();
    const refs = { ...p.catalogRefs, bar: { ...(p.catalogRefs.bar as object), specs: { fovDeg: 20 } } };
    expect(codes({ ...p, catalogRefs: refs as unknown as typeof p.catalogRefs })).toEqual([
      "design.camera-fov",
    ]);
  });

  it("ceiling-mic-coverage and ceiling-speaker-coverage: one per 20 and 25 m² in a 38.7 m² room", () => {
    expect(codes(project(boardroomItems().filter((i) => i.id !== "item_mic2")))).toEqual([
      "design.ceiling-mic-coverage",
    ]);
    expect(codes(project(boardroomItems().filter((i) => i.id !== "item_spk2")))).toEqual([
      "design.ceiling-speaker-coverage",
    ]);
  });

  it("chair-clearance: a chair 300 mm from the wall, or backed onto a credenza, is too close", () => {
    expect(codes(project(edit("item_c00s", () => ({ position: { x: 2650, y: 500 } }))))).toEqual([
      "design.chair-clearance",
    ]);
    const credenza = {
      ...item("item_cred", "tbl", 4000, 400),
      ref: {
        kind: "recipe" as const,
        recipe: { kind: "box" as const, size: { w: 1800, d: 500, h: 720 }, label: "Credenza" },
      },
    };
    expect(codes(project([...boardroomItems(), credenza]))).toEqual(["design.chair-clearance"]);
  });

  it("door-swing-clear: floor furniture inside the door's square is reported; ceiling items are not", () => {
    const blocker = item("item_bin", "chr", 1200, 400);
    expect(codes(project([...boardroomItems(), blocker]))).toEqual(["design.door-swing-clear"]);
    const above = item("item_mic3", "mic", 1200, 400, {
      elevation: 2645,
      mount: { kind: "ceiling", targetId: null, height: null },
    });
    expect(codes(project([...boardroomItems(), above]))).not.toContain("design.door-swing-clear");
  });

  it("display-centre-height: a wall display centred at 1800 mm is too high", () => {
    expect(codes(project(edit("item_display", () => ({ elevation: 1319 }))))).toEqual([
      "design.display-centre-height",
    ]);
  });

  it("rules that do not apply are silent, disabled rules never run, and a broken rule reports itself", () => {
    const p = project();
    const cafe = { ...p, rooms: p.rooms.map((r) => ({ ...r, purpose: "cafeteria" as const })) };
    expect(codes({ ...cafe, items: boardroomItems().filter((i) => !i.id.startsWith("item_mic")) })).toEqual(
      [],
    );
    const off = mergePacks(
      AV_CORE,
      RulesPack.parse({
        id: "x",
        version: "1.0.0",
        name: "x",
        extends: "av-core",
        designRules: [
          { ...AV_CORE_INPUT.designRules?.find((r) => r.id === "chair-clearance"), enabled: false },
          { id: "typo", applies: "true", check: "count('chair') > room.seatz", message: "m" },
        ],
      }),
    );
    const problems = checkDesign(project(edit("item_c00s", () => ({ position: { x: 2650, y: 500 } }))), off);
    expect(problems.map((x) => x.code)).toEqual(["design.rule-error"]);
    expect(problems[0]?.message).toBe("design rule typo could not be checked: unknown identifier room.seatz");
  });
});

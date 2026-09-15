// Behaviours found by reading real drawings (2026-09-15): bound external-reference layer names, headers
// whose units are wrong, dimension labels drawn as plain text and lines, window callouts that are not rooms,
// and structural walls under architectural ones.
import { describe, expect, it } from "vitest";
import { dxfToDraft, layerRole } from "../src/index.js";

type Pair = [number, string | number];

function dxf(entities: Pair[], insUnits: number | null = 4, extraHeader: Pair[] = []): string {
  const out: Pair[] = [
    [0, "SECTION"],
    [2, "HEADER"],
  ];
  if (insUnits !== null) out.push([9, "$INSUNITS"], [70, insUnits]);
  out.push(
    ...extraHeader,
    [0, "ENDSEC"],
    [0, "SECTION"],
    [2, "ENTITIES"],
    ...entities,
    [0, "ENDSEC"],
    [0, "EOF"],
  );
  return out.map(([c, v]) => `${c}\n${v}`).join("\r\n");
}

const line = (layer: string, x1: number, y1: number, x2: number, y2: number): Pair[] => [
  [0, "LINE"],
  [8, layer],
  [10, x1],
  [20, y1],
  [11, x2],
  [21, y2],
];
const text = (layer: string, x: number, y: number, h: number, value: string, rotation = 0): Pair[] => [
  [0, "TEXT"],
  [8, layer],
  [10, x],
  [20, y],
  [40, h],
  [1, value],
  [50, rotation],
];

/** A rectangle of double-line walls `t` thick around 0..w by 0..d, with centrelines on the edges. */
function box(layer: string, w: number, d: number, t: number): Pair[] {
  const h = t / 2;
  return [
    ...line(layer, 0, -h, w, -h),
    ...line(layer, 0, h, w, h),
    ...line(layer, w - h, 0, w - h, d),
    ...line(layer, w + h, 0, w + h, d),
    ...line(layer, w, d - h, 0, d - h),
    ...line(layer, w, d + h, 0, d + h),
    ...line(layer, h, d, h, 0),
    ...line(layer, -h, d, -h, 0),
  ];
}

describe("real-drawing behaviours", () => {
  it("bound and attached external-reference prefixes do not hide a layer's role", () => {
    expect(layerRole("xref-Bishop-Overland-08$0$A-WALL")).toBe("wall");
    expect(layerRole("SITE$0$A-OPENING")).toBe("door");
    expect(layerRole("Level1|A-GLAZ")).toBe("window");
    expect(layerRole("XREF")).toBe("ignore");
    expect(layerRole("A-NOTE")).toBe("text");
    expect(layerRole("doorswindows")).toBe("door");
    expect(layerRole("wallhigh")).toBe("wall");
    expect(layerRole("drywindows")).toBe("window");
    expect(layerRole("doormat")).toBe("door");
  });

  it("a header in mm on a drawing in metres is overruled by dimension labels drawn as text and lines", () => {
    const text12 = dxf([
      ...box("A-WALL", 12, 9, 0.25),
      ...line("A-DIMS", 0, -0.8, 12, -0.8),
      ...line("A-DIMS", 0, -0.95, 0, -0.65),
      ...text("A-DIMS", 5.65, -0.56, 0.33, "12000"),
      ...line("A-DIMS", -0.8, 0, -0.8, 9),
      ...text("A-DIMS", -0.56, 4.5, 0.33, "9000", 90),
    ]);
    const { draft } = dxfToDraft(text12);
    expect(draft.units).toMatchObject({ detected: "m", mmPerUnit: 1000, scaleSource: "dimension-text" });
    expect(draft.units.checks.map((c) => c.text)).toEqual(["12000", "9000"]);
    expect(draft.walls).toHaveLength(4);
    expect(draft.questions.some((q) => q.kind === "scale" && q.text.includes("header"))).toBe(true);
  });

  it("without dimensions, a header whose units make the walls implausible is replaced by the unit that fits", () => {
    // drawn in inches (6 inch walls, 40 by 30 feet) while the header claims millimetres
    const { draft } = dxfToDraft(dxf(box("A-WALL", 480, 360, 6)));
    expect(draft.units).toMatchObject({ detected: "unknown", mmPerUnit: 25.4, scaleSource: "guess" });
    expect(draft.walls).toHaveLength(4);
    const q = draft.questions.find((x) => x.kind === "scale");
    expect(q?.text).toContain("mm");
    expect(q?.text).toContain("in");
  });

  it("a plausible header is kept", () => {
    const { draft } = dxfToDraft(dxf(box("A-WALL", 12000, 9000, 250)));
    expect(draft.units).toMatchObject({ detected: "mm", scaleSource: "header" });
    expect(draft.walls).toHaveLength(4);
  });

  it("window and door callouts and notes are not room names; short labels on note layers are", () => {
    const { draft } = dxfToDraft(
      dxf([
        ...box("A-WALL", 12000, 9000, 250),
        ...text("A-TEXT", 3000, 3000, 250, "LIVING ROOM"),
        ...text("A-TEXT", 6000, 100, 150, "5050 XO"),
        ...text("A-TEXT", 9000, 100, 150, "6068 S.G.D."),
        ...text("A-TEXT", 9000, 8800, 150, '18" MIN. RAISED'),
        ...text("A-NOTE", 5000, 5000, 150, "NOTE: VERIFY ON SITE"),
        ...text("A-NOTE", 7000, 7000, 150, "PROVIDE 20 MIN. DOOR W/ SELF CLOSING"),
        ...text("A-NOTE", 9000, 3000, 250, "%%uKITCHEN"),
        ...text("A-TEXT", 3000, 7000, 250, "KITCHEN / DINING"),
      ]),
    );
    expect(draft.rooms.map((r) => r.name)).toEqual(["LIVING ROOM", "KITCHEN", "KITCHEN / DINING"]);
  });

  it("structural walls are left out when architectural wall layers exist", () => {
    const { draft, report } = dxfToDraft(
      dxf([...box("A-WALL", 12000, 9000, 250), ...box("S-STEM-WALL", 12000, 9000, 200)]),
    );
    expect(report.wallLayers).toEqual(["A-WALL"]);
    expect(draft.walls).toHaveLength(4);
    expect(draft.walls.every((w) => Math.abs((w.thickness ?? 0) - 250) < 1)).toBe(true);
  });
});

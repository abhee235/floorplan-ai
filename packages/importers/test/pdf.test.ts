// Spec 06 A6: the PDF page interpretation without a PDF library: operator lists, arcs from Bézier curves,
// labels from text runs, and roles for the synthetic layers.
import { describe, expect, it } from "vitest";
import {
  cubicArc,
  interpretPdfOperators,
  type PdfPageContent,
  type PdfPath,
  pageLabels,
  pdfPageToDocument,
} from "../src/index.js";

// pdfjs-dist 6 operator numbers
const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  setLineWidth: 2,
  setDash: 6,
  setGState: 9,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  setStrokeRGBColor: 58,
  setFillRGBColor: 59,
  paintImageXObject: 85,
  constructPath: 91,
};

const K = (4 / 3) * Math.tan(Math.PI / 8); // quarter circle control distance for a unit radius

const line = (a: [number, number], b: [number, number], width = 0.25, color = "#000000"): PdfPath => ({
  subpaths: [
    { start: { x: a[0], y: a[1] }, commands: [{ op: "L", to: { x: b[0], y: b[1] } }], closed: false },
  ],
  stroke: true,
  fill: false,
  lineWidth: width,
  strokeColor: color,
  fillColor: "#000000",
  dashed: false,
});

describe("PDF page interpretation (spec 06 A6)", () => {
  it("tracks transforms, save and restore, line width, dash, colour and painting", () => {
    const { paths, images } = interpretPdfOperators(
      [
        OPS.setLineWidth,
        OPS.setStrokeRGBColor,
        OPS.save,
        OPS.transform,
        OPS.constructPath,
        OPS.restore,
        OPS.setDash,
        OPS.constructPath,
        OPS.constructPath,
        OPS.paintImageXObject,
      ],
      [
        [2],
        ["#ff0000"],
        null,
        [2, 0, 0, 2, 10, 0],
        [OPS.closeStroke, [Float32Array.from([0, 0, 0, 1, 10, 0, 1, 10, 10])], null],
        null,
        [[3, 2], 0],
        [OPS.stroke, [Float32Array.from([0, 0, 100, 1, 100, 100])], null],
        [OPS.fill, [null], null],
        ["img", 10, 10],
      ],
      OPS,
    );
    expect(paths).toHaveLength(2);
    const [first, second] = paths as [PdfPath, PdfPath];
    expect(first.subpaths[0]?.start).toEqual({ x: 10, y: 0 });
    expect(first.subpaths[0]?.commands[1]).toEqual({ op: "L", to: { x: 30, y: 20 } });
    expect(first).toMatchObject({ lineWidth: 4, strokeColor: "#ff0000", dashed: false, stroke: true });
    expect(first.subpaths[0]?.closed).toBe(true);
    expect(second).toMatchObject({ lineWidth: 2, dashed: true });
    expect(images).toBe(1);
  });

  it("a cubic drawn as a quarter circle is an arc; other cubics are not", () => {
    const arc = cubicArc({ x: 1, y: 0 }, { x: 1, y: K }, { x: K, y: 1 }, { x: 0, y: 1 });
    expect(arc).not.toBeNull();
    expect(arc?.centre.x).toBeCloseTo(0, 6);
    expect(arc?.centre.y).toBeCloseTo(0, 6);
    expect(arc?.radius).toBeCloseTo(1, 6);
    expect(arc?.sweep).toBeCloseTo(Math.PI / 2, 6);
    const clockwise = cubicArc({ x: 0, y: 1 }, { x: K, y: 1 }, { x: 1, y: K }, { x: 1, y: 0 });
    expect(clockwise?.sweep).toBeCloseTo(-Math.PI / 2, 6);
    expect(cubicArc({ x: 0, y: 0 }, { x: 3, y: 5 }, { x: 5, y: -4 }, { x: 10, y: 0 })).toBeNull();
  });

  it("joins pieces of one line and puts a capacity line under its label", () => {
    const labels = pageLabels([
      { str: "BOARD", x: 100, y: 100, height: 10, rotation: 0, width: 35 },
      { str: "ROOM", x: 135.5, y: 100, height: 10, rotation: 0, width: 32 },
      { str: "12 PAX", x: 115, y: 86, height: 10, rotation: 0, width: 36 },
      { str: "HALL", x: 300, y: 100, height: 10, rotation: 0, width: 30 },
    ]);
    expect(labels.map((l) => l.text)).toEqual(["BOARDROOM\n12 PAX", "HALL"]);
  });

  it("heavy parallel line pairs are walls; arcs are door swings; a length label and its line are a dimension; dashes are ignored", () => {
    const paths: PdfPath[] = [
      line([0, 0], [300, 0], 0.7),
      line([0, 7], [300, 7], 0.7),
      line([0, 0], [0, 200], 0.7),
      line([7, 7], [7, 200], 0.7),
      line([20, 50], [120, 50]),
      line([20, 55], [120, 55]),
      line([0, -40], [300, -40]),
      { ...line([-50, 3.5], [400, 3.5]), dashed: true },
      {
        ...line([0, 0], [0, 0]),
        subpaths: [
          {
            start: { x: 130, y: 7 },
            commands: [
              {
                op: "C",
                c1: { x: 130, y: 7 + 25 * K },
                c2: { x: 105 + 25 * K, y: 32 },
                to: { x: 105, y: 32 },
              },
            ],
            closed: false,
          },
        ],
      },
    ];
    const content: PdfPageContent = {
      page: 1,
      width: 800,
      height: 600,
      paths,
      texts: [
        { str: "10500", x: 140, y: -38, height: 6, rotation: 0, width: 18 },
        { str: "SCALE 1:100", x: 600, y: 20, height: 8, rotation: 0, width: 50 },
      ],
      images: 0,
    };
    const { doc, layerRoles, header, wallLayers } = pdfPageToDocument(content);
    expect(wallLayers).toEqual(["pdf-stroke-0.70-000000"]);
    expect(layerRoles.get("pdf-stroke-0.25-000000")).toBe("window");
    expect(layerRoles.get("pdf-dashed")).toBe("ignore");
    expect(header).toMatchObject({ mmPerUnit: (100 * 25.4) / 72, label: "the sheet says 1:100" });
    const arcs = doc.entities.filter((e) => e.type === "ARC");
    expect(arcs).toHaveLength(1);
    const arc = arcs[0] as { layer: string; start: number; end: number; radius: number };
    expect(arc.layer).toBe("pdf-arcs");
    expect(arc.start).toBeCloseTo(0, 6);
    expect(arc.end).toBeCloseTo(90, 6);
    expect(arc.radius).toBeCloseTo(25, 6);
    const dimension = doc.entities.filter((e) => e.layer === "pdf-dimensions");
    expect(dimension.map((e) => e.type).sort()).toEqual(["LINE", "TEXT"]);
  });
});

// Spec 06 A6: the vector PDF reader on a page of a real drawing (a NIST technical note, public domain; see
// tools/fixtures/plans-pdf-real/SOURCES.md). The page is a dimensioned CAD floor plan whose walls, hatching,
// symbols and sheet frame are all drawn as parallel lines, and whose dimension lines are broken around their
// text, so it pins the rules that tell those apart.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type PdfPageContent, pdfPageToDraft } from "@fpv/importers";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../../../tools/fixtures/plans-pdf-real/", import.meta.url));
const expected = JSON.parse(readFileSync(`${DIR}nist-tn1838-first-floor.expected.json`, "utf8")) as {
  mmPerUnit: number;
  mmPerUnitTolerancePct: number;
  wallsAtLeast: number;
};
const content = JSON.parse(
  readFileSync(`${DIR}nist-tn1838-first-floor.page.json`, "utf8"),
) as PdfPageContent;

describe("vector PDF reader on a real drawing (PRD P2-7)", () => {
  const { draft, report } = pdfPageToDraft(content, { file: "nist-tn1838-first-floor.page.json" });

  it("reads the walls from the group of long parallel pairs, not the sheet frame or the hatching", () => {
    // 0.85 pt strokes are the walls; 1.17 pt is the figure frame and 0.43 pt the fixtures and hatching
    expect(report.wallLayers).toEqual(["pdf-stroke-0.85-000000"]);
    expect(draft.walls.length).toBeGreaterThanOrEqual(expected.wallsAtLeast);
    expect(draft.openings.length).toBeGreaterThan(0);
  });

  it("takes the scale from the plan's extent when the dimension lines are broken around their text", () => {
    // one label happens to sit beside a line of its own length, which is not enough to read dimension text
    expect(draft.units.scaleSource).toBe("header");
    const error = Math.abs((draft.units.mmPerUnit as number) - expected.mmPerUnit) / expected.mmPerUnit;
    expect(error * 100).toBeLessThanOrEqual(expected.mmPerUnitTolerancePct);
    // a scale read this way is never confirmed on its own; the review asks about it
    expect(draft.questions.some((q) => q.kind === "scale")).toBe(true);
  });

  it("keeps the legend and the notes out of the room names", () => {
    const names = draft.rooms.map((r) => (r.name ?? "").toLowerCase());
    for (const legend of ["legend", "symbol", "meaning", "appendix a", "dimensioned drawings", "1st floor"])
      expect(names, `"${legend}" is a note, not a room`).not.toContain(legend);
  });
});

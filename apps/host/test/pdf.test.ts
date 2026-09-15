// PRD P2-7 acceptance: the fixture vector PDF reaches the DXF fixture metrics (wall recall and precision 0.9,
// opening recall 0.8, scale within 2 percent, rooms found) through pdfjs-dist in the host (spec 06 A6).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExpectedPlan, PlanDraft, scoreDraft } from "@fpv/importers";
import { describe, expect, it } from "vitest";
import { FilePlanReader } from "../src/plans.js";
import { createSession } from "../src/session.js";

const PLANS = fileURLToPath(new URL("../../../tools/fixtures/plans/", import.meta.url));

/** A one-page PDF with the given content stream and Helvetica as F1. */
function tinyPdf(content: string): string {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  return `${out}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

describe("vector PDF plans (PRD P2-7)", () => {
  it("office-mm.pdf reaches the DXF fixture metrics", async () => {
    const reader = new FilePlanReader({ baseDir: () => PLANS });
    const out = await reader.read({ path: "office-mm.pdf" });
    const expected = JSON.parse(
      readFileSync(join(PLANS, "office-mm.pdf.expected.json"), "utf8"),
    ) as ExpectedPlan;
    const score = scoreDraft(out.draft, expected);
    expect(() => PlanDraft.parse(out.draft)).not.toThrow();
    expect(out.draft.source).toMatchObject({ kind: "pdf-vector", file: "office-mm.pdf", page: 1 });
    expect(out.draft.units.scaleSource).toBe("dimension-text");
    expect(score.wallRecall, JSON.stringify(score)).toBeGreaterThanOrEqual(0.9);
    expect(score.wallPrecision, JSON.stringify(score)).toBeGreaterThanOrEqual(0.9);
    expect(score.openingRecall, JSON.stringify(score.missedOpenings)).toBeGreaterThanOrEqual(0.8);
    expect(score.scaleErrorPct as number).toBeLessThan(2);
    expect(score.missedRooms).toEqual([]);
    expect((out.report as { wallLayers?: string[] }).wallLayers).toEqual(["pdf-stroke-0.70-000000"]);
    expect(out.draft.rooms.find((r) => r.name === "BOARDROOM")).toMatchObject({
      purpose: "boardroom",
      capacity: 12,
    });
    expect(out.preview?.segments.length).toBeGreaterThan(0);
  });

  it("a host session imports the PDF end to end: the dimensions confirm the scale and rooms are detected", async () => {
    const session = createSession({ plans: new FilePlanReader({ baseDir: () => PLANS }) });
    const review = await session.registry.call("import_plan", { path: "office-mm.pdf" });
    expect(review.ok, JSON.stringify(review)).toBe(true);
    const id = review.ok ? (review.result as { draftId: string }).draftId : "";
    const done = await session.registry.call("import_plan", { draftId: id, confirm: true });
    expect(done.ok, JSON.stringify(done)).toBe(true);
    const p = session.store.project;
    expect(p.walls.length).toBeGreaterThanOrEqual(6);
    expect(p.rooms.map((r) => r.name).sort()).toEqual(["BOARDROOM", "MEETING ROOM", "OPEN OFFICE"]);
    expect(p.provenance?.sourceFile).toBe("office-mm.pdf");
  });

  it("refuses a page without line work, a page that does not exist and bytes that are not a PDF", async () => {
    const reader = new FilePlanReader();
    const textOnly = Buffer.from(tinyPdf("BT /F1 12 Tf 1 0 0 1 50 60 Tm (NOTES) Tj ET")).toString("base64");
    await expect(reader.read({ contentBase64: textOnly, fileName: "notes.pdf" })).rejects.toMatchObject({
      code: "import.unsupported",
    });
    await expect(
      reader.read({ contentBase64: textOnly, fileName: "notes.pdf", page: 5 }),
    ).rejects.toMatchObject({
      code: "import.format",
    });
    const junk = Buffer.from("not a pdf at all").toString("base64");
    await expect(reader.read({ contentBase64: junk, fileName: "junk.pdf" })).rejects.toMatchObject({
      code: "import.parse",
    });
  });
});

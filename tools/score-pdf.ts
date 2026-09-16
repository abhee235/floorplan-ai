// Scores the vector PDF reader on pages of real PDFs (spec 06 A6). The fixtures in
// tools/fixtures/plans-pdf-real are single pages extracted by tools/build-pdf-real-fixture.ts, so this runs
// offline and without a model: the reader is deterministic. Expectations are coarse, because a drawing we did
// not generate cannot be labelled wall by wall; see that directory's SOURCES.md.
//
// Usage: corepack pnpm exec tsx tools/score-pdf.ts [--only <name>]
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type PdfPageContent, pdfPageToDraft } from "@fpv/importers";

const DIR = fileURLToPath(new URL("./fixtures/plans-pdf-real/", import.meta.url));

const argValue = (flag: string) => {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const only = argValue("--only");

export interface CoarsePdfExpectation {
  name: string;
  kind: "coarse";
  page: { file: string };
  mmPerUnit: number | null;
  mmPerUnitTolerancePct: number;
  scaleFrom: string | null;
  rooms: string[];
  doors: number | null;
  windows: number | null;
  wallsAtLeast: number;
}

export interface PdfRow {
  plan: string;
  walls: number;
  openings: number;
  doors: number;
  windows: number;
  rooms: string[];
  missedRooms: string[];
  roomRecall: number | null;
  mmPerUnit: number | null;
  scaleReadAs: string;
  scaleErrorPct: number | null;
  scaleFromExpected: boolean;
  enoughWalls: boolean;
  wallLayers: string[];
  questions: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function scoreAllPdf(): PdfRow[] {
  const names = readdirSync(DIR)
    .filter((f) => f.endsWith(".expected.json"))
    .map((f) => f.slice(0, -".expected.json".length))
    .filter((n) => !only || n === only)
    .sort();
  const rows: PdfRow[] = [];
  for (const name of names) {
    const expected = JSON.parse(readFileSync(`${DIR}${name}.expected.json`, "utf8")) as CoarsePdfExpectation;
    const content = JSON.parse(readFileSync(`${DIR}${expected.page.file}`, "utf8")) as PdfPageContent;
    const { draft, report } = pdfPageToDraft(content, { file: expected.page.file });
    const found = draft.rooms.map((r) => norm(r.name ?? ""));
    const missing = expected.rooms.filter(
      (r) => !found.some((f) => f && (f === norm(r) || f.includes(norm(r)))),
    );
    const mmPerUnit = draft.units.mmPerUnit;
    rows.push({
      plan: name,
      walls: draft.walls.length,
      openings: draft.openings.length,
      doors: draft.openings.filter((o) => o.kind === "door").length,
      windows: draft.openings.filter((o) => o.kind === "window").length,
      rooms: draft.rooms.map((r) => r.name ?? "(unnamed)"),
      missedRooms: missing,
      roomRecall:
        expected.rooms.length === 0
          ? null
          : Math.round(((expected.rooms.length - missing.length) / expected.rooms.length) * 1000) / 1000,
      mmPerUnit: mmPerUnit === null ? null : Math.round(mmPerUnit * 100) / 100,
      scaleReadAs: draft.units.scaleSource,
      scaleErrorPct:
        expected.mmPerUnit === null || mmPerUnit === null
          ? null
          : Math.round((Math.abs(mmPerUnit - expected.mmPerUnit) / expected.mmPerUnit) * 1000) / 10,
      scaleFromExpected: expected.scaleFrom === null || draft.units.scaleSource === expected.scaleFrom,
      enoughWalls: draft.walls.length >= expected.wallsAtLeast,
      wallLayers: report.wallLayers,
      questions: draft.questions.length,
    });
  }
  return rows;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("tools/score-pdf.ts")) {
  const rows = scoreAllPdf();
  for (const r of rows) console.log(JSON.stringify(r));
  if (rows.length === 0) console.log("no PDF page fixtures found");
}

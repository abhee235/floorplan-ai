// Scores the DXF reader on every plan fixture (ADR-011 D6, spec 06 A4): the generated plans in
// tools/fixtures/plans against their labelled walls and openings, and the real drawings in
// tools/fixtures/plans-real against their own wall line work and hand counts. Prints one table.
// Usage: corepack pnpm exec tsx tools/score-plans.ts [--json]
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  decodePlanText,
  dxfToDraft,
  type ExpectedPlan,
  type RealPlanExpectation,
  scoreDraft,
  scoreRealPlan,
  sourceWallFaces,
} from "@fpv/importers";

const GENERATED = fileURLToPath(new URL("./fixtures/plans/", import.meta.url));
const REAL = fileURLToPath(new URL("./fixtures/plans-real/", import.meta.url));

export interface PlanRow {
  name: string;
  kind: "generated" | "real";
  ms: number;
  walls: number;
  /** Wall recall for generated plans, face coverage for real ones. */
  wallScore: number;
  scaleErrorPct: number | null;
  doorRecall: number | null;
  windowRecall: number | null;
  openingRecall: number | null;
  roomRecall: number;
  scaleSource: string;
  notes: string[];
}

const namesIn = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".expected.json"))
    .map((f) => f.slice(0, -".expected.json".length))
    .sort();

export function scoreAll(): PlanRow[] {
  const rows: PlanRow[] = [];
  for (const name of namesIn(GENERATED)) {
    const text = readFileSync(`${GENERATED}${name}.dxf`, "utf8");
    const expected = JSON.parse(readFileSync(`${GENERATED}${name}.expected.json`, "utf8")) as ExpectedPlan;
    const start = performance.now();
    const { draft } = dxfToDraft(text, { file: `${name}.dxf` });
    const ms = performance.now() - start;
    const s = scoreDraft(draft, expected);
    rows.push({
      name,
      kind: "generated",
      ms,
      walls: draft.walls.length,
      wallScore: s.wallRecall,
      scaleErrorPct: s.scaleErrorPct,
      doorRecall: null,
      windowRecall: null,
      openingRecall: s.openingRecall,
      roomRecall: s.roomRecall,
      scaleSource: draft.units.scaleSource,
      notes: [
        ...s.missedOpenings.map((o) => `missed ${o.kind}`),
        ...s.missedRooms.map((r) => `missed room ${r}`),
      ],
    });
  }
  for (const name of namesIn(REAL)) {
    const text = decodePlanText(new Uint8Array(readFileSync(`${REAL}${name}.dxf`)));
    const expected = JSON.parse(readFileSync(`${REAL}${name}.expected.json`, "utf8")) as RealPlanExpectation;
    const start = performance.now();
    const { draft } = dxfToDraft(text, { file: `${name}.dxf` });
    const ms = performance.now() - start;
    const s = scoreRealPlan(draft, sourceWallFaces(text, expected.wallLayers), expected);
    rows.push({
      name,
      kind: "real",
      ms,
      walls: draft.walls.length,
      wallScore: s.wallFaceCoverage,
      scaleErrorPct: s.scaleErrorPct,
      doorRecall: s.doorRecall,
      windowRecall: s.windowRecall,
      openingRecall: null,
      roomRecall: s.roomRecall,
      scaleSource: draft.units.scaleSource,
      notes: [
        ...(s.missedRooms.length ? [`missed rooms: ${s.missedRooms.join(", ")}`] : []),
        ...(s.extraRooms.length ? [`extra rooms: ${s.extraRooms.join(", ")}`] : []),
      ],
    });
  }
  return rows;
}

const pct = (v: number | null) => (v === null ? "-" : `${Math.round(v * 100)}%`);

if (process.argv[1]?.endsWith("score-plans.ts")) {
  const rows = scoreAll();
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else {
    const header = [
      "plan",
      "kind",
      "ms",
      "walls",
      "wall score",
      "scale err",
      "scale from",
      "doors",
      "windows",
      "openings",
      "rooms",
    ];
    const table = rows.map((r) => [
      r.name,
      r.kind,
      String(Math.round(r.ms)),
      String(r.walls),
      pct(r.wallScore),
      r.scaleErrorPct === null ? "-" : `${r.scaleErrorPct.toFixed(1)}%`,
      r.scaleSource,
      pct(r.doorRecall),
      pct(r.windowRecall),
      pct(r.openingRecall),
      pct(r.roomRecall),
    ]);
    const widths = header.map((h, i) => Math.max(h.length, ...table.map((t) => (t[i] as string).length)));
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] as number)).join("  ");
    console.log(line(header));
    for (const t of table) console.log(line(t));
    for (const r of rows) for (const n of r.notes) console.log(`${r.name}: ${n}`);
  }
}

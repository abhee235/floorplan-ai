// Scores the DXF reader on every plan fixture (ADR-011 D6, spec 06 A4): the generated plans in
// tools/fixtures/plans against their labelled walls and openings, and the real drawings in
// tools/fixtures/plans-real against their own wall line work and hand counts. Prints one table.
// Usage: corepack pnpm exec tsx tools/score-plans.ts [--json]
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createStore } from "@fpv/commands";
import {
  decodePlanText,
  dxfToDraft,
  type ExpectedPlan,
  type PlanDraft,
  type RealPlanExpectation,
  scoreDraft,
  scoreRealPlan,
  sourceWallFaces,
  withScale,
} from "@fpv/importers";
import { derive, sequentialIdGenerator } from "@fpv/ir";
import { blankProject, catalogSourceOf, commitDraft, memoryCatalog } from "@fpv/tools";

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
  /** Found and expected counts for real plans, e.g. "10/14"; null for generated plans. */
  doors: string | null;
  windows: string | null;
  openingRecall: number | null;
  roomRecall: number;
  /** Share of wall-enclosed rooms that become rooms (by name or as a label inside one) after committing. */
  enclosedRecall: number;
  /** Rooms the commit made, and how many of them are unnamed. */
  roomsMade: string;
  scaleSource: string;
  notes: string[];
}

const namesIn = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".expected.json"))
    .map((f) => f.slice(0, -".expected.json".length))
    .sort();

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Commit a draft at its true scale and report which of the named rooms end up inside a room. */
function commitRooms(draft: PlanDraft, mmPerUnit: number, names: readonly string[]) {
  const now = "2026-09-16T12:00:00.000Z";
  const store = createStore(blankProject("score", now), {
    ids: sequentialIdGenerator(1),
    now: () => now,
    catalog: catalogSourceOf(memoryCatalog([]), () => now),
  });
  commitDraft(store, withScale(draft, { mmPerUnit }), { levelId: "level_000000", label: "score", now });
  const p = store.project;
  const pool = draft.rooms.filter((r) => r.name && r.labelAt).map((r) => ({ r, used: false }));
  let found = 0;
  for (const name of names) {
    const hit = pool.find((x) => !x.used && norm(x.r.name as string) === norm(name));
    if (!hit) continue;
    hit.used = true;
    const at = {
      x: Math.round((hit.r.labelAt as { x: number }).x * mmPerUnit),
      y: Math.round((hit.r.labelAt as { y: number }).y * mmPerUnit),
    };
    if (p.rooms.some((room) => derive.roomContains(room, at))) found += 1;
  }
  const unnamed = p.rooms.filter((r) => r.name === null).length;
  return {
    enclosedRecall: names.length === 0 ? 1 : found / names.length,
    roomsMade: `${p.rooms.length}${unnamed ? ` (${unnamed} unnamed)` : ""}`,
  };
}

export function scoreAll(): PlanRow[] {
  const rows: PlanRow[] = [];
  for (const name of namesIn(GENERATED)) {
    const text = readFileSync(`${GENERATED}${name}.dxf`, "utf8");
    const expected = JSON.parse(readFileSync(`${GENERATED}${name}.expected.json`, "utf8")) as ExpectedPlan;
    const start = performance.now();
    const { draft } = dxfToDraft(text, { file: `${name}.dxf` });
    const ms = performance.now() - start;
    const s = scoreDraft(draft, expected);
    const made = commitRooms(
      draft,
      expected.mmPerUnit,
      expected.rooms.map((r) => r.name),
    );
    rows.push({
      name,
      kind: "generated",
      ms,
      walls: draft.walls.length,
      wallScore: s.wallRecall,
      scaleErrorPct: s.scaleErrorPct,
      doorRecall: null,
      windowRecall: null,
      doors: null,
      windows: null,
      openingRecall: s.openingRecall,
      roomRecall: s.roomRecall,
      enclosedRecall: made.enclosedRecall,
      roomsMade: made.roomsMade,
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
    const made = commitRooms(draft, expected.mmPerUnit, expected.enclosedRooms);
    rows.push({
      name,
      kind: "real",
      ms,
      walls: draft.walls.length,
      wallScore: s.wallFaceCoverage,
      scaleErrorPct: s.scaleErrorPct,
      doorRecall: s.doorRecall,
      windowRecall: s.windowRecall,
      doors: `${s.doorsFound}/${expected.doors ?? "?"}`,
      windows: `${s.windowsFound}/${expected.windows ?? "?"}`,
      openingRecall: null,
      roomRecall: s.roomRecall,
      enclosedRecall: made.enclosedRecall,
      roomsMade: made.roomsMade,
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
      "door count",
      "windows",
      "window count",
      "openings",
      "rooms",
      "enclosed",
      "rooms made",
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
      r.doors ?? "-",
      pct(r.windowRecall),
      r.windows ?? "-",
      pct(r.openingRecall),
      pct(r.roomRecall),
      pct(r.enclosedRecall),
      r.roomsMade,
    ]);
    const widths = header.map((h, i) => Math.max(h.length, ...table.map((t) => (t[i] as string).length)));
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] as number)).join("  ");
    console.log(line(header));
    for (const t of table) console.log(line(t));
    for (const r of rows) for (const n of r.notes) console.log(`${r.name}: ${n}`);
  }
}

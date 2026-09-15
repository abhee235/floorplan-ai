// The DXF reader on every plan fixture must stay at or above its recorded floor (ADR-011 D6). Real drawings
// are scored against their own wall line work and hand counts; see tools/fixtures/plans-real/SOURCES.md.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type PlanRow, scoreAll } from "../score-plans.js";

interface Floor {
  wallScore: number;
  doorRecall?: number;
  windowRecall?: number;
  openingRecall?: number;
  roomRecall: number;
  maxScaleErrorPct: number;
}

const baseline = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/plans-real/baseline.json", import.meta.url)), "utf8"),
) as { plans: Record<string, Floor> };

describe("plan reader scores", () => {
  const rows = scoreAll();

  it("every scored plan has a floor and every floor has a plan", () => {
    expect(rows.map((r) => r.name).sort()).toEqual(Object.keys(baseline.plans).sort());
  });

  for (const row of rows)
    it(`${row.name} (${row.kind}) stays at or above its floor`, () => {
      const floor = baseline.plans[row.name] as Floor;
      const got = (r: PlanRow) => ({
        wallScore: r.wallScore,
        doorRecall: r.doorRecall,
        windowRecall: r.windowRecall,
        openingRecall: r.openingRecall,
        roomRecall: r.roomRecall,
        scaleErrorPct: r.scaleErrorPct,
      });
      const g = got(row);
      const detail = JSON.stringify({ got: g, floor, notes: row.notes });
      expect(g.wallScore, detail).toBeGreaterThanOrEqual(floor.wallScore);
      expect(g.roomRecall, detail).toBeGreaterThanOrEqual(floor.roomRecall);
      if (floor.doorRecall !== undefined)
        expect(g.doorRecall ?? 0, detail).toBeGreaterThanOrEqual(floor.doorRecall);
      if (floor.windowRecall !== undefined)
        expect(g.windowRecall ?? 0, detail).toBeGreaterThanOrEqual(floor.windowRecall);
      if (floor.openingRecall !== undefined)
        expect(g.openingRecall ?? 0, detail).toBeGreaterThanOrEqual(floor.openingRecall);
      expect(g.scaleErrorPct, detail).not.toBeNull();
      expect(g.scaleErrorPct as number, detail).toBeLessThanOrEqual(floor.maxScaleErrorPct);
    });
});

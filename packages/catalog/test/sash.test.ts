import { describe, expect, it } from "vitest";
import { importFlatCatalog, Sash } from "../src/index.js";

const NOW = "2026-09-15T12:00:00.000Z";
const opts = { libraryId: "lib", source: "library" as const, now: NOW };

function door(extra: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    name: "French door",
    category: "Doors",
    icon: "d.png",
    model: "d.obj",
    width: "91",
    depth: "34",
    height: "209",
    movable: "false",
    doorOrWindow: "true",
    ...extra,
  };
  return Object.entries(base)
    .map(([k, v]) => `${k}#1=${v}`)
    .join("\n");
}

function sashes(text: string) {
  const r = importFlatCatalog(text, opts);
  if (!r.ok) throw new Error(r.error);
  return r.items[0]?.product.opening?.sashes ?? [];
}

describe("sashes (O-084..O-087, C-012, C-013)", () => {
  it("O-086 no sash axis key means no sashes", () => {
    expect(sashes(door())).toEqual([]);
  });

  it("O-084 axes and width are fractions of the piece from its top-left corner: 2 cm on 91 cm", () => {
    const [s] = sashes(
      door({
        doorOrWindowSashXAxis: "2",
        doorOrWindowSashYAxis: "25",
        doorOrWindowSashWidth: "63.5",
        doorOrWindowSashStartAngle: "0",
        doorOrWindowSashEndAngle: "90",
      }),
    );
    expect(s?.xAxis).toBeCloseTo(2 / 91, 9);
    expect(s?.yAxis).toBeCloseTo(25 / 34, 9);
    expect(s?.width).toBeCloseTo(63.5 / 91, 9);
  });

  it("C-013 angles stay in degrees, never radians", () => {
    const [s] = sashes(
      door({
        doorOrWindowSashXAxis: "0.1",
        doorOrWindowSashYAxis: "0",
        doorOrWindowSashWidth: "72.8",
        doorOrWindowSashStartAngle: "0",
        doorOrWindowSashEndAngle: "90",
      }),
    );
    expect(s?.startAngle).toBe(0);
    expect(s?.endAngle).toBe(90);
  });

  it("O-085 C-012 the five lists must be present with equal counts; the first mismatch is named", () => {
    const r = importFlatCatalog(
      door({
        doorOrWindowSashXAxis: "2 130",
        doorOrWindowSashYAxis: "25 25",
        doorOrWindowSashWidth: "63.5",
        doorOrWindowSashStartAngle: "0 180",
        doorOrWindowSashEndAngle: "-90 270",
      }),
      opts,
    );
    expect(r).toEqual({
      ok: false,
      error: "doorOrWindowSashWidth#1: expected 2 values in doorOrWindowSashWidth, got 1",
    });
    const missing = importFlatCatalog(door({ doorOrWindowSashXAxis: "2" }), opts);
    expect(missing).toEqual({
      ok: false,
      error: "doorOrWindowSashYAxis#1: expected 1 values in doorOrWindowSashYAxis, key missing",
    });
  });

  it("O-087 a typical French door on 91 x 34 gives sashes[1] = (130/91, 25/34, 63.5/91, 180, 270)", () => {
    const all = sashes(
      door({
        doorOrWindowSashXAxis: "2 130",
        doorOrWindowSashYAxis: "25 25",
        doorOrWindowSashWidth: "63.5 63.5",
        doorOrWindowSashStartAngle: "0 180",
        doorOrWindowSashEndAngle: "-90 270",
      }),
    );
    expect(all).toHaveLength(2);
    const second = all[1] as Sash;
    expect(second.xAxis).toBeCloseTo(130 / 91, 9);
    expect(second.yAxis).toBeCloseTo(25 / 34, 9);
    expect(second.width).toBeCloseTo(63.5 / 91, 9);
    expect(second.startAngle).toBe(180);
    expect(second.endAngle).toBe(270);
    expect(all[0]?.endAngle).toBe(-90);
    expect(Sash.safeParse(second).success).toBe(true);
  });
});

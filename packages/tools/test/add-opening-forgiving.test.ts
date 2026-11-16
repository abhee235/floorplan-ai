// add_opening answers the traps live copies fell into instead of refusing them: both ways of placing an
// opening at once, an empty productId, an opening past the wall's end, and the same opening added twice.
// An overlap is still refused, but says what is in the way and where.
import { describe, expect, it } from "vitest";
import type { WallView } from "../src/index.js";
import { harness } from "./helpers.js";

async function wall() {
  const h = harness();
  const made = await h.ok<{ walls: WallView[] }>("create_walls", {
    levelId: "level_000000",
    points: [
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
    ],
    closed: false,
  });
  return { h, wallId: (made.result.walls[0] as WallView).id };
}

describe("add_opening", () => {
  it("uses a measured atMm over a round position, and says so", async () => {
    const { h, wallId } = await wall();
    const r = await h.ok<{ opening: { atMm: number } }>("add_opening", {
      wallId,
      kind: "door",
      position: 0.5,
      atMm: 900,
    });
    expect(r.result.opening.atMm).toBe(900);
    expect(r.warnings.join(" ")).toMatch(/atMm was used/);
  });

  it("takes atMm 0 beside a position as left out (live runs put every door at the wall's start)", async () => {
    const { h, wallId } = await wall();
    const r = await h.ok<{ opening: { id: string; atMm: number } }>("add_opening", {
      wallId,
      kind: "door",
      position: 0.25,
      atMm: 0,
    });
    expect(r.result.opening.atMm).toBe(1000);
    const m = await h.ok<{ opening: { atMm: number } }>("modify_opening", {
      openingId: r.result.opening.id,
      position: 0.75,
      atMm: 0,
    });
    expect(m.result.opening.atMm).toBe(3000);
  });

  it("moves an opening that runs past the wall's end back onto it, and says so", async () => {
    const { h, wallId } = await wall();
    const r = await h.ok<{ opening: { atMm: number } }>("add_opening", {
      wallId,
      kind: "door",
      position: 0.98,
      width: 1000,
    });
    expect(r.result.opening.atMm).toBe(3500);
    expect(r.warnings.join(" ")).toMatch(/ran past the end/);
  });

  it("answers the same opening added twice with the one already there", async () => {
    const { h, wallId } = await wall();
    const first = await h.ok<{ opening: { id: string } }>("add_opening", {
      wallId,
      kind: "window",
      atMm: 2000,
    });
    const again = await h.ok<{ opening: { id: string } }>("add_opening", {
      wallId,
      kind: "window",
      atMm: 2050,
    });
    expect(again.result.opening.id).toBe(first.result.opening.id);
    expect(h.ctx.store.project.openings).toHaveLength(1);
    expect(again.warnings.join(" ")).toMatch(/already there/);
  });

  it("refuses an overlap by naming what is in the way and where", async () => {
    const { h, wallId } = await wall();
    await h.ok("add_opening", { wallId, kind: "window", atMm: 2000 });
    const r = await h.call("add_opening", { wallId, kind: "door", atMm: 2400 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toMatch(/overlap opening_\w+, a window 1200 wide at 1400-2600 mm/);
      expect(r.error.hint).toMatch(/modify_opening/);
    }
  });

  it("reads an empty productId as no product", async () => {
    const { h, wallId } = await wall();
    const r = await h.ok<{ opening: { productId: string | null } }>("add_opening", {
      wallId,
      kind: "window",
      position: 0.5,
      productId: "",
    });
    expect(r.result.opening.productId).toBeNull();
  });
});

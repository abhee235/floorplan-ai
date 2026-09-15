import { AV_CORE, type Bom } from "@fpv/catalog";
import { describe, expect, it } from "vitest";
import { buildFixtureRoom, harness } from "./helpers.js";

describe("get_bom and design problems through the registry (spec 04 section 7, spec 07)", () => {
  it("get_bom returns item and rule lines with reasons; includeUnverified false keeps verified lines", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const { roomId } = await buildFixtureRoom(h);
    await h.ok("place_item", { productId: "acme-boardroom-3600", levelId: "level_000000", x: 2500, y: 2500 });
    const r = await h.ok<Bom>("get_bom", { scope: `room:${roomId}`, explain: true });
    expect(r.changed).toBeNull();
    const lines = r.result.lines;
    expect(lines.find((l) => l.productId === "acme-boardroom-3600")).toMatchObject({
      quantity: 1,
      status: "verified",
      total: 2400,
      reason: { kind: "item", ruleId: null },
    });
    // the memory catalog has no connectors or schedulers, so the rules leave placeholders naming the gap
    expect(lines.find((l) => l.reason.ruleId === "table-power")).toMatchObject({
      quantity: 3,
      status: "placeholder",
      description: "Table power and data module",
      reason: {
        expression: "ceil(room.capacity / seatsPerTablePowerModule)",
        evaluated: expect.stringContaining("= 3"),
      },
    });
    expect(lines.find((l) => l.reason.ruleId === "scheduler")?.status).toBe("placeholder");
    const verifiedOnly = await h.ok<Bom>("get_bom", { scope: "project", includeUnverified: false });
    expect(verifiedOnly.result.lines.every((l) => l.status === "verified" || l.status === "labour")).toBe(
      true,
    );
    expect(verifiedOnly.result.totals.placeholder).toBe(r.result.totals.placeholder);
  });

  it("a bad scope or a missing room is a clear error", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    const bad = await h.call("get_bom", { scope: "everything" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("args.invalid");
    const missing = await h.call("get_bom", { scope: "room:room_zzzzzz" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("ref.missing");
  });

  it("with a pack loaded, validate and every mutating result carry design problems", async () => {
    const h = harness(undefined, { rules: AV_CORE });
    await buildFixtureRoom(h);
    // a chair backed 150 mm from the north wall
    const placed = await h.ok("place_item", {
      productId: "acme-task-chair",
      levelId: "level_000000",
      x: 1000,
      y: 4500,
      rotation: 0,
    });
    expect(placed.problems.map((p) => p.code)).toContain("design.chair-clearance");
    const v = await h.ok<{ warnings: { code: string }[] }>("validate", {});
    expect(v.result.warnings.map((w) => w.code)).toContain("design.chair-clearance");
    const without = harness();
    await buildFixtureRoom(without);
    const plain = await without.ok("place_item", {
      productId: "acme-task-chair",
      levelId: "level_000000",
      x: 1000,
      y: 4500,
      rotation: 0,
    });
    expect(plain.problems.some((p) => p.code.startsWith("design."))).toBe(false);
  });
});

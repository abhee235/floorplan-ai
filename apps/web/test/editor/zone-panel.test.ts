// A desk cluster in the properties panel (P3-6): what it says about itself, and what each row asks for.
// Every rule row must send ONE command that both changes the rule and lays the pieces out again, or an
// undo would leave the old desks gone and the new ones unplaced.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apply, type Ctx } from "@fpv/commands";
import { Project, type Project as ProjectT, sequentialIdGenerator } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { deleteCommands, describeEntity, type Fact, kindOf } from "../../src/editor/selection.js";
import { DEFAULT_PIECE, DEFAULT_RULE, ZoneTool } from "../../src/editor/zone-tool.js";

const fixtureDir = fileURLToPath(new URL("../../../../tools/fixtures/boardroom.fpviz/", import.meta.url));
const fixture = (): ProjectT => Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));
const ctxOf = (): Ctx => ({ ids: sequentialIdGenerator(900), now: () => "2026-09-18T00:00:00.000Z" });

/** A project holding one cluster of desks, drawn over an empty part of the plan. */
function withCluster(): { project: ProjectT; zoneId: string } {
  const p = fixture();
  const levelId = p.levels[0]?.id as string;
  const tool = new ZoneTool({ levelId, piece: () => DEFAULT_PIECE, rule: () => DEFAULT_RULE });
  const options = { walls: [], pixelMm: 1, magnetism: false };
  tool.begin({ x: 30_000, y: 0 }, options);
  const command = tool.end({ x: 42_000, y: 8000 }, options);
  const result = apply(p, command, ctxOf());
  if (!result.ok) throw new Error(result.error.message);
  return { project: result.project, zoneId: result.project.zones[0]?.id as string };
}

const factOf = (facts: readonly Fact[], label: string): Fact => {
  const f = facts.find((x) => x.label === label);
  if (!f) throw new Error(`no fact called ${label}: ${facts.map((x) => x.label).join(", ")}`);
  return f;
};

describe("a desk cluster in the panel", () => {
  it("is described at all, and knows what it is called and what it holds", () => {
    const { project, zoneId } = withCluster();
    expect(kindOf(zoneId)).toBe("zone");
    const d = describeEntity(project, zoneId);
    if (!d) throw new Error("no description");
    expect(d.kind).toBe("zone");
    expect(d.title).toBe("Desk cluster");
    expect(factOf(d.facts, "Pattern").value).toBe("rows");
    expect(factOf(d.facts, "Gap across").value).toBe("600");
    expect(factOf(d.facts, "Facing").value).toBe("180");
    expect(factOf(d.facts, "Piece").value).toBe("Table");
    // asked for what fits, so nothing is missing
    const placed = project.zones[0]?.generatedItemIds.length as number;
    expect(factOf(d.facts, "Pieces").value).toBe(String(placed));
    expect(factOf(d.facts, "Standing").value).toBe(String(placed));
  });

  it("lays the pieces out again as one command when the pattern changes", () => {
    const { project, zoneId } = withCluster();
    const d = describeEntity(project, zoneId);
    const outcome = factOf(d?.facts ?? [], "Pattern").edit?.("bench");
    if (!outcome?.ok || !outcome.command) throw new Error("the pattern did not ask for anything");
    expect(outcome.command.type).toBe("item.arrange");
    expect(outcome.command.payload.target).toEqual({ zoneId });
    expect(outcome.command.payload.replace).toBe(true);

    const after = apply(project, outcome.command, ctxOf());
    if (!after.ok) throw new Error(after.error.message);
    const zone = after.project.zones[0];
    expect(zone?.rule?.pattern).toBe("bench");
    // the old desks went and new ones stand in their place, all in one entry
    expect(after.project.zones).toHaveLength(1);
    expect(after.project.items.filter((i) => i.tags.includes("generated"))).toHaveLength(
      zone?.generatedItemIds.length as number,
    );
    // a bench turns every other row to face back
    const rotations = new Set(
      after.project.items.filter((i) => i.tags.includes("generated")).map((i) => i.rotation),
    );
    expect(rotations.size).toBe(2);
  });

  it("keeps the same rule when only the gap changes, and asks for fewer when the gap grows", () => {
    const { project, zoneId } = withCluster();
    const before = project.zones[0]?.generatedItemIds.length as number;
    const d = describeEntity(project, zoneId);
    const outcome = factOf(d?.facts ?? [], "Gap across").edit?.("3000");
    if (!outcome?.ok || !outcome.command) throw new Error("the gap did not ask for anything");
    const rule = outcome.command.payload.rule as { spacing: { x: number; y: number }; pattern: string };
    expect(rule.spacing).toEqual({ x: 3000, y: 600 });
    expect(rule.pattern).toBe("rows");
    const after = apply(project, outcome.command, ctxOf());
    if (!after.ok) throw new Error(after.error.message);
    expect(after.project.zones[0]?.generatedItemIds.length).toBeLessThan(before);
  });

  it("refills the zone when the count is emptied, and says when nothing fits", () => {
    const { project, zoneId } = withCluster();
    const fits = project.zones[0]?.generatedItemIds.length as number;
    // ask for two, then empty the field: it goes back to what fits
    const fewer = factOf(describeEntity(project, zoneId)?.facts ?? [], "Pieces").edit?.("2");
    if (!fewer?.ok || !fewer.command) throw new Error("the count did not ask for anything");
    const two = apply(project, fewer.command, ctxOf());
    if (!two.ok) throw new Error(two.error.message);
    expect(two.project.zones[0]?.generatedItemIds).toHaveLength(2);

    const d2 = describeEntity(two.project, zoneId);
    expect(factOf(d2?.facts ?? [], "Standing").value).toBe("2");
    const refill = factOf(d2?.facts ?? [], "Pieces").edit?.("");
    if (!refill?.ok || !refill.command) throw new Error("emptying the count did not refill");
    expect((refill.command.payload.rule as { count: number }).count).toBe(fits);
    expect(refill.said).toBe(`${fits} filling the zone`);
  });

  it("refuses a count that is not a whole number, in words", () => {
    const { project, zoneId } = withCluster();
    const outcome = factOf(describeEntity(project, zoneId)?.facts ?? [], "Pieces").edit?.("a few");
    expect(outcome).toEqual({ ok: false, message: "Pieces needs a whole number, such as 24." });
  });

  it("takes its desks with it when it is deleted", () => {
    const { project, zoneId } = withCluster();
    const commands = deleteCommands([zoneId]);
    expect(commands).toEqual([{ type: "zone.delete", payload: { zoneIds: [zoneId], deleteItems: true } }]);
    const after = apply(project, commands[0], ctxOf());
    if (!after.ok) throw new Error(after.error.message);
    expect(after.project.zones).toHaveLength(0);
    expect(after.project.items.filter((i) => i.tags.includes("generated"))).toHaveLength(0);
  });
});

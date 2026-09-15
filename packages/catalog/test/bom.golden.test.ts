// PRD P1-3 acceptance: the boardroom fixture's BOM equals the golden CSV. The fixture is built through the
// real tools by tools/build-boardroom-fixture.ts. Regenerate the golden file deliberately with
// UPDATE_GOLDEN=1 and review the diff; never to make a failing test pass unseen.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Project, validate } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { AV_CORE, type BomCatalog, bomToCsv, checkDesign, getBom, LibraryManifest } from "../src/index.js";

const DIR = fileURLToPath(new URL("../../../tools/fixtures/boardroom.fpviz/", import.meta.url));
const NOW = "2026-09-15T12:00:00.000Z";

const project = Project.parse(JSON.parse(readFileSync(`${DIR}project.json`, "utf8")));
const library = LibraryManifest.parse(JSON.parse(readFileSync(`${DIR}catalog.json`, "utf8")));
const catalog: BomCatalog = {
  byCategory: (category) => library.products.filter((p) => p.category === category),
  product: (id) => library.products.find((p) => p.id === id) ?? null,
};

describe("boardroom fixture BOM (PRD P1-3)", () => {
  it("equals the golden CSV", () => {
    const csv = bomToCsv(getBom(project, AV_CORE, { now: NOW, catalog }), project);
    const golden = `${DIR}bom.csv`;
    if (process.env.UPDATE_GOLDEN) writeFileSync(golden, csv);
    expect(csv).toBe(readFileSync(golden, "utf8").replaceAll("\r\n", "\n"));
  });

  it("the room has no validation errors and passes every design rule", () => {
    expect(validate(project).filter((p) => p.severity === "error")).toEqual([]);
    expect(checkDesign(project, AV_CORE, { catalog })).toEqual([]);
  });

  it("every enabled core rule that applies to a furnished boardroom fires once", () => {
    const bom = getBom(project, AV_CORE, { now: NOW, catalog, explain: true });
    const fired = bom.lines
      .filter((l) => l.reason.kind === "rule")
      .map((l) => [l.reason.ruleId, l.productId ?? l.description]);
    expect(fired.sort()).toEqual(
      [
        ["bar-usb", "acme-usb-10m"],
        ["display-hdmi", "acme-hdmi-5m"],
        ["display-mount", "acme-vm-600"],
        ["mic-dsp", "acme-dsp-24"],
        ["network-ports", "PoE switch port"],
        ["scheduler", "acme-room-panel"],
        ["speaker-amp", "acme-amp-4"],
        ["table-power", "acme-table-box"],
      ].sort(),
    );
    expect(bom.lines.every((l) => l.status !== "placeholder" || l.reason.ruleId === "network-ports")).toBe(
      true,
    );
  });
});

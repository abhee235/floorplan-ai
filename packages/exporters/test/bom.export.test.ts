// ADR-013: the boardroom fixture's BOM as CSV (golden file) and XLSX (cell set), with provenance,
// highlighted verification status and byte-identical output for the same inputs.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AV_CORE, type BomCatalog, getBom, LibraryManifest } from "@fpv/catalog";
import { Project } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import {
  bomToExportCsv,
  bomToXlsx,
  EXPORT_CSV_COLUMNS,
  provenanceFor,
  readXlsxCells,
  STYLE_INDEX,
  sourceLookup,
  unzipStore,
} from "../src/index.js";

const DIR = fileURLToPath(new URL("../../../tools/fixtures/boardroom.fpviz/", import.meta.url));
const NOW = "2026-09-15T12:00:00.000Z";
const project = Project.parse(JSON.parse(readFileSync(`${DIR}project.json`, "utf8")));
const library = LibraryManifest.parse(JSON.parse(readFileSync(`${DIR}catalog.json`, "utf8")));
const catalog: BomCatalog = {
  byCategory: (category) => library.products.filter((p) => p.category === category),
  product: (id) => library.products.find((p) => p.id === id) ?? null,
};
const bom = getBom(project, AV_CORE, { now: NOW, catalog });
const provenance = (over: { draft?: boolean; validationErrors?: number; exportedAt?: string } = {}) =>
  provenanceFor(bom, project, {
    appVersion: "0.0.1",
    exportedAt: over.exportedAt ?? NOW,
    scope: "project",
    validationErrors: over.validationErrors ?? 0,
    draft: over.draft ?? false,
  });
const sources = sourceLookup(project, catalog);

describe("BOM CSV export (ADR-013 D3)", () => {
  it("equals the golden export CSV: BOM mark, provenance lines, header, one row per line, CRLF", () => {
    const csv = bomToExportCsv(bom, project, provenance(), sources);
    const golden = `${DIR}bom.export.csv`;
    if (process.env.UPDATE_GOLDEN) writeFileSync(golden, csv);
    expect(csv).toBe(readFileSync(golden, "utf8").replace(/\r?\n/g, "\r\n"));
    expect(csv.startsWith("\uFEFF# floorplan-ai bill of materials\r\n")).toBe(true);
    const rows = csv.split("\r\n");
    const header = rows.indexOf(EXPORT_CSV_COLUMNS.join(","));
    expect(header).toBeGreaterThan(0);
    expect(rows.slice(header + 1).filter(Boolean)).toHaveLength(bom.lines.length);
    expect(csv).toContain("# rules pack: av-core 1.0.0");
    expect(csv).toContain("# verification: contains unverified or placeholder lines; check before ordering");
    expect(csv).toContain("https://example.com/acme/acme-dsp-24");
  });

  it("a forced export says DRAFT; only the timestamp changes between runs", () => {
    expect(bomToExportCsv(bom, project, provenance({ draft: true, validationErrors: 2 }), sources)).toContain(
      "# status: DRAFT: exported with 2 validation error(s)",
    );
    const a = bomToExportCsv(bom, project, provenance({ exportedAt: "2026-09-15T12:00:00.000Z" }), sources);
    const b = bomToExportCsv(bom, project, provenance({ exportedAt: "2026-09-16T09:30:00.000Z" }), sources);
    expect(b.replace("2026-09-16T09:30:00.000Z", "2026-09-15T12:00:00.000Z")).toBe(a);
  });
});

describe("BOM XLSX export (ADR-013 D3)", () => {
  const bytes = bomToXlsx(bom, project, provenance(), sources);
  const book = readXlsxCells(unzipStore(bytes));
  const sheet = (name: string) => {
    const s = book.find((x) => x.name === name);
    if (!s) throw new Error(`no sheet ${name}`);
    return s.cells;
  };

  it("has Summary, one sheet per room, Project, Products and Provenance", () => {
    expect(book.map((s) => s.name)).toEqual(["Summary", "Boardroom", "Project", "Products", "Provenance"]);
  });

  it("Summary totals by status and by room match the BOM", () => {
    const s = sheet("Summary");
    const rows = [...s.values()];
    const valueRight = (label: string, col: "B" | "C") => {
      const cell = rows.find((c) => c.v === label && c.ref.startsWith("A"));
      return s.get(`${col}${cell?.ref.slice(1)}`)?.v;
    };
    expect(s.get("A1")?.v).toBe("Bill of materials: Boardroom task card");
    expect(valueRight("verified", "C")).toBe(bom.totals.verified);
    expect(valueRight("placeholder", "B")).toBe(bom.lines.filter((l) => l.status === "placeholder").length);
    expect(valueRight("all", "C")).toBe(bom.totals.all);
    expect(valueRight("Boardroom", "B")).toBe(bom.byRoom[0]?.lines);
    expect(rows.find((c) => String(c.v).startsWith("Contains unverified"))?.style).toBe(STYLE_INDEX.draft);
  });

  it("room lines are highlighted by status: unverified yellow, placeholder orange, verified plain", () => {
    const s = sheet("Boardroom");
    const header = [...s.values()].find((c) => c.v === "Status");
    const statusCol = header?.ref.replace(/\d+/, "") as string;
    const headerRow = Number(header?.ref.replace(/[A-Z]+/, ""));
    const room = bom.lines.filter((l) => l.scope.roomId !== null);
    room.forEach((l, i) => {
      const r = headerRow + 1 + i;
      expect(s.get(`${statusCol}${r}`)?.v).toBe(l.status);
      const expected =
        l.status === "unverified"
          ? STYLE_INDEX.unverified
          : l.status === "placeholder"
            ? STYLE_INDEX.placeholder
            : 0;
      expect(s.get(`A${r}`)?.style, `${l.productId ?? l.description}`).toBe(expected);
    });
    expect(s.get("A1")?.v).toBe("Room: Boardroom");
  });

  it("Project holds the door; Products lists each product once with sources; Provenance names the pack and snapshot", () => {
    expect([...sheet("Project").values()].some((c) => c.v === "generic-door-900")).toBe(true);
    const products = sheet("Products");
    const ids = [...products.values()].filter((c) => c.ref.startsWith("A") && c.ref !== "A1").map((c) => c.v);
    expect(ids).toEqual(
      [...new Set(bom.lines.map((l) => l.productId).filter((x): x is string => x !== null))].sort(),
    );
    expect([...products.values()].some((c) => c.v === "https://example.com/acme/acme-dsp-24")).toBe(true);
    const prov = [...sheet("Provenance").values()].map((c) => c.v);
    expect(prov).toEqual(
      expect.arrayContaining([
        "rules pack",
        "av-core 1.0.0",
        "catalog snapshot",
        bom.catalogSnapshotAt,
        "exported at",
        NOW,
      ]),
    );
  });

  it("is byte-identical for the same inputs and says DRAFT on every line sheet when forced", () => {
    expect(bomToXlsx(bom, project, provenance(), sources)).toEqual(bytes);
    const draft = readXlsxCells(
      unzipStore(bomToXlsx(bom, project, provenance({ draft: true, validationErrors: 1 }), sources)),
    );
    for (const name of ["Summary", "Boardroom", "Project"])
      expect(
        [...(draft.find((s) => s.name === name)?.cells.values() ?? [])].some(
          (c) => c.v === "DRAFT: exported with 1 validation error(s)",
        ),
      ).toBe(true);
  });
});

// The layout drawing (PRD P3-7, ADR-013 D5): a PDF and a DXF drawn from the same shapes as the editor's plan.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { planItems, planStructure, planZones } from "@fpv/engine";
import { dxfToDraft, parseDxf } from "@fpv/importers";
import { derive, Project, type Project as ProjectT } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import {
  catalogSnapshotOf,
  chooseScale,
  type DrawingProvenance,
  DXF_LAYERS,
  DxfWriter,
  dxfText,
  PdfPage,
  pdfNumber,
  projectToDxf,
  projectToPdf,
  scheduleOf,
  tagName,
  textWidth,
  writePdf,
} from "../src/index.js";

const fixture = (name: string): ProjectT =>
  Project.parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../../../tools/fixtures/${name}.fpviz/project.json`, import.meta.url)),
        "utf8",
      ),
    ),
  );
const L = "level_000000";
const provenance = (p: ProjectT, draft = false): DrawingProvenance => ({
  projectName: p.meta.name,
  appVersion: "9.9.9",
  exportedAt: "2026-11-17T09:30:00.000Z",
  catalogSnapshotAt: catalogSnapshotOf(p),
  draft,
  validationErrors: draft ? 2 : 0,
});
const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join("");

describe("the PDF writer", () => {
  it("writes numbers plainly, escapes strings, and measures Helvetica", () => {
    expect(pdfNumber(-0.0001)).toBe("0");
    expect(pdfNumber(12.5)).toBe("12.5");
    expect(pdfNumber(1 / 3)).toBe("0.333");
    expect(textWidth("A", 10)).toBeCloseTo(6.67, 2);
    expect(textWidth("A", 10, "bold")).toBeCloseTo(7.22, 2);
    const page = new PdfPage(100, 100).text("a (b) \\ 38.8 m² · x", 1, 1, { size: 8 });
    expect(page.content()).toContain("(a \\(b\\) \\\\ 38.8 m\\262 \\267 x) Tj");
  });

  it("writes a file whose cross-reference table points at every object, the same bytes every time", () => {
    const make = () => {
      const a = new PdfPage(200, 100).fill("rgba(10, 20, 30, 0.5)").rect(10, 10, 50, 20).fillPath();
      const b = new PdfPage(200, 100).stroke("#ff0000").lineWidth(1).moveTo(0, 0).lineTo(10, 10).strokePath();
      return writePdf([a, b], { title: "T (1)", producer: "p", createdAt: "2026-11-17T09:30:00.000Z" });
    };
    const bytes = make();
    expect(make()).toEqual(bytes);
    const text = latin1(bytes);
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    const start = Number(/startxref\n(\d+)\n/.exec(text)?.[1]);
    expect(text.slice(start, start + 4)).toBe("xref");
    const entries = text
      .slice(start)
      .split("\n")
      .slice(3)
      .filter((l) => / n $/.test(l));
    entries.forEach((e, i) => {
      const at = Number(e.slice(0, 10));
      expect(text.slice(at, at + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    expect(text).toContain("/Count 2");
    expect(text).toContain("/GA50 << /Type /ExtGState /ca 0.5 >>");
    expect(text).toContain("/CreationDate (D:20261117093000Z)");
  });
});

describe("the layout drawing as a PDF (PRD P3-7)", () => {
  it("P3-7 drawing matches the plan view primitives: every room, wall cut, opening, item and zone, once", () => {
    for (const name of ["boardroom", "six-wall-room"]) {
      const p = fixture(name);
      const sizes = derive.snapshotSizeSource(p);
      const out = projectToPdf(p, { levelIds: [L], sizes, provenance: provenance(p) });
      const s = planStructure(p, L);
      expect(out.sheets[0]?.drawn).toMatchObject({
        rooms: s.rooms.length,
        wallCuts: s.walls.length,
        openings: s.openings.length,
        items: planItems(p, L, sizes).length,
        zones: planZones(p, L).length,
      });
    }
  });

  it("draws the boardroom at 1:50 on A3 with its schedule, tags, mount heights and title block", () => {
    const p = fixture("boardroom");
    const out = projectToPdf(p, {
      levelIds: [L],
      sizes: derive.snapshotSizeSource(p),
      provenance: provenance(p),
    });
    expect(out.paper).toBe("A3");
    expect(out.sheets).toHaveLength(1);
    expect(out.sheets[0]).toMatchObject({ scale: 50, fits: true, kinds: 7 });
    // two wall items and four ceiling items: a height for each
    expect(out.sheets[0]?.drawn.mountNotes).toBe(6);
    expect(out.warnings).toEqual([]);
    const text = latin1(out.bytes);
    for (const s of [
      "(Boardroom task card) Tj",
      "(Scale 1:50 at A3) Tj",
      "(Schedule) Tj",
      "(CLG 2 700) Tj",
      "(8 100) Tj",
    ])
      expect(text).toContain(s);
    expect(text).not.toContain("(DRAFT) Tj");
    // landscape A3 in points
    expect(text).toContain("/MediaBox [0 0 1190.551 841.89]");
  });

  it("says DRAFT when forced over errors, frames a room, and warns when an asked scale runs off the sheet", () => {
    const p = fixture("boardroom");
    const sizes = derive.snapshotSizeSource(p);
    const draft = latin1(projectToPdf(p, { levelIds: [L], sizes, provenance: provenance(p, true) }).bytes);
    expect(draft).toContain("(DRAFT) Tj");
    expect(draft).toContain("(DRAFT: 2 validation errors) Tj");
    const tight = projectToPdf(p, { levelIds: [L], sizes, provenance: provenance(p), scale: 10 });
    expect(tight.sheets[0]).toMatchObject({ scale: 10, fits: false });
    expect(tight.warnings[0]).toContain("runs off an A3 sheet at 1:10");
    const room = projectToPdf(p, {
      levelIds: [L],
      roomId: p.rooms[0]?.id ?? null,
      sizes,
      provenance: provenance(p),
      paper: "A4",
    });
    expect(room.sheets[0]?.fits).toBe(true);
    expect(latin1(room.bytes)).toContain("at A4) Tj");
  });

  it("tags every kind of item once, in the same order every time", () => {
    const p = fixture("boardroom");
    const items = planItems(p, L, derive.snapshotSizeSource(p));
    const { rows, tags } = scheduleOf(items);
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(items.length);
    expect(new Set(tags.values()).size).toBe(rows.length);
    expect(scheduleOf([...items].reverse()).rows.map((r) => r.tag + r.title)).toEqual(
      rows.map((r) => r.tag + r.title),
    );
    expect([0, 25, 26, 27, 701].map(tagName)).toEqual(["A", "Z", "AA", "AB", "ZZ"]);
  });

  it("chooses the largest standard scale that fits", () => {
    expect(chooseScale({ w: 8100, h: 5100 }, { w: 270, h: 250 })).toEqual({ scale: 50, fits: true });
    expect(chooseScale({ w: 42000, h: 32000 }, { w: 270, h: 250 })).toEqual({ scale: 200, fits: true });
    expect(chooseScale({ w: 42000, h: 32000 }, { w: 270, h: 250 }, 100)).toEqual({ scale: 100, fits: false });
  });
});

describe("the DXF writer", () => {
  it("writes R12 in millimetres with its layers declared, arcs counter-clockwise and text escaped", () => {
    const dxf = new DxfWriter([{ name: "A", colour: 1 }]);
    dxf.arc("A", { x: 0, y: 0 }, 900, Math.PI / 2, -Math.PI / 2);
    dxf.text("A", "38.8 m²", { x: 0, y: 0 }, 100, "center");
    dxf.polyline("A", [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ]);
    const doc = parseDxf(dxf.toString());
    expect(doc.insUnits).toBe(4);
    const arc = doc.entities.find((e) => e.type === "ARC") as
      | { startAngle?: number; endAngle?: number }
      | undefined;
    expect(dxf.toString()).toMatch(/\n50\n0\n51\n90\n/);
    expect(arc).toBeDefined();
    expect(dxfText("38.8 m²")).toBe("38.8 m\\U+00B2");
    expect(doc.entities.find((e) => e.type === "POLYLINE")).toMatchObject({ closed: true });
    expect(() => dxf.line("B", { x: 0, y: 0 }, { x: 1, y: 1 })).toThrow("no layer B");
  });
});

describe("the layout drawing as a DXF (PRD P3-7)", () => {
  it("P3-7 puts every wall, opening, room and item on its layer, and our own importer reads the plan back", () => {
    const p = fixture("boardroom");
    const out = projectToDxf(p, {
      levelId: L,
      sizes: derive.snapshotSizeSource(p),
      provenance: provenance(p),
    });
    const text = latin1(out.bytes);
    const doc = parseDxf(text);
    for (const layer of Object.keys(out.counts)) expect(DXF_LAYERS.map((l) => l.name)).toContain(layer);
    expect(out.scale).toBe(50);
    expect(out.drawn).toMatchObject({ rooms: 1, wallCuts: 1, openings: 1, items: 18, scheduleRows: 7 });
    // the room's name and area are the only text on TEXT, so a reader cannot name the room after anything else
    const onText = doc.entities
      .filter((e) => e.layer === "TEXT" && e.type === "TEXT")
      .map((e) => (e as { text: string }).text);
    expect(onText).toEqual(
      ["Boardroom", "38.8 m\\U+00B2"].map((t) => expect.stringContaining(t.slice(0, 9))),
    );
    const back = dxfToDraft(text).draft;
    expect(back.walls).toHaveLength(p.walls.length);
    expect(back.openings.map((o) => o.kind)).toEqual(["door"]);
    expect(back.rooms.map((r) => r.name)).toEqual(["Boardroom"]);
  });
});

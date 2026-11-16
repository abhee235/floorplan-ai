import { AV_CORE, ensureSeed } from "@fpv/catalog";
import { CatalogStore } from "@fpv/catalog/store";
import { readXlsxCells, unzipStore } from "@fpv/exporters";
import { describe, expect, it } from "vitest";
import type { ExportWriter } from "../src/index.js";
import { harness, NOW } from "./helpers.js";

function memoryWriter(): ExportWriter & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    appVersion: "9.9.9",
    files,
    async write(path, bytes, { overwrite }) {
      if (files.has(path) && !overwrite)
        throw Object.assign(new Error(`${path} already exists`), {
          code: "file.exists",
          entityId: null,
          hint: "pass overwrite: true",
        });
      files.set(path, bytes);
      return { path: `/exports/${path}`, bytes: bytes.length };
    },
  };
}

async function furnishedBoardroom() {
  const catalog = CatalogStore.open(":memory:");
  ensureSeed(catalog, NOW);
  const writer = memoryWriter();
  const h = harness(undefined, { catalog, rules: AV_CORE, writer });
  await h.ok("create_room_from_brief", { brief: "10-seat boardroom, 8 by 5 metres, video conferencing" });
  return { h, writer, catalog };
}

describe("export tool (PRD P1-5, ADR-013 D2)", () => {
  it("refuses unverified or placeholder lines unless includeUnverified, then writes an XLSX that highlights them", async () => {
    const { h, writer, catalog } = await furnishedBoardroom();
    const refused = await h.call("export", { format: "xlsx", path: "bom.xlsx" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("export.unverified");
      expect(refused.error.hint).toContain("includeUnverified: true");
    }
    expect(writer.files.size).toBe(0);
    const r = await h.ok<{
      path: string;
      bytes: number;
      lines: number;
      draft: boolean;
      includesUnverified: boolean;
    }>("export", {
      format: "xlsx",
      path: "bom.xlsx",
      includeUnverified: true,
    });
    expect(r.result).toMatchObject({ path: "/exports/bom.xlsx", draft: false, includesUnverified: true });
    expect(r.warnings.some((w) => w.includes("highlighted"))).toBe(true);
    const book = readXlsxCells(unzipStore(writer.files.get("bom.xlsx") as Uint8Array));
    expect(book.map((s) => s.name)).toEqual(["Summary", "Boardroom", "Project", "Products", "Provenance"]);
    expect([...(book[4]?.cells.values() ?? [])].map((c) => c.v)).toEqual(
      expect.arrayContaining(["app version", "9.9.9"]),
    );
    catalog.close();
  });

  it("refuses on validation errors unless force, and a forced CSV is marked DRAFT", async () => {
    const { h, writer, catalog } = await furnishedBoardroom();
    // remove the snapshots so every placed product is an error (catalog.missing-snapshot)
    h.ctx.store.load({ ...h.ctx.store.project, catalogRefs: {} });
    const refused = await h.call("export", { format: "csv", path: "bom.csv", includeUnverified: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("export.invalid");
      expect(refused.error.message).toContain("catalog.missing-snapshot");
      expect(refused.error.hint).toContain("force: true");
    }
    const forced = await h.ok<{ draft: boolean }>("export", {
      format: "csv",
      path: "bom.csv",
      includeUnverified: true,
      force: true,
    });
    expect(forced.result.draft).toBe(true);
    const text = new TextDecoder().decode(writer.files.get("bom.csv"));
    expect(text).toMatch(/# status: DRAFT: exported with \d+ validation error\(s\)/);
    catalog.close();
  });

  it("scopes, existing files and sessions without a writer", async () => {
    const { h, writer, catalog } = await furnishedBoardroom();
    const room = h.ctx.store.project.rooms[0]?.id as string;
    await h.ok("export", { format: "csv", path: "room.csv", scope: `room:${room}`, includeUnverified: true });
    const text = new TextDecoder().decode(writer.files.get("room.csv"));
    expect(text).toContain(`# scope: room:${room}`);
    expect(text).not.toContain("generic-door"); // the door is a level line, outside the room scope
    const again = await h.call("export", {
      format: "csv",
      path: "room.csv",
      scope: `room:${room}`,
      includeUnverified: true,
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("file.exists");
    expect(
      (
        await h.call("export", {
          format: "csv",
          path: "room.csv",
          scope: `room:${room}`,
          includeUnverified: true,
          overwrite: true,
        })
      ).ok,
    ).toBe(true);
    const badScope = await h.call("export", { format: "csv", path: "x.csv", scope: "room:room_zzzzzz" });
    expect(badScope.ok).toBe(false);
    const noWriter = harness(undefined, { rules: AV_CORE });
    const nw = await noWriter.call("export", { format: "csv", path: "x.csv" });
    expect(nw.ok).toBe(false);
    if (!nw.ok)
      expect(nw.error.message).toBe("export is unavailable because this session cannot write files");
    catalog.close();
  });

  it("P3-7 writes the layout drawing as a PDF and as a DXF, with no rules pack or verification needed", async () => {
    const { h, writer, catalog } = await furnishedBoardroom();
    const pdf = await h.ok<{ path: string; pages: number; scale: number; lines: number; draft: boolean }>(
      "export",
      {
        format: "pdf",
        path: "layout.pdf",
      },
    );
    expect(pdf.result).toMatchObject({ path: "/exports/layout.pdf", pages: 1, scale: 50, draft: false });
    expect(pdf.result.lines).toBeGreaterThan(3);
    const pdfText = new TextDecoder("latin1").decode(writer.files.get("layout.pdf"));
    expect(pdfText.startsWith("%PDF-1.4")).toBe(true);
    expect(pdfText).toContain("(floorplan-ai 9.9.9) Tj");
    const dxf = await h.ok<{ pages: number; scale: number }>("export", {
      format: "dxf",
      path: "layout.dxf",
      paper: "A2",
    });
    expect(dxf.result).toMatchObject({ pages: 1, scale: 50 });
    expect(dxf.warnings).toContain("paper applies to pdf only; a DXF has no sheet");
    expect(new TextDecoder().decode(writer.files.get("layout.dxf"))).toContain("AC1009");
    // a room scope frames the room on A4
    const room = h.ctx.store.project.rooms[0]?.id as string;
    const framed = await h.ok<{ pages: number }>("export", {
      format: "pdf",
      path: "room.pdf",
      scope: `room:${room}`,
      paper: "A4",
    });
    expect(framed.result.pages).toBe(1);
    catalog.close();
  });

  it("P3-7 draws a sheet per level, asks a DXF for one level, and marks a drawing forced over errors DRAFT", async () => {
    const { h, writer, catalog } = await furnishedBoardroom();
    await h.ok("add_level", { name: "First floor" });
    const levels = h.ctx.store.project.levels;
    expect(levels).toHaveLength(2);
    const pdf = await h.ok<{ pages: number }>("export", { format: "pdf", path: "all.pdf" });
    expect(pdf.result.pages).toBe(2);
    expect(pdf.warnings).toEqual([]);
    const refused = await h.call("export", { format: "dxf", path: "all.dxf" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("export.scope");
      expect(refused.error.hint).toContain(`level:${levels[0]?.id}`);
    }
    const upstairs = await h.ok("export", {
      format: "dxf",
      path: "first.dxf",
      scope: `level:${levels[1]?.id}`,
    });
    expect(upstairs.warnings).toContain("the drawing is empty for this scope");
    // without the snapshots every placed product is an error
    h.ctx.store.load({ ...h.ctx.store.project, catalogRefs: {} });
    const invalid = await h.call("export", { format: "pdf", path: "bad.pdf" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe("export.invalid");
    const forced = await h.ok<{ draft: boolean }>("export", { format: "pdf", path: "bad.pdf", force: true });
    expect(forced.result.draft).toBe(true);
    expect(new TextDecoder("latin1").decode(writer.files.get("bad.pdf"))).toContain("(DRAFT) Tj");
    catalog.close();
  });

  it("writes the scene as a GLB with one node per entity, needing no BOM verification (PRD P2-5)", async () => {
    const { h, writer, catalog } = await furnishedBoardroom();
    const r = await h.ok<{ format: string; nodes: number; triangles: number; draft: boolean }>("export", {
      format: "glb",
      path: "room.glb",
      force: true,
    });
    expect(r.result.format).toBe("glb");
    expect(r.result.nodes).toBeGreaterThan(5);
    expect(r.result.triangles).toBeGreaterThan(0);
    const bytes = writer.files.get("room.glb") as Uint8Array;
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("glTF");
    const badScope = await h.call("export", { format: "glb", path: "x.glb", scope: "room:room_zzzzzz" });
    expect(badScope.ok).toBe(false);
    if (!badScope.ok) expect(badScope.error.code).toBe("ref.missing");
    catalog.close();
  });
});

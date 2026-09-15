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

  it("scopes, existing files, formats of later phases and sessions without a writer", async () => {
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
    const glb = await h.call("export", { format: "glb", path: "x.glb" });
    expect(glb.ok).toBe(false);
    if (!glb.ok) expect(glb.error.code).toBe("unavailable");
    const badScope = await h.call("export", { format: "csv", path: "x.csv", scope: "room:room_zzzzzz" });
    expect(badScope.ok).toBe(false);
    const noWriter = harness(undefined, { rules: AV_CORE });
    const nw = await noWriter.call("export", { format: "csv", path: "x.csv" });
    expect(nw.ok).toBe(false);
    if (!nw.ok)
      expect(nw.error.message).toBe("export is unavailable because this session cannot write files");
    catalog.close();
  });
});

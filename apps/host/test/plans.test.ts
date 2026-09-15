import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FilePlanReader } from "../src/plans.js";
import { createSession } from "../src/session.js";

const PLANS = fileURLToPath(new URL("../../../tools/fixtures/plans/", import.meta.url));

describe("FilePlanReader", () => {
  it("reads a DXF by absolute path and by a path relative to its base directory", async () => {
    const reader = new FilePlanReader({ baseDir: () => PLANS });
    const abs = await reader.read({ path: join(PLANS, "office-mm.dxf") });
    const rel = await reader.read({ path: "office-mm.dxf" });
    expect(abs.fileName).toBe("office-mm.dxf");
    expect(abs.draft.walls).toHaveLength(6);
    expect(rel.draft).toEqual(abs.draft);
    expect(abs.preview.segments.length).toBeGreaterThan(0);
  });

  it("decodes old code-page DXF text and reads content without a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fpv-plans-"));
    const text = await new FilePlanReader({ baseDir: () => PLANS }).read({ path: "office-mm.dxf" });
    expect(text.draft.rooms[0]?.name).toBe("BOARDROOM");
    // a label with a Latin-1 "é" byte that is not valid UTF-8
    const source = (await import("node:fs"))
      .readFileSync(join(PLANS, "lshape-metres.dxf"), "latin1")
      .replace("Reception", "R\xe9ception");
    writeFileSync(join(dir, "fr.dxf"), Buffer.from(source, "latin1"));
    const fr = await new FilePlanReader({ baseDir: () => dir }).read({ path: "fr.dxf" });
    expect(fr.draft.rooms.map((r) => r.name)).toContain("Réception");
    const inline = await new FilePlanReader().read({ content: source, fileName: "inline.dxf" });
    expect(inline.fileName).toBe("inline.dxf");
  });

  it("refuses missing files, DWG and oversized plans with tool errors", async () => {
    const reader = new FilePlanReader({ baseDir: () => PLANS, maxBytes: 1000 });
    await expect(reader.read({ path: "nope.dxf" })).rejects.toMatchObject({ code: "file.missing" });
    await expect(reader.read({ content: "", fileName: "plan.dwg" })).rejects.toMatchObject({
      code: "import.format",
    });
    await expect(reader.read({ path: "office-mm.dxf" })).rejects.toMatchObject({ code: "import.too-large" });
    await expect(reader.read({})).rejects.toMatchObject({ code: "args.invalid" });
  });

  it("a host session imports a fixture plan end to end through the registry", async () => {
    const session = createSession({ plans: new FilePlanReader({ baseDir: () => PLANS }) });
    const review = await session.registry.call("import_plan", { path: "rotated-inches.dxf" });
    expect(review.ok).toBe(true);
    const id = review.ok ? (review.result as { draftId: string }).draftId : "";
    const done = await session.registry.call("import_plan", { draftId: id, confirm: true });
    expect(done.ok).toBe(true);
    expect(session.store.project.walls.length).toBeGreaterThan(0);
    expect(session.store.project.provenance?.sourceFile).toBe("rotated-inches.dxf");
  });
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanReaderRole } from "@fpv/agents";
import { RasterReply, rasterReplyToDraft } from "@fpv/importers";
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
    expect(abs.preview?.segments.length).toBeGreaterThan(0);
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

describe("image plans through the reader model (P2-2)", () => {
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  const fakeRaster = (calls: { fileName: string; width: number; dataUrl: string }[]): PlanReaderRole => ({
    id: "fake:vision",
    async read(image) {
      calls.push({ fileName: image.fileName, width: image.info.width, dataUrl: image.dataUrl });
      const reply = RasterReply.parse({
        walls: [
          { from: [100, 100], to: [900, 100], thickness: 10 },
          { from: [900, 100], to: [900, 450], thickness: 10 },
          { from: [900, 450], to: [100, 450], thickness: 10 },
          { from: [100, 450], to: [100, 100], thickness: 10 },
        ],
        rooms: [{ name: "HUDDLE", at: [500, 275] }],
      });
      return {
        draft: rasterReplyToDraft(reply, image.info, { file: image.fileName }),
        reply,
        refined: null,
        attempts: 1,
        usage: { promptTokens: 0, completionTokens: 0 },
      };
    },
  });

  it("an image goes to the reader model with its size; the draft carries the image for the review", async () => {
    const calls: { fileName: string; width: number; dataUrl: string }[] = [];
    const reader = new FilePlanReader({ baseDir: () => PLANS, raster: fakeRaster(calls) });
    const out = await reader.read({
      contentBase64: png(1600, 800).toString("base64"),
      fileName: "level1.png",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ fileName: "level1.png", width: 1600 });
    expect(calls[0]?.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(out.draft.source).toMatchObject({ kind: "image", pixelSize: { w: 1600, h: 800 } });
    expect(out.image).toMatchObject({ width: 1600, height: 800 });
    expect(out.preview).toBeNull();
    expect(out.report.warnings.some((w) => w.includes("fake:vision"))).toBe(true);
  });

  it("without a reader model image plans are refused with a way forward; non-images are refused", async () => {
    const reader = new FilePlanReader({ baseDir: () => PLANS });
    await expect(
      reader.read({ contentBase64: png(800, 600).toString("base64"), fileName: "a.png" }),
    ).rejects.toMatchObject({
      code: "unavailable",
      hint: expect.stringContaining("roles.reader"),
    });
    const withModel = new FilePlanReader({ baseDir: () => PLANS, raster: fakeRaster([]) });
    await expect(
      withModel.read({ contentBase64: Buffer.from("not an image").toString("base64"), fileName: "a.png" }),
    ).rejects.toMatchObject({ code: "import.format" });
  });

  it("import_plan reviews an image draft whose scale must be confirmed before it commits", async () => {
    const session = createSession({
      plans: new FilePlanReader({ baseDir: () => PLANS, raster: fakeRaster([]) }),
    });
    const review = await session.registry.call("import_plan", {
      contentBase64: png(1600, 800).toString("base64"),
      fileName: "level1.png",
    });
    expect(review.ok).toBe(true);
    const result = (review.ok ? review.result : {}) as { draftId: string; scale: { confirmed: boolean } };
    expect(result.scale.confirmed).toBe(false);
    const refused = await session.registry.call("import_plan", { draftId: result.draftId, confirm: true });
    expect(refused.ok || refused.error.code).toBe("import.scale-unconfirmed");
    const done = await session.registry.call("import_plan", {
      draftId: result.draftId,
      confirm: true,
      scale: { mmPerUnit: 10 },
    });
    expect(done.ok).toBe(true);
    expect(session.store.project.walls).toHaveLength(4);
    expect(session.store.project.rooms.map((r) => r.name)).toEqual(["HUDDLE"]);
  });
});

// import_texture (ADR-010 D10, PRD P3-8): a picture a person brings, made into a texture.
import { deflateSync } from "node:zlib";
import { encodePng } from "@fpv/assets";
import type { Texture } from "@fpv/catalog";
import { describe, expect, it } from "vitest";
import type { Attachment, TextureImporter, TextureImportRequest } from "../src/index.js";
import { harness } from "./helpers.js";

const png = (width: number, height: number) =>
  encodePng({ width, height, rgb: new Uint8Array(width * height * 3).fill(128) }, (d) => deflateSync(d));
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
/** The start of a JPEG: enough for its size to be read. */
const jpeg = (width: number, height: number) =>
  new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    3,
    1,
    0x11,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);

/** Keeps what it is given in memory, as the host keeps it on disk. */
function keeper(): TextureImporter & { requests: TextureImportRequest[] } {
  const requests: TextureImportRequest[] = [];
  const byBytes = new Map<string, Texture>();
  return {
    requests,
    add(request) {
      requests.push(request);
      const key = base64(request.bytes);
      const known = byBytes.get(key);
      if (known) return { texture: known, existing: true };
      const texture = {
        id: `user/t${byBytes.size + 1}`,
        name: request.name,
        image: "sha256:x",
        widthMm: request.widthMm,
        heightMm: request.heightMm,
        transparent: false,
        creator: null,
        licence: { id: "own" as const, author: null, sourceUrl: null, attribution: null },
        tags: request.tags,
      };
      byBytes.set(key, texture);
      return { texture, existing: false };
    },
  };
}

describe("import_texture (P3-8)", () => {
  it("makes a PNG a texture at the width given, its height from the picture's shape, named after its file", async () => {
    const textures = keeper();
    const h = harness(undefined, { textures });
    const r = await h.ok<{
      id: string;
      name: string;
      widthMm: number;
      heightMm: number;
      pixels: object;
      existing: boolean;
    }>("import_texture", { contentBase64: base64(png(40, 30)), fileName: "oak-plank_02.png", widthMm: 600 });
    expect(r.result).toMatchObject({
      id: "user/t1",
      name: "Oak plank 02",
      widthMm: 600,
      heightMm: 450,
      existing: false,
    });
    expect(r.result.pixels).toEqual({ width: 40, height: 30 });
    expect(textures.requests[0]).toMatchObject({ mime: "image/png", widthMm: 600, heightMm: 450, tags: [] });
    // 200 mm when no width is given, and a name given wins over the file's
    const jpg = await h.ok<{ widthMm: number; heightMm: number; name: string }>("import_texture", {
      contentBase64: `data:image/jpeg;base64,${base64(jpeg(100, 50))}`,
      fileName: "x.jpg",
      name: "Grey carpet",
    });
    expect(jpg.result).toMatchObject({ widthMm: 200, heightMm: 100, name: "Grey carpet" });
    expect(textures.requests[1]?.mime).toBe("image/jpeg");
  });

  it("goes by what the bytes are, not the name, and refuses what cannot be a texture", async () => {
    const h = harness(undefined, { textures: keeper() });
    const text = await h.call("import_texture", {
      contentBase64: base64(new TextEncoder().encode("0\nSECTION\n")),
      fileName: "plan.png",
    });
    expect(text.ok).toBe(false);
    if (!text.ok)
      expect(text.error).toMatchObject({ code: "texture.format", message: "the file is not a picture" });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 10, 0, 0, 0, 0]);
    const refused = await h.call("import_texture", { contentBase64: base64(gif), fileName: "a.gif" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toBe("a GIF picture cannot be a texture");
    const nothing = await h.call("import_texture", { fileName: "a.png" });
    expect(nothing.ok).toBe(false);
  });

  it("warns about a large picture, and says when the picture is already a texture", async () => {
    const h = harness(undefined, { textures: keeper() });
    const big = base64(png(2100, 10));
    const first = await h.ok("import_texture", { contentBase64: big, fileName: "wide.png" });
    expect(first.warnings[0]).toContain("2100 by 10 pixels");
    const again = await h.ok<{ existing: boolean }>("import_texture", {
      contentBase64: big,
      fileName: "copy.png",
    });
    expect(again.result.existing).toBe(true);
    expect(again.warnings).toContain('This picture is already the texture "Wide"; that one is used.');
  });

  it("takes a picture attached to the conversation, and names what is attached when the id is not", async () => {
    const files: Attachment[] = [
      { id: "a1", name: "felt.png", mime: "image/png", bytes: png(8, 8) } as Attachment,
    ];
    const attachments = {
      get: (id: string) => files.find((f) => f.id === id) ?? null,
      list: () => files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.bytes.length })),
    };
    const h = harness(undefined, { textures: keeper(), attachments });
    const r = await h.ok<{ name: string }>("import_texture", { attachmentId: "a1" });
    expect(r.result.name).toBe("Felt");
    const missing = await h.call("import_texture", { attachmentId: "a9" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.hint).toBe("attached: a1 (felt.png)");
  });

  it("is unavailable where nothing can keep the picture", async () => {
    const r = await harness().call("import_texture", { contentBase64: base64(png(4, 4)), fileName: "a.png" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("unavailable");
  });
});

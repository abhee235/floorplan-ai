// Pictures imported as textures (ADR-010 D7, D10; ADR-012 D1; PRD P3-8): kept by their hash, served,
// found transparent or not once, carried in the project's assets/ folder, and taken back in on open.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { CatalogStore } from "@fpv/catalog/store";
import { crc32 } from "@fpv/exporters";
import { Project, sequentialIdGenerator } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import {
  createSession,
  hasTransparency,
  MANIFEST_FILE,
  type Manifest,
  ProjectFileStore,
  TextureImages,
  UserTextures,
} from "../src/index.js";

const NOW = "2026-11-17T10:00:00.000Z";
const tmp = () => mkdtempSync(join(tmpdir(), "fpv-user-textures-"));
const fixture = () =>
  Project.parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../tools/fixtures/six-wall-room.fpviz/project.json", import.meta.url)),
        "utf8",
      ),
    ),
  );

// ---- PNGs made here, so every filter and colour type can be tried ----

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function chunk(type: string, data: Uint8Array): number[] {
  const body = new Uint8Array([...type].map((c) => c.charCodeAt(0)).concat([...data]));
  return [...be32(data.length), ...body, ...be32(crc32(body))];
}
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
/** A PNG of the given unfiltered rows, row n written with filter n % 5 so all five are read back. */
function pngOf(
  colour: number,
  width: number,
  rows: number[][],
  extra: { plte?: number[]; trns?: number[] } = {},
) {
  const bpp = CHANNELS[colour] as number;
  const raw: number[] = [];
  let prev = new Array(width * bpp).fill(0);
  rows.forEach((row, y) => {
    const f = y % 5;
    raw.push(f);
    row.forEach((v, x) => {
      const a = x >= bpp ? (row[x - bpp] as number) : 0;
      const b = prev[x] as number;
      const c = x >= bpp ? (prev[x - bpp] as number) : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f] as number;
      raw.push((v - pred) & 255);
    });
    prev = row;
  });
  const ihdr = new Uint8Array([...be32(width), ...be32(rows.length), 8, colour, 0, 0, 0]);
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk("IHDR", ihdr),
    ...(extra.plte ? chunk("PLTE", new Uint8Array(extra.plte)) : []),
    ...(extra.trns ? chunk("tRNS", new Uint8Array(extra.trns)) : []),
    ...chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(raw)))),
    ...chunk("IEND", new Uint8Array()),
  ]);
}
/** RGBA rows of varied colour, every alpha 255 but the one given. */
function rgbaRows(
  width: number,
  height: number,
  translucent?: { x: number; y: number; alpha: number },
): number[][] {
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => [
      (x * 37 + y * 11) & 255,
      (x * 5 + y * 73) & 255,
      (x * 91 + y) & 255,
      translucent && translucent.x === x && translucent.y === y ? translucent.alpha : 255,
    ]).flat(),
  );
}
const webp = (tag: string, flags: number[]) =>
  new Uint8Array([
    ...[..."RIFF"].map((c) => c.charCodeAt(0)),
    30,
    0,
    0,
    0,
    ...[..."WEBP"].map((c) => c.charCodeAt(0)),
    ...[...tag].map((c) => c.charCodeAt(0)),
    10,
    0,
    0,
    0,
    ...flags,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);

describe("a picture's transparency, found once at import (ADR-010 D7)", () => {
  it("reads an RGBA PNG through all five filters: opaque everywhere is not transparent, one see-through pixel is", () => {
    expect(hasTransparency(pngOf(6, 9, rgbaRows(9, 10)), "image/png")).toBe(false);
    expect(hasTransparency(pngOf(6, 9, rgbaRows(9, 10, { x: 8, y: 9, alpha: 254 })), "image/png")).toBe(true);
    expect(hasTransparency(pngOf(6, 9, rgbaRows(9, 10, { x: 0, y: 4, alpha: 0 })), "image/png")).toBe(true);
  });

  it("reads grey with alpha, a palette's own alphas and a transparent key colour", () => {
    const grey = (alpha: number) => [
      [10, 255, 20, 255],
      [30, 255, 40, alpha],
    ];
    expect(hasTransparency(pngOf(4, 2, grey(255)), "image/png")).toBe(false);
    expect(hasTransparency(pngOf(4, 2, grey(3)), "image/png")).toBe(true);
    const palette = { plte: [0, 0, 0, 255, 255, 255] };
    expect(hasTransparency(pngOf(3, 2, [[0, 1]], { ...palette, trns: [255, 255] }), "image/png")).toBe(false);
    expect(hasTransparency(pngOf(3, 2, [[0, 1]], { ...palette, trns: [255, 0] }), "image/png")).toBe(true);
    expect(hasTransparency(pngOf(2, 1, [[1, 2, 3]]), "image/png")).toBe(false);
    expect(hasTransparency(pngOf(2, 1, [[1, 2, 3]], { trns: [0, 1, 0, 2, 0, 3] }), "image/png")).toBe(true);
  });

  it("never finds it in a JPEG, and takes a WebP at its header's word", () => {
    expect(hasTransparency(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg")).toBe(false);
    expect(hasTransparency(webp("VP8X", [0x10]), "image/webp")).toBe(true);
    expect(hasTransparency(webp("VP8X", [0x00]), "image/webp")).toBe(false);
    expect(hasTransparency(webp("VP8L", [0x2f, 0, 0, 0, 0x10]), "image/webp")).toBe(true);
    expect(hasTransparency(webp("VP8 ", [0x2f]), "image/webp")).toBe(false);
  });
});

describe("pictures kept as textures (P3-8)", () => {
  const request = (bytes: Uint8Array, name: string) => ({
    bytes,
    mime: "image/png" as const,
    name,
    widthMm: 600,
    heightMm: 600,
    tags: ["floor"],
  });

  it("keeps a picture once by its hash, as a texture of the user library, and serves it", () => {
    const data = tmp();
    const catalog = CatalogStore.open(":memory:");
    const kept = new UserTextures(catalog, data);
    const picture = pngOf(6, 4, rgbaRows(4, 4));
    const first = kept.add(request(picture, "Oak"));
    expect(first.existing).toBe(false);
    expect(first.texture).toMatchObject({
      id: "user/oak",
      name: "Oak",
      transparent: false,
      tags: ["imported", "floor"],
    });
    expect(first.texture.licence.id).toBe("own");
    const files = readdirSync(join(data, "user", "textures"));
    expect(files).toEqual([`${first.texture.image.slice("sha256:".length)}.png`]);
    // the same picture under another name is the same texture; another picture with the name is numbered
    expect(kept.add(request(picture, "Copy of oak"))).toMatchObject({
      existing: true,
      texture: { id: "user/oak" },
    });
    expect(kept.add(request(pngOf(6, 4, rgbaRows(4, 5)), "Oak")).texture.id).toBe("user/oak-2");
    const served = new TextureImages(catalog, data, kept).image("user/oak");
    expect(served?.type).toBe("image/png");
    expect(served?.bytes).toEqual(picture);
    expect(new TextureImages(catalog, data).image("user/oak")).toBeNull();
    catalog.close();
  });

  it("carries the pictures a project uses in its assets/ folder, and another installation takes them back in", async () => {
    // one installation imports a picture, puts it on a wall and saves
    const dataA = tmp();
    const catalogA = CatalogStore.open(":memory:");
    const keptA = new UserTextures(catalogA, dataA);
    const assets = (k: UserTextures) => ({
      assetsFor: (p: Parameters<UserTextures["assetsFor"]>[0]) => k.assetsFor(p),
      adopt: (p: Parameters<UserTextures["adopt"]>[0], dir: string) => k.adopt(p, dir),
    });
    const filesA = new ProjectFileStore({ now: () => NOW, autosaveMs: 60_000, assets: assets(keptA) });
    const a = createSession({
      files: filesA,
      project: fixture(),
      catalog: catalogA,
      textures: keptA,
      ids: sequentialIdGenerator(900),
      now: () => NOW,
    });
    const picture = pngOf(6, 4, rgbaRows(4, 4));
    const made = await a.registry.call("import_texture", {
      contentBase64: Buffer.from(picture).toString("base64"),
      fileName: "slate.png",
      widthMm: 300,
    });
    expect(made.ok).toBe(true);
    const id = (made as { result: { id: string } }).result.id;
    const wall = a.store.project.walls[0]?.id as string;
    // the person picks it in the panel, so the call is the editor's: a person's wall is theirs to change
    const fin = await a.registry.call(
      "finish_wall",
      { wallId: wall, face: "both", texture: id },
      { origin: "editor" },
    );
    expect(fin.ok).toBe(true);
    const where = tmp();
    await filesA.save(where);
    const hex = (a.store.project.textures[id] as unknown as { image: string }).image.slice("sha256:".length);
    expect(readdirSync(join(where, "assets"))).toEqual([`${hex}.png`]);
    const manifest = JSON.parse(readFileSync(join(where, MANIFEST_FILE), "utf8")) as Manifest;
    expect(manifest.assets).toEqual([{ key: hex, file: `${hex}.png`, sha256: hex }]);

    // another installation, which has never seen the picture, opens the project
    const dataB = tmp();
    const catalogB = CatalogStore.open(":memory:");
    const keptB = new UserTextures(catalogB, dataB);
    const filesB = new ProjectFileStore({ now: () => NOW, assets: assets(keptB) });
    expect(catalogB.getTexture(id)).toBeNull();
    await filesB.open(where);
    expect(catalogB.getTexture(id)).toMatchObject({ id, name: "Slate", widthMm: 300 });
    expect(new TextureImages(catalogB, dataB, keptB).image(id)?.bytes).toEqual(picture);

    // a picture whose bytes do not match its name is not taken in
    const dataC = tmp();
    const catalogC = CatalogStore.open(":memory:");
    const keptC = new UserTextures(catalogC, dataC);
    writeFileSync(join(where, "assets", `${hex}.png`), new Uint8Array([1, 2, 3]));
    await new ProjectFileStore({ now: () => NOW, assets: assets(keptC) }).open(where);
    expect(catalogC.getTexture(id)).toBeNull();
    expect(keptC.fileFor(hex)).toBeNull();
    for (const c of [catalogA, catalogB, catalogC]) c.close();
  });
});

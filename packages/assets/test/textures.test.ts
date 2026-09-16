// The textures the app draws itself (P3-5): deterministic, tiling, and written out as valid PNG.
import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodePng, GENERATED_TEXTURES, renderGeneratedTexture } from "../src/index.js";

const pixel = (img: { width: number; rgb: Uint8Array }, x: number, y: number) =>
  [0, 1, 2].map((c) => img.rgb[(y * img.width + x) * 3 + c] as number);
const diff = (a: number[], b: number[]) => a.reduce((n, v, i) => n + Math.abs(v - (b[i] as number)), 0);

describe("generated textures", () => {
  it("draws every texture it lists, the same way every time", () => {
    for (const t of GENERATED_TEXTURES) {
      const a = renderGeneratedTexture(t.name, 64);
      const b = renderGeneratedTexture(t.name, 64);
      expect(a, t.name).not.toBeNull();
      expect(a?.rgb.length).toBe(64 * 64 * 3);
      expect(Buffer.from(a?.rgb ?? []).equals(Buffer.from(b?.rgb ?? []))).toBe(true);
      expect(t.widthMm).toBeGreaterThan(0);
      expect(t.heightMm).toBeGreaterThan(0);
    }
    expect(renderGeneratedTexture("marble")).toBeNull();
    expect(new Set(GENERATED_TEXTURES.map((t) => t.name)).size).toBe(GENERATED_TEXTURES.length);
  });

  it("tiles: across each edge the colour changes no more than it does inside", () => {
    for (const t of GENERATED_TEXTURES) {
      const img = renderGeneratedTexture(t.name, 128);
      if (!img) throw new Error(t.name);
      let inside = 0;
      let across = 0;
      for (let y = 0; y < 128; y += 1) {
        inside += diff(pixel(img, 63, y), pixel(img, 64, y));
        across += diff(pixel(img, 127, y), pixel(img, 0, y));
      }
      for (let x = 0; x < 128; x += 1) {
        inside += diff(pixel(img, x, 63), pixel(img, x, 64));
        across += diff(pixel(img, x, 127), pixel(img, x, 0));
      }
      // a seam would make the edge stand out; patterns with lines on the edge (grout, mortar) may match it
      expect(across, t.name).toBeLessThanOrEqual(inside * 2.5 + 256);
    }
  });

  it("is not a flat colour", () => {
    for (const t of GENERATED_TEXTURES) {
      const img = renderGeneratedTexture(t.name, 64);
      if (!img) throw new Error(t.name);
      const distinct = new Set<string>();
      for (let i = 0; i < img.rgb.length; i += 3)
        distinct.add(`${img.rgb[i]},${img.rgb[i + 1]},${img.rgb[i + 2]}`);
      expect(distinct.size, t.name).toBeGreaterThan(20);
    }
  });
});

describe("PNG encoding", () => {
  it("writes a PNG a decoder reads back pixel for pixel", () => {
    const img = renderGeneratedTexture("oak", 16);
    if (!img) throw new Error("no oak");
    const png = encodePng(img, (d) => deflateSync(d));
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(new TextDecoder().decode(png.subarray(12, 16))).toBe("IHDR");
    expect([view.getUint32(16), view.getUint32(20), png[24], png[25]]).toEqual([16, 16, 8, 2]);
    // the IDAT chunk inflates to one filter byte and three bytes a pixel per row
    const idatLength = view.getUint32(33);
    expect(new TextDecoder().decode(png.subarray(37, 41))).toBe("IDAT");
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    expect(raw.length).toBe((16 * 3 + 1) * 16);
    for (let y = 0; y < 16; y += 1) {
      expect(raw[y * 49]).toBe(0);
      expect(
        Buffer.from(raw.subarray(y * 49 + 1, (y + 1) * 49)).equals(
          Buffer.from(img.rgb.subarray(y * 48, (y + 1) * 48)),
        ),
      ).toBe(true);
    }
    expect(new TextDecoder().decode(png.subarray(png.length - 8, png.length - 4))).toBe("IEND");
  });
});

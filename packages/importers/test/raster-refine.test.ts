import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  decodePngGray,
  type GrayBitmap,
  PngDecodeError,
  RasterReply,
  rasterReplyToDraft,
  refineRasterDraft,
} from "../src/index.js";

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  return out; // decoder does not check CRCs
}

function png(
  width: number,
  height: number,
  type: number,
  depth: number,
  rows: number[][],
  palette?: number[],
): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = type;
  const raw = Buffer.from(rows.flat());
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr),
      ...(palette ? [chunk("PLTE", new Uint8Array(palette))] : []),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

const inflate = (d: Uint8Array) => new Uint8Array(inflateSync(d));

describe("PNG to greyscale", () => {
  it("decodes RGB rows with none, sub, up, average and Paeth filters", () => {
    // 2 by 5 pixels, RGB 8-bit: every row is black then white, written with a different filter each
    const target = [0, 0, 0, 255, 255, 255];
    const rows = [
      [0, ...target],
      [1, 0, 0, 0, 255, 255, 255],
      [2, 0, 0, 0, 0, 0, 0],
      [3, 0, 0, 0, 255, 255, 255],
      [4, 0, 0, 0, 255, 255, 255],
    ];
    // row 3 average: pred = (a + b) >> 1 = (0 + 255) >> 1 = 127 for the white pixel, so raw = 128
    rows[3] = [3, 0, 0, 0, 128, 128, 128];
    // row 4 Paeth for the white pixel: a = 0 (left), b = 255 (up), c = 0 (up-left) gives b, so raw = 0
    rows[4] = [4, 0, 0, 0, 0, 0, 0];
    const bmp = decodePngGray(png(2, 5, 2, 8, rows), inflate);
    expect(bmp).toMatchObject({ width: 2, height: 5 });
    expect([...bmp.gray]).toEqual([0, 255, 0, 255, 0, 255, 0, 255, 0, 255]);
  });

  it("decodes palette, 1-bit grey and RGBA over white", () => {
    const pal = decodePngGray(png(3, 1, 3, 8, [[0, 0, 1, 2]], [0, 0, 0, 255, 255, 255, 255, 0, 0]), inflate);
    expect([...pal.gray]).toEqual([0, 255, 76]);
    const bits = decodePngGray(png(8, 1, 0, 1, [[0, 0b10100000]]), inflate);
    expect([...bits.gray]).toEqual([255, 0, 255, 0, 0, 0, 0, 0]);
    const rgba = decodePngGray(png(1, 1, 6, 8, [[0, 0, 0, 0, 0]]), inflate);
    expect([...rgba.gray]).toEqual([255]);
    expect(() => decodePngGray(new Uint8Array([1, 2, 3]), inflate)).toThrow(PngDecodeError);
  });
});

/** A white bitmap with ink drawn by the helpers. */
function canvas(W: number, H: number) {
  const gray = new Uint8Array(W * H).fill(255);
  const hline = (x1: number, x2: number, y: number) => {
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x += 1) gray[y * W + x] = 0;
  };
  const vline = (x: number, y1: number, y2: number) => {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y += 1) gray[y * W + x] = 0;
  };
  return { bitmap: { width: W, height: H, gray } as GrayBitmap, hline, vline };
}

describe("refining walls against the image", () => {
  it("offset model walls snap to double-line walls, ends join, and a phantom stub is dropped", () => {
    const W = 1000;
    const H = 600;
    const { bitmap, hline, vline } = canvas(W, H);
    // exterior walls: faces 12 px apart around 100..900 by 100..500 (centrelines), drawn as two lines each
    for (const [y, x1, x2] of [
      [94, 94, 906],
      [106, 106, 894],
      [494, 106, 894],
      [506, 94, 906],
    ] as const)
      hline(x1, x2, y);
    for (const [x, y1, y2] of [
      [94, 94, 506],
      [106, 106, 494],
      [894, 106, 494],
      [906, 94, 506],
    ] as const)
      vline(x, y1, y2);
    // a partition at x = 500 with faces 6 px apart
    vline(497, 106, 494);
    vline(503, 106, 494);
    // the model's reply in 0..1000 per axis, each wall off by about 2 to 3 percent, plus a stub with no ink
    const toAxis = (x: number, y: number): [number, number] => [(x / W) * 1000, (y / H) * 1000];
    const reply = RasterReply.parse({
      walls: [
        { from: toAxis(80, 118), to: toAxis(880, 118), thickness: 10 },
        { from: toAxis(880, 118), to: toAxis(880, 520), thickness: 10 },
        { from: toAxis(880, 520), to: toAxis(80, 520), thickness: 10 },
        { from: toAxis(80, 520), to: toAxis(80, 118), thickness: 10 },
        { from: toAxis(520, 118), to: toAxis(520, 520), thickness: 5 },
        { from: toAxis(300, 300), to: toAxis(330, 300), thickness: 5 },
      ],
    });
    const raw = rasterReplyToDraft(reply, { width: W, height: H });
    const { draft, report } = refineRasterDraft(raw, bitmap);
    expect(report.snapped).toBe(5);
    const u = 1000 / W;
    const px = (p: { x: number; y: number }) => ({ x: Math.round(p.x / u), y: Math.round(H - p.y / u) });
    const lines = draft.walls.map((w) => w.points.map(px));
    const has = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      lines.some(
        ([p, q]) =>
          p &&
          q &&
          ((Math.abs(p.x - a.x) <= 1 &&
            Math.abs(p.y - a.y) <= 1 &&
            Math.abs(q.x - b.x) <= 1 &&
            Math.abs(q.y - b.y) <= 1) ||
            (Math.abs(p.x - b.x) <= 1 &&
              Math.abs(p.y - b.y) <= 1 &&
              Math.abs(q.x - a.x) <= 1 &&
              Math.abs(q.y - a.y) <= 1)),
      );
    expect(has({ x: 100, y: 100 }, { x: 900, y: 100 })).toBe(true);
    expect(has({ x: 900, y: 100 }, { x: 900, y: 500 })).toBe(true);
    expect(has({ x: 100, y: 500 }, { x: 900, y: 500 })).toBe(true);
    expect(has({ x: 100, y: 100 }, { x: 100, y: 500 })).toBe(true);
    expect(has({ x: 500, y: 100 }, { x: 500, y: 500 })).toBe(true);
    expect(draft.walls).toHaveLength(5);
    const exterior = draft.walls.find((w) => Math.abs((w.points[0]?.y ?? 0) - (H - 100) * u) < 1);
    expect((exterior?.thickness ?? 0) / u).toBeCloseTo(13, 0);
  });

  it("a solid filled wall snaps to the middle of its band", () => {
    const W = 800;
    const H = 800;
    const { bitmap, hline } = canvas(W, H);
    for (let y = 395; y <= 405; y += 1) hline(100, 700, y);
    const reply = RasterReply.parse({ walls: [{ from: [125, 470], to: [875, 470], thickness: 8 }] });
    const { draft } = refineRasterDraft(rasterReplyToDraft(reply, { width: W, height: H }), bitmap);
    const u = 1000 / W;
    expect(Math.round(H - (draft.walls[0]?.points[0]?.y ?? 0) / u)).toBe(400);
    expect(Math.round((draft.walls[0]?.thickness ?? 0) / u)).toBe(11);
  });

  it("does nothing when the bitmap does not match the draft's image", () => {
    const { bitmap } = canvas(10, 10);
    const raw = rasterReplyToDraft(RasterReply.parse({ walls: [{ from: [0, 500], to: [1000, 500] }] }), {
      width: 20,
      height: 20,
    });
    expect(refineRasterDraft(raw, bitmap).draft).toBe(raw);
  });
});

describe("gaps in refined walls", () => {
  it("two pieces of one wall across a doorway merge into one wall with a passage in the gap", () => {
    const W = 1000;
    const H = 600;
    const { bitmap, hline } = canvas(W, H);
    // a wall at y = 300, faces 8 px apart, from 100 to 420 and from 500 to 900 (an 80 px doorway)
    for (const y of [296, 304]) {
      hline(100, 420, y);
      hline(500, 900, y);
    }
    const toAxis = (x: number, y: number): [number, number] => [(x / W) * 1000, (y / H) * 1000];
    const reply = RasterReply.parse({
      walls: [
        { from: toAxis(100, 310), to: toAxis(420, 310), thickness: 8 },
        { from: toAxis(500, 310), to: toAxis(900, 310), thickness: 8 },
      ],
    });
    const { draft, report } = refineRasterDraft(rasterReplyToDraft(reply, { width: W, height: H }), bitmap);
    expect(report).toMatchObject({ bridged: 1, passages: 1 });
    expect(draft.walls).toHaveLength(1);
    const u = 1000 / W;
    expect(draft.openings).toHaveLength(1);
    expect(draft.openings[0]).toMatchObject({ kind: "passage", wallIdx: 0 });
    expect(Math.round((draft.openings[0]?.at.x ?? 0) / u)).toBe(460);
    expect(Math.round((draft.openings[0]?.width ?? 0) / u)).toBe(80);
  });
});

describe("text and doorways", () => {
  it("rows of text are not a wall, and a wall piece the model missed past a doorway is recovered and joined", () => {
    const W = 1000;
    const H = 600;
    const { bitmap, hline, vline } = canvas(W, H);
    // a wall at y = 300 (faces 296 and 304) from 100 to 400, a doorway, then 520 to 700; walls at x = 100 and 700 below
    for (const y of [296, 304]) {
      hline(96, 400, y);
      hline(520, 704, y);
    }
    for (const x of [96, 104]) vline(x, 296, 500);
    for (const x of [696, 704]) vline(x, 296, 500);
    // "text": short strokes along y 450..462 from x 200 to 400
    for (let x = 200; x <= 400; x += 7) vline(x, 450, 462);
    for (let x = 200; x <= 400; x += 11) hline(x, x + 3, 456);
    const toAxis = (x: number, y: number): [number, number] => [(x / W) * 1000, (y / H) * 1000];
    const reply = RasterReply.parse({
      walls: [
        { from: toAxis(100, 305), to: toAxis(400, 305), thickness: 8 },
        { from: toAxis(100, 305), to: toAxis(100, 500), thickness: 8 },
        { from: toAxis(700, 305), to: toAxis(700, 500), thickness: 8 },
        { from: toAxis(200, 452), to: toAxis(400, 452), thickness: 8 },
      ],
    });
    const { draft, report } = refineRasterDraft(rasterReplyToDraft(reply, { width: W, height: H }), bitmap);
    const u = 1000 / W;
    const horizontal = draft.walls.filter(
      (w) => Math.abs((w.points[0]?.y ?? 0) - (w.points[1]?.y ?? 1)) < 1e-6,
    );
    expect(horizontal).toHaveLength(1);
    const xs = (horizontal[0]?.points ?? []).map((p) => Math.round(p.x / u)).sort((x, y) => x - y);
    expect(xs).toEqual([100, 700]);
    expect(Math.round(H - (horizontal[0]?.points[0]?.y ?? 0) / u)).toBe(300);
    expect(draft.walls).toHaveLength(3);
    expect(report.passages).toBe(1);
    const passage = draft.openings.find((o) => o.kind === "passage");
    expect(Math.round((passage?.at.x ?? 0) / u)).toBe(460);
  });
});

import { describe, expect, it } from "vitest";
import {
  cleanupRasterDraft,
  imageBox,
  imageInfo,
  PlanDraft,
  RasterReply,
  rasterReplyToDraft,
  readerUserPrompt,
  scaleStatus,
} from "../src/index.js";

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

describe("image headers", () => {
  it("reads PNG, GIF, BMP, JPEG and WebP sizes without decoding", () => {
    expect(
      imageInfo(bytes([0x89], "PNG", [13, 10, 26, 10], be32(13), "IHDR", be32(1600), be32(900))),
    ).toEqual({
      format: "png",
      width: 1600,
      height: 900,
      mime: "image/png",
    });
    expect(imageInfo(bytes("GIF89a", le16(640), le16(480)))).toMatchObject({
      format: "gif",
      width: 640,
      height: 480,
    });
    expect(imageInfo(bytes("BM", new Array(16).fill(0), le32(800), le32(-600 >>> 0)))).toMatchObject({
      format: "bmp",
      width: 800,
      height: 600,
    });
    const jpeg = bytes(
      [0xff, 0xd8],
      [0xff, 0xe0],
      [0x00, 0x04, 0x00, 0x00],
      [0xff, 0xc0, 0x00, 0x11, 0x08],
      [0x04, 0x38],
      [0x07, 0x80],
      [3],
    );
    expect(imageInfo(jpeg)).toMatchObject({ format: "jpeg", width: 1920, height: 1080 });
    const vp8x = bytes(
      "RIFF",
      le32(30),
      "WEBP",
      "VP8X",
      le32(10),
      [0, 0, 0, 0],
      [0x7f, 0x07, 0x00],
      [0x37, 0x04, 0x00],
    );
    expect(imageInfo(vp8x)).toMatchObject({ format: "webp", width: 1920, height: 1080 });
    expect(imageInfo(bytes("not an image at all, just text"))).toBeNull();
  });

  it("the box maps the longer side to 1000 units", () => {
    expect(imageBox(2000, 1000)).toEqual({ unitsPerPixel: 0.5, width: 1000, height: 500 });
    expect(readerUserPrompt({ width: 2000, height: 1000 })).toContain("0 to 1000 on each axis");
  });
});

describe("reader reply to draft", () => {
  const info = { width: 2000, height: 1000 };

  it("flips y once, keeps rooms and purposes, and is a valid PlanDraft", () => {
    const reply = RasterReply.parse({
      walls: [{ from: [100, 100], to: [900, 100], thickness: 10, exterior: true }],
      openings: [],
      rooms: [{ name: "Boardroom 12 seats", at: [500, 300] }],
      dimensions: [],
    });
    const draft = rasterReplyToDraft(reply, info, { file: "plan.png" });
    expect(() => PlanDraft.parse(draft)).not.toThrow();
    expect(draft.source).toEqual({
      kind: "image",
      file: "plan.png",
      page: null,
      pixelSize: { w: 2000, h: 1000 },
    });
    expect(draft.walls[0]?.points).toEqual([
      { x: 100, y: 450 },
      { x: 900, y: 450 },
    ]);
    expect(draft.walls[0]?.kind).toBe("exterior");
    expect(draft.rooms[0]).toMatchObject({
      name: "Boardroom 12 seats",
      purpose: "boardroom",
      capacity: 12,
      labelAt: { x: 500, y: 350 },
    });
  });

  it("agreeing dimension strings suggest the scale; a scale question is always asked for an image", () => {
    const withDims = rasterReplyToDraft(
      RasterReply.parse({
        walls: [{ from: [100, 100], to: [900, 100] }],
        dimensions: [
          { text: "12000", from: [100, 450], to: [900, 450] },
          { text: "6000", from: [950, 100], to: [950, 900] },
        ],
      }),
      info,
    );
    expect(withDims.units).toMatchObject({ scaleSource: "dimension-text", mmPerUnit: 15 });
    // a scale read from an image is only a suggestion: a person confirms it (ADR-011 D3)
    expect(scaleStatus(withDims).confirmed).toBe(false);
    expect(withDims.questions.filter((q) => q.kind === "scale")).toHaveLength(1);

    const oneDim = rasterReplyToDraft(
      RasterReply.parse({
        walls: [{ from: [100, 100], to: [900, 100] }],
        dimensions: [{ text: "12 m", from: [100, 450], to: [900, 450] }],
      }),
      info,
    );
    expect(oneDim.units).toMatchObject({ scaleSource: "guess", mmPerUnit: 15 });
    expect(scaleStatus(oneDim).confirmed).toBe(false);
    expect(oneDim.questions.filter((q) => q.kind === "scale")).toHaveLength(1);

    const none = rasterReplyToDraft(
      RasterReply.parse({ walls: [{ from: [100, 100], to: [900, 100] }] }),
      info,
    );
    expect(none.units.mmPerUnit).toBeNull();
    expect(none.questions.find((q) => q.kind === "scale")?.text).toContain("known length");
  });

  it("accepts numbers written as strings and missing optional fields from a model", () => {
    const reply = RasterReply.parse({
      walls: [{ from: ["10", "20"], to: [30, "40"] }],
      openings: [{ kind: "door", at: ["5", 6] }],
      rooms: [],
    });
    expect(reply.walls[0]?.from).toEqual([10, 20]);
    expect(reply.dimensions).toEqual([]);
  });
});

describe("raster clean-up", () => {
  const base = (
    walls: { from: [number, number]; to: [number, number]; thickness?: number }[],
    openings: { kind: "door" | "window"; at: [number, number] }[] = [],
  ) => rasterReplyToDraft(RasterReply.parse({ walls, openings }), { width: 1000, height: 1000 });

  it("a hand-wobbly rectangle becomes four axis-aligned walls meeting at shared corners", () => {
    const draft = base([
      { from: [100, 102], to: [898, 96], thickness: 8 },
      { from: [904, 101], to: [897, 703], thickness: 8 },
      { from: [900, 698], to: [103, 705], thickness: 8 },
      { from: [98, 699], to: [101, 97], thickness: 8 },
    ]);
    expect(draft.walls).toHaveLength(4);
    for (const w of draft.walls) {
      const [a, b] = w.points as [{ x: number; y: number }, { x: number; y: number }];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
    const ends = draft.walls.flatMap((w) => w.points.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`));
    const counts = new Map<string, number>();
    for (const e of ends) counts.set(e, (counts.get(e) ?? 0) + 1);
    expect([...counts.values()].every((n) => n === 2)).toBe(true);
    expect(counts.size).toBe(4);
  });

  it("a wall split around a door merges into one wall and the door attaches to it", () => {
    const draft = base(
      [
        { from: [100, 500], to: [400, 500], thickness: 8 },
        { from: [480, 501], to: [900, 499], thickness: 8 },
      ],
      [{ kind: "door", at: [440, 506] }],
    );
    expect(draft.walls).toHaveLength(1);
    const [a, b] = draft.walls[0]?.points as [{ x: number; y: number }, { x: number; y: number }];
    expect(Math.round(a.x)).toBe(100);
    expect(Math.round(b.x)).toBe(900);
    expect(draft.openings[0]).toMatchObject({ wallIdx: 0 });
    expect(Math.round(draft.openings[0]?.at.y ?? 0)).toBe(Math.round(a.y));
  });

  it("a wall ending short of another reaches it, and specks are dropped", () => {
    const draft = base([
      { from: [100, 500], to: [900, 500], thickness: 8 },
      { from: [500, 900], to: [500, 508], thickness: 6 },
      { from: [300, 300], to: [302, 301] },
    ]);
    expect(draft.walls).toHaveLength(2);
    const stub = draft.walls.find((w) => w.points.every((p) => Math.abs(p.x - 500) < 1e-9));
    expect(stub?.points.map((p) => Math.round(p.y)).sort((x, y) => x - y)).toEqual([100, 500]);
  });

  it("clean-up is idempotent", () => {
    const once = base([
      { from: [100, 102], to: [898, 96] },
      { from: [904, 101], to: [897, 703] },
    ]);
    expect(cleanupRasterDraft(once).walls).toEqual(once.walls);
  });
});

describe("reader coordinates and labels", () => {
  it("0 to 1000 on each axis maps onto the long-side box; a two-line label keeps its first line as the name", () => {
    const draft = rasterReplyToDraft(
      RasterReply.parse({
        walls: [{ from: [0, 0], to: [1000, 1000], thickness: 20 }],
        openings: [{ kind: "door", at: [500, 500], width: 40 }],
        rooms: [{ name: "BOARDROOM\n12 PAX", at: [250, 750] }],
      }),
      { width: 1600, height: 800 },
    );
    expect(draft.walls[0]?.points).toEqual([
      { x: 0, y: 500 },
      { x: 1000, y: 0 },
    ]);
    expect(draft.walls[0]?.thickness).toBeCloseTo(15, 9);
    expect(draft.openings[0]?.width).toBeCloseTo(30, 9);
    expect(draft.rooms[0]).toMatchObject({
      name: "BOARDROOM",
      capacity: 12,
      purpose: "boardroom",
      labelAt: { x: 250, y: 125 },
    });
  });
});

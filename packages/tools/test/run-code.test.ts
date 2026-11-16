// run_code (ADR-030): the sandbox a model thinks in.
//
// What has to hold: it remembers between calls; the pictures are pixels it can measure; every change
// it makes goes through the registry like any other call; and nothing outside what it was given is in
// reach, including time.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "../src/index.js";
import { DEFAULT_LIMITS, Sandbox } from "../src/sandbox/sandbox.js";
import { harness } from "./helpers.js";

const L = "level_000000";

function attachments(
  files: { id: string; name: string; mime: string; bytes: Uint8Array }[],
): NonNullable<ToolContext["attachments"]> {
  return {
    get: (id) => files.find((f) => f.id === id) ?? null,
    list: () => files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.bytes.length })),
  };
}

/** An 80 by 60 white JPEG with one dark band five pixels thick across rows 20 to 24: a wall. */
function wallJpeg(): Uint8Array {
  const width = 80;
  const height = 60;
  const data = Buffer.alloc(width * height * 4, 255);
  for (let y = 20; y <= 24; y += 1)
    for (let x = 10; x < 70; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = 40;
      data[i + 1] = 40;
      data[i + 2] = 40;
    }
  return new Uint8Array(jpeg.encode({ width, height, data }, 95).data);
}

const OFFICE = fileURLToPath(new URL("../../../tools/fixtures/plans-raster/office-mm.png", import.meta.url));

interface Out {
  ok: boolean;
  printed: string;
  value: unknown;
  error: string | null;
  fresh: boolean;
  calls: { name: string; ok: boolean }[];
  images: { pngBase64: string; width: number; height: number }[];
  caption: string;
}

describe("run_code", () => {
  it("keeps its variables between calls, and says when it starts fresh", async () => {
    const h = harness();
    const first = await h.ok<Out>("run_code", { code: "var answer = 6 * 7; answer" });
    expect(first.result).toMatchObject({ ok: true, value: 42, fresh: true });
    const second = await h.ok<Out>("run_code", { code: "answer + 1" });
    expect(second.result).toMatchObject({ ok: true, value: 43, fresh: false });
    const reset = await h.ok<Out>("run_code", { code: "typeof answer", reset: true });
    expect(reset.result).toMatchObject({ value: "undefined", fresh: true });
  });

  it("calls tools synchronously, through the registry, and the project sees the change", async () => {
    const h = harness();
    const out = await h.ok<Out>("run_code", {
      code: `
        var made = tools.call("create_walls", { levelId: "${L}", closed: true, thickness: 100,
          points: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }] });
        var bad = tools.call("create_walls", { levelId: "nope", closed: false, points: [] });
        console.log("made", made.result.walls.length, "then", bad.ok);
        project().walls.length`,
    });
    expect(out.result.ok).toBe(true);
    expect(out.result.value).toBe(4);
    expect(out.result.printed).toBe("made 4 then false");
    expect(out.result.calls.map((c) => [c.name, c.ok])).toEqual([
      ["create_walls", true],
      ["create_walls", false],
    ]);
    // The same four walls, in the same store, as a direct call would have made.
    expect(h.ctx.store.project.walls).toHaveLength(4);
  });

  it("decodes a JPEG to pixels a script can measure", async () => {
    const h = harness(undefined, {
      attachments: attachments([{ id: "a1", name: "wall.jpg", mime: "image/jpeg", bytes: wallJpeg() }]),
    });
    const out = await h.ok<Out>("run_code", {
      code: `
        var img = image("a1");
        // Rows whose middle is dark: where the wall is.
        var rows = [];
        for (var y = 0; y < img.height; y++) if (img.gray[y * img.width + 40] < 128) rows.push(y);
        ({ width: img.width, height: img.height, rows: rows })`,
    });
    expect(out.result.ok).toBe(true);
    expect(out.result.value).toEqual({ width: 80, height: 60, rows: [20, 21, 22, 23, 24] });
  });

  it("hands back an enlarged crop under a grid labelled in the picture's own pixels", async () => {
    const h = harness(undefined, {
      attachments: attachments([
        { id: "a1", name: "office.png", mime: "image/png", bytes: readFileSync(OFFICE) },
      ]),
    });
    const out = await h.ok<Out>("run_code", {
      code: `
        var img = image("a1");
        var c = crop(img, { x: 0, y: 0, w: 200, h: 150 });
        show(c, "the top-left corner");
        ({ scale: c.scale, grid: c.grid, region: c.region })`,
    });
    expect(out.result.ok).toBe(true);
    expect(out.result.value).toMatchObject({ region: { x: 0, y: 0, w: 200, h: 150 } });
    expect((out.result.value as { scale: number }).scale).toBeGreaterThan(1);
    expect(out.result.images).toHaveLength(1);
    expect(out.result.caption).toContain("the top-left corner");
    const png = Buffer.from(out.result.images[0]?.pngBase64 ?? "", "base64");
    expect([...png.subarray(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG");
  });

  it("shows the last picture a script made when it forgot to show it", async () => {
    const h = harness(undefined, {
      attachments: attachments([{ id: "a1", name: "wall.jpg", mime: "image/jpeg", bytes: wallJpeg() }]),
    });
    const out = await h.ok<Out>("run_code", {
      code: `draw(image("a1"), [{ line: [10, 22, 70, 22], colour: "green", label: 1 }]); "drawn"`,
    });
    expect(out.result.value).toBe("drawn");
    expect(out.result.images).toHaveLength(1);
  });

  it("has nothing it was not given: no require, no fetch, no process, no timers", async () => {
    const h = harness();
    const out = await h.ok<Out>("run_code", {
      code: "[typeof require, typeof fetch, typeof process, typeof setTimeout, typeof globalThis.Deno].join(',')",
    });
    expect(out.result.value).toBe("undefined,undefined,undefined,undefined,undefined");
  });

  it("stops a script that runs past its time, and says what to do about it", async () => {
    const box = await Sandbox.create();
    const host = {
      attachments: () => [],
      attachmentBytes: () => null,
      project: () => ({}),
      callTool: async () => ({ ok: true }),
    };
    const limits = { ...DEFAULT_LIMITS, timeMs: 500 };
    const started = Date.now();
    const out = await box.run("while (true) {}", host, limits);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/time limit/);
    // The sandbox survives it, with its globals.
    await box.run("var kept = 'yes'", host, limits);
    expect((await box.run("kept", host, limits)).value).toBe("yes");
    box.dispose();
  });

  it("answers an await with the reason it is not needed", async () => {
    const h = harness();
    const out = await h.ok<Out>("run_code", { code: 'await tools.call("get_scene", { detail: "summary" })' });
    expect(out.result.ok).toBe(false);
    expect(out.result.error).toMatch(/synchronous/);
  });

  it("will not call itself", async () => {
    const h = harness();
    const out = await h.ok<Out>("run_code", { code: 'tools.call("run_code", { code: "1" })' });
    expect(out.result.ok).toBe(false);
    expect(out.result.error).toMatch(/cannot call itself/);
  });
});

describe("run_code pictures", () => {
  it("makes a valid picture at a fractional scale (a gpt-6-sol run died on scale 1.5)", async () => {
    const h = harness(undefined, {
      attachments: attachments([{ id: "a1", name: "wall.jpg", mime: "image/jpeg", bytes: wallJpeg() }]),
    });
    const out = await h.ok<Out>("run_code", {
      code: `var c = crop(image("a1"), { x: 0, y: 0, w: 45, h: 39, scale: 1.5 }); show(c, "odd scale"); [c.width, c.height, c.scale]`,
    });
    expect(out.result.value).toEqual([45, 39, 1]);
    const png = Buffer.from(out.result.images[0]?.pngBase64 ?? "", "base64");
    expect(png.readUInt32BE(16)).toBe(45);
    expect(png.readUInt32BE(20)).toBe(39);
  });

  it("offers scaleFrom inside the sandbox", async () => {
    const h = harness();
    const out = await h.ok<Out>("run_code", {
      code: 'scaleFrom([{ kind: "door", px: 45 }, { kind: "desk", px: 70 }]).mmPerPx',
    });
    expect(out.result.ok).toBe(true);
    expect(out.result.value).toBeGreaterThan(18);
    expect(out.result.value).toBeLessThan(23);
  });

  it("shows the whole picture for an attachment id or a decoded image (live runs stopped on it)", async () => {
    const h = harness(undefined, {
      attachments: attachments([{ id: "a1", name: "wall.jpg", mime: "image/jpeg", bytes: wallJpeg() }]),
    });
    const out = await h.ok<Out>("run_code", { code: `show("a1", "by id"); show(image("a1"), "decoded"); 1` });
    expect(out.result.ok).toBe(true);
    expect(out.result.images).toHaveLength(2);
  });
});

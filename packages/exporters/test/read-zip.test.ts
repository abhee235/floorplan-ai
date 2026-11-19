// Reading a zip as any tool writes one (P3-8): stored or deflated, sizes from the central directory.
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readZip, ZipError, zipStore } from "../src/index.js";
import { makeZip } from "./zip-maker.js";

const inflateRaw = (data: Uint8Array, max: number) =>
  new Uint8Array(inflateRawSync(data, { maxOutputLength: max }));
const text = (s: string) => new TextEncoder().encode(s);
const codeOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof ZipError ? e.code : `not a ZipError: ${String(e)}`;
  }
  return "read";
};

describe("reading a zip (P3-8)", () => {
  it("reads stored and deflated entries, streamed ones from the directory, and leaves folders out", () => {
    const long = text("slate ".repeat(500));
    const zip = makeZip([
      { name: "lib/" },
      { name: "lib/library.json", data: text('{"id":"a"}') },
      { name: "lib/textures/a.png", data: long, deflate: true, streamed: true },
    ]);
    const entries = readZip(zip, { inflateRaw });
    expect(entries.map((e) => e.name)).toEqual(["lib/library.json", "lib/textures/a.png"]);
    expect(new TextDecoder().decode(entries[1]?.data)).toBe("slate ".repeat(500));
  });

  it("reads what its own writer writes", () => {
    const zip = zipStore([
      { name: "project.json", data: text("{}") },
      { name: "assets/a.png", data: new Uint8Array([1, 2, 3]) },
    ]);
    expect(readZip(zip).map((e) => [e.name, e.data.length])).toEqual([
      ["project.json", 2],
      ["assets/a.png", 3],
    ]);
  });

  it("says why it cannot read a file, rather than reading it wrongly", () => {
    const deflated = makeZip([{ name: "a.txt", data: text("aaaa"), deflate: true }]);
    expect(codeOf(() => readZip(deflated))).toBe("zip.unsupported");
    expect(codeOf(() => readZip(makeZip([{ name: "a", data: text("x"), flags: 1 }])))).toBe(
      "zip.unsupported",
    );
    expect(codeOf(() => readZip(makeZip([{ name: "a", data: text("x"), method: 12 }])))).toBe(
      "zip.unsupported",
    );
    expect(codeOf(() => readZip(makeZip([{ name: "a", data: text("x"), crc: 1 }])))).toBe("zip.corrupt");
    expect(codeOf(() => readZip(text("0\nSECTION\n2\nHEADER\n")))).toBe("zip.not-zip");
    expect(codeOf(() => readZip(new Uint8Array()))).toBe("zip.not-zip");
  });

  it("refuses a zip that would unpack past its limits", () => {
    const zeros = makeZip([{ name: "big.bin", data: new Uint8Array(100_000), deflate: true }]);
    expect(zeros.length).toBeLessThan(1000);
    expect(codeOf(() => readZip(zeros, { inflateRaw, maxBytes: 50_000 }))).toBe("zip.too-big");
    const many = makeZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: text("x") })));
    expect(codeOf(() => readZip(many, { maxEntries: 4 }))).toBe("zip.too-big");
  });
});

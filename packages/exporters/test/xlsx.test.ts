import { describe, expect, it } from "vitest";
import {
  columnName,
  crc32,
  readXlsxCells,
  STYLE_INDEX,
  sheetNames,
  unzipStore,
  writeXlsx,
  zipStore,
} from "../src/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("zip (stored entries)", () => {
  it("crc32 matches the standard check value", () => {
    expect(crc32(enc.encode("123456789")).toString(16)).toBe("cbf43926");
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("round-trips entries in order and is byte-identical for the same input", () => {
    const entries = [
      { name: "a.txt", data: enc.encode("alpha") },
      { name: "dir/ü.xml", data: enc.encode("<x/>") },
    ];
    const one = zipStore(entries);
    const two = zipStore(entries);
    expect(one).toEqual(two);
    expect(unzipStore(one).map((e) => [e.name, dec.decode(e.data)])).toEqual([
      ["a.txt", "alpha"],
      ["dir/ü.xml", "<x/>"],
    ]);
    expect(dec.decode(one.subarray(one.length - 22, one.length - 18))).toBe("PK");
    expect(() => zipStore([entries[0] as never, entries[0] as never])).toThrow("duplicate zip entry a.txt");
  });
});

describe("xlsx writer", () => {
  it("names columns like a spreadsheet", () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  });

  it("sheet names are at most 31 characters, without forbidden characters, and unique ignoring case", () => {
    expect(sheetNames(["Summary", "summary", "Room: A/B [1]", "x".repeat(40), "x".repeat(40), ""])).toEqual([
      "Summary",
      "summary (2)",
      "Room  A B  1",
      "x".repeat(31),
      `${"x".repeat(27)} (2)`,
      "Sheet",
    ]);
  });

  it("writes the package parts, styles, frozen header and autofilter; cells read back with values and styles", () => {
    const bytes = writeXlsx([
      {
        name: "Lines",
        widths: [20, 10],
        headerRow: 0,
        rows: [
          [
            { v: "Item", s: "header" },
            { v: "Total", s: "header" },
          ],
          [{ v: "Chair & <table>" }, { v: 1234.5, s: "money" }],
          [
            { v: 'quote "x"', s: "unverified" },
            { v: null, s: "placeholder" },
          ],
        ],
      },
      { name: "Notes", rows: [[{ v: "only" }]] },
    ]);
    const entries = unzipStore(bytes);
    expect(entries.map((e) => e.name)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
    ]);
    const sheet1 = dec.decode(entries[5]?.data);
    expect(sheet1).toContain('state="frozen"');
    expect(sheet1).toContain('<autoFilter ref="A1:B3"/>');
    expect(sheet1).toContain('<col min="1" max="1" width="20" customWidth="1"/>');
    const [lines, notes] = readXlsxCells(entries);
    expect(lines?.name).toBe("Lines");
    expect(lines?.cells.get("A2")).toEqual({ ref: "A2", v: "Chair & <table>", style: 0 });
    expect(lines?.cells.get("B2")).toEqual({ ref: "B2", v: 1234.5, style: STYLE_INDEX.money });
    expect(lines?.cells.get("A3")).toEqual({ ref: "A3", v: 'quote "x"', style: STYLE_INDEX.unverified });
    expect(notes?.cells.get("A1")?.v).toBe("only");
    expect(writeXlsx([{ name: "Lines", rows: [[{ v: 1 }]] }])).toEqual(
      writeXlsx([{ name: "Lines", rows: [[{ v: 1 }]] }]),
    );
    expect(() => writeXlsx([])).toThrow("at least one sheet");
  });
});

// A small XLSX (Office Open XML SpreadsheetML) writer: inline strings, numbers, a handful of named
// styles, column widths, a frozen header row and autofilter. Written for ADR-013 D2's byte-identical
// requirement, which spreadsheet libraries do not meet because they stamp creation dates.
import { zipStore } from "./zip.js";

export type CellStyle =
  | "normal"
  | "title"
  | "header"
  | "money"
  | "unverified"
  | "placeholder"
  | "draft"
  | "bold";

export interface Cell {
  v: string | number | null;
  s?: CellStyle;
}

export interface Sheet {
  name: string;
  rows: Cell[][];
  /** Column widths in characters. */
  widths?: number[];
  /** Row index (0-based) of a header row to freeze panes below and filter on. */
  headerRow?: number;
}

/** Style index per name; must match the cellXfs order in styles.xml below. */
const STYLE_INDEX: Record<CellStyle, number> = {
  normal: 0,
  title: 1,
  header: 2,
  money: 3,
  unverified: 4,
  placeholder: 5,
  draft: 6,
  bold: 7,
};

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFC00000"/><name val="Calibri"/></font></fonts>
<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF8CBAD"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="3" fillId="5" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function esc(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function columnName(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Excel sheet names: at most 31 characters, none of []:*?/\, unique regardless of case. */
export function sheetNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const base = (
      raw
        .replace(/[[\]:*?/\\]/g, " ")
        .replace(/^'+|'+$/g, "")
        .trim() || "Sheet"
    ).slice(0, 31);
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i += 1) {
      const suffix = ` (${i})`;
      name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

function sheetXml(sheet: Sheet): string {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
  ];
  const cols = Math.max(1, ...sheet.rows.map((r) => r.length));
  const rows = Math.max(1, sheet.rows.length);
  out.push(`<dimension ref="A1:${columnName(cols - 1)}${rows}"/>`);
  if (sheet.headerRow !== undefined)
    out.push(
      `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.headerRow + 1}" topLeftCell="A${sheet.headerRow + 2}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`,
    );
  else out.push('<sheetViews><sheetView workbookViewId="0"/></sheetViews>');
  if (sheet.widths?.length)
    out.push(
      `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`,
    );
  out.push("<sheetData>");
  sheet.rows.forEach((row, r) => {
    const cells = row
      .map((cell, c) => {
        const ref = `${columnName(c)}${r + 1}`;
        const style = cell.s && cell.s !== "normal" ? ` s="${STYLE_INDEX[cell.s]}"` : "";
        if (cell.v === null || cell.v === "") return style ? `<c r="${ref}"${style}/>` : "";
        if (typeof cell.v === "number" && Number.isFinite(cell.v))
          return `<c r="${ref}"${style}><v>${cell.v}</v></c>`;
        return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(String(cell.v))}</t></is></c>`;
      })
      .join("");
    out.push(`<row r="${r + 1}">${cells}</row>`);
  });
  out.push("</sheetData>");
  if (sheet.headerRow !== undefined && sheet.rows.length > sheet.headerRow + 1) {
    const headerCols = sheet.rows[sheet.headerRow]?.length ?? cols;
    out.push(`<autoFilter ref="A${sheet.headerRow + 1}:${columnName(headerCols - 1)}${sheet.rows.length}"/>`);
  }
  out.push("</worksheet>");
  return out.join("");
}

export function writeXlsx(sheets: readonly Sheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error("a workbook needs at least one sheet");
  const names = sheetNames(sheets.map((s) => s.name));
  const enc = new TextEncoder();
  const file = (name: string, text: string) => ({ name, data: enc.encode(text) });
  const overrides = sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("");
  return zipStore([
    file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}</Types>`,
    ),
    file(
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    file(
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names
        .map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    ),
    file(
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join(
          "",
        )}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    file("xl/styles.xml", STYLES),
    ...sheets.map((s, i) => file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s))),
  ]);
}

export interface ReadCell {
  ref: string;
  v: string | number;
  style: number;
}

/** Read sheet names and cells back from a workbook this writer made (tests and round trips). */
export function readXlsxCells(
  entries: readonly { name: string; data: Uint8Array }[],
): { name: string; cells: Map<string, ReadCell> }[] {
  const dec = new TextDecoder();
  const text = (name: string) => {
    const e = entries.find((x) => x.name === name);
    if (!e) throw new Error(`missing ${name}`);
    return dec.decode(e.data);
  };
  const unesc = (s: string) =>
    s
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&");
  const names = [...text("xl/workbook.xml").matchAll(/<sheet name="([^"]*)" sheetId="(\d+)"/g)].map((m) =>
    unesc(m[1] as string),
  );
  return names.map((name, i) => {
    const cells = new Map<string, ReadCell>();
    for (const m of text(`xl/worksheets/sheet${i + 1}.xml`).matchAll(
      /<c r="([A-Z]+\d+)"(?: s="(\d+)")?(?: t="inlineStr")?(?:\/>|>(.*?)<\/c>)/g,
    )) {
      const body = m[3];
      if (body === undefined) continue;
      const str = /<t xml:space="preserve">(.*?)<\/t>/.exec(body);
      const num = /<v>(.*?)<\/v>/.exec(body);
      cells.set(m[1] as string, {
        ref: m[1] as string,
        v: str ? unesc(str[1] as string) : Number(num?.[1]),
        style: Number(m[2] ?? 0),
      });
    }
    return { name, cells };
  });
}

export { STYLE_INDEX };

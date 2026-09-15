// One entry point from a plan file to a draft (ADR-011 D2): pick the path by file kind, decode DXF text,
// and give the review a faint preview of the source drawing. Pure: the host reads the bytes.
import type { PlanDraft } from "./draft.js";
import { DxfError, flatten, parseDxf } from "./dxf.js";
import { type DxfImportReport, dxfToDraft } from "./dxf-draft.js";
import { type PdfPageContent, pdfPageToDraft } from "./pdf.js";

export type PlanFileKind = "dxf" | "dwg" | "pdf" | "image" | "unknown";

export class PlanFormatError extends Error {
  constructor(
    readonly code: "import.format" | "import.parse" | "import.unsupported",
    message: string,
    readonly hint: string | null = null,
  ) {
    super(message);
    this.name = "PlanFormatError";
  }
}

export function planFileKind(fileName: string): PlanFileKind {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? "";
  if (ext === "dxf") return "dxf";
  if (ext === "dwg") return "dwg";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"].includes(ext)) return "image";
  return "unknown";
}

/** Fewer segments than this on a page means it is not a vector drawing (a scan, or a text page). */
const MIN_VECTOR_SEGMENTS = 20;

const segmentCount = (p: PdfPageContent) =>
  p.paths.reduce((n, path) => n + path.subpaths.reduce((m, s) => m + s.commands.length, 0), 0);

/**
 * One page of a vector PDF as a draft (spec 06 A6). Without a page number the page with the most line work is
 * read. A page that is only an image is refused with a hint to import it as an image instead.
 */
export function readPlanPdf(
  fileName: string,
  pages: readonly PdfPageContent[],
  page?: number,
): PlanReadResult {
  const chosen =
    page !== undefined
      ? pages.find((p) => p.page === page)
      : [...pages].sort((a, b) => segmentCount(b) - segmentCount(a) || a.page - b.page)[0];
  if (!chosen)
    throw new PlanFormatError(
      "import.format",
      page !== undefined ? `"${fileName}" has no page ${page}` : `"${fileName}" has no pages`,
      null,
    );
  if (segmentCount(chosen) < MIN_VECTOR_SEGMENTS)
    throw new PlanFormatError(
      "import.unsupported",
      chosen.images > 0
        ? `page ${chosen.page} of "${fileName}" is a scanned image, not vector line work`
        : `page ${chosen.page} of "${fileName}" has no line work`,
      chosen.images > 0
        ? "export the page as a PNG and import the image; the vision reader reads it"
        : "give the page number of the floor plan",
    );
  const { draft, report, preview } = pdfPageToDraft(chosen, { file: fileName });
  return { draft, report, preview };
}

/** DXF text: UTF-8 when valid (AutoCAD 2007 and later), else the Windows code page older files use. */
export function decodePlanText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Source line work in draft units, for drawing under the draft while it is reviewed. */
export interface PlanPreview {
  /** Flat [x1, y1, x2, y2] segments. */
  segments: [number, number, number, number][];
  /** True when the drawing had more line work than the preview carries. */
  truncated: boolean;
}

export interface PlanReadResult {
  draft: PlanDraft;
  report: DxfImportReport;
  preview: PlanPreview;
}

const PREVIEW_LIMIT = 20_000;

function dxfPreview(text: string): PlanPreview {
  const doc = parseDxf(text);
  const hidden = new Set([...doc.layers.values()].filter((l) => l.frozen || l.off).map((l) => l.name));
  const segments: [number, number, number, number][] = [];
  let truncated = false;
  const push = (x1: number, y1: number, x2: number, y2: number) => {
    if (segments.length >= PREVIEW_LIMIT) truncated = true;
    else segments.push([x1, y1, x2, y2]);
  };
  for (const { entity: e } of flatten(doc).placed) {
    if (hidden.has(e.layer)) continue;
    if (e.type === "LINE") push(e.a.x, e.a.y, e.b.x, e.b.y);
    else if (e.type === "POLYLINE") {
      const v = e.vertices;
      const n = e.closed ? v.length : v.length - 1;
      for (let i = 0; i < n; i += 1) {
        const a = v[i] as { x: number; y: number };
        const b = v[(i + 1) % v.length] as { x: number; y: number };
        push(a.x, a.y, b.x, b.y);
      }
    } else if (e.type === "ARC" || e.type === "CIRCLE") {
      const start = e.type === "ARC" ? e.start : 0;
      let sweep = e.type === "ARC" ? (((e.end - e.start) % 360) + 360) % 360 : 360;
      if (sweep === 0) sweep = 360;
      const steps = Math.max(4, Math.ceil(sweep / 15));
      for (let i = 0; i < steps; i += 1) {
        const a0 = ((start + (sweep * i) / steps) * Math.PI) / 180;
        const a1 = ((start + (sweep * (i + 1)) / steps) * Math.PI) / 180;
        push(
          e.centre.x + e.radius * Math.cos(a0),
          e.centre.y + e.radius * Math.sin(a0),
          e.centre.x + e.radius * Math.cos(a1),
          e.centre.y + e.radius * Math.sin(a1),
        );
      }
    }
  }
  return { segments, truncated };
}

/** Read a plan file's text into a draft, its report and a preview. Throws PlanFormatError. */
export function readPlanText(fileName: string, text: string): PlanReadResult {
  const kind = planFileKind(fileName);
  if (kind === "dwg")
    throw new PlanFormatError(
      "import.format",
      "DWG files are not read",
      "save the drawing as DXF (or PDF) from the CAD program and import that",
    );
  if (kind === "pdf")
    throw new PlanFormatError(
      "import.format",
      "PDF plans are read from their bytes, not text",
      "send the PDF as a path or as contentBase64",
    );
  if (kind === "image")
    throw new PlanFormatError(
      "import.unsupported",
      "image plans are read by the vision reader",
      "send the image as a path or as contentBase64",
    );
  if (kind !== "dxf" && !/^\s*0\s*\r?\n\s*SECTION/.test(text))
    throw new PlanFormatError("import.format", `"${fileName}" is not a DXF file`, "import a .dxf file");
  try {
    const { draft, report } = dxfToDraft(text, { file: fileName });
    return { draft, report, preview: dxfPreview(text) };
  } catch (e) {
    if (e instanceof DxfError) throw new PlanFormatError("import.parse", e.message, null);
    throw e;
  }
}

// Vector PDF extraction for plan import (ADR-011 D2, spec 06 A6): pdfjs-dist reads each page's operator list
// and text in the host process (no worker thread, no service); the importers package interprets them.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { interpretPdfOperators, type PdfPageContent, type PdfText } from "@fpv/importers";

const require = createRequire(import.meta.url);
const PDFJS_DIR = dirname(require.resolve("pdfjs-dist/package.json"));
/** Pages read when no page is asked for; the page with the most line work is imported. */
export const MAX_PDF_PAGES = 50;

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let loaded: Promise<PdfJs> | null = null;
const pdfjs = (): Promise<PdfJs> => {
  loaded ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return loaded;
};

export class PdfReadError extends Error {
  constructor(
    readonly code: "import.parse" | "import.format",
    message: string,
  ) {
    super(message);
    this.name = "PdfReadError";
  }
}

/** Pages of a PDF as painted paths and text runs in page space (points, y up); only `page` when given. */
export async function extractPdfPages(bytes: Uint8Array, page?: number): Promise<PdfPageContent[]> {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: `${join(PDFJS_DIR, "standard_fonts")}/`,
    useSystemFonts: false,
    verbosity: 0,
  });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (e) {
    const name = (e as { name?: string }).name;
    throw new PdfReadError(
      "import.parse",
      name === "PasswordException"
        ? "the PDF is password protected"
        : `the PDF could not be read: ${(e as Error).message}`,
    );
  }
  try {
    if (page !== undefined && (page < 1 || page > doc.numPages))
      throw new PdfReadError(
        "import.format",
        `the PDF has ${doc.numPages} page(s); there is no page ${page}`,
      );
    const numbers =
      page !== undefined
        ? [page]
        : Array.from({ length: Math.min(doc.numPages, MAX_PDF_PAGES) }, (_, i) => i + 1);
    const out: PdfPageContent[] = [];
    for (const n of numbers) {
      const p = await doc.getPage(n);
      const ops = await p.getOperatorList();
      const text = await p.getTextContent();
      const [x0, y0, x1, y1] = p.view as [number, number, number, number];
      const texts: PdfText[] = [];
      for (const item of text.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const t = item.transform as number[];
        const [a, b, c, d, e, f] = t as [number, number, number, number, number, number];
        texts.push({
          str: item.str,
          x: e,
          y: f,
          height: Math.hypot(c, d),
          rotation: (Math.atan2(b, a) * 180) / Math.PI,
          width: item.width,
        });
      }
      const { paths, images } = interpretPdfOperators(
        ops.fnArray,
        ops.argsArray,
        lib.OPS as unknown as Record<string, number>,
      );
      out.push({ page: n, width: x1 - x0, height: y1 - y0, paths, texts, images });
      p.cleanup();
    }
    return out;
  } finally {
    await task.destroy();
  }
}

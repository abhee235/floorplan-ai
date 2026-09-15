// Plan files for import_plan (ADR-011 D2): the host reads the bytes; DXF goes to the importers package and
// images go to the configured Plan Reader model. Relative paths resolve against the host's working directory.
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { JsonOutputError, type PlanReaderRole, ProviderError, ReaderUnavailableError } from "@fpv/agents";
import {
  decodePlanText,
  decodePngGray,
  type GrayBitmap,
  imageInfo,
  PlanFormatError,
  planFileKind,
  readPlanPdf,
  readPlanText,
} from "@fpv/importers";
import { type PlanReader, type PlanReadOutcome, type PlanReadRequest, ToolError } from "@fpv/tools";
import { extractPdfPages, PdfReadError } from "./pdf.js";

/** Larger drawings are refused rather than parsed for minutes. */
export const MAX_PLAN_BYTES = 64 * 1024 * 1024;
/** Images larger than this are refused before they reach a model. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Readers do best at or below this many pixels on the long side (ADR-011 D2). */
export const READER_LONG_SIDE_PX = 2048;

export interface FilePlanReaderOptions {
  baseDir: () => string;
  maxBytes?: number;
  /** The vision model for image plans; null refuses them with a hint. */
  raster?: PlanReaderRole | null;
}

export class FilePlanReader implements PlanReader {
  constructor(private readonly options: FilePlanReaderOptions = { baseDir: () => process.cwd() }) {}

  resolvePath(path: string): string {
    return isAbsolute(path) ? path : resolve(this.options.baseDir(), path);
  }

  private async bytesOf(
    req: PlanReadRequest,
  ): Promise<{ fileName: string; bytes: Uint8Array | null; text: string | null }> {
    const max = this.options.maxBytes ?? MAX_PLAN_BYTES;
    const tooLarge = (what: string, size: number) =>
      new ToolError("import.too-large", `${what} is ${size} bytes; the limit is ${max}`, null, null);
    if (req.contentBase64 !== undefined) {
      const bytes = new Uint8Array(Buffer.from(req.contentBase64, "base64"));
      if (bytes.length > max) throw tooLarge("the plan", bytes.length);
      return { fileName: req.fileName ?? "plan.png", bytes, text: null };
    }
    if (req.content !== undefined) {
      if (req.content.length > max) throw tooLarge("the plan", req.content.length);
      return { fileName: req.fileName ?? "plan.dxf", bytes: null, text: req.content };
    }
    if (req.path !== undefined) {
      const target = this.resolvePath(req.path);
      let size: number;
      try {
        size = (await stat(target)).size;
      } catch {
        throw new ToolError(
          "file.missing",
          `no file at ${target}`,
          null,
          "give an absolute path or one relative to where the host runs",
        );
      }
      if (size > max) throw tooLarge(target, size);
      return {
        fileName: req.fileName ?? basename(target),
        bytes: new Uint8Array(await readFile(target)),
        text: null,
      };
    }
    throw new ToolError(
      "args.invalid",
      "give path, content with fileName, or contentBase64 with fileName",
      null,
      'e.g. path: "plans/level1.dxf"',
    );
  }

  async read(req: PlanReadRequest): Promise<PlanReadOutcome> {
    const { fileName, bytes, text } = await this.bytesOf(req);
    if (planFileKind(fileName) === "image") {
      if (!bytes) throw new ToolError("args.invalid", "send an image as contentBase64 or a path", null, null);
      return this.readImage(fileName, bytes);
    }
    if (planFileKind(fileName) === "pdf") {
      if (!bytes) throw new ToolError("args.invalid", "send a PDF as contentBase64 or a path", null, null);
      return this.readPdf(fileName, bytes, req.page);
    }
    const source = text ?? decodePlanText(bytes as Uint8Array);
    try {
      const r = readPlanText(fileName, source);
      return { draft: r.draft, report: r.report, preview: r.preview, image: null, fileName };
    } catch (e) {
      if (e instanceof PlanFormatError) throw new ToolError(e.code, e.message, null, e.hint);
      throw e;
    }
  }

  private async readPdf(
    fileName: string,
    bytes: Uint8Array,
    page: number | undefined,
  ): Promise<PlanReadOutcome> {
    try {
      const r = readPlanPdf(fileName, await extractPdfPages(bytes, page), page);
      return { draft: r.draft, report: r.report, preview: r.preview, image: null, fileName };
    } catch (e) {
      if (e instanceof PlanFormatError) throw new ToolError(e.code, e.message, null, e.hint);
      if (e instanceof PdfReadError) throw new ToolError(e.code, e.message, null, null);
      throw e;
    }
  }

  private async readImage(fileName: string, bytes: Uint8Array): Promise<PlanReadOutcome> {
    const info = imageInfo(bytes);
    if (!info)
      throw new ToolError(
        "import.format",
        `"${fileName}" is not a PNG, JPEG, GIF, WebP or BMP image`,
        null,
        "export the plan as PNG or JPEG",
      );
    if (bytes.length > MAX_IMAGE_BYTES)
      throw new ToolError(
        "import.too-large",
        `the image is ${bytes.length} bytes; the limit for a reader model is ${MAX_IMAGE_BYTES}`,
        null,
        `resize it to at most ${READER_LONG_SIDE_PX} pixels on the long side`,
      );
    const raster = this.options.raster;
    if (!raster)
      throw new ToolError(
        "unavailable",
        "image plans need a reader model, and none is configured",
        null,
        "set roles.reader in <data>/config.json, or FPV_READER_BASE_URL and FPV_READER_MODEL, to a vision model",
      );
    const dataUrl = `data:${info.mime};base64,${Buffer.from(bytes).toString("base64")}`;
    const warnings: string[] = [];
    if (Math.max(info.width, info.height) > READER_LONG_SIDE_PX)
      warnings.push(
        `the image is ${info.width} by ${info.height} pixels; readers work best at ${READER_LONG_SIDE_PX} or less on the long side`,
      );
    // PNG pixels let the reader snap the model's walls to the drawing; other formats are read without refinement
    let bitmap: GrayBitmap | null = null;
    if (info.format === "png") {
      try {
        bitmap = decodePngGray(bytes, (d) => new Uint8Array(inflateSync(d)));
      } catch (e) {
        warnings.push(
          `the PNG could not be decoded for refinement (${e instanceof Error ? e.message : String(e)}); walls are as the model read them`,
        );
      }
    } else
      warnings.push(
        `${info.format.toUpperCase()} images are not refined against their pixels; PNG plans are placed more accurately`,
      );
    try {
      const reading = await raster.read({ dataUrl, info, fileName, bitmap });
      if (reading.refined)
        warnings.push(
          `${reading.refined.snapped} walls were snapped to the drawing and ${reading.refined.dropped} with no line in it were dropped`,
        );
      warnings.push(
        `read by ${raster.id} in ${reading.attempts} attempt${reading.attempts === 1 ? "" : "s"}`,
      );
      return {
        draft: reading.draft,
        report: { warnings, skipped: {} },
        preview: null,
        image: { dataUrl, width: info.width, height: info.height },
        fileName,
      };
    } catch (e) {
      if (e instanceof ReaderUnavailableError)
        throw new ToolError("unavailable", e.message, null, "use a vision model for roles.reader");
      if (e instanceof JsonOutputError)
        throw new ToolError(
          "import.reader",
          `the reader model did not return a usable plan: ${e.message}`,
          null,
          "try again, or use a larger vision model",
        );
      if (e instanceof ProviderError)
        throw new ToolError(
          "import.reader",
          `the reader model failed: ${e.message}`,
          null,
          "check that the model server is running",
        );
      throw e;
    }
  }
}

// Plan files for import_plan (ADR-011 D2): the host reads the bytes, the importers package turns them into
// a draft. Relative paths resolve against the directory the host was started in.
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { decodePlanText, PlanFormatError, readPlanText } from "@fpv/importers";
import { type PlanReader, type PlanReadRequest, ToolError } from "@fpv/tools";

/** Larger drawings are refused rather than parsed for minutes. */
export const MAX_PLAN_BYTES = 64 * 1024 * 1024;

export class FilePlanReader implements PlanReader {
  constructor(
    private readonly options: { baseDir: () => string; maxBytes?: number } = { baseDir: () => process.cwd() },
  ) {}

  resolvePath(path: string): string {
    return isAbsolute(path) ? path : resolve(this.options.baseDir(), path);
  }

  async read(req: PlanReadRequest) {
    const max = this.options.maxBytes ?? MAX_PLAN_BYTES;
    let fileName: string;
    let text: string;
    if (req.content !== undefined) {
      fileName = req.fileName ?? "plan.dxf";
      if (req.content.length > max)
        throw new ToolError("import.too-large", `the plan is larger than ${max} bytes`, null, null);
      text = req.content;
    } else if (req.path !== undefined) {
      const target = this.resolvePath(req.path);
      fileName = req.fileName ?? basename(target);
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
      if (size > max)
        throw new ToolError(
          "import.too-large",
          `${target} is ${size} bytes; the limit is ${max}`,
          null,
          null,
        );
      text = decodePlanText(new Uint8Array(await readFile(target)));
    } else {
      throw new ToolError(
        "args.invalid",
        "give path, or content with fileName",
        null,
        'e.g. path: "plans/level1.dxf"',
      );
    }
    try {
      return { ...readPlanText(fileName, text), fileName };
    } catch (e) {
      if (e instanceof PlanFormatError) throw new ToolError(e.code, e.message, null, e.hint);
      throw e;
    }
  }
}

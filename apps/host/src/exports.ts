// Where exports land (ADR-013): relative paths resolve against the open project's directory, or the data
// directory's exports folder when the project has not been saved. Files are written atomically and an
// existing file is only replaced when asked.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ExportWriter } from "@fpv/tools";
import { writeAtomic } from "./files.js";

export class ExportFileError extends Error {
  readonly entityId = null;
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string | null,
  ) {
    super(message);
    this.name = "ExportFileError";
  }
}

export class FileExportWriter implements ExportWriter {
  readonly appVersion: string;

  constructor(private readonly options: { baseDir: () => string; appVersion?: string }) {
    this.appVersion = options.appVersion ?? "0.0.1";
  }

  resolvePath(path: string): string {
    return isAbsolute(path) ? path : resolve(this.options.baseDir(), path);
  }

  async write(
    path: string,
    bytes: Uint8Array,
    options: { overwrite: boolean },
  ): Promise<{ path: string; bytes: number }> {
    const target = this.resolvePath(path);
    if (existsSync(target) && !options.overwrite)
      throw new ExportFileError(
        "file.exists",
        `${target} already exists`,
        "pass overwrite: true or choose another path",
      );
    try {
      mkdirSync(dirname(target), { recursive: true });
      await writeAtomic(target, bytes);
    } catch (e) {
      if (e instanceof ExportFileError) throw e;
      const message = e instanceof Error ? e.message : String(e);
      throw new ExportFileError(
        "file.write",
        `could not write ${target}: ${message}`,
        "check the folder exists and is writable",
      );
    }
    return { path: target, bytes: bytes.length };
  }
}

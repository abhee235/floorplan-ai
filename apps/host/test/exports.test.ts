import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExportFileError, FileExportWriter } from "../src/exports.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "fpv-exports-"));
  temps.push(d);
  return d;
};

describe("FileExportWriter (ADR-013)", () => {
  it("writes relative paths under the base directory, creating folders, with no temporary left behind", async () => {
    const base = dir();
    const w = new FileExportWriter({ baseDir: () => base, appVersion: "1.2.3" });
    const out = await w.write("exports/bom.csv", new TextEncoder().encode("a,b\r\n"), { overwrite: false });
    expect(out).toEqual({ path: join(base, "exports", "bom.csv"), bytes: 5 });
    expect(readFileSync(out.path, "utf8")).toBe("a,b\r\n");
    expect(readdirSync(join(base, "exports"))).toEqual(["bom.csv"]);
    expect(w.appVersion).toBe("1.2.3");
  });

  it("refuses to replace an existing file unless overwrite is set; absolute paths are kept", async () => {
    const base = dir();
    const w = new FileExportWriter({ baseDir: () => join(base, "unused") });
    const target = join(base, "bom.xlsx");
    await w.write(target, new Uint8Array([1, 2, 3]), { overwrite: false });
    await expect(w.write(target, new Uint8Array([9]), { overwrite: false })).rejects.toMatchObject({
      code: "file.exists",
      entityId: null,
      hint: "pass overwrite: true or choose another path",
    });
    await expect(w.write(target, new Uint8Array([9]), { overwrite: false })).rejects.toBeInstanceOf(
      ExportFileError,
    );
    expect([...readFileSync(target)]).toEqual([1, 2, 3]);
    await w.write(target, new Uint8Array([9]), { overwrite: true });
    expect([...readFileSync(target)]).toEqual([9]);
    expect(existsSync(join(base, "unused"))).toBe(false);
  });
});

// Model files for the viewer (ADR-003 D5, PRD P3-8), served at /models/<key>: a library's glTF from the
// copy the installer checked and put under the data directory, a person's own from where it was kept by
// its hash. Paths are found once and the bytes streamed per request; a model can be tens of megabytes.
import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { AssetEntry } from "@fpv/assets";
import { libraryDir } from "@fpv/catalog/store";
import { USER_LIBRARY } from "./user-textures.js";

/** What the catalog store answers about an asset; CatalogStore has it. */
export interface ModelLookup {
  assetOrigin(key: string): { entry: AssetEntry; library: string; version: string } | null;
}

export const GLB_TYPE = "model/gltf-binary";

export interface ModelFile {
  path: string;
  bytes: number;
  type: string;
}

export class ModelFiles {
  private readonly cache = new Map<string, ModelFile | null>();

  constructor(
    private readonly lookup: ModelLookup,
    private readonly dataDir: string,
    /** Models a person imported, kept by their hash rather than in a library's copy. */
    private readonly user: { fileFor(hex: string): string | null } | null = null,
  ) {}

  /** Drop what was found, after a library was installed or removed: a key may name another file now. */
  forget(): void {
    this.cache.clear();
  }

  /** The file for a model's asset key, or null when the catalog has no such model or its file is gone. */
  file(key: string): ModelFile | null {
    const known = this.cache.get(key);
    if (known && existsSync(known.path)) return known;
    const found = this.find(key);
    this.cache.set(key, found);
    return found;
  }

  private find(key: string): ModelFile | null {
    const origin = this.lookup.assetOrigin(key);
    const entry = origin?.entry;
    if (!origin || entry?.kind !== "gltf" || !entry.file) return null;
    let path: string | null;
    if (origin.library === USER_LIBRARY)
      path = entry.sha256 ? (this.user?.fileFor(entry.sha256) ?? null) : null;
    else {
      // the manifest names the file; it must stay inside the library's own folder
      const folder = resolve(
        join(libraryDir(this.dataDir, origin.library, origin.version), "assets", "files"),
      );
      const candidate = resolve(folder, entry.file);
      path = candidate.startsWith(folder + sep) ? candidate : null;
    }
    if (!path || !existsSync(path)) return null;
    return { path, bytes: statSync(path).size, type: GLB_TYPE };
  }
}

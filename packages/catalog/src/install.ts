// Library installation on disk (spec 02 section 4, ADR-010 D10): a library is a directory (or an
// extracted zip) with library.json at its root and files beside it. Install verifies every declared
// hash before anything is written (C-025), copies the tree under <data>/libraries/<id>/<version>/ so
// later edits to the source never reach the catalog (C-029), then registers the manifest.
// Node-only: reached through "@fpv/catalog/store", never the root entry.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AssetManifest } from "@fpv/assets";
import { LibraryManifest, type LibraryManifestInput } from "./schema.js";
import { CatalogError, type CatalogStore, type LibraryRecord } from "./store.js";

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function libraryDir(dataDir: string, id: string, version: string): string {
  return join(dataDir, "libraries", id, version);
}

/** Read and validate library.json from a library directory (or the file itself). */
export function readLibraryManifest(source: string): { manifest: LibraryManifest; dir: string } {
  const file = statSync(source).isDirectory() ? join(source, "library.json") : source;
  if (!existsSync(file)) throw new CatalogError("library.missing", `${source}: no library.json`);
  const parsed = LibraryManifest.safeParse(JSON.parse(readFileSync(file, "utf8")) as LibraryManifestInput);
  if (!parsed.success)
    throw new CatalogError(
      "library.invalid",
      parsed.error.issues.map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`).join("; "),
    );
  return { manifest: parsed.data, dir: dirname(resolve(file)) };
}

/** Every gltf entry's file must exist under assets/files and hash to what the manifest declares. */
export function verifyLibraryFiles(manifest: LibraryManifest, dir: string): void {
  for (const e of AssetManifest.parse(manifest.assets).entries) {
    if (e.kind !== "gltf") continue;
    const path = join(dir, "assets", "files", e.file as string);
    if (!existsSync(path))
      throw new CatalogError("asset.missing", `${manifest.id}: ${e.key}: file not found: ${e.file}`);
    const actual = sha256File(path);
    if (actual !== e.sha256)
      throw new CatalogError("asset.hash", `${manifest.id}: ${e.key}: sha256 mismatch for ${e.file}`);
    const bytes = statSync(path).size;
    if (bytes !== e.bytes)
      throw new CatalogError(
        "asset.bytes",
        `${manifest.id}: ${e.key}: ${e.file} is ${bytes} bytes, manifest says ${e.bytes}`,
      );
  }
  for (const t of manifest.textures) {
    const hex = t.image.slice("sha256:".length);
    const path = join(dir, "textures", `${hex}${extensionOf(dir, hex)}`);
    if (!existsSync(path))
      throw new CatalogError("texture.missing", `${manifest.id}: ${t.id}: no file textures/${hex}.*`);
    if (sha256File(path) !== hex)
      throw new CatalogError("texture.hash", `${manifest.id}: ${t.id}: sha256 mismatch`);
  }
}

function extensionOf(dir: string, hex: string): string {
  const folder = join(dir, "textures");
  if (!existsSync(folder)) return "";
  const hit = readdirSync(folder).find((f) => f.startsWith(hex));
  return hit ? hit.slice(hex.length) : "";
}

/**
 * Install from a directory: verify, copy under the data directory, register. The source directory is
 * left untouched; installing the same id and version again replaces the copy.
 */
export function installLibraryDir(
  store: CatalogStore,
  source: string,
  dataDir: string,
  now: string,
): LibraryRecord {
  const { manifest, dir } = readLibraryManifest(source);
  verifyLibraryFiles(manifest, dir);
  const target = libraryDir(dataDir, manifest.id, manifest.version);
  if (resolve(dir) !== resolve(target)) {
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    cpSync(dir, target, { recursive: true });
  }
  try {
    return store.installLibrary(manifest, now);
  } catch (e) {
    if (resolve(dir) !== resolve(target)) rmSync(target, { recursive: true, force: true });
    throw e;
  }
}

/** Remove one version: its files and its registration; the index is rebuilt from what remains. */
export function uninstallLibraryDir(
  store: CatalogStore,
  id: string,
  version: string,
  dataDir: string,
  now: string,
): boolean {
  const removed = store.uninstallLibrary(id, version, now);
  rmSync(libraryDir(dataDir, id, version), { recursive: true, force: true });
  return removed;
}

/** Installed libraries newest first (C-028), as the store lists them. */
export function installedLibraries(store: CatalogStore): LibraryRecord[] {
  return store.libraries();
}

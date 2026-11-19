// Catalog libraries installed from the editor (ADR-010 D10, spec 02 section 4, PRD P3-8). A library is a
// zip with library.json at its root and its files beside it. The catalog already knows how to check one
// and install it from a folder; this is the part between a person's zip and that folder.
//
// The zip arrives from a browser and may have been made by anything, so its entry names are held to what
// a library may contain rather than cleaned up: a name that climbs out of the folder, or names a drive,
// is refused with the rest of the file. Installing changes the catalog of every project on this host, so
// it is the person's to do from the editor, never a tool the agent is offered.
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GENERATED_LIBRARY_ID, LibraryManifest, SEED_LIBRARY_ID } from "@fpv/catalog";
import {
  CatalogError,
  type CatalogStore,
  installLibraryDir,
  type LibraryRecord,
  uninstallLibraryDir,
} from "@fpv/catalog/store";
import { type ZipEntry, ZipError } from "@fpv/exporters";
import { USER_LIBRARY } from "./user-textures.js";
import { readHostZip } from "./zips.js";

/** Libraries the app installs itself, or keeps itself: never installed over, never removed by hand. */
export const BUILT_IN_LIBRARIES: ReadonlySet<string> = new Set([
  SEED_LIBRARY_ID,
  GENERATED_LIBRARY_ID,
  USER_LIBRARY,
]);

/** The largest library zip taken from the editor. A library of models can be big; this is not a limit anyone should meet. */
export const MAX_LIBRARY_BYTES = 200 * 1024 * 1024;

/** A library as the editor lists it. */
export interface LibraryView extends LibraryRecord {
  /** Installed by the app; it cannot be removed. */
  builtIn: boolean;
}

/** Why a library was refused, in words for the person who chose the file. */
export class LibraryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string | null = null,
  ) {
    super(message);
    this.name = "LibraryError";
  }
}

/** A path inside a library: plain names, separated by slashes, none of them "." or "..". */
const SAFE_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9 _.()+-]+(?:\/[A-Za-z0-9 _.()+-]+)*$/;

/** Folders and files a zip tool adds that are not part of anything: macOS's resource forks and the like. */
const NOISE = (name: string) => name.startsWith("__MACOSX/") || /(?:^|\/)\.[^/]*$/.test(name);

export class Libraries {
  constructor(
    private readonly store: CatalogStore,
    private readonly dataDir: string,
    private readonly now: () => string,
    /** Told after anything is installed or removed, so caches of the catalog can be dropped. */
    private readonly changed: () => void = () => {},
  ) {}

  list(): LibraryView[] {
    return this.store.libraries().map((l) => ({ ...l, builtIn: BUILT_IN_LIBRARIES.has(l.id) }));
  }

  /** Install a library from its zip. Nothing is installed unless all of it checks out. */
  installZip(bytes: Uint8Array): { library: LibraryView; replaced: boolean } {
    if (bytes.length > MAX_LIBRARY_BYTES)
      throw new LibraryError(
        "library.too-big",
        `that file is ${Math.round(bytes.length / 1e6)} MB; the limit is ${Math.round(MAX_LIBRARY_BYTES / 1e6)} MB`,
      );
    let entries: ZipEntry[];
    try {
      entries = readHostZip(bytes);
    } catch (e) {
      if (e instanceof ZipError)
        throw new LibraryError(
          "library.unreadable",
          `this file is not a library: ${e.message}`,
          "choose a library's .zip",
        );
      throw e;
    }
    const files = entries.filter((e) => !NOISE(e.name));
    const prefix = rootOf(files);
    if (prefix === null)
      throw new LibraryError(
        "library.missing",
        "there is no library.json in this zip",
        "a library has library.json at its root, or in one folder at the top",
      );
    const manifestEntry = files.find((e) => e.name === `${prefix}library.json`) as ZipEntry;
    const manifest = parseManifest(manifestEntry.data);
    if (BUILT_IN_LIBRARIES.has(manifest.id))
      throw new LibraryError(
        "library.reserved",
        `"${manifest.id}" is a library the app keeps itself`,
        "give the library another id in its library.json",
      );
    for (const f of files)
      if (!f.name.startsWith(prefix) || !SAFE_PATH.test(f.name.slice(prefix.length)))
        throw new LibraryError(
          "library.unsafe",
          `the zip holds a file named "${f.name}", which a library may not`,
        );
    const replaced = this.store
      .libraries()
      .some((l) => l.id === manifest.id && l.version === manifest.version);
    // Unpacked beside the libraries rather than in the system's temporary folder, so the copy the
    // installer makes stays on one volume; and removed whatever happens.
    const incoming = join(this.dataDir, "libraries", `.incoming-${randomBytes(6).toString("hex")}`);
    try {
      for (const f of files) {
        const path = join(incoming, ...f.name.slice(prefix.length).split("/"));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, f.data);
      }
      const record = installLibraryDir(this.store, incoming, this.dataDir, this.now());
      this.changed();
      return { library: { ...record, builtIn: false }, replaced };
    } catch (e) {
      if (e instanceof CatalogError) throw new LibraryError(e.code, e.message);
      throw e;
    } finally {
      rmSync(incoming, { recursive: true, force: true });
    }
  }

  /** Remove one version of a library. Projects keep the products they placed from it: each holds a copy. */
  uninstall(id: string, version: string): boolean {
    if (BUILT_IN_LIBRARIES.has(id))
      throw new LibraryError("library.built-in", `"${id}" comes with the app and cannot be removed`);
    const removed = uninstallLibraryDir(this.store, id, version, this.dataDir, this.now());
    if (removed) this.changed();
    return removed;
  }
}

/** "" when library.json is at the root, "folder/" when it is in the one folder everything sits in, else null. */
function rootOf(files: readonly ZipEntry[]): string | null {
  if (files.some((f) => f.name === "library.json")) return "";
  const first = files[0]?.name ?? "";
  const slash = first.indexOf("/");
  if (slash < 0) return null;
  const prefix = first.slice(0, slash + 1);
  return files.every((f) => f.name.startsWith(prefix)) &&
    files.some((f) => f.name === `${prefix}library.json`)
    ? prefix
    : null;
}

function parseManifest(bytes: Uint8Array): LibraryManifest {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new LibraryError("library.invalid", "library.json is not JSON");
  }
  const parsed = LibraryManifest.safeParse(json);
  if (!parsed.success)
    throw new LibraryError(
      "library.invalid",
      `library.json: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`)
        .join("; ")}`,
    );
  return parsed.data;
}

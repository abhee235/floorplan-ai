// Project files (ADR-012): a project is a directory with project.json and manifest.json. Saves are
// atomic (temp file, fsync, rename), a manifest hash detects outside edits without ever blocking an
// open, a recovery file is written while the project is modified, and a session file lets other
// processes find the host that has the project open.
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { access, constants, mkdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Store } from "@fpv/commands";
import { deserialize, type Project, SCHEMA_VERSION, serialize } from "@fpv/ir";
import type { OpenInfo, OpenOptions, ProjectFiles } from "@fpv/tools";

export const FORMAT_VERSION = 1;
export const PROJECT_FILE = "project.json";
export const MANIFEST_FILE = "manifest.json";
export const RECOVERY_FILE = "recovery.json";
export const SESSION_DIR = ".fpviz";
export const SESSION_FILE = "session.json";
export const AUTOSAVE_MS = 60_000;

export interface Manifest {
  formatVersion: number;
  appVersion: string;
  schemaVersion: number;
  savedAt: string;
  project: { file: string; sha256: string; bytes: number };
  assets: { key: string; file: string; sha256: string }[];
}

export interface SessionFile {
  pid: number;
  port: number;
  startedAt: string;
  projectPath: string;
  protocolVersion: number;
}

export class ProjectFileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string | null = null,
  ) {
    super(message);
    this.name = "ProjectFileError";
  }
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Accepts a project directory, a `project.json` path, or a `<name>.fpviz` directory; returns the directory. */
export function projectDir(path: string): string {
  const abs = resolve(path);
  if (extname(abs) === ".json") return dirname(abs);
  return abs;
}

/** Write a file fully, flush it to disk, and only then rename it over its target (ADR-012 D3, P-005 reversed). */
export async function writeAtomic(
  target: string,
  text: string | Uint8Array,
  signal?: AbortSignal,
): Promise<number> {
  const tmp = `${target}.tmp`;
  const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : Buffer.from(text);
  try {
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (signal?.aborted)
      throw new ProjectFileError("file.aborted", "save was cancelled before the file was replaced");
    await rename(tmp, target); // replace semantics on every platform Node supports
  } catch (e) {
    await rm(tmp, { force: true }); // never leave a temporary behind (P-020 reversed)
    throw e;
  }
  return bytes.length;
}

/** Free bytes on the volume holding `dir`, or null when the platform cannot say (which disables the check, P-007). */
export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    const free = Number(s.bavail) * Number(s.bsize);
    return Number.isFinite(free) && free > 0 ? free : null;
  } catch {
    return null;
  }
}

export interface ProjectFileStoreOptions {
  now?: () => string;
  appVersion?: string;
  autosaveMs?: number;
  /** Override for tests: pretend the volume has this many free bytes. */
  freeBytes?: (dir: string) => Promise<number | null>;
}

/** Owns the on-disk form of the open project; implements the tools' ProjectFiles hook. */
export class ProjectFileStore implements ProjectFiles {
  private dir: string | null = null;
  private savedAt: string | null = null;
  private recovery: string | null = null;
  private store: Store | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => string;
  private readonly appVersion: string;
  private readonly autosaveMs: number;
  private readonly free: (dir: string) => Promise<number | null>;
  /** Transient flags of the open project (P-011 reversed: never written). */
  modifiedOutside = false;
  manifestMissing = false;

  constructor(options: ProjectFileStoreOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.appVersion = options.appVersion ?? "0.0.1";
    this.autosaveMs = options.autosaveMs ?? AUTOSAVE_MS;
    this.free = options.freeBytes ?? freeBytes;
  }

  /** The store whose project is saved; set once the session exists. */
  bind(store: Store): this {
    this.store = store;
    return this;
  }

  path(): string | null {
    return this.dir;
  }
  lastSavedAt(): string | null {
    return this.savedAt;
  }
  recoveryAt(): string | null {
    return this.recovery;
  }

  /** Read and validate a project directory; never repairs, never blocks on a hash mismatch (ADR-012 D4). */
  async open(path: string, options: OpenOptions = {}): Promise<OpenInfo> {
    const dir = projectDir(path);
    const mainPath = join(dir, PROJECT_FILE);
    const recoveryPath = join(dir, RECOVERY_FILE);
    if (!existsSync(mainPath))
      throw new ProjectFileError(
        "file.missing",
        `${mainPath} does not exist`,
        "give a project directory or its project.json",
      );
    const recoveryAt = newerRecovery(mainPath, recoveryPath);
    const source = options.recover && recoveryAt ? recoveryPath : mainPath;
    const text = await readFile(source, "utf8");
    const parsed = deserialize(text);
    if (!parsed.ok) {
      const first = parsed.problems[0];
      const hint =
        source === mainPath && recoveryAt
          ? `a recovery file from ${recoveryAt} exists; open with recover: true`
          : null;
      throw new ProjectFileError(
        first?.code ?? "file.shape",
        `${basename(source)}: ${first?.message ?? "unreadable"}`,
        hint,
      );
    }
    // manifest: a hash mismatch is reported, not repaired (P-008..P-012 reversed)
    let manifestMissing = false;
    let modifiedOutside = false;
    const manifestPath = join(dir, MANIFEST_FILE);
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
        if (manifest.formatVersion > FORMAT_VERSION)
          throw new ProjectFileError(
            "file.newer",
            `manifest is format version ${manifest.formatVersion}; this build supports up to ${FORMAT_VERSION}`,
            "update the app",
          );
        const mainText = source === mainPath ? text : await readFile(mainPath, "utf8");
        modifiedOutside = manifest.project?.sha256 !== sha256(mainText);
      } catch (e) {
        if (e instanceof ProjectFileError) throw e;
        modifiedOutside = true; // unreadable manifest counts as an outside edit
      }
    } else manifestMissing = true;
    this.dir = dir;
    this.recovery = recoveryAt;
    this.modifiedOutside = modifiedOutside;
    this.manifestMissing = manifestMissing;
    this.savedAt = null;
    try {
      this.savedAt = (await stat(mainPath)).mtime.toISOString();
    } catch {
      this.savedAt = null;
    }
    return {
      project: parsed.project,
      path: dir,
      migrated: parsed.migrated,
      modifiedOutside,
      manifestMissing,
      recoveryAt,
    };
  }

  /**
   * Save the store's project: writable check, free-space check, then project.json and manifest.json
   * written atomically (ADR-012 D3). A failure leaves the previous files intact.
   */
  async save(
    path: string | null,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ path: string; bytes: number }> {
    const store = this.requireStore();
    const dir = path ? projectDir(path) : this.dir;
    if (!dir)
      throw new ProjectFileError("file.no-path", "the project has no path yet", "give a path to save to");
    // P-006: a destination that cannot be created or written fails before any temporary is created
    try {
      await mkdir(dir, { recursive: true });
      await access(dir, constants.W_OK);
    } catch {
      throw new ProjectFileError("file.not-writable", `${dir} is not a writable directory`);
    }
    const text = serialize(store.project);
    const manifest: Manifest = {
      formatVersion: FORMAT_VERSION,
      appVersion: this.appVersion,
      schemaVersion: SCHEMA_VERSION,
      savedAt: this.now(),
      project: { file: PROJECT_FILE, sha256: sha256(text), bytes: Buffer.byteLength(text, "utf8") },
      assets: [],
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    // P-007: free space must cover the growth over the existing files
    const needed = Buffer.byteLength(text, "utf8") + Buffer.byteLength(manifestText, "utf8");
    const existing = sizeOf(join(dir, PROJECT_FILE)) + sizeOf(join(dir, MANIFEST_FILE));
    const free = await this.free(dir);
    if (free !== null && free < needed - existing) {
      const missing = needed - existing - free;
      throw new ProjectFileError(
        "file.no-space",
        `not enough free space to save: ${missing} more bytes needed`,
        "free some disk space or save elsewhere",
      );
    }
    const bytes = await writeAtomic(join(dir, PROJECT_FILE), text, options.signal);
    await writeAtomic(join(dir, MANIFEST_FILE), manifestText, options.signal);
    await rm(join(dir, RECOVERY_FILE), { force: true }); // D6: recovery is cleared by a successful save
    this.dir = dir;
    this.savedAt = manifest.savedAt;
    this.recovery = null;
    this.modifiedOutside = false;
    this.manifestMissing = false;
    store.markSaved();
    return { path: dir, bytes };
  }

  /** Write recovery.json when the project is modified and has a directory (ADR-012 D6). */
  async writeRecovery(): Promise<boolean> {
    const store = this.requireStore();
    if (!this.dir || !store.modified) return false;
    await writeAtomic(join(this.dir, RECOVERY_FILE), serialize(store.project));
    this.recovery = this.now();
    return true;
  }

  startAutosave(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.writeRecovery().catch(() => {});
    }, this.autosaveMs);
    this.timer.unref?.();
  }

  stopAutosave(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** D7: record this host in <dir>/.fpviz/session.json; removed by closeSession. */
  async writeSession(port: number, protocolVersion: number, pid = process.pid): Promise<string | null> {
    if (!this.dir) return null;
    const dir = join(this.dir, SESSION_DIR);
    await mkdir(dir, { recursive: true });
    const file = join(dir, SESSION_FILE);
    const body: SessionFile = { pid, port, startedAt: this.now(), projectPath: this.dir, protocolVersion };
    await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    return file;
  }

  async closeSession(): Promise<void> {
    if (!this.dir) return;
    await rm(join(this.dir, SESSION_DIR, SESSION_FILE), { force: true });
  }

  private requireStore(): Store {
    if (!this.store) throw new ProjectFileError("file.no-store", "no project is open in this session");
    return this.store;
  }
}

/** Read a session file and say whether its host is still alive (a stale file names a dead pid). */
export function readSession(
  projectPath: string,
  isAlive: (pid: number) => boolean = pidAlive,
): { session: SessionFile; alive: boolean } | null {
  const file = join(projectDir(projectPath), SESSION_DIR, SESSION_FILE);
  if (!existsSync(file)) return null;
  try {
    const session = JSON.parse(readFileSync(file, "utf8")) as SessionFile;
    return { session, alive: isAlive(session.pid) };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** ISO time of a recovery file newer than the main file, else null. */
function newerRecovery(mainPath: string, recoveryPath: string): string | null {
  if (!existsSync(recoveryPath)) return null;
  const r = statSync(recoveryPath).mtimeMs;
  const m = statSync(mainPath).mtimeMs;
  return r > m ? new Date(r).toISOString() : null;
}

export type { Project };

import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Project, sequentialIdGenerator } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import {
  createSession,
  MANIFEST_FILE,
  type Manifest,
  PROJECT_FILE,
  ProjectFileError,
  ProjectFileStore,
  RECOVERY_FILE,
  readSession,
  sha256,
} from "../src/index.js";

const fixtureDir = fileURLToPath(new URL("../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const fixture = () => Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));
const NOW = "2026-09-15T12:00:00.000Z";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "fpv-save-"));
}

function session(options: { freeBytes?: number | null; project?: ReturnType<typeof fixture> } = {}) {
  const files = new ProjectFileStore({
    now: () => NOW,
    appVersion: "test",
    autosaveMs: 60_000,
    ...(options.freeBytes !== undefined ? { freeBytes: async () => options.freeBytes ?? null } : {}),
  });
  const s = createSession({
    files,
    project: options.project ?? fixture(),
    ids: sequentialIdGenerator(900),
    now: () => NOW,
  });
  return { ...s, files };
}

const tmpFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".tmp"));

async function fail(p: Promise<unknown>): Promise<ProjectFileError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ProjectFileError) return e;
    throw e;
  }
  throw new Error("expected a ProjectFileError");
}

describe("project files: atomic save (ADR-012 D3)", () => {
  it("P-005 P-050 P-054 P-060 saves project.json and manifest.json by rename, stamped, byte-stable, in our units", async () => {
    const dir = tmp();
    const { files, store } = session();
    const r = await files.save(dir);
    expect(r.path).toBe(dir);
    expect(tmpFiles(dir)).toEqual([]);
    const text = readFileSync(join(dir, PROJECT_FILE), "utf8");
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8")) as Manifest;
    expect(manifest.project.sha256).toBe(sha256(text));
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.savedAt).toBe(NOW);
    const doc = JSON.parse(text) as {
      schemaVersion: number;
      meta: { units: string; north: number; createdAt: string };
      walls: { thickness: number }[];
    };
    expect(doc.schemaVersion).toBe(1);
    expect(doc.meta.units).toBe("mm");
    expect(Number.isInteger(doc.walls[0]?.thickness)).toBe(true);
    expect(doc.meta.north).toBe(90); // degrees, not radians
    expect(doc.meta.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(store.modified).toBe(false);
    // save, load, save again gives identical bytes
    const again = session();
    const opened = await again.files.open(dir);
    again.store.load(opened.project);
    const dir2 = tmp();
    await again.files.save(dir2);
    expect(readFileSync(join(dir2, PROJECT_FILE), "utf8")).toBe(text);
  });

  it("P-006 a destination that is not writable fails before any temporary file exists", async () => {
    const dir = tmp();
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    const { files } = session();
    const e = await fail(files.save(blocker));
    expect(e.code).toBe("file.not-writable");
    expect(tmpFiles(dir)).toEqual([]);
  });

  it("P-007 too little free space fails with the missing byte count; existing files count against the need", async () => {
    const dir = tmp();
    const { files } = session({ freeBytes: 10 });
    const e = await fail(files.save(dir));
    expect(e.code).toBe("file.no-space");
    expect(e.message).toMatch(/\d+ more bytes/);
    expect(existsSync(join(dir, PROJECT_FILE))).toBe(false);
    const roomy = session({ freeBytes: null }); // unknown free space disables the check
    await roomy.files.save(dir);
    const grown = session({ freeBytes: 1 });
    await grown.files.save(dir); // same content already on disk: nothing more is needed
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(true);
  });

  it("P-020 P-061 reversed: a save cancelled before the rename leaves the destination untouched and no temporary", async () => {
    const dir = tmp();
    const { files, store } = session();
    await files.save(dir);
    const before = readFileSync(join(dir, PROJECT_FILE), "utf8");
    store.apply({ type: "wall.move", payload: { wallIds: ["wall_000004"], dx: 0, dy: 100 } }, "editor");
    const ac = new AbortController();
    ac.abort();
    const e = await fail(files.save(dir, { signal: ac.signal }));
    expect(e.code).toBe("file.aborted");
    expect(readFileSync(join(dir, PROJECT_FILE), "utf8")).toBe(before);
    expect(tmpFiles(dir)).toEqual([]);
    expect(store.modified).toBe(true);
  });
});

describe("project files: open, integrity, recovery (ADR-012 D4, D6, D7)", () => {
  it("P-004 P-009 bytes that are not a project are rejected with the file code; nothing is repaired", async () => {
    const dir = tmp();
    writeFileSync(join(dir, PROJECT_FILE), Buffer.alloc(8192));
    const { files } = session();
    const e = await fail(files.open(dir));
    expect(e.code).toBe("file.json");
    writeFileSync(join(dir, PROJECT_FILE), JSON.stringify({ schemaVersion: 1, meta: {} }));
    expect((await fail(files.open(dir))).code).toBe("file.shape");
    expect((await fail(files.open(join(dir, "nope")))).code).toBe("file.missing");
  });

  it("P-008 P-010 P-011 P-012 reversed: a hash mismatch or a missing manifest opens with a transient flag, never a repair", async () => {
    const dir = tmp();
    const { files } = session();
    await files.save(dir);
    writeFileSync(
      join(dir, PROJECT_FILE),
      readFileSync(join(dir, PROJECT_FILE), "utf8").replace(
        '"name": "Six-wall L-shaped room"',
        '"name": "Edited outside"',
      ),
    );
    const other = session();
    const opened = await other.files.open(dir);
    expect(opened.modifiedOutside).toBe(true);
    expect(opened.project.meta.name).toBe("Edited outside");
    other.store.load(opened.project);
    await other.files.save(dir);
    expect(other.files.modifiedOutside).toBe(false);
    expect(readFileSync(join(dir, MANIFEST_FILE), "utf8")).not.toContain("modifiedOutside");
    const bare = tmp();
    writeFileSync(join(bare, PROJECT_FILE), readFileSync(join(dir, PROJECT_FILE)));
    const noManifest = await session().files.open(bare);
    expect(noManifest.manifestMissing).toBe(true);
    expect(noManifest.modifiedOutside).toBe(false);
  });

  it("P-051 reversed: a newer format or schema is refused, naming both versions", async () => {
    const dir = tmp();
    const { files } = session();
    await files.save(dir);
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8")) as Manifest;
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify({ ...manifest, formatVersion: 2 }));
    const e = await fail(session().files.open(dir));
    expect(e.code).toBe("file.newer");
    expect(e.message).toContain("2");
    expect(e.message).toContain("1");
    const dir2 = tmp();
    writeFileSync(
      join(dir2, PROJECT_FILE),
      readFileSync(join(dir, PROJECT_FILE), "utf8").replace('"schemaVersion": 1', '"schemaVersion": 99'),
    );
    expect((await fail(session().files.open(dir2))).code).toBe("file.newer");
  });

  it("P-052 selection and history are not persisted; P-059 rejected: no size backfill from files", async () => {
    const dir = tmp();
    const { files, store, registry } = session();
    store.apply({ type: "wall.move", payload: { wallIds: ["wall_000004"], dx: 0, dy: 100 } }, "editor");
    store.setSelection(["wall_000004"]);
    await files.save(dir);
    const again = session();
    const opened = await again.files.open(dir);
    again.store.load(opened.project);
    expect(again.store.selection).toEqual([]);
    expect(again.store.canUndo).toBe(false);
    expect(again.store.project.walls[3]?.start.y).toBe(3100);
    // a product without a snapshot on disk stays a validation problem instead of an invented size
    const doc = JSON.parse(readFileSync(join(dir, PROJECT_FILE), "utf8")) as { items: unknown[] };
    doc.items.push({
      ...JSON.parse(JSON.stringify(blankItem())),
    });
    writeFileSync(join(dir, PROJECT_FILE), JSON.stringify(doc));
    const third = session();
    third.store.load((await third.files.open(dir)).project);
    const problems = third.registry.problems();
    expect(problems.some((p) => p.code === "catalog.missing-snapshot")).toBe(true);
    expect(registry.list().length).toBeGreaterThan(0);
  });

  it("recovery.json is written while modified, offered on open when newer, loadable, and cleared by a save", async () => {
    const dir = tmp();
    const { files, store } = session();
    await files.save(dir);
    expect(await files.writeRecovery()).toBe(false); // not modified
    store.apply({ type: "wall.move", payload: { wallIds: ["wall_000004"], dx: 0, dy: 100 } }, "editor");
    expect(await files.writeRecovery()).toBe(true);
    // make the recovery file clearly newer than project.json
    const future = new Date(Date.now() + 5000);
    utimesSync(join(dir, RECOVERY_FILE), future, future);
    const other = session();
    const opened = await other.files.open(dir);
    expect(opened.recoveryAt).not.toBeNull();
    expect(opened.project.walls[3]?.start.y).toBe(3000); // the saved file by default
    const recovered = await other.files.open(dir, { recover: true });
    expect(recovered.project.walls[3]?.start.y).toBe(3100);
    other.store.load(recovered.project);
    await other.files.save(dir);
    expect(existsSync(join(dir, RECOVERY_FILE))).toBe(false);
    expect(other.files.recoveryAt()).toBeNull();
    // a corrupt main file points at the recovery file
    writeFileSync(join(dir, RECOVERY_FILE), readFileSync(join(dir, PROJECT_FILE)));
    utimesSync(join(dir, RECOVERY_FILE), future, future);
    writeFileSync(join(dir, PROJECT_FILE), "{ broken");
    const e = await fail(session().files.open(dir));
    expect(e.hint).toContain("recover: true");
  });

  it("session.json names the host while open and reads as stale when its pid is dead", async () => {
    const dir = tmp();
    const { files } = session();
    await files.save(dir);
    const file = await files.writeSession(4310, 1, 424242);
    expect(file).not.toBeNull();
    const alive = readSession(dir, () => true);
    expect(alive?.session).toMatchObject({ pid: 424242, port: 4310, protocolVersion: 1, projectPath: dir });
    expect(readSession(dir, () => false)?.alive).toBe(false);
    await files.closeSession();
    expect(readSession(dir)).toBeNull();
  });

  it("the project tool saves, opens and reports through the same store", async () => {
    const dir = tmp();
    const { registry, store } = session();
    const saved = await registry.call("project", { op: "save", path: dir });
    expect(saved.ok).toBe(true);
    if (saved.ok)
      expect(saved.result).toMatchObject({
        path: dir,
        modified: false,
        lastSavedAt: NOW,
        recoveryAvailable: null,
      });
    store.apply({ type: "wall.move", payload: { wallIds: ["wall_000004"], dx: 0, dy: 100 } }, "editor");
    const fresh = await registry.call("project", { op: "new", name: "Blank" });
    expect(fresh.ok).toBe(true);
    expect(store.project.walls).toHaveLength(0);
    const opened = await registry.call("project", { op: "open", path: dir });
    expect(opened.ok).toBe(true);
    expect(store.project.walls).toHaveLength(6);
    expect(store.project.walls[3]?.start.y).toBe(3000); // the saved state, not the moved one
    const missing = await registry.call("project", { op: "open", path: join(dir, "nowhere") });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("file.missing");
  });
});

function blankItem() {
  return {
    id: "item_zz0001",
    levelId: "level_000000",
    ref: { kind: "product", productId: "ghost-desk" },
    position: { x: 2000, y: 2000 },
    rotation: 0,
    elevation: 0,
    size: null,
    mirrored: false,
    mount: { kind: "floor", targetId: null, height: null },
    parentId: null,
    roomId: null,
    finish: null,
    materials: {},
    pose: null,
    visible: true,
    tags: [],
    properties: {},
  };
}

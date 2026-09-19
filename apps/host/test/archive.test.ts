// A project as one file, out and back (P3-11, ADR-021 D4).
//
// The library owns where projects live and the editor never sees a path, so this pair is the only way
// work gets out of an installation. Without it "the app decides where your work lives" means "your work
// is not yours", which no amount of care in the library would make up for.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "@fpv/commands";
import { unzipStore, zipStore } from "@fpv/exporters";
import { sequentialIdGenerator } from "@fpv/ir";
import { blankProject } from "@fpv/tools";
import { describe, expect, it } from "vitest";
import { archiveName, packProject, readArchive } from "../src/archive.js";
import { libraryRoot } from "../src/library.js";
import { ProjectRegistry } from "../src/projects.js";
import { Workspace } from "../src/workspace.js";

const NOW = "2026-09-19T10:00:00.000Z";
const temp = () => mkdtempSync(join(tmpdir(), "fpv-archive-"));

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const entryNames = (zip: Uint8Array) =>
  unzipStore(zip)
    .map((e) => e.name)
    .sort();
const entry = (zip: Uint8Array, name: string) => unzipStore(zip).find((e) => e.name === name);

function aProject(name = "Boardroom") {
  // Built through the reducer, not by hand: an entity written out in a test drifts from the schema the
  // moment the schema changes, and the archive's whole job is to carry entities the schema accepts.
  const project = blankProject(name, NOW);
  const r = apply(
    project,
    {
      type: "wall.create",
      payload: {
        levelId: project.levels[0]?.id ?? "level_000000",
        start: { x: 0, y: 0 },
        end: { x: 4000, y: 0 },
      },
    },
    { ids: sequentialIdGenerator(1), now: () => NOW },
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}

describe("packing a project into one file", () => {
  it("writes the tree ADR-012 D1 describes, and nothing of this installation's own", async () => {
    const dir = temp();
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "abc123.png"), Buffer.from([1, 2, 3]));
    // working state that belongs to this machine and means nothing anywhere else
    writeFileSync(join(dir, "recovery.json"), "{}", "utf8");
    mkdirSync(join(dir, ".fpviz"), { recursive: true });
    writeFileSync(join(dir, ".fpviz", "session.json"), "{}", "utf8");

    const zip = await packProject(aProject(), dir, "0.0.1", NOW);
    expect(entryNames(zip)).toEqual(["assets/abc123.png", "manifest.json", "project.json"]);

    const manifest = JSON.parse(text(entry(zip, "manifest.json")?.data as Uint8Array));
    expect(manifest.appVersion).toBe("0.0.1");
    expect(manifest.assets).toEqual([{ key: "abc123", file: "abc123.png", sha256: expect.any(String) }]);
  });

  it("packs the project in hand, not the one on disk: exporting is not saving", async () => {
    const dir = temp();
    // a stale file in the folder, as an unsaved project has
    writeFileSync(join(dir, "project.json"), JSON.stringify(blankProject("Stale", NOW)), "utf8");
    const zip = await packProject(aProject("Live"), dir, "0.0.1", NOW);
    const inside = JSON.parse(text(entry(zip, "project.json")?.data as Uint8Array));
    expect(inside.meta.name).toBe("Live");
    expect(inside.walls).toHaveLength(1);
  });

  it("works for a project with no folder at all", async () => {
    const zip = await packProject(aProject(), null, "0.0.1", NOW);
    expect(entryNames(zip)).toEqual(["manifest.json", "project.json"]);
  });

  it("names the file after the project, without the characters a file system argues about", () => {
    expect(archiveName("Boardroom")).toBe("Boardroom.fpviz.zip");
    expect(archiveName("Level 2 / East wing")).toBe("Level 2 - East wing.fpviz.zip");
    expect(archiveName("  ..  ")).toBe("project.fpviz.zip");
    expect(archiveName("")).toBe("project.fpviz.zip");
  });
});

describe("reading a file back", () => {
  it("round-trips a project through the archive", async () => {
    const zip = await packProject(aProject(), null, "0.0.1", NOW);
    const read = readArchive(zip);
    expect(read.project.meta.name).toBe("Boardroom");
    expect(read.project.walls).toHaveLength(1);
  });

  it("reads an archive that wraps everything in one folder, as zipping a folder does", async () => {
    const zip = await packProject(aProject(), null, "0.0.1", NOW);
    const wrapped = zipStore(
      unzipStore(zip).map((e) => ({ name: `Boardroom.fpviz/${e.name}`, data: e.data })),
    );
    expect(readArchive(wrapped).project.meta.name).toBe("Boardroom");
  });

  it("takes only the files a project is allowed to have, whatever the archive calls them", async () => {
    const zip = await packProject(aProject(), null, "0.0.1", NOW);
    const nasty = zipStore([
      ...unzipStore(zip),
      { name: "assets/../../.ssh/authorized_keys", data: new TextEncoder().encode("ssh-rsa AAA") },
      { name: "assets/ok.png", data: new Uint8Array([9]) },
      { name: "/etc/passwd", data: new TextEncoder().encode("root:x:0:0") },
    ]);
    const read = readArchive(nasty);
    // the climbing names match nothing a project may contain, so nothing carries them out of here
    expect(read.assets.map((a) => a.name)).toEqual(["ok.png"]);
  });

  it("says what is wrong rather than throwing something the editor cannot show", async () => {
    // a file that is not a zip at all, and an empty one, are different things to whoever chose it
    expect(() => readArchive(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a project archive/);
    expect(() => readArchive(new Uint8Array([0x50, 0x4b, 5, 6]))).toThrow(/nothing in it/);
    const empty = zipStore([{ name: "readme.txt", data: new TextEncoder().encode("hello") }]);
    expect(() => readArchive(empty)).toThrow(/holds no project\.json/);
    const bad = zipStore([{ name: "project.json", data: new TextEncoder().encode("{oh no") }]);
    expect(() => readArchive(bad)).toThrow(/not valid JSON/);
    const wrong = zipStore([{ name: "project.json", data: new TextEncoder().encode('{"a":1}') }]);
    expect(() => readArchive(wrong)).toThrow(/not a project/);
  });
});

describe("a project imported into the library", () => {
  function library(): { root: string; workspace: Workspace } {
    const dir = temp();
    const root = libraryRoot(dir);
    const registry = ProjectRegistry.memory();
    return { root, workspace: new Workspace({ now: () => NOW, library: root, registry }) };
  }

  it("keeps its own id, so a project carried between installations is the same project", async () => {
    const zip = await packProject(aProject(), null, "0.0.1", NOW);
    const { root, workspace } = library();
    const held = await workspace.import(zip);
    expect(held.id).toBe(readArchive(zip).project.meta.id);
    // and it is in the library, written through the ordinary save: manifest and all
    const written = JSON.parse(readFileSync(join(root, held.id, "project.json"), "utf8"));
    expect(written.meta.id).toBe(held.id);
    expect(readFileSync(join(root, held.id, "manifest.json"), "utf8")).toContain("formatVersion");
    workspace.closeAll();
  });

  it("gives a copy a new id rather than overwriting the project already here", async () => {
    const zip = await packProject(aProject(), null, "0.0.1", NOW);
    const { root, workspace } = library();
    const first = await workspace.import(zip);
    const second = await workspace.import(zip);
    expect(second.id).not.toBe(first.id);
    // both are on disk, and the first still holds its own work
    expect(readFileSync(join(root, first.id, "project.json"), "utf8")).toContain(first.id);
    expect(readFileSync(join(root, second.id, "project.json"), "utf8")).toContain(second.id);
    // and they are told apart in the list, rather than being two rows of the same name
    expect(second.session.store.project.meta.name).not.toBe(first.session.store.project.meta.name);
    workspace.closeAll();
  });

  it("brings its assets with it", async () => {
    const dir = temp();
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "deadbeef.png"), Buffer.from([7, 7, 7]));
    const zip = await packProject(aProject(), dir, "0.0.1", NOW);
    const { root, workspace } = library();
    const held = await workspace.import(zip);
    expect([...readFileSync(join(root, held.id, "assets", "deadbeef.png"))]).toEqual([7, 7, 7]);
    workspace.closeAll();
  });

  it("exports what the editor shows, including work that has not been saved", async () => {
    const { workspace } = library();
    const made = await workspace.create("Boardroom");
    made.session.store.apply({
      type: "wall.create",
      payload: {
        levelId: made.session.store.project.levels[0]?.id,
        start: { x: 0, y: 0 },
        end: { x: 2000, y: 0 },
      },
    });
    const before = made.session.store.savedPosition;
    const file = await workspace.export(made.id);
    expect(file.name).toBe("Boardroom.fpviz.zip");
    expect(readArchive(file.bytes).project.walls).toHaveLength(1);
    // exporting is a copy, not a save: the unsaved mark is exactly where it was
    expect(made.session.store.savedPosition).toBe(before);
    workspace.closeAll();
  });
});

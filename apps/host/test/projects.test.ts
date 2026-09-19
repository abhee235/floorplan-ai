// Managing several projects from the editor (ADR-012 D8): the remembered list, looking around the
// machine's folders, and the message that tells a tab what is open and whether it is saved.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankProject } from "@fpv/tools";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ProjectFileStore } from "../src/files.js";
import { createSession, type Served, serve } from "../src/index.js";
import { ProjectRegistry, RECENT_LIMIT } from "../src/projects.js";

const NOW = "2026-09-19T10:00:00.000Z";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "fpv-projects-"));
}

/** A project directory on disk, as `project open` expects one. */
function makeProject(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "project.json"), JSON.stringify(blankProject(name, NOW)), "utf8");
  return dir;
}

/** The id inside a project on disk; everything is keyed by it now (ADR-020 D1). */
function idOf(dir: string): string {
  return (JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as { meta: { id: string } }).meta.id;
}

describe("the projects this installation knows (ADR-020 D1, D3)", () => {
  it("keeps the newest first and moves a project rather than repeating it", () => {
    const db = ProjectRegistry.memory();
    for (const [i, n] of ["a", "b", "c"].entries())
      db.remember({
        id: `id${n}aaaaaaaaa`,
        address: `/p/${n}`,
        name: n,
        at: `2026-01-0${i + 1}T00:00:00.000Z`,
      });
    expect(db.recent().map((r) => r.name)).toEqual(["c", "b", "a"]);

    // opening one again moves it to the top; the same project is one row, not two
    db.remember({ id: "idaaaaaaaaaa", address: "/p/a", name: "a", at: "2026-02-01T00:00:00.000Z" });
    expect(db.recent().map((r) => r.name)).toEqual(["a", "c", "b"]);
    expect(db.recent()).toHaveLength(3);
    db.close();
  });

  it("follows a project that moved, because the id is the key and not the address", () => {
    // A registry keyed by location orphans a link the moment a folder is dragged; this is the whole
    // reason the id lives in the document (ADR-020 D1).
    const db = ProjectRegistry.memory();
    db.remember({ id: "movedproject", address: "/old/place", name: "Boardroom", at: NOW });
    db.remember({ id: "movedproject", address: "/new/place", name: "Boardroom", at: NOW });
    expect(db.recent()).toHaveLength(1);
    expect(db.byId("movedproject")?.address).toBe("/new/place");
    db.close();
  });

  it("keeps the date a project was first seen when it is opened again", () => {
    const db = ProjectRegistry.memory();
    db.remember({ id: "firstseenaaa", address: "/p/a", name: "a", at: "2026-01-01T00:00:00.000Z" });
    db.remember({ id: "firstseenaaa", address: "/p/a", name: "a", at: "2026-06-01T00:00:00.000Z" });
    const row = db.byId("firstseenaaa");
    expect(row?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(row?.lastOpenedAt).toBe("2026-06-01T00:00:00.000Z");
    db.close();
  });

  it("answers for an id it has never seen with nothing, rather than guessing", () => {
    const db = ProjectRegistry.memory();
    expect(db.byId("neverseenaaa")).toBeNull();
    expect(db.recent()).toEqual([]);
    db.close();
  });

  it("stops at the limit", () => {
    const db = ProjectRegistry.memory();
    for (let i = 0; i < RECENT_LIMIT + 5; i += 1)
      db.remember({
        id: `bulk${String(i).padStart(8, "0")}`,
        address: `/p/n${i}`,
        name: `n${i}`,
        at: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
    expect(db.recent()).toHaveLength(RECENT_LIMIT);
    db.close();
  });

  it("hides projects that are no longer on disk without forgetting them", () => {
    const dir = temp();
    const db = ProjectRegistry.memory();
    const live = makeProject(dir, "still-here");
    db.remember({ id: idOf(live), address: live, name: "still-here", at: NOW });
    db.remember({ id: "goneprojecta", address: join(dir, "deleted"), name: "deleted", at: NOW });
    // both are still known: a project on a drive that is not plugged in today is worth remembering
    expect(db.recent()).toHaveLength(2);
    expect(db.recentPresent().map((r) => r.name)).toEqual(["still-here"]);
    db.close();
  });

  it("survives being reopened, which a JSON list read and rewritten in place would race over", () => {
    const dir = temp();
    const first = ProjectRegistry.open(dir);
    first.remember({ id: "persistedaaa", address: "/p/a", name: "Kept", at: NOW });
    first.close();
    const second = ProjectRegistry.open(dir);
    expect(second.byId("persistedaaa")?.name).toBe("Kept");
    second.close();
  });

  it("is written by the file store itself, so an open from anywhere is remembered", async () => {
    const dir = temp();
    const db = ProjectRegistry.memory();
    const project = makeProject(dir, "boardroom");
    const files = new ProjectFileStore({ now: () => NOW, remember: (entry) => db.remember(entry) });
    await files.open(project);
    expect(db.recent().map((r) => r.address)).toEqual([project]);
    expect(db.byId(idOf(project))?.name).toBe("boardroom");
    db.close();
  });
});

describe("a new project has no file (ADR-012 D8)", () => {
  /**
   * `project new` used to leave the file store pointing at whatever was open before it, so the very
   * next save wrote a blank project over that one without a word. File > New followed by Ctrl+S
   * destroyed the project that had been open a second earlier; it was found by doing exactly that in a
   * browser, and the project it ate was a real one.
   */
  it("refuses to save a new project until it is told where, rather than writing over the last one", async () => {
    const dir = temp();
    const project = makeProject(dir, "boardroom");
    const files = new ProjectFileStore({ now: () => NOW });
    const opened = await files.open(project);
    const session = createSession({ files, project: opened.project, now: () => NOW });
    expect(files.path()).toBe(project);

    const made = await session.registry.call("project", { op: "new", name: "Untitled" });
    expect(made.ok).toBe(true);
    expect(files.path()).toBeNull();

    const saved = await session.registry.call("project", { op: "save" });
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error.code).toBe("file.no-path");

    // and the project that was open a moment ago is untouched on disk
    const onDisk = JSON.parse(readFileSync(join(project, "project.json"), "utf8")) as {
      meta: { name: string };
    };
    expect(onDisk.meta.name).toBe("boardroom");
  });

  /**
   * The autosave used to set the same flag the editor reads to ask "unsaved work was recovered, take
   * it back?". So a minute into any session the question appeared about the session's own autosave,
   * and because it is a modal it tore down whatever menu was open at that moment. It was found by a
   * submenu vanishing under the pointer in a real browser.
   */
  it("never offers this session's own autosave back as recovered work", async () => {
    const dir = temp();
    const project = makeProject(dir, "boardroom");
    const files = new ProjectFileStore({ now: () => NOW });
    const opened = await files.open(project);
    const session = createSession({ files, project: opened.project, now: () => NOW });
    expect(files.recoveryAt()).toBeNull();

    session.store.apply({
      type: "wall.create",
      payload: {
        levelId: session.store.project.levels[0]?.id,
        start: { x: 0, y: 0 },
        end: { x: 1000, y: 0 },
      },
    });
    expect(await files.writeRecovery()).toBe(true);
    expect(existsSync(join(project, "recovery.json"))).toBe(true);
    // the file is there to be recovered from after a crash, and it is not a question for right now
    expect(files.recoveryAt()).toBeNull();
  });

  it("saves where it is told, and is a normal project from then on", async () => {
    const dir = temp();
    const files = new ProjectFileStore({ now: () => NOW });
    const session = createSession({ files, now: () => NOW });
    await session.registry.call("project", { op: "new", name: "Untitled" });
    const where = join(dir, "somewhere-new");
    const saved = await session.registry.call("project", { op: "save", path: where });
    expect(saved.ok).toBe(true);
    expect(files.path()).toBe(where);
    expect(session.store.modified).toBe(false);
  });
});

/** A tab, reduced to what these tests ask of it. */
class Tab {
  ws: WebSocket;
  seen: Record<string, unknown>[] = [];
  private pending = new Map<string, (m: Record<string, unknown>) => void>();
  private seq = 0;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as Record<string, unknown>;
      if (m.type === "result" || m.type === "welcome") this.pending.get(m.id as string)?.(m);
      else this.seen.push(m);
    });
  }
  open(): Promise<void> {
    return new Promise((r) => this.ws.once("open", () => r()));
  }
  send(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `t${(this.seq += 1)}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, ...body }));
    });
  }
  /** Wait until a message of this type has arrived, then return the last one. */
  async settle(type: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 100; i += 1) {
      const all = this.seen.filter((m) => m.type === type);
      if (all.length > 0) return all[all.length - 1] as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${type} arrived`);
  }
  close(): Promise<void> {
    return new Promise((r) => {
      this.ws.once("close", () => r());
      this.ws.close();
    });
  }
}

let served: Served | null = null;
afterEach(async () => {
  await served?.close();
  served = null;
});

describe("a project's URL is a route, not a file (ADR-020 D2)", () => {
  it("answers /p/<id> with the app, and a missing asset with a 404", async () => {
    const dir = temp();
    // a stand-in for the built web app
    mkdirSync(join(dir, "web"), { recursive: true });
    writeFileSync(join(dir, "web", "index.html"), "<!doctype html><title>app</title>", "utf8");
    const session = createSession({ now: () => NOW });
    served = await serve(session, { port: 0, webDir: join(dir, "web") });

    const route = await fetch(`http://127.0.0.1:${served.port}/p/g0z9i3cvo7qx`);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("<title>app</title>");

    // the root still works, and a missing script is still missing rather than answered with a page
    expect((await fetch(`http://127.0.0.1:${served.port}/`)).status).toBe(200);
    const asset = await fetch(`http://127.0.0.1:${served.port}/assets/not-there.js`);
    expect(asset.status).toBe(404);
  });
});

describe("what is open, over the bridge (ADR-012 D8)", () => {
  it("says what is open on connecting, and again when a save moves the saved position", async () => {
    const dir = temp();
    const project = makeProject(dir, "boardroom");
    const files = new ProjectFileStore({ now: () => NOW });
    const opened = await files.open(project);
    const session = createSession({ files, project: opened.project, now: () => NOW });
    served = await serve(session, { port: 0 });
    const tab = new Tab(`ws://127.0.0.1:${served.port}/bridge`);
    await tab.open();
    await tab.send({ type: "hello", clientVersion: "t", capabilities: ["plan"] });

    const first = await tab.settle("project.state");
    expect(first).toMatchObject({ name: "boardroom", historyPosition: 0, savedPosition: 0 });
    expect(first.path).toBe(project);

    // one change: the tab can see it is modified because the two positions differ
    tab.seen.length = 0;
    const r = await session.registry.call("project", { op: "info" });
    expect(r.ok).toBe(true);
    const drawn = session.store.apply({
      type: "wall.create",
      payload: {
        levelId: session.store.project.levels[0]?.id,
        start: { x: 0, y: 0 },
        end: { x: 1000, y: 0 },
      },
    });
    expect(drawn.ok).toBe(true);
    expect(session.store.historyPosition).toBe(1);
    expect(session.store.savedPosition).toBe(0);

    // saving moves nothing in the history, so only this message can carry the news
    await session.registry.call("project", { op: "save" });
    const after = await tab.settle("project.state");
    expect(after).toMatchObject({ historyPosition: 1, savedPosition: 1 });
    expect(after.lastSavedAt).toBe(NOW);
    await tab.close();
  });

  it("lists the library by id and name, and tells a tab no path at all (ADR-021)", async () => {
    const dir = temp();
    const project = makeProject(dir, "boardroom");
    const known = {
      id: idOf(project),
      address: project,
      name: "boardroom",
      createdAt: NOW,
      lastOpenedAt: NOW,
    };
    const session = createSession({ now: () => NOW });
    served = await serve(session, { port: 0, library: () => [known] });
    const tab = new Tab(`ws://127.0.0.1:${served.port}/bridge`);
    await tab.open();
    await tab.send({ type: "hello", clientVersion: "t", capabilities: ["plan"] });

    const listed = await tab.send({ type: "files", op: "list" });
    expect(listed.ok).toBe(true);
    const body = listed.result as { projects: Record<string, unknown>[] };
    expect(body.projects.map((p) => p.name)).toEqual(["boardroom"]);
    expect(body.projects[0]?.projectId).toBe(known.id);

    // The whole point of ADR-021: nothing a tab is told says where anything is on this machine.
    const said = JSON.stringify(listed);
    for (const leak of [project, dir, "address", String.fromCharCode(92), "/Users/", "/home/"])
      expect(said, leak).not.toContain(leak);
    await tab.close();
  });

  it("opening another project from the tab replaces what is shown and says so", async () => {
    const dir = temp();
    const other = makeProject(dir, "other-project");
    const files = new ProjectFileStore({ now: () => NOW });
    const session = createSession({ files, now: () => NOW });
    served = await serve(session, { port: 0 });
    const tab = new Tab(`ws://127.0.0.1:${served.port}/bridge`);
    await tab.open();
    await tab.send({ type: "hello", clientVersion: "t", capabilities: ["plan"] });
    await tab.settle("project.state");
    tab.seen.length = 0;

    const r = await tab.send({ type: "tool", name: "project", args: { op: "open", path: other } });
    expect(r.ok).toBe(true);
    // the whole project arrives as a patch, and the state message names the new file
    const changes = await tab.settle("changes");
    expect((changes.changeSet as { commandType: string }).commandType).toBe("project.load");
    const state = await tab.settle("project.state");
    expect(state).toMatchObject({ name: "other-project", historyPosition: 0, savedPosition: 0 });
    expect(state.path).toBe(other);
    await tab.close();
  });
});

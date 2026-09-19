// Managing several projects from the editor (ADR-012 D7): the remembered list, looking around the
// machine's folders, and the message that tells a tab what is open and whether it is saved.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankProject } from "@fpv/tools";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { browse, places, startingDir } from "../src/browse.js";
import { ProjectFileStore } from "../src/files.js";
import { createSession, type Served, serve } from "../src/index.js";
import { noteRecent, RECENT_LIMIT, readRecent, readRecentPresent } from "../src/recent.js";

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

describe("the remembered projects (ADR-012 D7)", () => {
  it("keeps the newest first, never repeats one, and stops at the limit", async () => {
    const dir = temp();
    const file = join(dir, "recent.json");
    for (const n of ["a", "b", "c"]) await noteRecent(file, { path: `/p/${n}`, name: n, at: NOW });
    expect(readRecent(file).map((r) => r.name)).toEqual(["c", "b", "a"]);

    // opening one again moves it to the top rather than adding a second line for it
    await noteRecent(file, { path: "/p/a", name: "a", at: NOW });
    expect(readRecent(file).map((r) => r.name)).toEqual(["a", "c", "b"]);

    for (let i = 0; i < RECENT_LIMIT + 5; i += 1)
      await noteRecent(file, { path: `/p/n${i}`, name: `n${i}`, at: NOW });
    expect(readRecent(file)).toHaveLength(RECENT_LIMIT);
  });

  it("reads an absent or corrupt file as nothing remembered rather than failing", () => {
    const dir = temp();
    expect(readRecent(join(dir, "nothing.json"))).toEqual([]);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json", "utf8");
    expect(readRecent(bad)).toEqual([]);
  });

  it("drops entries whose project has gone, but only when the list is read", async () => {
    const dir = temp();
    const file = join(dir, "recent.json");
    const live = makeProject(dir, "still-here");
    await noteRecent(file, { path: live, name: "still-here", at: NOW });
    await noteRecent(file, { path: join(dir, "deleted"), name: "deleted", at: NOW });
    // the file still holds both: a project on a drive that is not plugged in today is worth keeping
    expect(readRecent(file)).toHaveLength(2);
    expect(readRecentPresent(file).map((r) => r.name)).toEqual(["still-here"]);
  });

  it("is written by the file store itself, so an open from anywhere is remembered", async () => {
    const dir = temp();
    const file = join(dir, "recent.json");
    const project = makeProject(dir, "boardroom");
    const files = new ProjectFileStore({
      now: () => NOW,
      remember: (entry) => void noteRecent(file, entry),
    });
    await files.open(project);
    // the write is deliberately not awaited by open; give the microtask its turn
    await new Promise((r) => setTimeout(r, 20));
    expect(readRecent(file).map((r) => r.path)).toEqual([project]);
  });
});

describe("looking around the host's folders (ADR-012 D7)", () => {
  it("lists directories, marks the ones that are projects, and sorts those first", async () => {
    const dir = temp();
    makeProject(dir, "zebra-project");
    mkdirSync(join(dir, "aaa-plain"));
    mkdirSync(join(dir, ".hidden"));
    writeFileSync(join(dir, "a-file.txt"), "not a folder", "utf8");

    const listing = await browse(dir);
    expect(listing.entries.map((e) => e.name)).toEqual(["zebra-project", "aaa-plain"]);
    expect(listing.entries[0]?.project).toBe(true);
    expect(listing.entries[1]?.project).toBe(false);
    expect(listing.parent).not.toBeNull();
  });

  it("reports a directory it cannot read instead of throwing", async () => {
    const listing = await browse(join(temp(), "no-such-folder"));
    expect(listing.entries).toEqual([]);
    expect(listing.problem).toBeTruthy();
  });

  it("a drive root has no parent, which is how the picker knows to stop", async () => {
    const root = startingDir(null);
    let at = await browse(root);
    for (let hops = 0; at.parent && hops < 20; hops += 1) at = await browse(at.parent);
    expect(at.parent).toBeNull();
  });

  it("offers only shortcuts that exist, with the open project's folder first", async () => {
    const dir = temp();
    const project = makeProject(dir, "boardroom");
    const list = await places(project);
    expect(list[0]?.path).toBe(dir);
    expect(list[0]?.name).toContain("boardroom");
    for (const place of list) expect((await browse(place.path)).problem).toBeUndefined();
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

describe("what is open, over the bridge (ADR-012 D7)", () => {
  it("says what is open on connecting, and again when a save moves the saved position", async () => {
    const dir = temp();
    const project = makeProject(dir, "boardroom");
    const files = new ProjectFileStore({ now: () => NOW });
    const opened = await files.open(project);
    const session = createSession({ files, project: opened.project, now: () => NOW });
    served = await serve(session, { port: 0, projectPath: () => files.path() });
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

  it("lists folders and remembered projects for the picker", async () => {
    const dir = temp();
    const project = makeProject(dir, "boardroom");
    mkdirSync(join(dir, "plain-folder"));
    const session = createSession({ now: () => NOW });
    served = await serve(session, {
      port: 0,
      recent: () => [{ path: project, name: "boardroom", at: NOW }],
    });
    const tab = new Tab(`ws://127.0.0.1:${served.port}/bridge`);
    await tab.open();
    await tab.send({ type: "hello", clientVersion: "t", capabilities: ["plan"] });

    const browsed = await tab.send({ type: "files", op: "browse", path: dir });
    expect(browsed.ok).toBe(true);
    const listing = browsed.result as { entries: { name: string; project: boolean }[] };
    expect(listing.entries.find((e) => e.name === "boardroom")?.project).toBe(true);
    expect(listing.entries.find((e) => e.name === "plain-folder")?.project).toBe(false);

    const recent = await tab.send({ type: "files", op: "recent" });
    const body = recent.result as { recent: { name: string }[]; places: unknown[]; start: string };
    expect(body.recent.map((r) => r.name)).toEqual(["boardroom"]);
    expect(body.places.length).toBeGreaterThan(0);
    expect(body.start).toBeTruthy();
    await tab.close();
  });

  it("opening another project from the tab replaces what is shown and says so", async () => {
    const dir = temp();
    const other = makeProject(dir, "other-project");
    const files = new ProjectFileStore({ now: () => NOW });
    const session = createSession({ files, now: () => NOW });
    served = await serve(session, { port: 0, projectPath: () => files.path() });
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

// Several projects open in one host (ADR-020 D4).
//
// The question these answer is the one that made this worth building: can two tabs hold two different
// projects at the same time, without either of them noticing the other.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankProject } from "@fpv/tools";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type Served, serve } from "../src/index.js";
import { ProjectRegistry } from "../src/projects.js";
import { Workspace } from "../src/workspace.js";

const NOW = "2026-09-19T10:00:00.000Z";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "fpv-workspace-"));
}

function makeProject(root: string, name: string): { dir: string; id: string } {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const project = blankProject(name, NOW);
  writeFileSync(join(dir, "project.json"), JSON.stringify(project), "utf8");
  return { dir, id: project.meta.id };
}

function wall(store: { project: { levels: { id: string }[] } }, x: number): Record<string, unknown> {
  return {
    type: "wall.create",
    payload: {
      levelId: store.project.levels[0]?.id,
      start: { x, y: 0 },
      end: { x: x + 1000, y: 0 },
    },
  };
}

describe("a workspace of projects (ADR-020 D4)", () => {
  it("holds two at once, each with its own store", async () => {
    const dir = temp();
    const a = makeProject(dir, "alpha");
    const b = makeProject(dir, "beta");
    const workspace = new Workspace({ now: () => NOW });

    const one = await workspace.open(a.dir);
    const two = await workspace.open(b.dir);
    expect(one.id).toBe(a.id);
    expect(two.id).toBe(b.id);
    expect(
      workspace
        .list()
        .map((h) => h.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(one.session.store).not.toBe(two.session.store);

    // a change to one is invisible in the other
    one.session.store.apply(wall(one.session.store, 0));
    expect(one.session.store.project.walls).toHaveLength(1);
    expect(two.session.store.project.walls).toHaveLength(0);
    workspace.closeAll();
  });

  it("hands back the project it already holds rather than opening it twice", async () => {
    const dir = temp();
    const a = makeProject(dir, "alpha");
    const workspace = new Workspace({ now: () => NOW });
    const first = await workspace.open(a.dir);
    first.session.store.apply(wall(first.session.store, 0));

    const again = await workspace.open(a.dir);
    // the same session, with the work still in it: two stores over one document would each believe
    // they were the authority on it
    expect(again).toBe(first);
    expect(again.session.store.project.walls).toHaveLength(1);
    expect(workspace.list()).toHaveLength(1);
    workspace.closeAll();
  });

  it("makes a project that has never been saved, with an id of its own", async () => {
    const workspace = new Workspace({ now: () => NOW });
    const made = await workspace.create("Untitled");
    expect(made.files.path()).toBeNull();
    expect(made.id).toBe(made.session.store.project.meta.id);
    expect(workspace.default()?.id).toBe(made.id);
    workspace.closeAll();
  });

  it("numbers a new project when the library already has that name (ADR-021)", async () => {
    // A list of six things all called Untitled is a list of nothing.
    const registry = ProjectRegistry.memory();
    const workspace = new Workspace({ now: () => NOW, registry });
    const first = await workspace.create();
    registry.remember({ id: first.id, address: "/l/1", name: "Untitled", at: NOW });
    const second = await workspace.create();
    registry.remember({
      id: second.id,
      address: "/l/2",
      name: second.session.store.project.meta.name,
      at: NOW,
    });
    const third = await workspace.create();
    expect([
      first.session.store.project.meta.name,
      second.session.store.project.meta.name,
      third.session.store.project.meta.name,
    ]).toEqual(["Untitled", "Untitled 2", "Untitled 3"]);
    workspace.closeAll();
    registry.close();
  });

  it("remembers every project it opens, wherever the open came from", async () => {
    const dir = temp();
    const a = makeProject(dir, "alpha");
    const registry = ProjectRegistry.memory();
    const workspace = new Workspace({ now: () => NOW, registry });
    await workspace.open(a.dir);
    expect(registry.byId(a.id)?.address).toBe(a.dir);
    workspace.closeAll();
    registry.close();
  });

  it("gives each project its own view of the log, so one is not diffed against another", async () => {
    const lines: { project?: string; kind: string }[] = [];
    const fake = {
      path: null,
      dir: null,
      level: "info" as const,
      forProject(projectId: string) {
        return { ...fake, write: (kind: string) => lines.push({ project: projectId, kind }) };
      },
      write: (kind: string) => lines.push({ kind }),
      fromStore: () => {},
      baseline: () => {},
      close: () => {},
    };
    const workspace = new Workspace({ now: () => NOW, log: fake });
    const one = await workspace.create("one");
    const two = await workspace.create("two");
    one.session.log.write("test", "host");
    two.session.log.write("test", "host");
    expect(lines.map((l) => l.project)).toEqual([one.id, two.id]);
    workspace.closeAll();
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
  async settle(type: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 100; i += 1) {
      const all = this.seen.filter((m) => m.type === type);
      if (all.length > 0) return all[all.length - 1] as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${type} arrived`);
  }
  of(type: string): Record<string, unknown>[] {
    return this.seen.filter((m) => m.type === type);
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

describe("two tabs, two projects, one host (ADR-020 D4)", () => {
  it("shows each tab its own project and tells it only about that one", async () => {
    // This is the whole point. Until now two tabs on one host were two views of one document.
    const dir = temp();
    const a = makeProject(dir, "alpha");
    const b = makeProject(dir, "beta");
    const workspace = new Workspace({ now: () => NOW });
    const alpha = await workspace.open(a.dir);
    const beta = await workspace.open(b.dir);
    served = await serve(workspace, { port: 0 });

    const one = new Tab(`ws://127.0.0.1:${served.port}/bridge`);
    await one.open();
    const welcomeOne = await one.send({
      type: "hello",
      clientVersion: "t",
      capabilities: ["plan"],
      project: a.id,
    });
    expect(welcomeOne.projectId).toBe(a.id);

    const two = new Tab(`ws://127.0.0.1:${served.port}/bridge`);
    await two.open();
    await two.send({ type: "hello", clientVersion: "t", capabilities: ["plan"], project: b.id });

    // each was sent its own project
    expect(((await one.settle("snapshot")).project as { meta: { id: string } }).meta.id).toBe(a.id);
    expect(((await two.settle("snapshot")).project as { meta: { id: string } }).meta.id).toBe(b.id);

    one.seen.length = 0;
    two.seen.length = 0;

    // a change in alpha reaches the tab on alpha, and nothing reaches the tab on beta
    alpha.session.store.apply(wall(alpha.session.store, 0));
    const changed = await one.settle("changes");
    expect((changed.changeSet as { commandType: string }).commandType).toBe("wall.create");
    await new Promise((r) => setTimeout(r, 120));
    expect(two.of("changes")).toEqual([]);

    // and the other way round
    beta.session.store.apply(wall(beta.session.store, 5000));
    await two.settle("changes");
    expect(one.of("changes")).toHaveLength(1);
    await one.close();
    await two.close();
  });

  it("counts changes per project, so one project's edits are not a gap in another's", async () => {
    // A replica refuses a change that does not follow the one it holds and resyncs. With a single
    // counter, every edit in the second tab's project would look like a gap to the first.
    const dir = temp();
    const a = makeProject(dir, "alpha");
    const b = makeProject(dir, "beta");
    const workspace = new Workspace({ now: () => NOW });
    const alpha = await workspace.open(a.dir);
    const beta = await workspace.open(b.dir);
    served = await serve(workspace, { port: 0 });

    const one = new Tab(`ws://127.0.0.1:${served.port}/bridge`);
    await one.open();
    await one.send({ type: "hello", clientVersion: "t", capabilities: ["plan"], project: a.id });
    await one.settle("snapshot");
    one.seen.length = 0;

    // three edits in the OTHER project, then one in this one
    for (let i = 0; i < 3; i += 1) beta.session.store.apply(wall(beta.session.store, i * 2000));
    alpha.session.store.apply(wall(alpha.session.store, 0));
    const first = await one.settle("changes");
    // 1, not 4: this project has had exactly one change
    expect(first.seq).toBe(1);
    await one.close();
  });

  it("opens another project from a tab without disturbing the tab that was already there", async () => {
    const dir = temp();
    const a = makeProject(dir, "alpha");
    const b = makeProject(dir, "beta");
    const registry = ProjectRegistry.memory();
    registry.remember({ id: b.id, address: b.dir, name: "beta", at: NOW });
    const workspace = new Workspace({ now: () => NOW, registry });
    await workspace.open(a.dir);
    served = await serve(workspace, { port: 0 });

    const one = new Tab(`ws://127.0.0.1:${served.port}/bridge`);
    await one.open();
    await one.send({ type: "hello", clientVersion: "t", capabilities: ["plan"], project: a.id });
    await one.settle("snapshot");

    const two = new Tab(`ws://127.0.0.1:${served.port}/bridge`);
    await two.open();
    await two.send({ type: "hello", clientVersion: "t", capabilities: ["plan"], project: a.id });
    await two.settle("snapshot");
    one.seen.length = 0;

    // the second tab opens beta; the first stays on alpha, which it did NOT do before
    const opened = await two.send({ type: "workspace", op: "open", project: b.id });
    expect(opened).toMatchObject({ ok: true });
    expect((opened.result as { projectId: string }).projectId).toBe(b.id);
    expect(((await two.settle("snapshot")).project as { meta: { id: string } }).meta.id).toBe(b.id);

    await new Promise((r) => setTimeout(r, 150));
    expect(one.of("snapshot"), "the first tab was not moved").toEqual([]);

    // and it is still attached to alpha: a change there still reaches it, with alpha's own count
    const alpha = workspace.get(a.id);
    alpha?.session.store.apply(wall(alpha.session.store, 0));
    const still = await one.settle("changes");
    expect(still.seq).toBe(1);
    expect((still.changeSet as { commandType: string }).commandType).toBe("wall.create");
    await one.close();
    await two.close();
  });

  it("attaches by id, and says so plainly when nothing here knows the id", async () => {
    const dir = temp();
    const a = makeProject(dir, "alpha");
    const b = makeProject(dir, "beta");
    const registry = ProjectRegistry.memory();
    registry.remember({ id: b.id, address: b.dir, name: "beta", at: NOW });
    const workspace = new Workspace({ now: () => NOW, registry });
    await workspace.open(a.dir);
    served = await serve(workspace, { port: 0 });

    const tab = new Tab(`ws://127.0.0.1:${served.port}/bridge`);
    await tab.open();
    await tab.send({ type: "hello", clientVersion: "t", capabilities: ["plan"], project: a.id });
    await tab.settle("snapshot");

    // beta is not open here, but the library knows it, so a link to it works
    const attached = await tab.send({ type: "workspace", op: "attach", project: b.id });
    expect(attached).toMatchObject({ ok: true });
    expect(((await tab.settle("snapshot")).project as { meta: { id: string } }).meta.id).toBe(b.id);

    const nowhere = await tab.send({ type: "workspace", op: "attach", project: "zzzzzzzzzzzz" });
    expect(nowhere.ok).toBe(false);

    const list = await tab.send({ type: "workspace", op: "list" });
    expect((list.result as { open: { projectId: string }[] }).open.map((o) => o.projectId).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    await tab.close();
    registry.close();
  });

  it("makes a new project from a tab and moves that tab to it", async () => {
    const dir = temp();
    const a = makeProject(dir, "alpha");
    const workspace = new Workspace({ now: () => NOW });
    await workspace.open(a.dir);
    served = await serve(workspace, { port: 0 });

    const tab = new Tab(`ws://127.0.0.1:${served.port}/bridge`);
    await tab.open();
    await tab.send({ type: "hello", clientVersion: "t", capabilities: ["plan"], project: a.id });
    await tab.settle("snapshot");

    const made = await tab.send({ type: "workspace", op: "new", name: "Fresh" });
    expect(made).toMatchObject({ ok: true });
    const body = made.result as { projectId: string; name: string };
    expect(body.name).toBe("Fresh");
    expect(body.projectId).not.toBe(a.id);
    // no address, ever: a tab is never told where anything lives (ADR-021)
    expect(made.result).not.toHaveProperty("address");
    // and the tab is looking at it, with alpha still open beside it
    expect(((await tab.settle("snapshot")).project as { meta: { id: string } }).meta.id).toBe(body.projectId);
    expect(workspace.list()).toHaveLength(2);
    await tab.close();
  });

  it("a tab that names no project still gets one, as it always did", async () => {
    const dir = temp();
    const a = makeProject(dir, "alpha");
    const workspace = new Workspace({ now: () => NOW });
    await workspace.open(a.dir);
    served = await serve(workspace, { port: 0 });

    const tab = new Tab(`ws://127.0.0.1:${served.port}/bridge`);
    await tab.open();
    const welcome = await tab.send({ type: "hello", clientVersion: "t", capabilities: ["plan"] });
    expect(welcome.projectId).toBe(a.id);
    expect(((await tab.settle("snapshot")).project as { meta: { id: string } }).meta.id).toBe(a.id);
    await tab.close();
  });

  it("saves the project the tab is looking at, and not the other one", async () => {
    const dir = temp();
    const a = makeProject(dir, "alpha");
    const b = makeProject(dir, "beta");
    const workspace = new Workspace({ now: () => NOW });
    const alpha = await workspace.open(a.dir);
    const beta = await workspace.open(b.dir);
    served = await serve(workspace, { port: 0 });

    const tab = new Tab(`ws://127.0.0.1:${served.port}/bridge`);
    await tab.open();
    await tab.send({ type: "hello", clientVersion: "t", capabilities: ["plan"], project: b.id });
    await tab.settle("snapshot");

    beta.session.store.apply(wall(beta.session.store, 0));
    alpha.session.store.apply(wall(alpha.session.store, 0));
    const saved = await tab.send({ type: "tool", name: "project", args: { op: "save" } });
    expect(saved.ok).toBe(true);

    const onDisk = (file: string) =>
      (JSON.parse(readFileSync(join(file, "project.json"), "utf8")) as { walls: unknown[] }).walls.length;
    expect(onDisk(b.dir), "beta was saved").toBe(1);
    expect(onDisk(a.dir), "alpha was not").toBe(0);
    await tab.close();
  });
});

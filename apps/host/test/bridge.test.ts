import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROFILE } from "@fpv/agents";
import { PROTOCOL_VERSION } from "@fpv/commands";
import { Project, sequentialIdGenerator } from "@fpv/ir";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { AgentRuns, createSession, type Served, serve } from "../src/index.js";
import { Workspace } from "../src/workspace.js";

const fixtureDir = fileURLToPath(new URL("../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const fixture = () => Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));

/** A tiny bridge client for tests: JSON frames in, promises for ids, a log of unsolicited messages. */
class TestClient {
  ws: WebSocket;
  events: Record<string, unknown>[] = [];
  private pending = new Map<string, (m: Record<string, unknown>) => void>();
  private waiters: { type: string; resolve: (m: Record<string, unknown>) => void }[] = [];
  private seq = 0;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as Record<string, unknown>;
      // welcome answers the hello id (spec 06 B3); every other reply is a result
      if (m.type === "result" || m.type === "welcome") this.pending.get(m.id as string)?.(m);
      else {
        const i = this.waiters.findIndex((w) => w.type === m.type);
        if (i >= 0)
          (this.waiters.splice(i, 1)[0] as { resolve: (m: Record<string, unknown>) => void }).resolve(m);
        else this.events.push(m);
      }
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
  next(type: string): Promise<Record<string, unknown>> {
    const found = this.events.find((e) => e.type === type);
    if (found) {
      this.events.splice(this.events.indexOf(found), 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve) => this.waiters.push({ type, resolve }));
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

async function start(webDir?: string, options: { agent?: unknown } = {}) {
  const session = createSession({
    project: fixture(),
    ids: sequentialIdGenerator(900),
    now: () => "2026-09-15T00:00:00.000Z",
  });
  served = await serve(session, {
    port: 0,
    ...(webDir ? { webDir } : {}),
    ...(options.agent ? { agent: options.agent as never } : {}),
  });
  const client = new TestClient(`ws://127.0.0.1:${served.port}/bridge`);
  await client.open();
  return { session, client };
}

describe("viewer bridge over a real WebSocket (ADR-005 D4, D5, spec 06 B)", () => {
  it("hello gets welcome, snapshot, problems and selection; messages before hello are refused", async () => {
    const { client } = await start();
    const early = await client.send({ type: "undo" });
    expect(early).toMatchObject({ ok: false, error: { code: "bridge.no-hello" } });
    const welcome = await client.send({
      type: "hello",
      clientVersion: "t",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: ["plan"],
    });
    expect(welcome).toMatchObject({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    const snap = await client.next("snapshot");
    expect((snap.project as { walls: unknown[] }).walls).toHaveLength(6);
    expect(await client.next("problems")).toMatchObject({ type: "problems" });
    expect(await client.next("selection")).toMatchObject({ ids: [] });
    await client.close();
  });

  it("a tool call on the host reaches the tab as one changes message with patches, then problems", async () => {
    const { session, client } = await start();
    await client.send({ type: "hello", clientVersion: "t", capabilities: ["plan"] });
    await client.next("snapshot");
    const changes = client.next("changes");
    // the fixture is a migrated file, so its walls are the person's; a run releases what it was
    // given before it may change any of them (ADR-023 D3)
    const r = await session.registry.call(
      "modify_wall",
      { wallId: "wall_000004", thickness: 200 },
      { released: new Set(["wall_000004"]) },
    );
    expect(r.ok).toBe(true);
    const msg = await changes;
    expect(msg).toMatchObject({ seq: 1, origin: "agent", historyPosition: 1 });
    expect((msg.changeSet as { commandType: string }).commandType).toBe("wall.modify");
    expect((msg.patches as unknown[]).length).toBeGreaterThan(0);
    expect(await client.next("problems")).toMatchObject({ type: "problems" });
    await client.close();
  });

  it("commands from the tab go through the single store; undo and select broadcast to every client", async () => {
    const { session, client } = await start();
    const other = new TestClient(`ws://127.0.0.1:${served?.port}/bridge`);
    await other.open();
    await client.send({ type: "hello", clientVersion: "t", capabilities: ["plan"] });
    await other.send({ type: "hello", clientVersion: "t", capabilities: [] });
    await client.next("snapshot");
    await other.next("snapshot");
    await other.next("selection"); // the initial (empty) selection sent after hello
    const applied = await client.send({
      type: "command",
      command: { type: "wall.move", payload: { wallIds: ["wall_000004"], dx: 0, dy: 100 } },
    });
    expect(applied.ok).toBe(true);
    expect(session.store.project.walls[3]?.start.y).toBe(3100);
    expect(await other.next("changes")).toMatchObject({ origin: "editor", seq: 1 });
    const undone = await client.send({ type: "undo" });
    expect(undone.ok).toBe(true);
    expect(session.store.project.walls[3]?.start.y).toBe(3000);
    expect(await other.next("changes")).toMatchObject({ origin: "undo", seq: 2 });
    await client.send({ type: "select", ids: ["wall_000001"] });
    expect(await other.next("selection")).toMatchObject({ ids: ["wall_000001"] });
    expect(session.store.selection).toEqual(["wall_000001"]);
    const failed = await client.send({
      type: "transaction",
      label: "bad",
      commands: [{ type: "wall.move", payload: { wallIds: ["wall_zzzzzz"], dx: 1, dy: 0 } }],
    });
    expect(failed).toMatchObject({ ok: false, error: { code: "ref.missing" } });
    const invalid = await client.send({ type: "nonsense" });
    expect(invalid).toMatchObject({ ok: false, error: { code: "bridge.invalid" } });
    await other.close();
    await client.close();
  });

  it("the render tool routes to the first render-capable tab and returns its images", async () => {
    const { session, client } = await start();
    await client.send({ type: "hello", clientVersion: "t", capabilities: ["render"] });
    await client.next("snapshot");
    const pending = session.registry.call("render", { view: "overhead", width: 320 });
    const req = await client.next("render.request");
    expect(req).toMatchObject({ hideWalls: true, width: 320 });
    expect((req.views as { name: string }[]).map((v) => v.name)).toHaveLength(4);
    await client.send({
      type: "render.result",
      requestId: req.requestId,
      images: (req.views as { name: string }[]).map((v) => ({
        view: v.name,
        pngBase64: "AA==",
        width: 4,
        height: 3,
      })),
    });
    const r = await pending;
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.result as { views: unknown[] }).views).toHaveLength(4);
    await client.close();
    while ((served?.bridge.clientCount ?? 0) > 0) await new Promise((r) => setTimeout(r, 5));
    const none = await session.registry.call("render", { view: "plan" });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error.message).toContain("no viewer");
  });

  it("a protocol mismatch closes with code 4000 and says which side to update", async () => {
    const { client } = await start();
    const closed = new Promise<{ code: number; reason: string }>((r) =>
      client.ws.once("close", (code, reason) => r({ code, reason: String(reason) })),
    );
    const res = await client.send({
      type: "hello",
      clientVersion: "t",
      protocolVersion: PROTOCOL_VERSION + 1,
      capabilities: [],
    });
    expect(res).toMatchObject({ ok: false, error: { code: "bridge.version", hint: "update the host" } });
    expect((await closed).code).toBe(4000);
  });

  it("serves the built web app when present and a helpful page when not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fpv-web-"));
    writeFileSync(join(dir, "index.html"), "<h1>built</h1>");
    const { client } = await start(dir);
    const page = await fetch(`${served?.url}`);
    expect(await page.text()).toContain("built");
    expect((await fetch(`${served?.url}missing.js`)).status).toBe(404);
    expect((await fetch(`${served?.url}bridge`)).status).toBe(426);
    await client.close();
    await served?.close();
    served = null;
    const { client: c2 } = await start(join(dir, "nope"));
    const fallback = await (await fetch(`${(served as Served | null)?.url}`)).text();
    expect(fallback).toContain("not built");
    await c2.close();
  });
});

// The in-app agent over the bridge (ADR-022). The run manager's own rules are tested beside it; this
// is the part that matters to a person with two tabs open: they both watch the same build.
describe("the agent over the bridge (P4-1)", () => {
  /** A provider that answers once with a tool call, then finishes. */
  const scripted = () => {
    let i = 0;
    return {
      id: "fake",
      model: "fake-1",
      profile: { ...DEFAULT_PROFILE },
      async complete() {
        await new Promise((r) => setTimeout(r, 1));
        i += 1;
        return i === 1
          ? {
              text: null,
              toolCalls: [{ id: "c1", name: "get_scene", arguments: JSON.stringify({ detail: "summary" }) }],
              finishReason: "tool_calls",
              usage: { promptTokens: 1, completionTokens: 1 },
              raw: null,
            }
          : {
              text: "Looked at it.",
              toolCalls: [],
              finishReason: "stop",
              usage: { promptTokens: 1, completionTokens: 1 },
              raw: null,
            };
      },
    };
  };

  it("sends a run to every tab looking at that project, not only the one that asked", async () => {
    const session = createSession({
      project: fixture(),
      ids: sequentialIdGenerator(900),
      now: () => "2026-09-15T00:00:00.000Z",
    });
    const workspace = Workspace.of(session);
    const agent = new AgentRuns(workspace, { provider: scripted() as never, dataDir: null });
    served = await serve(workspace, { port: 0, agent });

    const a = new TestClient(`ws://127.0.0.1:${served.port}/bridge`);
    const b = new TestClient(`ws://127.0.0.1:${served.port}/bridge`);
    await a.open();
    await b.open();
    for (const c of [a, b]) {
      await c.send({ type: "hello", clientVersion: "t", capabilities: ["plan"] });
      await c.next("snapshot");
      // every tab is told what the agent is when it attaches
      expect(await c.next("agent.state")).toMatchObject({ available: true, model: "fake-1" });
    }

    const started = await a.send({ type: "agent", op: "start", text: "look at this" });
    expect(started).toMatchObject({ ok: true });

    // the tab that did not ask sees the same run
    const events: string[] = [];
    while (!events.includes("run.finished")) {
      const msg = await b.next("agent.event");
      events.push((msg.event as { type: string }).type);
    }
    expect(events[0]).toBe("run.started");
    expect(events).toContain("tool.finished");
    await a.close();
    await b.close();
  });

  it("refuses a second run, and cancels the one in flight", async () => {
    const session = createSession({ project: fixture(), ids: sequentialIdGenerator(900) });
    const workspace = Workspace.of(session);
    // a provider that never answers, so the run is still in flight when the second arrives
    const stuck = {
      id: "stuck",
      model: "stuck-1",
      profile: { ...DEFAULT_PROFILE },
      complete: () => new Promise<never>(() => {}),
    };
    const agent = new AgentRuns(workspace, { provider: stuck as never, dataDir: null });
    served = await serve(workspace, { port: 0, agent });
    const client = new TestClient(`ws://127.0.0.1:${served.port}/bridge`);
    await client.open();
    await client.send({ type: "hello", clientVersion: "t", capabilities: ["plan"] });
    await client.next("snapshot");

    expect(await client.send({ type: "agent", op: "start", text: "one" })).toMatchObject({ ok: true });
    const second = await client.send({ type: "agent", op: "start", text: "two" });
    expect(second).toMatchObject({ ok: false, error: { code: "agent.busy" } });
    expect(await client.send({ type: "agent", op: "cancel" })).toMatchObject({
      ok: true,
      result: { cancelled: true },
    });
    await client.close();
  });

  it("tells a tab there is no agent, rather than leaving a chat that refuses everything", async () => {
    const { client } = await start();
    await client.send({ type: "hello", clientVersion: "t", capabilities: ["plan"] });
    await client.next("snapshot");
    const r = await client.send({ type: "agent", op: "start", text: "build something" });
    expect(r).toMatchObject({ ok: false, error: { code: "agent.unavailable" } });
    await client.close();
  });
});

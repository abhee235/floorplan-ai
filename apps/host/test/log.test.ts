// The session event log (ADR-019): a line per event, the entity named rather than an array index, and
// nothing written at all when it is turned off.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@fpv/commands";
import { afterEach, describe, expect, it } from "vitest";
import { Bridge, type BridgeSocket } from "../src/bridge.js";
import { createLog, silentLog } from "../src/log.js";
import { createSession, type Session } from "../src/session.js";
import { Workspace } from "../src/workspace.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const where = (): string => {
  const d = mkdtempSync(join(tmpdir(), "fpv-log-"));
  dirs.push(d);
  return d;
};

/** Every line in the one file the run wrote. */
function lines(dir: string): Record<string, unknown>[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  expect(files).toHaveLength(1);
  return readFileSync(join(dir, files[0] as string), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A socket the test drives by hand, and the frames the host sent back down it. */
function tab(session: Session): { bridge: Bridge; say: (msg: unknown) => Promise<void>; back: unknown[] } {
  const back: unknown[] = [];
  let receive: ((data: unknown) => void) | null = null;
  const socket: BridgeSocket = {
    send: (data) => back.push(JSON.parse(data)),
    close: () => {},
    readyState: 1,
    on: (event: string, cb: (data?: unknown) => void) => {
      if (event === "message") receive = cb as (data: unknown) => void;
    },
  } as BridgeSocket;
  // a bridge over a workspace of one, which is what a host with a single project is
  const bridge = new Bridge(Workspace.of(session));
  bridge.attach(socket);
  return { bridge, back, say: async (msg) => void (await receive?.(JSON.stringify(msg))) };
}

describe("writing down what the person did", () => {
  it("writes a line per gesture, beside the commands they caused", async () => {
    const dir = where();
    const log = createLog({ dir });
    const session = createSession({ log });
    const { say } = tab(session);
    await say({
      id: "h",
      type: "hello",
      clientVersion: "test",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [],
    });
    await say({
      type: "gesture",
      gestures: [
        { what: "tool", detail: { tool: "zone", from: "select" } },
        { what: "drag", detail: { phase: "begin", kind: "move", target: "zone_a" } },
        { what: "drag", detail: { phase: "end", kind: "move", sent: [] } },
      ],
    });
    log.close();

    const written = lines(dir).filter((l) => l.kind === "gesture");
    expect(written.map((l) => l.what)).toEqual(["tool", "drag", "drag"]);
    expect(written[0]?.tool).toBe("zone");
    expect(written[1]?.target).toBe("zone_a");
    // the line this whole exercise is for: a drag that sent nothing, which on the plan looks exactly
    // like a drag that sent something
    expect(written[2]?.sent).toEqual([]);
    expect(written.every((l) => l.source === "editor")).toBe(true);
  });

  it("answers nothing, so a click costs no round trip", async () => {
    const dir = where();
    const log = createLog({ dir });
    const session = createSession({ log });
    const { say, back } = tab(session);
    await say({
      id: "h",
      type: "hello",
      clientVersion: "test",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [],
    });
    const answered = back.length;
    await say({ type: "gesture", gestures: [{ what: "view", detail: { mode: "3d" } }] });
    expect(back).toHaveLength(answered);
    // but a caller that asks for an answer by giving an id gets one
    await say({ id: "g1", type: "gesture", gestures: [{ what: "view", detail: { mode: "plan" } }] });
    expect(back[back.length - 1]).toMatchObject({ id: "g1", ok: true, result: { written: 1 } });
    log.close();
    expect(lines(dir).filter((l) => l.kind === "gesture")).toHaveLength(2);
  });

  it("keeps a gesture to the size of a line, and lets it rewrite none of the line's own fields", async () => {
    const dir = where();
    const log = createLog({ dir });
    const session = createSession({ log });
    const { say } = tab(session);
    await say({
      id: "h",
      type: "hello",
      clientVersion: "test",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [],
    });
    await say({
      type: "gesture",
      gestures: [
        {
          what: "field",
          detail: { kind: "not a kind", source: "not a source", said: "x".repeat(500), field: "Width" },
        },
      ],
    });
    log.close();
    const [line] = lines(dir).filter((l) => l.kind === "gesture");
    expect(line?.kind).toBe("gesture");
    expect(line?.source).toBe("editor");
    expect(line?.field).toBe("Width");
    expect(String(line?.said)).toHaveLength(201); // cut, and said so
  });

  it("drops a gesture from a tab that never said hello, having nowhere to put the refusal", async () => {
    const dir = where();
    const log = createLog({ dir });
    const session = createSession({ log });
    log.write("host", "host", { event: "started" }); // so there is a file to find either way
    const { say, back } = tab(session);
    await say({ type: "gesture", gestures: [{ what: "tool", detail: { tool: "zone" } }] });
    expect(back).toEqual([]);
    log.close();
    expect(lines(dir).filter((l) => l.kind === "gesture")).toEqual([]);
  });
});

describe("writing down what a session did", () => {
  it("writes a line per change, naming the command, who asked and what moved", () => {
    const dir = where();
    const log = createLog({ dir });
    const session = createSession({ log });
    const level = session.store.project.levels[0]?.id as string;
    const placed = session.store.apply(
      {
        type: "item.place",
        payload: {
          levelId: level,
          ref: { kind: "recipe", recipe: { kind: "chair", size: { w: 600, d: 600, h: 900 } } },
          position: { x: 1000, y: 1000 },
        },
      },
      "editor",
    );
    expect(placed.ok).toBe(true);
    const id = (placed as { result: { id: string } }).result.id;
    session.store.apply({ type: "item.move", payload: { itemIds: [id], dx: 500, dy: -250 } }, "agent");
    log.close();

    const written = lines(dir);
    expect(written.map((l) => l.kind)).toEqual(["command", "command"]);
    expect(written[0]?.command).toBe("item.place");
    expect((written[0]?.entities as { added: string[] }).added).toEqual([id]);
    expect(written[0]?.source).toBe("editor");

    const move = written[1] as Record<string, unknown>;
    expect(move.command).toBe("item.move");
    expect(move.source).toBe("agent");
    // the point of the whole exercise: where the object went, by id, not by array index
    const changed = move.changed as { entity: string; at: string; to: unknown }[];
    const position = changed.find((c) => c.at === "position");
    expect(position?.entity).toBe(id);
    expect(position?.to).toEqual({ x: 1500, y: 750 });
    // and the lines are in order, each with its own number
    expect(written.map((l) => l.seq)).toEqual([1, 2]);
  });

  it("says what moved on the very first change of a run, not that everything was replaced", () => {
    // Most reducers rewrite the whole object, so without the project as it stood beforehand the first
    // change reads as "item_7f was replaced" — and the first thing someone does after opening a file
    // is usually the thing they are about to ask about.
    const dir = where();
    const log = createLog({ dir });
    const session = createSession({ log });
    const level = session.store.project.levels[0]?.id as string;
    const placed = session.store.apply(
      {
        type: "item.place",
        payload: {
          levelId: level,
          ref: { kind: "recipe", recipe: { kind: "chair", size: { w: 600, d: 600, h: 900 } } },
          position: { x: 1000, y: 1000 },
        },
      },
      "editor",
    );
    const id = (placed as { result: { id: string } }).result.id;
    log.close();
    rmSync(dir, { recursive: true, force: true });

    // A second session, opened on a project that already holds the chair: its first change is a move.
    const again = where();
    const log2 = createLog({ dir: again });
    const session2 = createSession({ log: log2, project: session.store.project });
    session2.store.apply({ type: "item.move", payload: { itemIds: [id], dx: 300, dy: 0 } }, "editor");
    log2.close();

    const [first] = lines(again);
    const changed = first?.changed as { entity: string; at: string; from: unknown; to: unknown }[];
    expect(changed[0]?.at).toBe("position");
    expect(changed[0]?.from).toEqual({ x: 1000, y: 1000 });
    expect(changed[0]?.to).toEqual({ x: 1300, y: 1000 });
  });

  it("writes a refusal from a tool, with the reason", () => {
    const dir = where();
    const log = createLog({ dir });
    const session = createSession({ log });
    session.ctx.transcript?.record({
      seq: 1,
      tool: "render",
      args: {},
      result: { ok: false, error: { code: "unavailable", message: "no viewer is connected" } },
      at: "2026-09-18T00:00:00.000Z",
      durationMs: 3,
    });
    log.close();
    const [line] = lines(dir);
    expect(line?.kind).toBe("tool");
    expect(line?.tool).toBe("render");
    expect(line?.ok).toBe(false);
    expect(line?.because).toBe("no viewer is connected");
  });

  it("says who called a tool, so an agent is not blamed for what a person did", async () => {
    const dir = where();
    const log = createLog({ dir });
    const session = createSession({ log });
    await session.registry.call("get_scene", { detail: "summary" }, { origin: "editor" });
    await session.registry.call("get_scene", { detail: "summary" });
    log.close();
    const tools = lines(dir).filter((l) => l.kind === "tool");
    expect(tools.map((l) => l.source)).toEqual(["editor", "agent"]);
  });

  it("writes nothing at all when it is turned off", () => {
    const dir = where();
    const log = createLog({ dir, level: "off" });
    expect(log.path).toBeNull();
    const session = createSession({ log });
    session.store.apply({ type: "project.setMeta", payload: { changes: { name: "Quiet" } } }, "editor");
    log.close();
    expect(readdirSync(dir)).toEqual([]);
    expect(silentLog().path).toBeNull();
  });

  it("keeps only the newest runs, so a long-lived install cannot fill the disk", () => {
    const dir = where();
    for (const name of ["2026-01-01.jsonl", "2026-01-02.jsonl", "2026-01-03.jsonl"])
      writeFileSync(join(dir, name), "{}\n");
    const log = createLog({ dir, keep: 2 });
    log.write("host", "host", { event: "started" });
    log.close();
    const left = readdirSync(dir).sort();
    expect(left).toHaveLength(2);
    // the oldest went, the newest stayed, and this run's file is one of them
    expect(left).toContain("2026-01-03.jsonl");
    expect(left).not.toContain("2026-01-01.jsonl");
  });
});

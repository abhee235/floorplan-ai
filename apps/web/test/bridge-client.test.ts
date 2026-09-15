import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apply, type ChangesMsg, type Ctx, PROTOCOL_VERSION, type SnapshotMsg } from "@fpv/commands";
import { Project, type Project as ProjectT, sequentialIdGenerator } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { BridgeClient, bridgeUrl, Replica, type SocketLike } from "../src/index.js";

const fixtureDir = fileURLToPath(new URL("../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const fixture = (): ProjectT => Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));
const ctx: Ctx = { ids: sequentialIdGenerator(900), now: () => "2026-09-15T00:00:00.000Z" };

class FakeSocket implements SocketLike {
  sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number, reason?: string): void {
    this.closed = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) };
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "" });
  }
  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function snapshot(project: ProjectT, seq = 0): SnapshotMsg {
  return { type: "snapshot", seq, project, historyPosition: 0, savedPosition: 0 };
}

describe("bridge client and replica (spec 06 part B)", () => {
  it("says hello on open, takes the snapshot, and applies patch streams in sequence", () => {
    const socket = new FakeSocket();
    const replica = new Replica();
    const client = new BridgeClient(socket, replica, { clientVersion: "t", capabilities: ["plan"] });
    socket.onopen?.({});
    expect(socket.sent[0]).toMatchObject({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: ["plan"],
    });
    socket.receive({
      id: "c1",
      type: "welcome",
      hostVersion: "0",
      protocolVersion: PROTOCOL_VERSION,
      projectId: "x",
      path: null,
    });
    const p0 = fixture();
    socket.receive(snapshot(p0));
    expect(replica.project?.walls).toHaveLength(6);
    const events: string[] = [];
    replica.subscribe((e) => events.push(e.changes.commandType));
    const r = apply(p0, { type: "wall.move", payload: { wallIds: ["wall_000004"], dx: 0, dy: 100 } }, ctx);
    if (!r.ok) throw new Error(r.error.message);
    const msg: ChangesMsg = {
      type: "changes",
      seq: 1,
      changeSet: r.changes,
      historyPosition: 1,
      origin: "agent",
      patches: r.forward,
    };
    socket.receive(msg);
    expect(replica.project?.walls[3]?.start.y).toBe(3100);
    expect(replica.historyPosition).toBe(1);
    expect(events).toEqual(["wall.move"]);
    expect(client.status).toBe("open");
  });

  it("a gap in the sequence triggers a snapshot request instead of applying stale patches", () => {
    const socket = new FakeSocket();
    const replica = new Replica();
    new BridgeClient(socket, replica, { clientVersion: "t", capabilities: [] });
    socket.onopen?.({});
    const p0 = fixture();
    socket.receive(snapshot(p0, 5));
    const r = apply(p0, { type: "wall.move", payload: { wallIds: ["wall_000004"], dx: 0, dy: 100 } }, ctx);
    if (!r.ok) throw new Error(r.error.message);
    socket.receive({
      type: "changes",
      seq: 7,
      changeSet: r.changes,
      historyPosition: 1,
      origin: "agent",
      patches: r.forward,
    });
    expect(replica.project?.walls[3]?.start.y).toBe(3000);
    expect(socket.sent.at(-1)).toMatchObject({ type: "get", what: "snapshot" });
  });

  it("requests resolve with their result; pending requests reject when the socket closes", async () => {
    const socket = new FakeSocket();
    const client = new BridgeClient(socket, new Replica(), { clientVersion: "t", capabilities: [] });
    const p = client.select(["wall_000001"]);
    const id = socket.sent.at(-1)?.id as string;
    socket.receive({ id, type: "result", ok: true, result: { ids: ["wall_000001"] } });
    await expect(p).resolves.toMatchObject({ ok: true });
    const dangling = client.undo();
    socket.close(1006, "lost");
    await expect(dangling).rejects.toThrow(/lost/);
    expect(client.status).toBe("closed");
  });

  it("closes with code 4000 on a protocol mismatch and answers render requests when able", async () => {
    const socket = new FakeSocket();
    const statuses: string[] = [];
    const client = new BridgeClient(socket, new Replica(), {
      clientVersion: "t",
      capabilities: ["render"],
      onStatus: (s) => statuses.push(s),
      onRender: async (req) =>
        req.views.map((v) => ({ view: v.name, pngBase64: "AA==", width: 4, height: 3 })),
    });
    socket.onopen?.({});
    socket.receive({
      type: "render.request",
      requestId: "r1",
      views: [{ name: "plan" }],
      hideWalls: false,
      focusId: null,
      width: 4,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.sent.at(-1)).toMatchObject({
      type: "render.result",
      requestId: "r1",
      images: [{ view: "plan", width: 4 }],
    });
    socket.receive({
      id: "c1",
      type: "welcome",
      hostVersion: "0",
      protocolVersion: PROTOCOL_VERSION + 1,
      projectId: "x",
      path: null,
    });
    expect(socket.closed?.code).toBe(4000);
    expect(client.status).toBe("version-mismatch");
    expect(statuses).toEqual(["open", "version-mismatch"]);
    expect(bridgeUrl({ protocol: "http:", host: "127.0.0.1:4310" })).toBe("ws://127.0.0.1:4310/bridge");
    expect(bridgeUrl({ protocol: "https:", host: "x" })).toBe("wss://x/bridge");
  });
});

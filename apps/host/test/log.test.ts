// The session event log (ADR-019): a line per event, the entity named rather than an array index, and
// nothing written at all when it is turned off.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLog, silentLog } from "../src/log.js";
import { createSession } from "../src/session.js";

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

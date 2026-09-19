// Reading the session log back (ADR-019): the runs listed, a line turned into something a person reads,
// and a file that is still being written followed without catching a line half done.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatEntry, formatRuns, pickRun, readFrom, readRun, runs } from "../src/log-read.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const where = (): string => {
  const d = mkdtempSync(join(tmpdir(), "fpv-read-"));
  dirs.push(d);
  return d;
};
const one = (entry: Record<string, unknown>): string[] => formatEntry(JSON.stringify(entry));

describe("finding a run", () => {
  it("lists the runs newest first, with the time out of the name", () => {
    const dir = where();
    for (const name of ["2026-09-17T10-00-00-000Z.jsonl", "2026-09-19T05-41-42-568Z.jsonl"])
      writeFileSync(join(dir, name), "{}\n");
    writeFileSync(join(dir, "notes.txt"), "not a run");
    const all = runs(dir);
    expect(all.map((r) => r.name)).toEqual([
      "2026-09-19T05-41-42-568Z.jsonl",
      "2026-09-17T10-00-00-000Z.jsonl",
    ]);
    expect(all[0]?.at?.toISOString()).toBe("2026-09-19T05:41:42.568Z");
    expect(formatRuns(all)[0]).toContain("2026-09-19 05:41:42");
    // "last" is the newest, and a name can be given by its start rather than in full
    expect(pickRun(dir, "last")?.name).toBe("2026-09-19T05-41-42-568Z.jsonl");
    expect(pickRun(dir, "2026-09-17")?.name).toBe("2026-09-17T10-00-00-000Z.jsonl");
    expect(pickRun(dir, "nothing-like-this")).toBeNull();
  });

  it("says so rather than throwing when there is no log directory at all", () => {
    expect(runs(join(where(), "never-made"))).toEqual([]);
    expect(formatRuns([])).toEqual(["No runs have been written yet."]);
  });
});

describe("reading a line", () => {
  it("names the command, who asked, and what moved from where to where", () => {
    const [headline, ...rows] = one({
      ts: "2026-09-19T05:42:33.000Z",
      seq: 24,
      kind: "command",
      source: "editor",
      command: "zone.modify",
      entities: { updated: ["item_8pw843", "zone_2pl79z"] },
      changed: [
        { entity: "item_8pw843", at: "position", from: { x: 11400, y: 1800 }, to: { x: 12234, y: 2425 } },
      ],
    });
    expect(headline).toContain("zone.modify");
    expect(headline).toContain("by editor");
    expect(headline).toContain("~2");
    expect(rows[0]).toContain("item_8pw843");
    expect(rows[0]).toContain("→");
    expect(rows[0]).toContain('{"x":12234,"y":2425}');
  });

  it("names what was removed, which the patches cannot", () => {
    // A removal's patch points at an index that is no longer there, so the ids on the line are the only
    // record of what went. Dropping them would throw away the one thing worth keeping.
    const lines = one({
      ts: "2026-09-19T05:42:34.000Z",
      seq: 26,
      kind: "command",
      source: "editor",
      command: "item.arrange",
      entities: { removed: ["item_8pw843", "item_d26kgr"] },
      changed: [{ entity: null, at: "items.21", op: "remove" }],
    });
    expect(lines.join("\n")).toContain("(removed)");
    expect(lines.join("\n")).toContain("item_8pw843, item_d26kgr");
  });

  it("reads a gesture as what the person did", () => {
    const [headline] = one({
      ts: "2026-09-19T05:41:48.000Z",
      seq: 9,
      kind: "gesture",
      source: "editor",
      what: "draw",
      tool: "zone",
      phase: "end",
      sent: [],
      because: "nothing fits in 1700 by 3600 mm at this gap",
    });
    expect(headline).toContain("gesture");
    expect(headline).toContain("draw");
    expect(headline).toContain("because=nothing fits in 1700 by 3600 mm at this gap");
  });

  it("hides nothing, including a kind and a field it has never seen", () => {
    // A reader that quietly drops what it does not recognise is worse than none, because it looks
    // like it worked. Whatever is added to the log later has to reach the terminal on its own.
    const [headline] = one({
      ts: "2026-09-20T01:02:03.000Z",
      seq: 7,
      kind: "something-new",
      source: "host",
      event: "happened",
      anUnknownField: 42,
      another: { deep: true },
    });
    expect(headline).toContain("something-new");
    expect(headline).toContain("happened");
    expect(headline).toContain("anUnknownField=42");
    expect(headline).toContain('another={"deep":true}');
  });

  it("passes a torn line through rather than swallowing it", () => {
    // Which is exactly the state a file is in when it is being read while it is written.
    expect(formatEntry('{"kind":"command","seq":3,"comm').join("")).toContain('{"kind":"command"');
  });
});

describe("following a run as it is written", () => {
  it("takes only whole lines, and carries on from where it stopped", () => {
    const dir = where();
    const path = join(dir, "2026-09-19T05-41-42-568Z.jsonl");
    const line = (seq: number) =>
      `${JSON.stringify({ ts: "2026-09-19T05:41:42.000Z", seq, kind: "host", source: "host", event: "started" })}\n`;
    writeFileSync(path, line(1) + line(2));

    const out: string[] = [];
    let at = readRun(path, { write: (t) => out.push(t) });
    expect(out.filter((t) => t.includes("host")).length).toBe(2);

    // A line arrives in two pieces, as an append in flight looks to a reader.
    appendFileSync(path, '{"ts":"2026-09-19T05:41:43.000Z","seq":3,"kind":"host"');
    const half = readFrom(path, at);
    expect(half.text).toBe(""); // nothing yet: the line is not finished
    expect(half.end).toBe(at); // and it will be read again from the same place

    appendFileSync(path, ',"source":"host","event":"stopping"}\n');
    const whole = readFrom(path, at);
    expect(whole.text).toContain("stopping");
    at = whole.end;
    expect(readFrom(path, at).text).toBe(""); // and nothing twice
  });

  it("keeps only the lines asked for, which is how one object is followed", () => {
    const dir = where();
    const path = join(dir, "2026-09-19T05-41-42-568Z.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({ seq: 1, kind: "command", source: "editor", command: "item.move", entities: { updated: ["item_aaa"] } })}\n` +
        `${JSON.stringify({ seq: 2, kind: "command", source: "editor", command: "item.move", entities: { updated: ["item_bbb"] } })}\n`,
    );
    const out: string[] = [];
    readRun(path, { find: "item_aaa", write: (t) => out.push(t) });
    expect(out.join("")).toContain("item.move");
    expect(out.join("")).not.toContain("item_bbb");
  });

  it("starts again when the file it was following was replaced under it", () => {
    const dir = where();
    const path = join(dir, "run.jsonl");
    writeFileSync(path, "a line that was here before\n");
    const shorter = readFrom(path, 10_000);
    expect(shorter.text).toBe("");
    expect(shorter.end).toBeLessThan(10_000);
  });

  it("does not throw on a file that is not there", () => {
    expect(readFrom(join(where(), "gone.jsonl"), 0)).toEqual({ text: "", end: 0 });
  });
});

// Reading the session log back (ADR-019). The file is JSONL so that `grep` and `tail -f` work on it,
// but neither is at hand on the machine this is developed on, and JSON on a terminal is not something
// anyone reads twice. This turns a run into lines a person can follow, and can follow one as it grows.
//
// It never hides a field. A kind it has never seen still prints, with everything on it: a reader that
// quietly drops what it does not recognise is worse than no reader, because it looks like it worked.
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/** One run's file. */
export interface Run {
  name: string;
  path: string;
  /** When the run started, from the file's name; null when the name is not one this wrote. */
  at: Date | null;
  bytes: number;
}

/** The runs in a log directory, newest first. */
export function runs(dir: string): Run[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const path = join(dir, name);
      let bytes = 0;
      try {
        bytes = statSync(path).size;
      } catch {
        // a file that went between the listing and the stat
      }
      return { name, path, at: startedAt(name), bytes };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** The time in a run's file name, which was an ISO stamp with its colons and dot made safe. */
function startedAt(name: string): Date | null {
  const stem = name.replace(/\.jsonl$/, "");
  const iso = stem.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1T$2:$3:$4.$5Z");
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The run a name asks for: "last" or nothing is the newest, otherwise a name or the start of one. */
export function pickRun(dir: string, which: string | null): Run | null {
  const all = runs(dir);
  if (!which || which === "last" || which === "latest") return all[0] ?? null;
  return all.find((r) => r.name === which || r.name.startsWith(which)) ?? null;
}

/** The runs as a table, newest first. */
export function formatRuns(all: readonly Run[]): string[] {
  if (all.length === 0) return ["No runs have been written yet."];
  return all.map((r, i) => {
    const when = r.at ? r.at.toISOString().replace("T", " ").slice(0, 19) : "(unknown time)";
    const size = r.bytes < 1024 ? `${r.bytes} B` : `${Math.round(r.bytes / 1024)} kB`;
    return `${i === 0 ? "*" : " "} ${when}  ${size.padStart(7)}  ${r.name}`;
  });
}

/** The fields every line carries, which are printed as the line's own furniture rather than as fields. */
const COMMON = new Set(["ts", "seq", "kind", "source"]);

/**
 * One raw line as one or more lines to print: a headline, then a row per change. A line that is not
 * JSON is passed through as it stands, because a log with a torn last line is exactly when this is
 * being read.
 */
export function formatEntry(raw: string): string[] {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return [`   ?  ${raw}`];
  }
  const kind = String(e.kind ?? "?");
  const seq = String(e.seq ?? "").padStart(4);
  const time = typeof e.ts === "string" && e.ts.length >= 19 ? e.ts.slice(11, 19) : "--:--:--";
  const used = new Set(COMMON);
  const take = (key: string): unknown => {
    used.add(key);
    return e[key];
  };

  const parts: string[] = [];
  switch (kind) {
    case "command":
    case "transaction":
    case "undo":
    case "redo": {
      parts.push(String(take("command") ?? take("label") ?? "?"));
      parts.push(`by ${String(e.source ?? "?")}`);
      const entities = take("entities") as Record<string, string[]> | undefined;
      if (entities) {
        const counts: string[] = [];
        if (entities.added?.length) counts.push(`+${entities.added.length}`);
        if (entities.updated?.length) counts.push(`~${entities.updated.length}`);
        if (entities.removed?.length) counts.push(`-${entities.removed.length}`);
        if (counts.length) parts.push(counts.join(" "));
      }
      if (e.ok === false) parts.push(`REFUSED ${String(take("refused") ?? "")}`.trim());
      const because = take("because");
      if (because) parts.push(String(because));
      break;
    }
    case "tool":
      parts.push(String(take("tool") ?? "?"));
      parts.push(e.ok === false ? "refused" : "ok");
      used.add("ok");
      if (e.because) parts.push(String(take("because")));
      if (typeof e.ms === "number") parts.push(`${String(take("ms"))} ms`);
      break;
    case "gesture":
      parts.push(String(take("what") ?? "?"));
      break;
    default:
      // host, file, bridge, problem and anything added later: the event, then whatever else is on it.
      if (e.event) parts.push(String(take("event")));
      break;
  }

  // Everything not already spoken for, so a field added later still reaches the terminal.
  const rest = Object.entries(e).filter(([k]) => !used.has(k) && k !== "changed");
  for (const [k, v] of rest) parts.push(`${k}=${brief(v)}`);

  const out = [`${seq} ${time}  ${kind.padEnd(11)}${parts.filter(Boolean).join("  ")}`];
  for (const row of changes(e.changed)) out.push(`${INDENT}${row}`);
  // The patches of a removal point at an index that is no longer there, so nothing above can name what
  // went. The ids are on the line; without this they would be the one thing the reader threw away.
  const gone = (e.entities as { removed?: string[] } | undefined)?.removed;
  if (gone?.length) out.push(`${INDENT}${"(removed)".padEnd(15)}${gone.join(", ")}`);
  return out;
}

/** How far the rows under a headline are set in. */
const INDENT = " ".repeat(24);

/** The rows under a command: what moved, by name, from what to what. */
function changes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((c) => {
    const change = c as Record<string, unknown>;
    const entity = `${String(change.entity ?? "?")} `.padEnd(15);
    const at = `${String(change.at ?? "?")} `.padEnd(11);
    if ("from" in change || "to" in change) {
      const from = "from" in change ? `${brief(change.from)} → ` : "";
      return `${entity}${at}${from}${brief(change.to)}`;
    }
    return `${entity}${at}${String(change.op ?? "")}`;
  });
}

/** A value on one line: short JSON, with quotes off a plain string. */
function brief(value: unknown): string {
  if (typeof value === "string") return value;
  const text = JSON.stringify(value) ?? String(value);
  return text.length <= 120 ? text : `${text.slice(0, 117)}…`;
}

export interface ReadOptions {
  /** Only lines holding this text, matched against the raw line so ids and reasons both work. */
  find?: string | null;
  /** Where the lines go. */
  write: (text: string) => void;
}

/** Everything in a run, formatted. Returns where reading stopped, for following on from there. */
export function readRun(path: string, options: ReadOptions): number {
  const { text, end } = readFrom(path, 0);
  for (const line of text.split("\n"))
    if (line.trim() && (!options.find || line.includes(options.find)))
      for (const out of formatEntry(line)) options.write(`${out}\n`);
  return end;
}

/**
 * Reads from a byte offset to the end of the file, keeping only whole lines: following a file that is
 * being appended to will otherwise catch a line half written and print it as garbage.
 */
export function readFrom(path: string, from: number): { text: string; end: number } {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { text: "", end: from };
  }
  try {
    const size = statSync(path).size;
    // The file was replaced or truncated under us; start again from where it now begins.
    if (size < from) return { text: "", end: size };
    if (size === from) return { text: "", end: from };
    const buffer = Buffer.alloc(size - from);
    const read = readSync(fd, buffer, 0, buffer.length, from);
    const raw = buffer.subarray(0, read).toString("utf8");
    const cut = raw.lastIndexOf("\n");
    if (cut < 0) return { text: "", end: from };
    return { text: raw.slice(0, cut), end: from + Buffer.byteLength(raw.slice(0, cut + 1)) };
  } catch {
    return { text: "", end: from };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // nothing to be done about a descriptor that will not close
    }
  }
}

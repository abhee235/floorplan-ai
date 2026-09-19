// The session event log (ADR-019): one JSON object per line, one file per host run.
//
// Everything that changes the project goes through the store, and the store already says what changed,
// who asked and exactly how — the Immer patches are a precise diff. Nobody was listening. This listens,
// names the entities the patches point at, and writes it down, so that "where did this object go" is a
// line in a file rather than an afternoon of rebuilding the scenario in a headless browser.
//
// I/O lives here rather than in the packages (ADR-002): the store's job is to be right, not to write
// files.
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ChangeSet, Ref, StoreEvent } from "@fpv/commands";
import type { Project } from "@fpv/ir";

export type LogLevel = "off" | "info" | "verbose";

/** How many patches a line carries before it is cut short; the count is always kept. */
const PATCHES_AT_INFO = 12;
/** How many runs are kept in the log directory. */
const KEEP_RUNS = 20;
/** How long lines wait to be written together. */
const FLUSH_MS = 200;
const LINE_END = String.fromCharCode(10);

export interface LogEntry {
  ts: string;
  seq: number;
  kind: string;
  source: string;
  [field: string]: unknown;
}

export interface EventLog {
  /** Where the lines go, or null when nothing is being written. */
  readonly path: string | null;
  /** The directory holding this run and the ones before it, for reading them back (ADR-019 D7). */
  readonly dir: string | null;
  readonly level: LogLevel;
  /** One line. `fields` is merged in after the common ones, and may not overwrite them. */
  write(kind: string, source: string, fields?: Record<string, unknown>): void;
  /**
   * A view of this log for one project: the same file, with every line stamped with which project it
   * is about (ADR-020 D4).
   *
   * It carries its own "what the project was before the change", which is the part that matters. One
   * shared copy across several open projects would diff a change to one against the state of another,
   * and a log that reports the wrong thing changed is worse than no log.
   */
  forProject(projectId: string): EventLog;
  /** A change the store made: what was asked, who asked, and what moved. */
  fromStore(event: StoreEvent, project: Project): void;
  /**
   * The project as it stands, before anything has changed. Without it the first change of a run has
   * nothing to be compared with and reads as "the whole thing was replaced", which is exactly the
   * change someone is most likely to be asking about.
   */
  baseline(project: Project): void;
  close(): void;
}

/** A log that writes nothing, for `FPV_LOG=off` and for tests that do not care. */
export function silentLog(): EventLog {
  return {
    path: null,
    dir: null,
    level: "off",
    forProject: () => silentLog(),
    write: () => {},
    fromStore: () => {},
    baseline: () => {},
    close: () => {},
  };
}

export interface LogOptions {
  /** Where the run's file goes; null writes nothing. */
  dir: string | null;
  level?: LogLevel;
  now?: () => Date;
  /** Runs kept in `dir`, oldest pruned first. */
  keep?: number;
}

export function createLog(options: LogOptions): EventLog {
  const level = options.level ?? "info";
  if (!options.dir || level === "off") return silentLog();
  const now = options.now ?? (() => new Date());
  let path: string;
  try {
    mkdirSync(options.dir, { recursive: true });
    prune(options.dir, options.keep ?? KEEP_RUNS);
    // A name that sorts by time and survives a file system that dislikes colons.
    path = join(options.dir, `${now().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  } catch {
    return silentLog();
  }

  // Lines are gathered and put down together a moment later, so a burst of two hundred placements is one
  // write rather than two hundred, and nothing in the editor waits for a disk. `close` puts down what is
  // left, which is also what makes a test able to read the file straight afterwards.
  let waiting: string[] = [];
  let due: NodeJS.Timeout | null = null;
  const flush = (): void => {
    if (due) {
      clearTimeout(due);
      due = null;
    }
    if (waiting.length === 0) return;
    const text = waiting.join("");
    waiting = [];
    try {
      appendFileSync(path, text);
    } catch {
      // a full disk, a directory that went away: the session carries on regardless
    }
  };

  // The sequence counts lines in the FILE, so it is shared: every view appends to the same run, and a
  // line's number is where it sits in that run whichever project it came from.
  let seq = 0;

  /**
   * One view of the run. `tag` names the project its lines are about, or is null for the host's own
   * lines — starting up, a tab joining — which belong to no project in particular.
   */
  const make = (tag: string | null): EventLog => {
    // The project as it was after the last change, so a patch that replaces a whole entity can be turned
    // into the fields that actually differ. Most reducers rewrite the object rather than one field, and
    // "item_7f was replaced" answers none of the questions a log is kept for.
    //
    // Per view, not shared: two open projects each need their own, or a change to one is diffed against
    // the other and the log reports the wrong thing as having changed.
    let last: Project | null = null;
    const view: EventLog = {
      path,
      dir: options.dir,
      level,
      forProject: (projectId) => make(projectId),
      write(kind, source, fields) {
        seq += 1;
        // The common fields go last, so a caller cannot rewrite when something happened or who did it.
        const entry: LogEntry = {
          ...fields,
          ...(tag ? { project: tag } : {}),
          ts: now().toISOString(),
          seq,
          kind,
          source,
        };
        waiting.push(`${JSON.stringify(entry)}` + LINE_END);
        // unref: a log that has not been flushed yet must not hold the process open
        if (!due) due = setTimeout(flush, FLUSH_MS).unref();
      },
      fromStore(event, project) {
        const { changes } = event;
        view.write(kindOf(event), event.origin, {
          command: changes.commandType,
          entities: entities(changes),
          historyPosition: event.historyPosition,
          patchCount: event.patches.length,
          changed: named(
            project,
            last,
            event.patches,
            level === "verbose" ? Number.POSITIVE_INFINITY : PATCHES_AT_INFO,
          ),
        });
        last = project;
      },
      baseline(project) {
        last = project;
      },
      close() {
        flush();
      },
    };
    return view;
  };
  return make(null);
}

function kindOf(event: StoreEvent): string {
  if (event.origin === "undo" || event.origin === "redo") return event.origin;
  return "command";
}

/** The ids a change touched, by what happened to them. */
function entities(changes: ChangeSet): Record<string, string[]> {
  const ids = (refs: readonly Ref[]) => refs.map((r) => r.id);
  const out: Record<string, string[]> = {};
  if (changes.added.length) out.added = ids(changes.added);
  if (changes.updated.length) out.updated = ids(changes.updated);
  if (changes.removed.length) out.removed = ids(changes.removed);
  return out;
}

/**
 * Patches with the entity they belong to named: `items/3/position` is `item_7f position`, which is the
 * difference between a log you read and one you decode.
 *
 * The patches turn the OLD project into the new one, so an index in a removal points at something that
 * is no longer there. Those keep their raw path; the ids of everything removed are on the line anyway.
 */
function named(
  project: Project,
  before: Project | null,
  patches: readonly { op: string; path: readonly (string | number)[]; value?: unknown }[],
  limit: number,
): Change[] {
  const out: Change[] = [];
  for (const patch of patches) {
    if (out.length >= limit) break;
    const [list, index, ...rest] = patch.path;
    const collection = (project as unknown as Record<string, { id: string }[]>)[String(list)];
    const entity =
      Array.isArray(collection) && typeof index === "number" ? (collection[index]?.id ?? null) : null;
    const at = rest.join(".");
    if (entity && at === "" && patch.op === "replace") {
      // The whole entity was rewritten, which is how most reducers work. Say which fields differ.
      const was = before ? find(before, String(list), entity) : null;
      const fields = differences(was, patch.value);
      if (fields.length > 0) {
        for (const field of fields) {
          if (out.length >= limit) break;
          out.push({ ...field, entity });
        }
        continue;
      }
    }
    out.push({
      entity,
      at: entity ? at || "(whole)" : patch.path.join("."),
      op: patch.op,
      ...(patch.value !== undefined ? { to: small(patch.value) } : {}),
    });
  }
  return out;
}

interface Change {
  entity: string | null;
  at: string;
  op?: string;
  from?: unknown;
  to?: unknown;
}

/** The same entity in an earlier project, or null when it was not there. */
function find(project: Project, list: string, id: string): Record<string, unknown> | null {
  const collection = (project as unknown as Record<string, { id: string }[]>)[list];
  if (!Array.isArray(collection)) return null;
  return (collection.find((e) => e.id === id) as Record<string, unknown> | undefined) ?? null;
}

/** The top-level fields whose values differ, each with what it was and what it became. */
function differences(before: Record<string, unknown> | null, after: unknown): Change[] {
  if (!before || after === null || typeof after !== "object") return [];
  const now = after as Record<string, unknown>;
  const out: Change[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(now)])) {
    if (key === "id") continue;
    const a = JSON.stringify(before[key]);
    const b = JSON.stringify(now[key]);
    if (a === b) continue;
    out.push({ entity: null, at: key, from: small(before[key]), to: small(now[key]) });
  }
  return out;
}

/** How long a piece of text may be before it is cut; a line has to stay a line. */
const TEXT_LIMIT = 200;
/** How many fields one gesture may put on its line. */
const DETAIL_FIELDS = 12;

/** A value small enough to belong on one line; anything bigger is named rather than written out. */
function small(value: unknown): unknown {
  if (typeof value === "string") return value.length <= TEXT_LIMIT ? value : `${value.slice(0, TEXT_LIMIT)}…`;
  if (value === null || typeof value !== "object") return value;
  const text = JSON.stringify(value);
  if (text !== undefined && text.length <= TEXT_LIMIT) return value;
  return Array.isArray(value) ? `[${value.length} items]` : "{…}";
}

/**
 * The fields of a gesture, trimmed to what belongs on a line (ADR-019 D4). The browser is a replica and
 * a gesture is never acted on, so this is about size and readability rather than safety — except for the
 * common fields, which a line may not be talked out of.
 */
export function plainDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!detail) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (Object.keys(out).length >= DETAIL_FIELDS) break;
    if (key === "ts" || key === "seq" || key === "kind" || key === "source") continue;
    out[key] = small(value);
  }
  return out;
}

/** Keeps the newest `keep` runs and removes the rest, so a long-lived install cannot fill the disk. */
function prune(dir: string, keep: number): void {
  try {
    const runs = readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
    for (const name of runs.slice(0, Math.max(0, runs.length - keep + 1)))
      rmSync(join(dir, name), { force: true });
  } catch {
    // a directory that cannot be read is one that will not be written to either
  }
}

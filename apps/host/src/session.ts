// A session: one project, one store, one tool registry, one transcript, all in this process (ADR-005 D2).
// The MCP adapter, the viewer bridge and the in-app agent all call the same registry.
import type { RulesPack } from "@fpv/catalog";
import { createStore, type Store } from "@fpv/commands";
import { type IdGenerator, type Project, randomIdGenerator } from "@fpv/ir";
import {
  blankProject,
  type CatalogSearch,
  catalogSourceOf,
  createRegistry,
  createTranscript,
  type ExportWriter,
  memoryCatalog,
  type PlanReader,
  type ProductVerifier,
  type ProjectFiles,
  type Registry,
  type ToolContext,
  type Transcript,
  type ViewerRenderer,
} from "@fpv/tools";
import { type EventLog, silentLog } from "./log.js";

export interface SessionOptions {
  project?: Project;
  /** Bound to the store when it has a bind method, so `project open` and `project save` work. */
  files?: ProjectFiles | null;
  ids?: IdGenerator;
  now?: () => string;
  catalog?: CatalogSearch;
  viewer?: ViewerRenderer | null;
  verifier?: ProductVerifier | null;
  /** Rules pack for get_bom and design checks; the CLI loads the core AV pack. */
  rules?: RulesPack | null;
  /** Where the export tool writes files. */
  writer?: ExportWriter | null;
  /** Reads plan files for import_plan. */
  plans?: PlanReader | null;
  /** Where the session writes what it did (ADR-019); nothing is written without one. */
  log?: EventLog | null;
}

export interface Session {
  store: Store;
  registry: Registry;
  transcript: Transcript;
  ctx: ToolContext;
  /** What the session writes to; a silent one when the caller gave none. */
  log: EventLog;
}

export function createSession(options: SessionOptions = {}): Session {
  const now = options.now ?? (() => new Date().toISOString());
  const catalog = options.catalog ?? memoryCatalog();
  const project = options.project ?? blankProject("Untitled", now());
  const taken = new Set<string>();
  for (const list of [
    project.levels,
    project.walls,
    project.openings,
    project.rooms,
    project.items,
    project.zones,
    project.annotations,
  ])
    for (const e of list as { id: string }[]) taken.add(e.id);
  const ids = options.ids ?? randomIdGenerator(taken);
  const store = createStore(project, { ids, now, catalog: catalogSourceOf(catalog, now) });
  const log = options.log ?? silentLog();
  // Everything that changes the project passes here, whoever asked (ADR-019 D1).
  store.subscribe((event) => log.fromStore(event, store.project));
  const transcript = createTranscript();
  const bindable = options.files as { bind?: (s: Store) => unknown } | null | undefined;
  if (bindable && typeof bindable.bind === "function") bindable.bind(store);
  const ctx: ToolContext = {
    store,
    catalog,
    viewer: options.viewer ?? null,
    files: options.files ?? null,
    verifier: options.verifier ?? null,
    rules: options.rules ?? null,
    writer: options.writer ?? null,
    plans: options.plans ?? null,
    // The tools' own recorder keeps entries for replay (ADR-007 D4); the log gets a line each as well,
    // so an agent's calls and a person's commands sit in one file in the order they happened.
    transcript: {
      record(entry) {
        transcript.record(entry);
        const result = entry.result as { ok?: boolean; error?: { code?: string; message?: string } };
        log.write("tool", "agent", {
          tool: entry.tool,
          ok: result?.ok !== false,
          ms: entry.durationMs,
          ...(result?.ok === false ? { refused: result.error?.code, because: result.error?.message } : {}),
        });
      },
    },
    now,
  };
  return { store, registry: createRegistry(ctx), transcript, ctx, log };
}

// Several projects open in one host (ADR-020 D4).
//
// A host process was a session, a session was a store, and a store was one project. So two tabs on one
// host were two views of the same document: opening a project in one changed the other under it, and a
// link to a project could only ever mean "make this host hold that instead". That is what "one host per
// project" meant, and it is what this ends.
//
// A workspace holds sessions keyed by the project's own id. A tab attaches to one and sees only that
// one: its changes, its problems, its selection, its render requests. Everything a session already was
// stays exactly as it was — this only stops there being precisely one of them.

import type { RulesPack } from "@fpv/catalog";
import type { CatalogSearch, ExportWriter, PlanReader, ProductVerifier } from "@fpv/tools";
import { blankProject } from "@fpv/tools";
import { ProjectFileStore } from "./files.js";
import type { EventLog } from "./log.js";
import { silentLog } from "./log.js";
import type { ProjectRegistry } from "./projects.js";
import { createSession, type Session } from "./session.js";

/** One project open in this host. */
export interface Held {
  /** The project's own id (ADR-020 D1); what a tab asks for and what the URL says. */
  readonly id: string;
  readonly session: Session;
  readonly files: ProjectFileStore;
}

export interface WorkspaceOptions {
  now?: () => string;
  catalog?: CatalogSearch;
  verifier?: ProductVerifier | null;
  rules?: RulesPack | null;
  /** Built per project, because the export writer resolves paths against the project's own folder. */
  writer?: (files: ProjectFileStore) => ExportWriter | null;
  plans?: PlanReader | null;
  /** The run's log; each project gets a view of it stamped with its id. */
  log?: EventLog | null;
  /** Where projects are remembered, so an open is recorded wherever it came from. */
  registry?: ProjectRegistry | null;
}

export class Workspace {
  private readonly held = new Map<string, Held>();
  private readonly watchers = new Set<(held: Held) => void>();
  /** What a tab that asks for nothing in particular gets: the last project opened. */
  private latest: string | null = null;
  private readonly now: () => string;

  constructor(private readonly options: WorkspaceOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Be told when a project is opened here, so the viewer bridge can start following its changes.
   *
   * Existing ones are not replayed: the caller can see them with `list()`, and a listener that fired
   * for the past would have to be written to tell the two apart.
   */
  watch(listener: (held: Held) => void): () => void {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
  }

  /** Everything open, newest first. */
  list(): Held[] {
    return [...this.held.values()].reverse();
  }

  get(id: string): Held | null {
    return this.held.get(id) ?? null;
  }

  /**
   * What a tab gets when it names no project: whatever was opened last, or nothing at all.
   *
   * The MCP adapter and a one-shot agent run take this too. They are single-project by nature — a
   * command line names one project — and nothing about them needs to choose between several.
   */
  default(): Held | null {
    return this.latest ? (this.held.get(this.latest) ?? null) : null;
  }

  /**
   * Open a project directory, or hand back the one already open for it.
   *
   * The file is read before anything is decided, because a project's id is inside it: there is no way
   * to know whether this directory is something already open without looking.
   */
  async open(address: string, options: { recover?: boolean } = {}): Promise<Held> {
    const files = this.newFileStore();
    const opened = await files.open(address, options.recover ? { recover: true } : {});
    const id = opened.project.meta.id;
    const already = this.held.get(id);
    if (already) {
      // The same project, reached again — possibly by another path, if it was copied. The session that
      // is already open wins: two stores over one document would each believe they were authoritative.
      this.latest = id;
      return already;
    }
    const held = this.hold(id, files, opened.project);
    return held;
  }

  /**
   * Hold a session that already exists.
   *
   * A host built one before there were several, and so does every test that only cares about one
   * project. Rather than making those build a workspace, a workspace can be made of them.
   */
  adopt(session: Session): Held {
    const files = session.ctx.files instanceof ProjectFileStore ? session.ctx.files : new ProjectFileStore();
    return this.keep({ id: session.store.project.meta.id, session, files });
  }

  static of(session: Session, options: WorkspaceOptions = {}): Workspace {
    const workspace = new Workspace(options);
    workspace.adopt(session);
    return workspace;
  }

  /** A project that has never been saved anywhere. */
  create(name = "Untitled"): Held {
    const project = blankProject(name, this.now());
    return this.hold(project.meta.id, this.newFileStore(), project);
  }

  /**
   * Stop holding a project. Whatever is unsaved in it is gone, so the editor asks first; this only
   * does as it is told.
   */
  close(id: string): void {
    const held = this.held.get(id);
    if (!held) return;
    held.files.stopAutosave();
    held.session.log.close();
    this.held.delete(id);
    if (this.latest === id) this.latest = this.list()[0]?.id ?? null;
  }

  closeAll(): void {
    for (const id of [...this.held.keys()]) this.close(id);
  }

  private newFileStore(): ProjectFileStore {
    const registry = this.options.registry;
    return new ProjectFileStore({
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(registry ? { remember: (entry) => registry.remember(entry) } : {}),
    });
  }

  private hold(id: string, files: ProjectFileStore, project: ReturnType<typeof blankProject>): Held {
    const log = (this.options.log ?? silentLog()).forProject(id);
    const session = createSession({
      project,
      files,
      log,
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.catalog ? { catalog: this.options.catalog } : {}),
      ...(this.options.verifier !== undefined ? { verifier: this.options.verifier } : {}),
      ...(this.options.rules !== undefined ? { rules: this.options.rules } : {}),
      ...(this.options.plans !== undefined ? { plans: this.options.plans } : {}),
      ...(this.options.writer ? { writer: this.options.writer(files) } : {}),
    });
    files.startAutosave();
    return this.keep({ id, session, files });
  }

  private keep(held: Held): Held {
    this.held.set(held.id, held);
    this.latest = held.id;
    for (const w of this.watchers)
      try {
        w(held);
      } catch {
        // a listener's problem is its own; it must not fail the open that told it
      }
    return held;
  }
}

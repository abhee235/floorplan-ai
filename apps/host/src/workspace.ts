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
import { folderFor, makeFolder, removeFolder } from "./library.js";
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
  /** The library this installation keeps projects in (ADR-021); projects are made and found here. */
  library?: string | null;
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

  /**
   * A new project, written into the library at once (ADR-021).
   *
   * It exists on disk from the moment it is made, which is what removes the whole "not saved anywhere
   * yet" state: no Save as, no question about where it should go, no chance of losing it to a closed
   * tab. Save is only ever save.
   */
  async create(name = "Untitled"): Promise<Held> {
    const project = blankProject(this.freeName(name), this.now());
    const files = this.newFileStore();
    const held = this.hold(project.meta.id, files, project);
    if (this.options.library) {
      const dir = makeFolder(this.options.library, project.meta.id);
      await files.save(dir);
    }
    return held;
  }

  /**
   * Open a project of the library by its id.
   *
   * Where it lives is this module's business: the library folder named by the id, or wherever the
   * registry last saw it if it was opened from somewhere else at startup.
   */
  async openById(id: string): Promise<Held> {
    const already = this.held.get(id);
    if (already) {
      this.latest = id;
      return already;
    }
    const known = this.options.registry?.byId(id) ?? null;
    const where = known?.address ?? (this.options.library ? folderFor(this.options.library, id) : null);
    if (!where) throw new Error(`nothing here knows project ${id}`);
    return this.open(where);
  }

  /** Let go of a project and delete it. The editor has already asked; this only does as it is told. */
  async destroy(id: string): Promise<void> {
    const known = this.options.registry?.byId(id) ?? null;
    this.close(id);
    this.options.registry?.forget(id);
    if (this.options.library) await removeFolder(this.options.library, id);
    // A project opened from outside the library at startup is forgotten, never deleted: this did not
    // put it there and has no business removing someone's own folder.
    void known;
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

  /**
   * `name`, or `name 2`, `name 3`... if the library already has one by that name.
   *
   * A list of six things all called Untitled is a list of nothing, and the person who pressed New
   * three times had no way to tell which was which. Names need not be unique — two projects may
   * genuinely share one — but the app must not be the thing that makes them collide.
   */
  private freeName(wanted: string): string {
    const taken = new Set(
      [
        ...(this.options.registry?.recent(200) ?? []).map((p) => p.name),
        ...this.list().map((h) => h.session.store.project.meta.name),
      ].map((n) => n.toLowerCase()),
    );
    if (!taken.has(wanted.toLowerCase())) return wanted;
    for (let n = 2; n < 1000; n += 1) {
      const tried = `${wanted} ${n}`;
      if (!taken.has(tried.toLowerCase())) return tried;
    }
    return wanted;
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
    // A rename is an ordinary command, so the library hears about it the same way anything else does.
    // Without this the list and the switcher would show the old name until the next save.
    session.store.subscribe((e) => {
      if (e.changes.commandType !== "project.setMeta") return;
      const where = files.path();
      if (where)
        this.options.registry?.remember({
          id,
          address: where,
          name: session.store.project.meta.name,
          at: this.now(),
        });
    });
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

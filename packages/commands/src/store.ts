// Store: transactions, history with Immer patches, checkpoints, selection (ADR-004 D3, D4, D6).
import type { Project } from "@fpv/ir";
import { applyPatches, type Patch } from "immer";
import { type ApplyResult, apply } from "./apply.js";
import type { ChangeSet, Ctx, Ref } from "./context.js";

export interface HistoryEntry {
  label: string;
  forward: Patch[];
  inverse: Patch[];
  changes: ChangeSet;
  selectionBefore: string[];
  selectionAfter: string[];
  at: string;
}

export type Origin = "editor" | "agent" | "import" | "undo" | "redo" | "restore";

export interface StoreEvent {
  changes: ChangeSet;
  origin: Origin;
  historyPosition: number;
  /** Immer patches that turn the previous project into the current one; a replica applies them directly. */
  patches: Patch[];
}

export interface StoreOptions {
  historyDepth?: number;
  checkpointDepth?: number;
}

function invert(changes: ChangeSet): ChangeSet {
  return {
    commandType: `undo:${changes.commandType}`,
    added: changes.removed,
    updated: changes.updated,
    removed: changes.added,
  };
}

function merge(list: ChangeSet[], label: string): ChangeSet {
  const key = (r: Ref) => `${r.type}:${r.id}`;
  const added = new Map<string, Ref>();
  const updated = new Map<string, Ref>();
  const removed = new Map<string, Ref>();
  for (const c of list) {
    for (const r of c.added) {
      removed.delete(key(r));
      added.set(key(r), r);
    }
    for (const r of c.updated) {
      if (added.has(key(r)) || removed.has(key(r))) continue;
      // a change to the whole entity outranks one to its plan drawing alone, in whichever order they came
      const before = updated.get(key(r));
      updated.set(key(r), before && !before.aspect ? before : r);
    }
    for (const r of c.removed) {
      if (added.has(key(r))) added.delete(key(r));
      else removed.set(key(r), r);
      updated.delete(key(r));
    }
  }
  return {
    commandType: label,
    added: [...added.values()],
    updated: [...updated.values()],
    removed: [...removed.values()],
  };
}

export class Store {
  private current: Project;
  private history: HistoryEntry[] = [];
  private position = 0; // number of entries applied
  private saved = 0;
  private selectionIds: string[] = [];
  private tx: {
    label: string;
    base: Project;
    forward: Patch[];
    inverse: Patch[];
    changes: ChangeSet[];
    selectionBefore: string[];
  } | null = null;
  private checkpoints = new Map<string, { label: string; project: Project; at: string }>();
  private checkpointSeq = 0;
  private listeners = new Set<(e: StoreEvent) => void>();
  private readonly historyDepth: number;
  private readonly checkpointDepth: number;

  constructor(
    initial: Project,
    private readonly ctx: Ctx,
    options: StoreOptions = {},
  ) {
    this.current = initial;
    this.historyDepth = options.historyDepth ?? 200;
    this.checkpointDepth = options.checkpointDepth ?? 32;
  }

  get project(): Project {
    return this.current;
  }
  get selection(): string[] {
    return [...this.selectionIds];
  }
  get historyPosition(): number {
    return this.position;
  }
  get savedPosition(): number {
    return this.saved;
  }
  get modified(): boolean {
    return this.position !== this.saved;
  }
  get inTransaction(): boolean {
    return this.tx !== null;
  }
  get canUndo(): boolean {
    return this.position > 0 && !this.tx;
  }
  get canRedo(): boolean {
    return this.position < this.history.length && !this.tx;
  }
  entries(): readonly HistoryEntry[] {
    return this.history.slice(0, this.position);
  }

  subscribe(listener: (e: StoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(changes: ChangeSet, origin: Origin, patches: Patch[]): void {
    for (const l of this.listeners) l({ changes, origin, historyPosition: this.position, patches });
  }

  setSelection(ids: string[]): void {
    this.selectionIds = [...ids];
  }
  markSaved(): void {
    this.saved = this.position;
  }
  /** Replace the project wholesale (open a file); clears history. */
  /** Replace the project (new, open, recover); history is cleared and replicas get a whole-document patch. */
  load(project: Project): void {
    this.current = project;
    this.history = [];
    this.position = 0;
    this.saved = 0;
    this.selectionIds = [];
    this.tx = null;
    this.emit(
      { commandType: "project.load", added: [], updated: [{ type: "meta", id: "project" }], removed: [] },
      "import",
      [{ op: "replace", path: [], value: project }],
    );
  }

  /** Apply a command; outside a transaction it becomes its own history entry. */
  apply(command: unknown, origin: Origin = "editor"): ApplyResult {
    // the origin rides on the context so `apply` can stamp who made what (ADR-023 D2)
    const r = apply(this.current, command, { ...this.ctx, origin });
    if (!r.ok) return r;
    this.current = r.project;
    if (this.tx) {
      this.tx.forward.push(...r.forward);
      this.tx.inverse.unshift(...r.inverse);
      this.tx.changes.push(r.changes);
    } else if (r.forward.length > 0) {
      this.record({
        label: r.changes.commandType,
        forward: r.forward,
        inverse: r.inverse,
        changes: r.changes,
        selectionBefore: this.selectionIds,
      });
      this.emit(r.changes, origin, r.forward);
    }
    return r;
  }

  begin(label: string): void {
    if (this.tx) return; // nested begin flattens (ADR-004 D3)
    this.tx = {
      label,
      base: this.current,
      forward: [],
      inverse: [],
      changes: [],
      selectionBefore: [...this.selectionIds],
    };
  }

  /** Commit the open transaction as one history entry; returns null when nothing changed. */
  commit(origin: Origin = "editor"): HistoryEntry | null {
    const tx = this.tx;
    if (!tx) return null;
    this.tx = null;
    if (tx.forward.length === 0) return null;
    const changes = merge(tx.changes, tx.label);
    const entry = this.record({
      label: tx.label,
      forward: tx.forward,
      inverse: tx.inverse,
      changes,
      selectionBefore: tx.selectionBefore,
    });
    this.emit(changes, origin, tx.forward);
    return entry;
  }

  rollback(): void {
    const tx = this.tx;
    if (!tx) return;
    this.tx = null;
    this.current = tx.base;
    this.selectionIds = tx.selectionBefore;
  }

  /** Run commands atomically: any failure rolls everything back and returns the failure (ADR-004 D3). */
  transaction(
    label: string,
    commands: unknown[],
    origin: Origin = "editor",
  ):
    | { ok: true; entry: HistoryEntry | null; results: ApplyResult[] }
    | { ok: false; error: Extract<ApplyResult, { ok: false }>["error"]; failedIndex: number } {
    this.begin(label);
    const results: ApplyResult[] = [];
    for (let i = 0; i < commands.length; i += 1) {
      const r = this.apply(commands[i], origin);
      results.push(r);
      if (!r.ok) {
        this.rollback();
        return { ok: false, error: r.error, failedIndex: i };
      }
    }
    return { ok: true, entry: this.commit(origin), results };
  }

  private record(e: Omit<HistoryEntry, "at" | "selectionAfter">): HistoryEntry {
    this.history.length = this.position; // a new entry after undo discards the redo stack
    const entry: HistoryEntry = { ...e, selectionAfter: [...this.selectionIds], at: this.ctx.now() };
    this.history.push(entry);
    if (this.history.length > this.historyDepth) {
      const drop = this.history.length - this.historyDepth;
      this.history.splice(0, drop);
      this.saved = Math.max(-1, this.saved - drop);
    }
    this.position = this.history.length;
    return entry;
  }

  undo(): ChangeSet | null {
    if (!this.canUndo) return null;
    const entry = this.history[this.position - 1] as HistoryEntry;
    this.current = applyPatches(this.current, entry.inverse);
    this.position -= 1;
    this.selectionIds = [...entry.selectionBefore];
    const changes = invert(entry.changes);
    this.emit(changes, "undo", entry.inverse);
    return changes;
  }

  redo(): ChangeSet | null {
    if (!this.canRedo) return null;
    const entry = this.history[this.position] as HistoryEntry;
    this.current = applyPatches(this.current, entry.forward);
    this.position += 1;
    this.selectionIds = [...entry.selectionAfter];
    this.emit(entry.changes, "redo", entry.forward);
    return entry.changes;
  }

  checkpoint(label: string): string {
    this.checkpointSeq += 1;
    const id = `cp_${this.checkpointSeq}`;
    this.checkpoints.set(id, { label, project: this.current, at: this.ctx.now() });
    while (this.checkpoints.size > this.checkpointDepth) {
      const oldest = this.checkpoints.keys().next().value as string;
      this.checkpoints.delete(oldest);
    }
    return id;
  }

  listCheckpoints(): { id: string; label: string; at: string }[] {
    return [...this.checkpoints.entries()].map(([id, c]) => ({ id, label: c.label, at: c.at }));
  }

  /** Restore a checkpoint as a new history entry so it is itself undoable. */
  restore(id: string): ChangeSet | null {
    const cp = this.checkpoints.get(id);
    if (!cp || this.tx) return null;
    const before = this.current;
    // compute patches by a whole-document replacement
    const forward: Patch[] = [{ op: "replace", path: [], value: cp.project }];
    const inverse: Patch[] = [{ op: "replace", path: [], value: before }];
    this.current = cp.project;
    const changes: ChangeSet = {
      commandType: `restore:${id}`,
      added: [],
      updated: [{ type: "meta", id: "project" }],
      removed: [],
    };
    this.record({
      label: `restore ${cp.label}`,
      forward,
      inverse,
      changes,
      selectionBefore: this.selectionIds,
    });
    this.emit(changes, "restore", forward);
    return changes;
  }
}

export function createStore(initial: Project, ctx: Ctx, options?: StoreOptions): Store {
  return new Store(initial, ctx, options);
}

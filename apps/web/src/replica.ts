// The browser's copy of the project (ADR-005 D2): applies snapshots and patch streams from the host,
// tracks the history position, and detects when it has fallen out of sync.
import type { ChangeSet, ChangesMsg, SnapshotMsg } from "@fpv/commands";
import type { Problem, Project } from "@fpv/ir";
import { applyPatches, enablePatches } from "immer";

enablePatches();

export interface ReplicaListener {
  (event: { changes: ChangeSet; project: Project; historyPosition: number }): void;
}

export class Replica {
  project: Project | null = null;
  seq = -1;
  historyPosition = -1;
  savedPosition = 0;
  problems: Problem[] = [];
  selection: string[] = [];
  private listeners = new Set<ReplicaListener>();

  subscribe(l: ReplicaListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** A snapshot replaces everything; listeners see a whole-project change. */
  applySnapshot(msg: SnapshotMsg): void {
    this.project = msg.project;
    this.seq = msg.seq;
    this.historyPosition = msg.historyPosition;
    this.savedPosition = msg.savedPosition;
    this.notify({
      commandType: "snapshot",
      added: [],
      updated: [{ type: "meta", id: "project" }],
      removed: [],
    });
  }

  /**
   * Apply a change message. Returns false when the message does not follow the one we hold (a gap in
   * the sequence), in which case the caller requests a fresh snapshot (spec 06 B3).
   */
  applyChanges(msg: ChangesMsg): boolean {
    if (!this.project) return false;
    if (msg.seq !== this.seq + 1) return false;
    this.project = msg.patches.length > 0 ? applyPatches(this.project, msg.patches) : this.project;
    this.seq = msg.seq;
    this.historyPosition = msg.historyPosition;
    this.notify(msg.changeSet);
    return true;
  }

  /**
   * The host's view of what is selected.
   *
   * A method rather than a public field, because assigning the field told nobody. React reads the
   * selection through useSyncExternalStore, which only re-renders when a subscriber fires — so the
   * properties panel sat on a stale empty selection for the whole session while the app's own state
   * had the right answer. app.ts's per-frame `lastSelection` polling exists to work around exactly
   * this, and is no longer the only thing that notices.
   *
   * The change set is deliberately EMPTY: `binding.onChanges` and `plan.onChanges` both run it through
   * `expand()`, so putting anything in `updated` would rebuild geometry on every click.
   */
  setSelection(ids: string[]): void {
    this.selection = [...ids];
    this.notify({ commandType: "selection", added: [], updated: [], removed: [] });
  }

  /** Problems from the host; same notification gap as the selection had. */
  setProblems(problems: Problem[]): void {
    this.problems = problems;
    this.notify({ commandType: "problems", added: [], updated: [], removed: [] });
  }

  private notify(changes: ChangeSet): void {
    // Nothing to report against before the first snapshot; the field is still set, so the next real
    // notification carries the current value.
    if (!this.project) return;
    for (const l of this.listeners)
      l({ changes, project: this.project, historyPosition: this.historyPosition });
  }
}

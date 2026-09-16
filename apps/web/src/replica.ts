// The browser's copy of the project (ADR-005 D2): applies snapshots and patch streams from the host,
// tracks the history position, and detects when it has fallen out of sync.
import type { ChangeSet, ChangesMsg, SnapshotMsg } from "@fpv/commands";
import type { Problem, Project, Wall } from "@fpv/ir";
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

  /**
   * Take a whole project locally, ahead of the host agreeing to it.
   *
   * A drag has to show its result while it is happening, not once the button comes up. Commands cross a
   * bridge, so waiting for the host to answer every pointer move would be both slow and a history full of
   * intermediate positions. Instead the drag runs the real reducer against this copy and sends ONE
   * command at the end; the host's patch then lands on top and the two agree again.
   *
   * The change set comes from the caller because it comes from that reducer: it already knows exactly
   * what moved, including entities the caller never named — a wall move drags its joined neighbours
   * along (W-031), and the renderers have to be told about those too or a corner tears open mid-drag.
   *
   * `seq` is deliberately untouched. It counts the host's messages, and `applyChanges` refuses anything
   * that is not exactly the next one — so moving it here would make the very next real patch look like a
   * gap and throw away the session with a resync.
   *
   * The caller keeps whatever this replaces, because nothing here can put it back: if the host refuses
   * the command, restoring the previous project is the caller's job.
   */
  applyLocally(project: Project, changes: ChangeSet): void {
    if (!this.project) return;
    // Assigned, never mutated in place: immer applies the host's patches against whatever object this
    // holds, and editing the previous one would change a structure the next patch expects as it was.
    this.project = project;
    this.notify(changes);
  }

  /** One wall, replaced locally. A thin way onto applyLocally for edits that touch a single wall. */
  replaceWallLocally(wall: Wall): void {
    const project = this.project;
    if (!project) return;
    const index = project.walls.findIndex((w) => w.id === wall.id);
    if (index < 0) return;
    const walls = [...project.walls];
    walls[index] = wall;
    this.applyLocally(
      { ...project, walls },
      { commandType: "local.wall", added: [], updated: [{ type: "wall", id: wall.id }], removed: [] },
    );
  }

  private notify(changes: ChangeSet): void {
    // Nothing to report against before the first snapshot; the field is still set, so the next real
    // notification carries the current value.
    if (!this.project) return;
    for (const l of this.listeners)
      l({ changes, project: this.project, historyPosition: this.historyPosition });
  }
}

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

  private notify(changes: ChangeSet): void {
    if (!this.project) return;
    for (const l of this.listeners)
      l({ changes, project: this.project, historyPosition: this.historyPosition });
  }
}

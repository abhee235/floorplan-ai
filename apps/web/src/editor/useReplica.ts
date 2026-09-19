// React's window onto the browser copy of the project (ADR-018 D3).
//
// The replica is the source of truth and lives outside React: the host sends patches, the replica applies
// them, and it notifies. `useSyncExternalStore` is the supported way to read that from React without
// tearing. Every hook here takes a selector and returns a primitive or a stable reference, so a patch that
// changes one wall does not redraw the whole chrome: the properties panel and the status bar subscribe to
// different slices and re-render only when their own slice changes.
import type { ProjectStateMsg, WorkspaceStateMsg } from "@fpv/commands";
import type { Problem, Project } from "@fpv/ir";
import { useCallback, useSyncExternalStore } from "react";
import type { Replica } from "../replica.js";

/** Subscribes to the replica and returns whatever the selector picks out of it. */
export function useReplica<T>(replica: Replica, select: (replica: Replica) => T): T {
  const subscribe = useCallback(
    (onChange: () => void) => {
      // Replica.subscribe hands back its own unsubscribe, which is exactly what the store wants.
      return replica.subscribe(onChange);
    },
    [replica],
  );
  const snapshot = useCallback(() => select(replica), [replica, select]);
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * The project itself. The replica replaces the object on every patch, so identity is a safe signal.
 *
 * Takes a null replica, which is what the chrome has before the app has started: the toolbar is drawn
 * from the first frame, and a hook cannot be called conditionally to wait for one.
 */
export function useProject(replica: Replica | null): Project | null {
  const subscribe = useCallback(
    (onChange: () => void) => (replica ? replica.subscribe(onChange) : () => {}),
    [replica],
  );
  const snapshot = useCallback(() => (replica ? projectOf(replica) : null), [replica]);
  return useSyncExternalStore(subscribe, snapshot);
}

/** Problems as a count pair, so the status bar re-renders only when the numbers move. */
export function useProblemCount(replica: Replica): { errors: number; warnings: number } {
  const errors = useReplica(replica, errorCount);
  const warnings = useReplica(replica, warningCount);
  return { errors, warnings };
}

/** The selection as a joined string: a primitive, so React can compare it cheaply. */
export function useSelectionKey(replica: Replica): string {
  return useReplica(replica, selectionKey);
}

export function useHistoryPosition(replica: Replica): number {
  return useReplica(replica, historyPosition);
}

/**
 * What is open and whether it is saved (ADR-012 D8).
 *
 * Takes a null replica for the same reason `useProject` does: the app bar is drawn before the app has
 * connected, and the title has to say something in the meantime.
 */
export function useProjectState(replica: Replica | null): ProjectStateMsg | null {
  const subscribe = useCallback(
    (onChange: () => void) => (replica ? replica.subscribe(onChange) : () => {}),
    [replica],
  );
  const snapshot = useCallback(() => (replica ? replica.projectState : null), [replica]);
  return useSyncExternalStore(subscribe, snapshot);
}

/** Every project this host has open (ADR-020 D4), for the switcher. */
export function useOpenProjects(replica: Replica | null): WorkspaceStateMsg["open"] {
  const subscribe = useCallback(
    (onChange: () => void) => (replica ? replica.subscribe(onChange) : () => {}),
    [replica],
  );
  const snapshot = useCallback(() => (replica ? replica.openProjects : NONE), [replica]);
  return useSyncExternalStore(subscribe, snapshot);
}

/** A stable empty list: returning a new [] from a snapshot would re-render for ever. */
const NONE: WorkspaceStateMsg["open"] = [];

/** Whether there is work the file on disk does not have; a boolean, so the title redraws rarely. */
export function useModified(replica: Replica | null): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => (replica ? replica.subscribe(onChange) : () => {}),
    [replica],
  );
  const snapshot = useCallback(() => (replica ? replica.modified : false), [replica]);
  return useSyncExternalStore(subscribe, snapshot);
}

// Selectors are declared once at module scope rather than inline, so their identity is stable and
// useCallback actually memoises. An inline arrow would be a new function every render.
const projectOf = (r: Replica): Project | null => r.project;
const errorCount = (r: Replica): number => count(r.problems, "error");
const warningCount = (r: Replica): number => r.problems.length - count(r.problems, "error");
const selectionKey = (r: Replica): string => r.selection.join(",");
const historyPosition = (r: Replica): number => r.historyPosition;

function count(problems: readonly Problem[], severity: string): number {
  let n = 0;
  for (const p of problems) if (p.severity === severity) n += 1;
  return n;
}

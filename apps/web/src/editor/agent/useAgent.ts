// The chat's state, for React (ADR-022).
//
// useSyncExternalStore rather than a reducer in a component, for the same reason the replica uses
// one: the store is fed by a socket that knows nothing about rendering, and a run carries on whether
// or not the window is open.

import { useSyncExternalStore } from "react";
import type { AgentState, AgentStore } from "./agent-store.js";

export function useAgent(store: AgentStore): AgentState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

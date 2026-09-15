// @fpv/commands: commands as data, reducers, transactions, history (docs/spec/03-commands.md, ADR-004).
export const PACKAGE = "commands" as const;
export { type ApplyFail, type ApplyOk, type ApplyResult, apply } from "./apply.js";
export * from "./bridge.js";
export {
  type CatalogSource,
  type ChangeSet,
  Changes,
  type Ctx,
  descendantsOf,
  type EntityType,
  type Ref,
} from "./context.js";
export * from "./errors.js";
export { resolveAnchor } from "./reducers/items.js";
export { arrangePlacements } from "./reducers/zones.js";
export {
  createStore,
  type HistoryEntry,
  type Origin,
  Store,
  type StoreEvent,
  type StoreOptions,
} from "./store.js";
export * from "./types.js";

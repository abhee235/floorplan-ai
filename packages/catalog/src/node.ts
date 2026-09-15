// "@fpv/catalog/store": the Node-only half of the catalog: the SQLite store (built-in node:sqlite, no
// native module) and library installation on disk. The root entry stays free of Node APIs (ADR-002).
export { FetchRefused, type HttpFetcherOptions, httpPageFetcher, isPrivateAddress } from "./fetcher.js";
export {
  installedLibraries,
  installLibraryDir,
  libraryDir,
  readLibraryManifest,
  sha256File,
  uninstallLibraryDir,
  verifyLibraryFiles,
} from "./install.js";
export {
  CatalogError,
  type CatalogHit,
  CatalogStore,
  type CategoryConstraints,
  type LibraryRecord,
  type MatchTier,
  type ProductView,
  type SearchQuery,
  type SearchResult,
  type SpecConstraint,
  STORE_SCHEMA_VERSION,
  type UpsertResult,
} from "./store.js";

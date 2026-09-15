// @fpv/host: Session host: project state, tool registry, optional MCP adapter over stdio (ADR-005).
// The viewer bridge, project files, catalog database and agent runner join in later phase 0 items.
export const PACKAGE = "host" as const;
export { Bridge, type BridgeSocket } from "./bridge.js";
export { main, parseArgs } from "./cli.js";
export { ExportFileError, FileExportWriter } from "./exports.js";
export {
  AUTOSAVE_MS,
  FORMAT_VERSION,
  freeBytes,
  MANIFEST_FILE,
  type Manifest,
  PROJECT_FILE,
  ProjectFileError,
  ProjectFileStore,
  type ProjectFileStoreOptions,
  projectDir,
  RECOVERY_FILE,
  readSession,
  type SessionFile,
  sha256,
  writeAtomic,
} from "./files.js";
export { createMcpServer, HOST_VERSION, type McpOptions, serveStdio, toCallToolResult } from "./mcp.js";
export { DEFAULT_PORT, defaultWebDir, type Served, type ServeOptions, serve } from "./server.js";
export { createSession, type Session, type SessionOptions } from "./session.js";

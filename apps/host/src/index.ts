// @fpv/host: Session host: project state, tool registry, optional MCP adapter over stdio (ADR-005).
// The viewer bridge, project files, catalog database and agent runner join in later phase 0 items.
export const PACKAGE = "host" as const;
export {
  AGENT_TIMEOUT_MS,
  type AgentTaskOptions,
  type AgentTaskResult,
  describeEvent,
  loadAgentConfig,
  runAgentTask,
} from "./agent.js";
export {
  AgentRuns,
  type AgentRunsOptions,
  MAX_ATTACHMENT_BYTES,
  type StartResult,
  summarise,
} from "./agent-runs.js";
export { Bridge, type BridgeSocket } from "./bridge.js";
export { main, parseArgs, readLogLevel } from "./cli.js";
export {
  type DotEnvResult,
  expandProviderShortcuts,
  findEnvFile,
  loadDotEnv,
  MODEL_ROLES,
  type ModelRole,
  PROVIDERS,
} from "./env.js";
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
export { createLog, type EventLog, type LogLevel, silentLog } from "./log.js";
export { createMcpServer, HOST_VERSION, type McpOptions, serveStdio, toCallToolResult } from "./mcp.js";
export { createReader, loadReaderConfig, READER_TIMEOUT_MS } from "./reader.js";
export { DEFAULT_PORT, defaultWebDir, type Served, type ServeOptions, serve } from "./server.js";
export { createSession, type Session, type SessionOptions } from "./session.js";

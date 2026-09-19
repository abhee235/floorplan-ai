// @fpv/agents: Provider interface, agent runner, roles, prompts (ADR-007)
export const PACKAGE = "agents" as const;
export {
  afterGate,
  afterTool,
  type Gate,
  type GateState,
  gateFor,
  newGateState,
  PLAN_GATE_FIRINGS,
  VERIFY_GATE_FIRINGS,
} from "./gates.js";
export {
  type CompleteJsonOptions,
  completeJson,
  extractJson,
  JsonOutputError,
  type JsonResult,
  stripThinking,
} from "./json.js";
export {
  ASK_USER,
  ASK_USER_SPEC,
  type AskRequest,
  answerText,
  applyPlan,
  describePlan,
  LOOP_TOOL_NAMES,
  PLAN_WORK,
  PLAN_WORK_SPEC,
  type PlanItem,
  type PlanStatus,
  parseAsk,
  planForPrompt,
  planIsOpen,
} from "./loop-tools.js";
export {
  type ChatMessage,
  type Completion,
  type CompletionRequest,
  type ContentPart,
  DEFAULT_PROFILE,
  openAICompatible,
  type Provider,
  type ProviderConfig,
  ProviderError,
  type ProviderProfile,
  parameterQuirk,
  type ToolCall,
  type ToolSpec,
  type Usage,
} from "./provider.js";
export {
  DESIGNER_SYSTEM,
  type DesignerOptions,
  designerSystem,
  registryToolSpecs,
  runDesigner,
  type WorldOptions,
} from "./roles/designer.js";
export {
  type PlanReaderOptions,
  type PlanReaderRole,
  type PlanReading,
  planReader,
  type RasterImage,
  ReaderUnavailableError,
} from "./roles/reader.js";
export {
  VERIFIER_SYSTEM,
  type VerifierOptions,
  verifierExtractor,
  verifierPrompt,
} from "./roles/verifier.js";
export {
  type AgentEvent,
  type AgentOptions,
  type AgentRun,
  DEFAULT_MAX_RESULT_CHARS,
  DEFAULT_MAX_STEPS,
  parseToolArguments,
  runAgent,
  type StopReason,
  toolCallsInText,
  toolResultText,
} from "./runner.js";
export { DONE, decodeChunk, type StreamEvent, sseData, sseReader } from "./sse.js";

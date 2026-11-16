// @fpv/agents: Provider interface, agent runner, roles, prompts (ADR-007)
export const PACKAGE = "agents" as const;
export { DEFAULT_SHIELD, type ForNextRunOptions, forNextRun } from "./compact.js";
export {
  ACTION_TOOLS,
  COMPACTABLE_TOOLS,
  type CompactionKind,
  collapseSuperseded,
  compactionKindLabel,
  isClearedContent,
  maskObservations,
  microcompactToolResults,
  OBSERVATION_TOOLS,
  shieldedResultIds,
  snipLargeToolInputs,
  unconsumedReadIds,
} from "./context/compactionLayers.js";
export {
  ALL_COMPACTION_LAYERS,
  AUTOCOMPACT_BUFFER,
  type CompactionLayer,
  type CompactionPlan,
  constrainedAutoThreshold,
  DEFAULT_MAX_OUTPUT_TOKENS,
  HARD_BUFFER,
  KEEP_RECENT_RESULTS,
  planCompaction,
  resolveCompactionPlan,
  SUMMARY_OUTPUT_RESERVE,
  WARN_BUFFER,
} from "./context/compactionPlan.js";
export {
  type CompactDeps,
  compactIfNeeded,
  estimateTokens,
  estimateTokensWithThinking,
  isOverflowError,
  measureWireOverhead,
  olderBoundary,
  stripAnalysisBlock,
  turnAlignedBoundary,
} from "./context/compactor.js";
export { contextWindowForModel, type WindowTier, windowTier } from "./context/windows.js";
export {
  afterGate,
  afterLoopTool,
  afterTool,
  type Gate,
  type GateState,
  gateFor,
  IDLE_GATE_FIRINGS,
  newGateState,
  PLAN_GATE_FIRINGS,
  VERIFY_GATE_FIRINGS,
} from "./gates.js";
export {
  builtCounts,
  COPY_GATE_FIRINGS,
  copyReminder,
  type Inventory,
  inventoryFrom,
  inventoryGap,
} from "./inventory.js";
export {
  type CompleteJsonOptions,
  completeJson,
  extractJson,
  JsonOutputError,
  type JsonResult,
  stripThinking,
} from "./json.js";
export {
  ANTHROPIC_WIRE,
  anthropicMessages,
  claudeReachable,
  thinksAdaptively,
  toClaudeMessages,
} from "./llm/anthropic.js";
export { createProvider, providerFor, wireForName } from "./llm/factory.js";
export {
  type Block,
  blocksOf,
  dataUrl,
  fromLegacyMessages,
  type ImageBlock,
  imagesOf,
  type Message,
  pairedCalls,
  type ReasoningBlock,
  type TextBlock,
  type ToolResultBlock,
  type ToolUseBlock,
  textOf,
  toolResultMessage,
  toolResultOf,
  toolUsesOf,
  withResultText,
} from "./llm/messages.js";
export {
  ARCH_CONTEXT_CAP,
  looksLikeOllama,
  type ModelLimits,
  ollamaNative,
  ollamaRoot,
  probeModel,
} from "./llm/ollama.js";
export { openAIChat, parameterQuirk, toChatMessages } from "./llm/openai-chat.js";
export { openAIResponses, RESPONSES_WIRE, toResponsesInput } from "./llm/openai-responses.js";
export {
  type Completion,
  type CompletionRequest,
  DEFAULT_PROFILE,
  type FetchFn,
  type ModelProvider,
  type Provider,
  type ProviderConfig,
  ProviderError,
  type ProviderProfile,
  type ReasoningEffort,
  reasoningOf,
  type ToolCall,
  type ToolSpec,
  type Usage,
  type WireApi,
} from "./llm/provider.js";
export { DONE, decodeChunk, type StreamEvent, sseData, sseReader } from "./llm/sse.js";
export {
  ASK_USER,
  ASK_USER_SPEC,
  type AskRequest,
  answerText,
  applyNotes,
  applyPlan,
  CONSENT_NO,
  CONSENT_NONE,
  CONSENT_OPTIONS,
  CONSENT_YES,
  describePlan,
  LOOP_TOOL_NAMES,
  NOTES,
  NOTES_MAX_CHARS,
  NOTES_SPEC,
  type NotesResult,
  notesForPrompt,
  PLAN_WORK,
  PLAN_WORK_SPEC,
  type PlanItem,
  type PlanStatus,
  parseAsk,
  planForPrompt,
  planIsOpen,
  READ_SKILL,
} from "./loop-tools.js";
export {
  ARCHITECT_TOOLS,
  type ArchitectOptions,
  architectSystem,
  MAX_ROUNDS,
  runArchitect,
} from "./roles/architect.js";
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
  canonical,
  DEFAULT_MAX_RESULT_CHARS,
  DEFAULT_MAX_STEPS,
  parseToolArguments,
  runAgent,
  type StopReason,
  toolCallsInText,
  toolResultText,
  UNREADABLE_REPLIES,
} from "./runner.js";
export {
  loadSkills,
  parseFrontmatter,
  READ_SKILL_SPEC,
  readSkill,
  type Skill,
  type SkillIndexEntry,
  skillsIndex,
} from "./skills.js";

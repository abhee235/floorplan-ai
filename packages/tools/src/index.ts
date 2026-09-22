// @fpv/tools: The tool registry: schemas, descriptions, functions (spec 04). One definition per tool,
// called in-process by the app's agent and exposed unchanged by the host's optional MCP adapter.
export const PACKAGE = "tools" as const;

import type { ToolContext } from "./context.js";
import { Registry } from "./registry.js";
import {
  buildDesignTool,
  checkDesignTool,
  designLayoutTool,
  planRoomsTool,
  queryDesignTool,
  reviseDesignTool,
} from "./tools/design.js";
import { exportTool } from "./tools/export.js";
import { importPlan } from "./tools/import.js";
import { describeRoom, getScene, measure, searchCatalog, validateTool } from "./tools/inspect.js";
import { arrange, finishItem, modifyItem, placeItem } from "./tools/items.js";
import { lookAt } from "./tools/look.js";
import { createRoomFromBrief, furnishRoom } from "./tools/semantic.js";
import { batch, getBom, history, project, render, verifyProduct } from "./tools/session.js";
import {
  addLevel,
  addOpening,
  createRoom,
  createWalls,
  deleteTool,
  finishOpening,
  finishWall,
  modifyOpening,
  modifyRoom,
  modifyWall,
} from "./tools/structure.js";
import { readPage, webSearch } from "./tools/web.js";

/** The 23 tools of the first release (ADR-006 D2) in spec order, then import_plan (phase 2) and
 *  finish_wall (phase 3). */
export const TOOLS = [
  getScene,
  describeRoom,
  measure,
  validateTool,
  searchCatalog,
  render,
  createWalls,
  modifyWall,
  deleteTool,
  addOpening,
  createRoom,
  modifyRoom,
  placeItem,
  modifyItem,
  arrange,
  createRoomFromBrief,
  furnishRoom,
  verifyProduct,
  getBom,
  history,
  batch,
  project,
  exportTool,
  importPlan,
  finishOpening,
  modifyOpening,
  finishWall,
  finishItem,
  addLevel,
  designLayoutTool,
  planRoomsTool,
  checkDesignTool,
  buildDesignTool,
  queryDesignTool,
  reviseDesignTool,
  // What the model reads before it designs (ADR-027): a picture on demand, and the web when the
  // host has a search provider.
  lookAt,
  webSearch,
  readPage,
] as const;

/** Tools that only make sense with something the session may not have; the host advertises them or not. */
export const NEEDS_WEB: ReadonlySet<string> = new Set(["web_search", "read_page"]);
export const NEEDS_SIGHT: ReadonlySet<string> = new Set(["look_at"]);

export function createRegistry(ctx: ToolContext): Registry {
  const r = new Registry(ctx);
  for (const t of TOOLS) r.register(t as unknown as Parameters<Registry["register"]>[0]);
  return r;
}

export { type BriefUnderstanding, parseBrief } from "./brief.js";
export {
  type Attachment,
  type AttachmentStore,
  type CatalogHit,
  type CatalogProduct,
  type CatalogSearch,
  catalogSourceOf,
  type DraftPresentation,
  type ExportWriter,
  memoryCatalog,
  type OpenInfo,
  type OpenOptions,
  type PlanImage,
  type PlanReader,
  type PlanReadOutcome,
  type PlanReadRequest,
  type ProductVerifier,
  type ProjectFiles,
  RECIPE_TEMPLATES,
  type RenderedImage,
  type RenderRequest,
  type SubagentRequest,
  type SubagentResult,
  type SubagentRunner,
  searchRecipes,
  sizesFor,
  type ToolContext,
  type TranscriptEntry,
  type TranscriptRecorder,
  type ViewerRenderer,
  type WebAccess,
} from "./context.js";
export * from "./envelope.js";
export {
  FurnishError,
  type FurnishOptions,
  type FurnishPlan,
  pickRecipe,
  planFurnishing,
  roomCapacity,
  type Unresolved,
} from "./furnish.js";
export {
  buildChains,
  CommitError,
  type CommitOptions,
  type CommitReport,
  type CommitSkip,
  commitDraft,
} from "./import.js";
export { blankProject } from "./project.js";
export { WORKFLOW_PROMPT, WORKFLOW_PROMPT_NAME } from "./prompt.js";
export {
  type AnyObjectSchema,
  type CallOptions,
  defineTool,
  Registry,
  TIMEOUTS,
  type Tier,
  type ToolCall,
  type ToolDef,
  type ToolReliability,
} from "./registry.js";
export { doorSwingWarnings, itemRefFor, parseAnchor } from "./tools/items.js";
export { hingeEndFor } from "./tools/structure.js";
export { createTranscript, replay, type Transcript } from "./transcript.js";
export * from "./views.js";

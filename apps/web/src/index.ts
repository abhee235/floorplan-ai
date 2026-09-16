// @fpv/web: replica web app: plan canvas, three.js viewer, bridge client (ADR-003, ADR-005).
// This index exports the DOM-free parts for tests and for the host's render path.
export const PACKAGE = "web" as const;
export {
  BridgeClient,
  type BridgeClientOptions,
  type BridgeStatus,
  bridgeUrl,
  type SocketLike,
} from "./bridge/client.js";
export { Announcer, type AnnouncerOptions, type LiveRegion } from "./editor/announce.js";
export {
  type CommandMatch,
  CommandRegistry,
  type EditorCommand,
  type RegisteredCommand,
  type RunOutcome,
} from "./editor/commands.js";
export {
  type Chord,
  chordFromEvent,
  describeChord,
  describeShortcut,
  isTypingTarget,
  type KeyLike,
  matchesChord,
  normaliseKey,
  parseChord,
  type TargetLike,
} from "./editor/keys.js";
export {
  FIRST_SIDE_MM,
  MIN_CORNERS,
  type RoomCreateCommand,
  type RoomDetectCommand,
  RoomTool,
  type RoomToolOptions,
} from "./editor/room-tool.js";
export {
  type DeleteCommand,
  deleteCommands,
  describeEntity,
  type EntityKind,
  kindOf,
  type MoveCommand,
  moveCommands,
  nextSelection,
  type SelectedEntity,
} from "./editor/selection.js";
export {
  type CountsLike,
  countsText,
  describeLength,
  formatMm,
  type PaletteSection,
  type ProblemLike,
  type ProblemSummary,
  paletteSections,
  pointerText,
  problemCounts,
  problemSummary,
  scaleLabel,
} from "./editor/status.js";
export {
  checkTool,
  checkTools,
  k,
  type Phrase,
  phraseText,
  TOOLS,
  type ToolDefinition,
  type ToolId,
  type ToolOption,
  t,
  toolById,
  toolForKey,
  toolReady,
} from "./editor/tools.js";
export {
  arcExtentThrough,
  type HandleAnchor,
  handleAnchors,
  handleAt,
  handleCommand,
  indicatorMarginMm,
  MAX_ARC_EXTENT_DEG,
  previewWall,
  type WallHandle,
  type WallHandleCommand,
} from "./editor/wall-handles.js";
export {
  type Aim,
  type AimOptions,
  angleOf,
  clampLength,
  MAX_LENGTH_MM,
  MIN_LENGTH_MM,
  pointAt,
  type SnapKind,
  type WallChainCommand,
  WallTool,
  type WallToolOptions,
} from "./editor/wall-tool.js";
export { type Ctx2D, type PlanLayers, PlanRenderer, type PlanView } from "./plan/plan.js";
export { Replica, type ReplicaListener } from "./replica.js";
export {
  type BindingOptions,
  frameScheduler,
  immediateScheduler,
  SceneBinding,
  type Scheduler,
  toGeometry,
} from "./viewer/binding.js";
export { type Clipping, clippingFor } from "./viewer/clipping.js";
export { MaterialCache } from "./viewer/materials.js";
export {
  type Capture,
  type CapturedImage,
  camerasFor,
  focusBounds,
  renderViews,
  type ViewCamera,
} from "./viewer/render.js";

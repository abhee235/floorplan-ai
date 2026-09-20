// Viewer bridge protocol (spec 06 part B, ADR-005 D4). Shared by the host (server) and the web replica
// (client) so both sides validate the same shapes. One JSON message per frame; every client message
// with an id gets exactly one `result`.

import type { Problem, Project } from "@fpv/ir";
import type { Patch } from "immer";
import { z } from "zod";
import type { ChangeSet } from "./context.js";
import type { Origin } from "./store.js";

export const PROTOCOL_VERSION = 1;
/** WebSocket close code for a protocol mismatch (spec 06 B1). */
export const CLOSE_VERSION_MISMATCH = 4000;

const Id = z.string().min(1);
const CommandMsg = z.object({ id: Id, type: z.literal("command"), command: z.unknown() });
const TransactionMsg = z.object({
  id: Id,
  type: z.literal("transaction"),
  label: z.string(),
  commands: z.array(z.unknown()).min(1).max(200),
});

/** How many gestures one frame may carry; a browser with more to say sends another frame. */
export const GESTURES_PER_FRAME = 40;

/**
 * Something the person did, for the session log (ADR-019 D4): the tool picked, the selection, a drag
 * beginning and ending, a value committed in the panel, the view mode. `what` names it and `detail`
 * says the rest. It is never an instruction — the host writes it down and does nothing else with it.
 */
const GestureItem = z.object({
  what: z.string().min(1).max(40),
  detail: z.record(z.unknown()).optional(),
});
export type GestureItem = z.infer<typeof GestureItem>;

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({
    id: Id,
    type: z.literal("hello"),
    clientVersion: z.string(),
    protocolVersion: z.number().int().optional(),
    capabilities: z.array(z.enum(["render", "plan"])),
    /**
     * The project this tab wants, from its URL (ADR-020 D4). A tab that names none, or names one this
     * host is not holding, gets whatever was opened last — which is what a host started with a single
     * `--project` has always given it.
     */
    project: z.string().optional(),
  }),
  CommandMsg,
  TransactionMsg,
  z.object({ id: Id, type: z.literal("undo") }),
  z.object({ id: Id, type: z.literal("redo") }),
  z.object({
    id: Id,
    type: z.literal("get"),
    what: z.enum(["snapshot", "history", "selection", "problems", "textures"]),
  }),
  z.object({ id: Id, type: z.literal("select"), ids: z.array(z.string()) }),
  z.object({
    id: Id,
    type: z.literal("render.result"),
    requestId: z.string(),
    images: z.array(
      z.object({ view: z.string(), pngBase64: z.string(), width: z.number(), height: z.number() }),
    ),
  }),
  z.object({ id: Id, type: z.literal("tool"), name: z.string(), args: z.record(z.unknown()) }),
  // Reading the session log back in the editor (ADR-019 D7). `runs` lists them; `read` returns the
  // entries of one, from a byte offset so following a live run sends only what is new.
  z.object({
    id: Id,
    type: z.literal("log"),
    op: z.enum(["runs", "read"]),
    run: z.string().optional(),
    from: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(2000).optional(),
  }),
  // Everything this installation has, by id and name (ADR-021). There is no folder browsing: the
  // editor cannot address anything but the library, and no path ever reaches a browser.
  z.object({ id: Id, type: z.literal("files"), op: z.literal("list") }),
  // Several projects open at once (ADR-020 D4). A host holds a session per project and a tab looks at
  // one of them: `attach` moves this tab to a project it already holds or that the registry can find,
  // `open` reads a directory, `new` starts an empty one, `close` lets one go, `list` says what is open.
  z.object({
    id: Id,
    type: z.literal("workspace"),
    op: z.enum(["attach", "open", "new", "close", "delete", "list", "export", "import"]),
    /** Which project, by its own id. There is no other way to name one (ADR-021). */
    project: z.string().optional(),
    /** A name, for new. */
    name: z.string().optional(),
    /**
     * An exported project, base64, for import (P3-11).
     *
     * Carried on the bridge rather than posted to a route of its own: the socket is the channel that
     * already knows who is on it, and a plain HTTP endpoint that takes a project would be an unguarded
     * way in, exactly as one that hands a project out by id would be a way to read anyone's (ADR-020 D4).
     */
    data: z.string().optional(),
  }),
  // The one client message that expects no result: there is nothing to wait for, and a round trip per
  // click would make the log something the editor pays for.
  z.object({
    id: Id.optional(),
    type: z.literal("gesture"),
    gestures: z.array(GestureItem).min(1).max(GESTURES_PER_FRAME),
  }),
  // The in-app agent (ADR-022). One run at a time per project: `start` begins one, `cancel` ends it,
  // `answer` replies to a question it asked, `history` catches a tab up after a reload, `clear`
  // forgets the conversation so a new one starts from nothing.
  z.object({
    id: Id,
    type: z.literal("agent"),
    op: z.enum(["start", "cancel", "answer", "history", "clear"]),
    text: z.string().max(20_000).optional(),
    /** Files the person attached, base64. The bytes stay with the host; a model names an id. */
    attachments: z
      .array(
        z.object({
          name: z.string().min(1).max(200),
          mime: z.string().max(100),
          data: z.string(),
        }),
      )
      .max(3)
      .optional(),
    reliability: z.enum(["high", "medium", "low"]).optional(),
    questionId: z.string().optional(),
    answers: z.record(z.string()).optional(),
    /** For `history`: the sequence number a tab already has. */
    from: z.number().int().min(0).optional(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export interface WelcomeMsg {
  id: string;
  type: "welcome";
  hostVersion: string;
  protocolVersion: number;
  /** The open project's own id. It carried the project's NAME until ADR-020 D1 gave projects ids. */
  projectId: string;
  path: string | null;
  /**
   * Set when the host is running code older than what is on disk, or serving an app that has not been
   * built since its source changed: one sentence saying which, and what to do. A packaged host never
   * sends it, having no source to compare itself with.
   */
  stale?: string | null;
}
export interface ResultMsg {
  id: string;
  type: "result";
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; hint: string | null };
}
export interface SnapshotMsg {
  type: "snapshot";
  /** Sequence number of the last change folded into this snapshot. */
  seq: number;
  project: Project;
  historyPosition: number;
  savedPosition: number;
}
export interface ChangesMsg {
  type: "changes";
  /** Broadcast sequence number; a replica that misses one requests a snapshot. */
  seq: number;
  changeSet: ChangeSet;
  historyPosition: number;
  origin: Origin;
  patches: Patch[];
}
export interface ProblemsMsg {
  type: "problems";
  problems: Problem[];
}
/**
 * What is open and whether it is saved (ADR-012 D8). Sent on connecting and whenever the answer
 * changes: a project opened, a save finished, a recovery file appeared.
 *
 * `savedPosition` is here because saving emits no change — the store's history does not move when the
 * file is written, so a replica watching only the change stream would show a modified mark for the rest
 * of the session. The mark is `historyPosition !== savedPosition`, and both sides count the same way.
 */
export interface ProjectStateMsg {
  type: "project.state";
  /** The project's own id (ADR-020 D1); this is what a link carries, never the path. */
  projectId: string;
  path: string | null;
  name: string;
  historyPosition: number;
  savedPosition: number;
  lastSavedAt: string | null;
  /** ISO time of a recovery file newer than the saved project, or null. */
  recoveryAvailable: string | null;
  modifiedOutside: boolean;
}
/**
 * Which projects this host has open (ADR-020 D4), sent to every tab whenever the set changes.
 *
 * Pushed rather than asked for, because the set changes when ANOTHER tab opens or closes something:
 * a tab that only refreshed its own list would show a switcher that quietly went out of date.
 */
export interface WorkspaceStateMsg {
  type: "workspace.state";
  open: { projectId: string; name: string; address: string | null }[];
}
export interface RenderRequestMsg {
  type: "render.request";
  requestId: string;
  views: { name: string; camera?: Record<string, unknown> }[];
  hideWalls: boolean;
  focusId: string | null;
  width: number;
}
export interface SelectionMsg {
  type: "selection";
  ids: string[];
}
/** One job in the plan the agent keeps for itself (ADR-022). */
export interface AgentPlanItem {
  id: string;
  text: string;
  status: "pending" | "doing" | "done" | "skipped";
}

/** Why a run stopped. */
export type AgentStopReason = "done" | "step-budget" | "provider-error" | "stalled" | "aborted";

/**
 * Something a tab can draw that the model never sees.
 *
 * A render is a picture in the chat and a line of text to the model; a draft is a review overlay and
 * a draft id. Keeping the two apart is what stops a tool result being written twice, once for each
 * audience, and disagreeing with itself.
 */
export type AgentToolDisplay =
  | { kind: "image"; dataUrl: string; caption: string }
  | { kind: "draft"; draftId: string };

/**
 * What a run is doing, as it does it (ADR-022).
 *
 * Only `run.finished` means the work is over. Everything else means it is still going, which is the
 * rule that keeps a multi-minute build from looking hung, and the one a tab must not invent
 * exceptions to.
 */
export type AgentWireEvent =
  | {
      type: "run.started";
      at: string;
      text: string;
      attachments: { id: string; name: string; mime: string; bytes: number }[];
      model: string;
      reliability: string;
      /** Restoring this takes the project back to before the run; null when the host could not mark one. */
      checkpointId: string | null;
    }
  | { type: "step.started"; step: number; at: string }
  | { type: "text.delta"; step: number; text: string }
  | { type: "reasoning.delta"; step: number; text: string }
  /** The step's finished text, which is what a tab keeps once the deltas have been drawn. */
  | { type: "message"; step: number; at: string; text: string }
  | {
      type: "tool.started";
      step: number;
      at: string;
      id: string;
      name: string;
      args: unknown;
      summary: string;
    }
  | {
      type: "tool.finished";
      step: number;
      at: string;
      id: string;
      name: string;
      ok: boolean;
      /** A short line for the card; never the whole result, and never image bytes. */
      preview: string;
      error: { code: string; message: string; hint: string | null } | null;
      warnings: string[];
      problems: { errors: number; warnings: number };
      /** What moved, so a card can select it and the plan can flash it. */
      changed: ChangeSet | null;
      durationMs: number;
      display?: AgentToolDisplay;
    }
  | { type: "plan.updated"; step: number; items: AgentPlanItem[] }
  | {
      type: "question";
      step: number;
      id: string;
      text: string;
      kind: "text" | "choice" | "scale" | "consent";
      options: { id: string; label: string; description?: string }[];
      draftId: string | null;
      /** For kind "consent": what the agent is asking leave to change (ADR-023 D3). */
      ids: string[];
    }
  | { type: "question.answered"; id: string; answers: Record<string, string>; by: "person" | "review" }
  | { type: "reminder"; step: number; gate: "plan" | "verify" | "idle"; text: string }
  | { type: "context"; step: number; promptTokens: number; contextTokens: number }
  | { type: "retry"; step: number; error: string; waitMs: number }
  | { type: "warning"; step: number; message: string }
  | {
      type: "run.finished";
      at: string;
      reason: AgentStopReason;
      steps: number;
      toolCalls: number;
      failedCalls: number;
      usage: { promptTokens: number; completionTokens: number };
      text: string | null;
      error: string | null;
    };

export interface AgentEventMsg {
  type: "agent.event";
  projectId: string;
  runId: string;
  /** Per project and rising; a gap tells a tab it missed something and should ask for the rest. */
  seq: number;
  event: AgentWireEvent;
}

/**
 * Whether there is an agent at all, and what it is doing, sent when a tab attaches to a project.
 *
 * The replay is how a tab that was opened or reloaded mid-run shows the run so far rather than an
 * empty chat: the same events, through the same reducer, so the rebuilt transcript is the live one.
 */
export interface AgentStateMsg {
  type: "agent.state";
  projectId: string;
  available: boolean;
  model: string | null;
  /** Why it is unavailable, or what it is, in a sentence. */
  note: string | null;
  run: { runId: string; status: "running" | "waiting" | "cancelling"; startedAt: string } | null;
  replay: AgentEventMsg[];
}
/**
 * A plan draft under review (ADR-011 D5), or null to close the review. The draft is a PlanDraft from
 * @fpv/importers and the preview carries the source line work in draft units.
 */
export interface DraftMsg {
  type: "draft";
  draftId: string | null;
  draft: unknown;
  preview: { segments: [number, number, number, number][]; truncated: boolean } | null;
  /** The source image of a raster draft, as a data URL with its pixel size. */
  image: { dataUrl: string; width: number; height: number } | null;
  warnings: string[];
}
export interface ProgressMsg {
  type: "progress";
  requestId: string;
  percent: number;
  text: string;
}

export type HostMessage =
  | WelcomeMsg
  | ResultMsg
  | SnapshotMsg
  | ChangesMsg
  | ProblemsMsg
  | ProjectStateMsg
  | WorkspaceStateMsg
  | RenderRequestMsg
  | SelectionMsg
  | AgentEventMsg
  | AgentStateMsg
  | DraftMsg
  | ProgressMsg;

/** Parse one text frame from a client; null when it is not a message we know. */
export function parseClientMessage(
  text: string,
): { ok: true; message: ClientMessage } | { ok: false; error: string; id: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "frame is not JSON", id: null };
  }
  const parsed = ClientMessage.safeParse(raw);
  if (parsed.success) return { ok: true, message: parsed.data };
  const id =
    typeof raw === "object" && raw !== null && typeof (raw as { id?: unknown }).id === "string"
      ? (raw as { id: string }).id
      : null;
  return {
    ok: false,
    error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    id,
  };
}

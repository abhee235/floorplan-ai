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
    op: z.enum(["attach", "open", "new", "close", "delete", "list"]),
    /** Which project, by its own id. There is no other way to name one (ADR-021). */
    project: z.string().optional(),
    /** A name, for new. */
    name: z.string().optional(),
  }),
  // The one client message that expects no result: there is nothing to wait for, and a round trip per
  // click would make the log something the editor pays for.
  z.object({
    id: Id.optional(),
    type: z.literal("gesture"),
    gestures: z.array(GestureItem).min(1).max(GESTURES_PER_FRAME),
  }),
  z.object({
    id: Id,
    type: z.literal("agent"),
    op: z.enum(["start", "cancel"]),
    brief: z.string().optional(),
    roomId: z.string().optional(),
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
export interface AgentEventMsg {
  type: "agent.event";
  event: "step" | "tool" | "message" | "done" | "error";
  payload: Record<string, unknown>;
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

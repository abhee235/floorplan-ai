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

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({
    id: Id,
    type: z.literal("hello"),
    clientVersion: z.string(),
    protocolVersion: z.number().int().optional(),
    capabilities: z.array(z.enum(["render", "plan"])),
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
  projectId: string;
  path: string | null;
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

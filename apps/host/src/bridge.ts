// The viewer bridge (ADR-005 D4, D5, spec 06 part B): a WebSocket per browser tab, JSON frames, ids for
// requests, the snapshot and change stream from the store, and render requests routed to the first
// client that can render. Lives inside the host; the browser is a replica, never the authority.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ChangesMsg,
  CLOSE_VERSION_MISMATCH,
  type ClientMessage,
  type DraftMsg,
  type HostMessage,
  PROTOCOL_VERSION,
  type ProjectStateMsg,
  parseClientMessage,
  type ResultMsg,
} from "@fpv/commands";
import type { DraftPresentation, RenderedImage, RenderRequest, ViewerRenderer } from "@fpv/tools";
import type { WebSocket } from "ws";
import { browse, places, startingDir } from "./browse.js";
import { plainDetail } from "./log.js";
import { entriesFrom, pickRun, runs } from "./log-read.js";
import type { Session } from "./session.js";
import { staleness, stalenessNote } from "./staleness.js";

/** The `type` of a command, for a log line, without trusting it to be one. */
function commandTypeOf(command: unknown): string {
  const type = (command as { type?: unknown } | null)?.type;
  return typeof type === "string" ? type : "(unreadable)";
}

export const HOST_VERSION = "0.0.1";
/** When this process started, and where its own source would be, for the staleness check. */
const STARTED_AT = Date.now();
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RENDER_TIMEOUT_MS = 30_000;

/** The subset of a ws socket the bridge needs, so tests can use fakes. */
export interface BridgeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** ws readyState; 1 is OPEN. Fakes may omit it. */
  readyState?: number;
  on(event: "message", cb: (data: unknown) => void): unknown;
  on(event: "close", cb: () => void): unknown;
}

interface ClientState {
  socket: BridgeSocket;
  capabilities: Set<"render" | "plan">;
  hello: boolean;
}

/** One project this installation opened lately, as the editor's Open dialog shows it. */
export interface RecentEntry {
  path: string;
  name: string;
  at: string;
}

export interface BridgeOptions {
  /** The lately-opened projects, read fresh each time so another host's opens are seen too. */
  recent?: () => RecentEntry[];
}

export class Bridge implements ViewerRenderer {
  private readonly clients = new Set<ClientState>();
  private seq = 0;
  private renderSeq = 0;
  private readonly pendingRenders = new Map<
    string,
    { resolve: (images: RenderedImage[]) => void; reject: (e: Error) => void }
  >();
  private readonly unsubscribe: () => void;
  private readonly unwatchFiles: (() => void) | null;
  /** The draft under review, sent to clients that connect while it is open. */
  private draft: DraftMsg | null = null;

  constructor(
    private readonly session: Session,
    private readonly projectPath: () => string | null = () => null,
    private readonly options: BridgeOptions = {},
  ) {
    // What is open and whether it is saved changes without the history moving — a save, an open, a
    // recovery write — so none of it appears in the change stream below (ADR-012 D7).
    const files = session.ctx.files;
    this.unwatchFiles = files?.watch ? files.watch(() => this.broadcast(this.projectState())) : null;
    this.unsubscribe = session.store.subscribe((e) => {
      const msg: ChangesMsg = {
        type: "changes",
        seq: (this.seq += 1),
        changeSet: e.changes,
        historyPosition: e.historyPosition,
        origin: e.origin,
        patches: e.patches,
      };
      this.broadcast(msg);
      this.broadcast({ type: "problems", problems: session.registry.problems() });
    });
    // the tools' render goes through this bridge
    session.ctx.viewer = this;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get rendererCount(): number {
    return [...this.clients].filter((c) => c.hello && c.capabilities.has("render")).length;
  }

  attach(socket: BridgeSocket | WebSocket): void {
    const state: ClientState = { socket: socket as BridgeSocket, capabilities: new Set(), hello: false };
    this.clients.add(state);
    (socket as BridgeSocket).on("message", (data: unknown) => this.receive(state, String(data)));
    (socket as BridgeSocket).on("close", () => this.clients.delete(state));
  }

  private send(state: ClientState, msg: HostMessage): void {
    try {
      state.socket.send(JSON.stringify(msg));
    } catch {
      this.clients.delete(state);
    }
  }

  private broadcast(msg: HostMessage): void {
    for (const c of this.clients) if (c.hello) this.send(c, msg);
  }

  private reply(
    state: ClientState,
    id: string,
    ok: boolean,
    body: Omit<ResultMsg, "id" | "type" | "ok"> = {},
  ): void {
    this.send(state, { id, type: "result", ok, ...body });
  }

  /** What is open and whether it is saved, as the editor's title and File menu need it. */
  private projectState(): ProjectStateMsg {
    const store = this.session.store;
    const files = this.session.ctx.files;
    return {
      type: "project.state",
      path: files?.path() ?? this.projectPath(),
      name: store.project.meta.name,
      historyPosition: store.historyPosition,
      savedPosition: store.savedPosition,
      lastSavedAt: files?.lastSavedAt() ?? null,
      recoveryAvailable: files?.recoveryAt() ?? null,
      modifiedOutside: files?.modifiedOutside ?? false,
    };
  }

  private snapshot(): HostMessage {
    const store = this.session.store;
    return {
      type: "snapshot",
      seq: this.seq,
      project: store.project,
      historyPosition: store.historyPosition,
      savedPosition: store.savedPosition,
    };
  }

  async receive(state: ClientState, text: string): Promise<void> {
    const parsed = parseClientMessage(text);
    if (!parsed.ok) {
      if (parsed.id)
        this.reply(state, parsed.id, false, {
          error: { code: "bridge.invalid", message: parsed.error, hint: null },
        });
      return;
    }
    const msg = parsed.message;
    if (msg.type !== "hello" && !state.hello) {
      // A gesture carries no id and expects no answer, so there is nowhere to put the refusal; it is
      // dropped, which is the right end for a line about a click from a tab that never introduced itself.
      if (msg.id)
        this.reply(state, msg.id, false, {
          error: { code: "bridge.no-hello", message: "send hello first", hint: null },
        });
      return;
    }
    await this.handle(state, msg);
  }

  private async handle(state: ClientState, msg: ClientMessage): Promise<void> {
    const store = this.session.store;
    switch (msg.type) {
      case "hello": {
        const v = msg.protocolVersion ?? PROTOCOL_VERSION;
        if (v !== PROTOCOL_VERSION) {
          this.reply(state, msg.id, false, {
            error: {
              code: "bridge.version",
              message: `host speaks protocol ${PROTOCOL_VERSION}, client ${v}`,
              hint: v < PROTOCOL_VERSION ? "update the client" : "update the host",
            },
          });
          state.socket.close(CLOSE_VERSION_MISMATCH, `protocol ${PROTOCOL_VERSION} required`);
          return;
        }
        state.hello = true;
        state.capabilities = new Set(msg.capabilities);
        const behind = stalenessNote(staleness(REPO_ROOT, STARTED_AT));
        this.session.log.write("bridge", "host", {
          event: "joined",
          client: msg.clientVersion,
          protocolVersion: v,
          capabilities: [...state.capabilities],
          ...(behind ? { behind } : {}),
        });
        this.send(state, {
          id: msg.id,
          type: "welcome",
          hostVersion: HOST_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          projectId: store.project.meta.name,
          path: this.projectPath(),
          // Worked out per connection, not at startup: the code changes while the host runs, which is
          // the whole point of asking.
          stale: behind,
        });
        this.send(state, this.snapshot());
        this.send(state, this.projectState());
        this.send(state, { type: "problems", problems: this.session.registry.problems() });
        this.send(state, { type: "selection", ids: store.selection });
        if (this.draft) this.send(state, this.draft);
        return;
      }
      case "command": {
        const r = store.apply(msg.command, "editor");
        // A refusal emits nothing from the store, and "I did that and nothing happened" is the most
        // common report there is; it is written down here, where it is known (ADR-019 D2).
        if (!r.ok)
          this.session.log.write("command", "editor", {
            command: commandTypeOf(msg.command),
            ok: false,
            refused: r.error.code,
            because: r.error.message,
          });
        if (r.ok)
          this.reply(state, msg.id, true, {
            result: { changes: r.changes, warnings: r.warnings, result: r.result },
          });
        else
          this.reply(state, msg.id, false, {
            error: { code: r.error.code, message: r.error.message, hint: r.error.hint },
          });
        return;
      }
      case "transaction": {
        const t = store.transaction(msg.label, msg.commands, "editor");
        if (!t.ok)
          this.session.log.write("transaction", "editor", {
            label: msg.label,
            commands: msg.commands.map(commandTypeOf),
            ok: false,
            failedAt: t.failedIndex + 1,
            refused: t.error.code,
            because: t.error.message,
          });
        if (t.ok) this.reply(state, msg.id, true, { result: { changes: t.entry?.changes ?? null } });
        else
          this.reply(state, msg.id, false, {
            error: {
              code: t.error.code,
              message: `command ${t.failedIndex + 1}: ${t.error.message}`,
              hint: t.error.hint,
            },
          });
        return;
      }
      case "undo":
        this.reply(state, msg.id, true, { result: { changes: store.undo() } });
        return;
      case "redo":
        this.reply(state, msg.id, true, { result: { changes: store.redo() } });
        return;
      case "get": {
        if (msg.what === "snapshot") this.send(state, this.snapshot());
        const result =
          msg.what === "history"
            ? {
                position: store.historyPosition,
                entries: store.entries().map((e) => ({ label: e.label, at: e.at })),
              }
            : msg.what === "selection"
              ? { ids: store.selection }
              : msg.what === "problems"
                ? { problems: this.session.registry.problems() }
                : msg.what === "textures"
                  ? { textures: textureList(this.session) }
                  : { seq: this.seq };
        this.reply(state, msg.id, true, { result });
        return;
      }
      case "select":
        store.setSelection(msg.ids);
        this.reply(state, msg.id, true, { result: { ids: msg.ids } });
        this.broadcast({ type: "selection", ids: msg.ids });
        return;
      case "tool": {
        const r = await this.session.registry.call(msg.name, msg.args);
        this.reply(
          state,
          msg.id,
          r.ok,
          r.ok
            ? { result: r }
            : { error: { code: r.error.code, message: r.error.message, hint: r.error.hint } },
        );
        // `project new` replaces the project without touching a file, so the files' own watcher never
        // fires; the saved position still moved and every tab needs the new answer.
        if (msg.name === "project") this.broadcast(this.projectState());
        return;
      }
      case "files": {
        // The host lists its own folders so the editor can offer a picker (ADR-012 D7). A browser
        // cannot show one for a directory on this machine, and `project open` takes any path already.
        if (msg.op === "recent") {
          const current = this.session.ctx.files?.path() ?? this.projectPath();
          this.reply(state, msg.id, true, {
            result: {
              recent: this.options.recent?.() ?? [],
              places: await places(current),
              start: startingDir(current),
              current,
            },
          });
          return;
        }
        const where = msg.path ?? startingDir(this.session.ctx.files?.path() ?? this.projectPath());
        this.reply(state, msg.id, true, { result: await browse(where) });
        return;
      }
      case "log": {
        // Reading the log back in the editor (ADR-019 D7). The host owns the files; the tab asks.
        const dir = this.session.log.dir;
        if (!dir) {
          this.reply(state, msg.id, false, {
            error: {
              code: "unavailable",
              message: "this session is not writing a log",
              hint: "start the host without --log off",
            },
          });
          return;
        }
        if (msg.op === "runs") {
          this.reply(state, msg.id, true, {
            result: {
              runs: runs(dir).map((r) => ({
                name: r.name,
                at: r.at ? r.at.toISOString() : null,
                bytes: r.bytes,
                current: r.path === this.session.log.path,
              })),
            },
          });
          return;
        }
        const run = pickRun(dir, msg.run ?? null);
        if (!run) {
          this.reply(state, msg.id, false, {
            error: { code: "not-found", message: "there is no such run", hint: null },
          });
          return;
        }
        const read = entriesFrom(run.path, msg.from ?? 0, msg.limit ?? 500);
        this.reply(state, msg.id, true, {
          result: { path: run.path, name: run.name, ...read },
        });
        return;
      }
      case "gesture": {
        // What the person did, written beside the commands it caused (ADR-019 D4). Nothing is acted on
        // and nothing is answered: the whole of the host's interest in a gesture is a line in a file.
        for (const g of msg.gestures)
          this.session.log.write("gesture", "editor", { ...plainDetail(g.detail), what: g.what });
        if (msg.id) this.reply(state, msg.id, true, { result: { written: msg.gestures.length } });
        return;
      }
      case "render.result": {
        const p = this.pendingRenders.get(msg.requestId);
        this.pendingRenders.delete(msg.requestId);
        p?.resolve(
          msg.images.map((i) => ({ name: i.view, width: i.width, height: i.height, pngBase64: i.pngBase64 })),
        );
        this.reply(state, msg.id, true, { result: { accepted: p !== undefined } });
        return;
      }
      case "agent":
        this.reply(state, msg.id, false, {
          error: { code: "unavailable", message: "the in-app agent arrives in phase 1", hint: null },
        });
        return;
    }
  }

  /** ViewerRenderer for the render tool: first render-capable client, 30 s timeout (ADR-005 D6, D8). */
  render(req: RenderRequest): Promise<{ images: RenderedImage[] }> {
    const target = [...this.clients].find(
      (c) =>
        c.hello &&
        c.capabilities.has("render") &&
        (c.socket.readyState === undefined || c.socket.readyState === 1),
    );
    if (!target) return Promise.reject(new Error("no viewer with the render capability is connected"));
    const requestId = `r${(this.renderSeq += 1)}`;
    const views =
      req.view === "overhead" ? ["overhead-ne", "overhead-nw", "overhead-se", "overhead-sw"] : [req.view];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRenders.delete(requestId);
        reject(
          new Error(`the viewer did not answer the render request within ${RENDER_TIMEOUT_MS / 1000} s`),
        );
      }, RENDER_TIMEOUT_MS);
      this.pendingRenders.set(requestId, {
        resolve: (images) => {
          clearTimeout(timer);
          resolve({ images });
        },
        reject,
      });
      this.send(target, {
        type: "render.request",
        requestId,
        views: views.map((name) => ({ name })),
        hideWalls: req.hideWalls ?? req.view === "overhead",
        focusId: req.focusId ?? null,
        width: req.width ?? 1024,
      });
    });
  }

  /** Show a draft for review in every connected viewer, or close the review (ADR-011 D5). */
  presentDraft(presentation: DraftPresentation | null): void {
    const msg: DraftMsg = presentation
      ? {
          type: "draft",
          draftId: presentation.draftId,
          draft: presentation.draft,
          preview: presentation.preview,
          image: presentation.image,
          warnings: presentation.warnings,
        }
      : { type: "draft", draftId: null, draft: null, preview: null, image: null, warnings: [] };
    this.draft = presentation ? msg : null;
    this.broadcast(msg);
  }

  close(): void {
    this.unsubscribe();
    this.unwatchFiles?.();
    for (const c of this.clients) c.socket.close(1001, "host closing");
    this.clients.clear();
    if (this.session.ctx.viewer === this) this.session.ctx.viewer = null;
  }
}

/** What the editor's texture pickers need to know about each texture the catalog has (P3-5). */
function textureList(
  session: Session,
): { id: string; name: string; widthMm: number; heightMm: number; tags: string[] }[] {
  const all = (session.ctx.catalog.textures?.() ?? []) as {
    id?: unknown;
    name?: unknown;
    widthMm?: unknown;
    heightMm?: unknown;
    tags?: unknown;
  }[];
  return all.flatMap((t) =>
    typeof t.id === "string" &&
    typeof t.name === "string" &&
    typeof t.widthMm === "number" &&
    typeof t.heightMm === "number"
      ? [
          {
            id: t.id,
            name: t.name,
            widthMm: t.widthMm,
            heightMm: t.heightMm,
            tags: Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === "string") : [],
          },
        ]
      : [],
  );
}

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
import { plainDetail, silentLog } from "./log.js";
import { entriesFrom, pickRun, runs } from "./log-read.js";
import type { Session } from "./session.js";
import { staleness, stalenessNote } from "./staleness.js";
import type { Held, Workspace } from "./workspace.js";

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
  /**
   * The project this tab is looking at (ADR-020 D4), or null before it has said.
   *
   * This is what ends one-host-one-project: changes, problems, the selection and render requests all
   * go to the tabs attached to the project they belong to, and to no others.
   */
  held: Held | null;
}

/** One project this installation opened lately, as the editor's Open dialog shows it. */
export interface RecentEntry {
  /** The project's own id (ADR-020 D1): what a link carries and what the editor asks for. */
  id: string;
  address: string;
  name: string;
  lastOpenedAt: string;
}

export interface BridgeOptions {
  /** The lately-opened projects, read fresh each time so another host's opens are seen too. */
  recent?: () => RecentEntry[];
  /** Where a project id lives, for a link that names one (ADR-020 D2). */
  resolve?: (id: string) => RecentEntry | null;
}

export class Bridge {
  private readonly clients = new Set<ClientState>();
  /**
   * The change sequence, counted PER PROJECT.
   *
   * A replica refuses any change that does not follow the one it holds and asks for a fresh snapshot
   * instead (spec 06 B3). One counter shared across projects would step on every change to any of
   * them, so a change in the second tab's project would look like a gap to the first tab and throw
   * away its session — for a change it was never sent and does not care about.
   */
  private readonly seqs = new Map<string, number>();
  private renderSeq = 0;
  private readonly pendingRenders = new Map<
    string,
    { resolve: (images: RenderedImage[]) => void; reject: (e: Error) => void }
  >();
  /** One per project being followed, undone when the bridge closes. */
  private readonly stopFollowing = new Map<string, () => void>();
  /** The draft under review per project, sent to a tab that attaches while one is open. */
  private readonly drafts = new Map<string, DraftMsg>();

  constructor(
    private readonly workspace: Workspace,
    private readonly options: BridgeOptions = {},
  ) {
    for (const held of workspace.list()) this.follow(held);
    this.stopFollowing.set(
      "__workspace",
      workspace.watch((held) => this.follow(held)),
    );
  }

  /**
   * Start sending one project's changes to the tabs looking at it.
   *
   * Each project gets its own viewer, rather than the bridge being one: a render asked for by the
   * project in the second tab must be drawn by a tab showing THAT project, or the picture comes back
   * of something else entirely.
   */
  private follow(held: Held): void {
    if (this.stopFollowing.has(held.id)) return;
    const { session } = held;
    const files = session.ctx.files;
    const unwatchFiles = files?.watch
      ? files.watch(() => this.broadcast(held, this.projectState(held)))
      : null;
    const unsubscribe = session.store.subscribe((e) => {
      const msg: ChangesMsg = {
        type: "changes",
        seq: this.nextSeq(held),
        changeSet: e.changes,
        historyPosition: e.historyPosition,
        origin: e.origin,
        patches: e.patches,
      };
      this.broadcast(held, msg);
      this.broadcast(held, { type: "problems", problems: session.registry.problems() });
    });
    session.ctx.viewer = {
      render: (req) => this.renderFor(held, req),
      presentDraft: (presentation) => this.presentDraftFor(held, presentation),
    };
    this.stopFollowing.set(held.id, () => {
      unsubscribe();
      unwatchFiles?.();
      if (session.ctx.viewer && "render" in session.ctx.viewer) session.ctx.viewer = null;
    });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get rendererCount(): number {
    return [...this.clients].filter((c) => c.hello && c.capabilities.has("render")).length;
  }

  attach(socket: BridgeSocket | WebSocket): void {
    const state: ClientState = {
      socket: socket as BridgeSocket,
      capabilities: new Set(),
      hello: false,
      held: null,
    };
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

  private nextSeq(held: Held): number {
    const next = (this.seqs.get(held.id) ?? 0) + 1;
    this.seqs.set(held.id, next);
    return next;
  }

  /** To the tabs looking at this project, and to no others (ADR-020 D4). */
  private broadcast(held: Held, msg: HostMessage): void {
    for (const c of this.clients) if (c.hello && c.held?.id === held.id) this.send(c, msg);
  }

  /** Put a tab on a project and send it everything it needs to draw that project from nothing. */
  private showProjectTo(state: ClientState, held: Held): void {
    state.held = held;
    this.send(state, this.snapshot(held));
    this.send(state, this.projectState(held));
    this.send(state, { type: "problems", problems: held.session.registry.problems() });
    this.send(state, { type: "selection", ids: held.session.store.selection });
    const draft = this.drafts.get(held.id);
    if (draft) this.send(state, draft);
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
  private projectState(held: Held): ProjectStateMsg {
    const store = held.session.store;
    const files = held.session.ctx.files;
    return {
      type: "project.state",
      projectId: store.project.meta.id,
      path: files?.path() ?? null,
      name: store.project.meta.name,
      historyPosition: store.historyPosition,
      savedPosition: store.savedPosition,
      lastSavedAt: files?.lastSavedAt() ?? null,
      recoveryAvailable: files?.recoveryAt() ?? null,
      modifiedOutside: files?.modifiedOutside ?? false,
    };
  }

  private snapshot(held: Held): HostMessage {
    const store = held.session.store;
    return {
      type: "snapshot",
      seq: this.seqs.get(held.id) ?? 0,
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
    if (msg.type === "hello") {
      this.hello(state, msg);
      return;
    }
    if (msg.type === "workspace") {
      await this.workspaceMessage(state, msg);
      return;
    }
    // Everything else is about one project, and a tab that is not looking at one has nothing to say
    // about any of them. This is not reachable through the editor, which attaches with its hello.
    const held = state.held;
    if (!held) {
      if (msg.id)
        this.reply(state, msg.id, false, {
          error: {
            code: "bridge.no-project",
            message: "this tab is not looking at a project",
            hint: "attach to one first",
          },
        });
      return;
    }
    const session = held.session;
    const store = session.store;
    switch (msg.type) {
      case "command": {
        const r = store.apply(msg.command, "editor");
        // A refusal emits nothing from the store, and "I did that and nothing happened" is the most
        // common report there is; it is written down here, where it is known (ADR-019 D2).
        if (!r.ok)
          session.log.write("command", "editor", {
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
          session.log.write("transaction", "editor", {
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
        if (msg.what === "snapshot") this.send(state, this.snapshot(held));
        const result =
          msg.what === "history"
            ? {
                position: store.historyPosition,
                entries: store.entries().map((e) => ({ label: e.label, at: e.at })),
              }
            : msg.what === "selection"
              ? { ids: store.selection }
              : msg.what === "problems"
                ? { problems: session.registry.problems() }
                : msg.what === "textures"
                  ? { textures: textureList(session) }
                  : { seq: this.seqs.get(held.id) ?? 0 };
        this.reply(state, msg.id, true, { result });
        return;
      }
      case "select":
        store.setSelection(msg.ids);
        this.reply(state, msg.id, true, { result: { ids: msg.ids } });
        this.broadcast(held, { type: "selection", ids: msg.ids });
        return;
      case "tool": {
        const r = await session.registry.call(msg.name, msg.args);
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
        if (msg.name === "project") this.broadcast(held, this.projectState(held));
        return;
      }
      case "files": {
        // The host lists its own folders so the editor can offer a picker (ADR-012 D8). A browser
        // cannot show one for a directory on this machine, and `project open` takes any path already.
        if (msg.op === "recent") {
          const current = held.files.path();
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
        if (msg.op === "resolve") {
          // A link names a project by id; this says where that project is, or that nothing here knows
          // it — which is a different answer from "it is missing" and reads differently to the person.
          const known = msg.project ? (this.options.resolve?.(msg.project) ?? null) : null;
          this.reply(state, msg.id, true, { result: { project: known } });
          return;
        }
        const where = msg.path ?? startingDir(held.files.path());
        this.reply(state, msg.id, true, { result: await browse(where) });
        return;
      }
      case "log": {
        // Reading the log back in the editor (ADR-019 D7). The host owns the files; the tab asks.
        const dir = session.log.dir;
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
                current: r.path === session.log.path,
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
          session.log.write("gesture", "editor", { ...plainDetail(g.detail), what: g.what });
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

  /**
   * A tab introducing itself, and saying which project it wants (ADR-020 D4).
   *
   * `project` is the id from its URL. A tab that names none, or names one this host is not holding,
   * gets whatever was opened last — which for a host started with `--project` is that project, exactly
   * as before.
   */
  private hello(state: ClientState, msg: Extract<ClientMessage, { type: "hello" }>): void {
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
    const held = (msg.project ? this.workspace.get(msg.project) : null) ?? this.workspace.default();
    const behind = stalenessNote(staleness(REPO_ROOT, STARTED_AT));
    (held?.session.log ?? this.anyLog()).write("bridge", "host", {
      event: "joined",
      client: msg.clientVersion,
      protocolVersion: v,
      capabilities: [...state.capabilities],
      asked: msg.project ?? null,
      ...(behind ? { behind } : {}),
    });
    this.send(state, {
      id: msg.id,
      type: "welcome",
      hostVersion: HOST_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      projectId: held?.session.store.project.meta.id ?? "",
      path: held?.files.path() ?? null,
      // Worked out per connection, not at startup: the code changes while the host runs, which is
      // the whole point of asking.
      stale: behind,
    });
    if (held) this.showProjectTo(state, held);
  }

  /** Opening, making, listing and leaving projects (ADR-020 D4). */
  private async workspaceMessage(
    state: ClientState,
    msg: Extract<ClientMessage, { type: "workspace" }>,
  ): Promise<void> {
    const describe = (held: Held) => ({
      projectId: held.id,
      name: held.session.store.project.meta.name,
      address: held.files.path(),
    });
    try {
      switch (msg.op) {
        case "list":
          this.reply(state, msg.id, true, { result: { open: this.workspace.list().map(describe) } });
          return;
        case "attach": {
          // By id when this host is already holding it, else by where the registry says it lives, so a
          // link works on a host that has never had that project open.
          const byId = msg.project ? this.workspace.get(msg.project) : null;
          const address = msg.address ?? (msg.project ? this.options.resolve?.(msg.project)?.address : null);
          const held = byId ?? (address ? await this.workspace.open(address) : null);
          if (!held) {
            this.reply(state, msg.id, false, {
              error: {
                code: "not-found",
                message: "nothing here knows that project",
                hint: "open it once by name and the link will work from then on",
              },
            });
            return;
          }
          this.showProjectTo(state, held);
          this.reply(state, msg.id, true, { result: describe(held) });
          return;
        }
        case "open": {
          if (!msg.address) {
            this.reply(state, msg.id, false, {
              error: { code: "invalid", message: "open needs an address", hint: null },
            });
            return;
          }
          const held = await this.workspace.open(msg.address, msg.recover ? { recover: true } : {});
          this.showProjectTo(state, held);
          this.reply(state, msg.id, true, { result: describe(held) });
          return;
        }
        case "new": {
          const held = this.workspace.create(msg.name ?? "Untitled");
          this.showProjectTo(state, held);
          this.reply(state, msg.id, true, { result: describe(held) });
          return;
        }
        case "close": {
          const held = msg.project ? this.workspace.get(msg.project) : null;
          if (held) {
            // Any tab still looking at it is put back on whatever remains, rather than left watching a
            // project that no longer exists.
            for (const c of this.clients) if (c.held?.id === held.id) c.held = null;
            this.workspace.close(held.id);
            this.stopFollowing.get(held.id)?.();
            this.stopFollowing.delete(held.id);
            this.drafts.delete(held.id);
            this.seqs.delete(held.id);
            // A tab always has a project to be looking at. Closing the last one leaves an empty one
            // rather than a tab attached to nothing, which nothing in the editor is built to draw.
            const left = this.workspace.default() ?? this.workspace.create();
            for (const c of this.clients) if (c.hello && !c.held) this.showProjectTo(c, left);
          }
          this.reply(state, msg.id, true, { result: { open: this.workspace.list().map(describe) } });
          return;
        }
      }
    } catch (e) {
      this.reply(state, msg.id, false, {
        error: {
          code: (e as { code?: string }).code ?? "file.error",
          message: e instanceof Error ? e.message : String(e),
          hint: (e as { hint?: string | null }).hint ?? null,
        },
      });
    }
  }

  /** Any session's log; they all write to the same run, and the host's own lines belong to no project. */
  private anyLog(): Session["log"] {
    const held = this.workspace.default() ?? this.workspace.list()[0];
    return held ? held.session.log : silentLog();
  }

  /** ViewerRenderer for the render tool: first render-capable client, 30 s timeout (ADR-005 D6, D8). */
  private renderFor(held: Held, req: RenderRequest): Promise<{ images: RenderedImage[] }> {
    // A tab showing ANOTHER project would draw a perfectly good picture of the wrong building.
    const target = [...this.clients].find(
      (c) =>
        c.hello &&
        c.held?.id === held.id &&
        c.capabilities.has("render") &&
        (c.socket.readyState === undefined || c.socket.readyState === 1),
    );
    if (!target)
      return Promise.reject(
        new Error(
          `no viewer with the render capability is looking at ${held.session.store.project.meta.name}`,
        ),
      );
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

  /** Show a draft for review in the viewers of one project, or close the review (ADR-011 D5). */
  private presentDraftFor(held: Held, presentation: DraftPresentation | null): void {
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
    if (presentation) this.drafts.set(held.id, msg);
    else this.drafts.delete(held.id);
    this.broadcast(held, msg);
  }

  close(): void {
    for (const stop of this.stopFollowing.values()) stop();
    this.stopFollowing.clear();
    for (const c of this.clients) c.socket.close(1001, "host closing");
    this.clients.clear();
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

// Bridge client (spec 06 part B): one WebSocket to the host, request ids with promises, and the
// snapshot / changes stream feeding the replica. The socket is injected so tests run without a network.
import {
  CLOSE_VERSION_MISMATCH,
  type DraftMsg,
  type HostMessage,
  PROTOCOL_VERSION,
  type RenderRequestMsg,
  type ResultMsg,
} from "@fpv/commands";
import type { Replica } from "../replica.js";

// Handler properties are declared through method shorthand so a browser WebSocket (whose handlers take
// DOM event types) is assignable; parameters are checked bivariantly for methods.
type Handler<E> = { fn(ev: E): void }["fn"];

/** The subset of WebSocket the client needs; a browser WebSocket satisfies it. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: Handler<unknown> | null;
  onmessage: Handler<{ data: unknown }> | null;
  onclose: Handler<{ code: number; reason: string }> | null;
  onerror: Handler<unknown> | null;
}

export type Capability = "render" | "plan";

export interface RenderHandler {
  (req: RenderRequestMsg): Promise<{ view: string; pngBase64: string; width: number; height: number }[]>;
}

export interface BridgeClientOptions {
  clientVersion: string;
  capabilities: Capability[];
  /** Answers render requests when the client advertised the render capability. */
  onRender?: RenderHandler;
  onStatus?: (status: BridgeStatus) => void;
  /** A plan draft opened for review, or closed (draftId null). */
  onDraft?: (msg: DraftMsg) => void;
}

export type BridgeStatus = "connecting" | "open" | "closed" | "version-mismatch";

export class BridgeClient {
  private seq = 0;
  private pending = new Map<string, { resolve: (m: ResultMsg) => void; reject: (e: Error) => void }>();
  status: BridgeStatus = "connecting";
  welcome: Extract<HostMessage, { type: "welcome" }> | null = null;

  constructor(
    private readonly socket: SocketLike,
    private readonly replica: Replica,
    private readonly options: BridgeClientOptions,
  ) {
    socket.onopen = () => {
      this.setStatus("open");
      void this.request({
        type: "hello",
        clientVersion: options.clientVersion,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: options.capabilities,
      });
    };
    socket.onmessage = (ev) => this.handle(String(ev.data));
    socket.onclose = (ev) => {
      this.setStatus(ev.code === CLOSE_VERSION_MISMATCH ? "version-mismatch" : "closed");
      for (const p of this.pending.values()) p.reject(new Error(`bridge closed: ${ev.reason || ev.code}`));
      this.pending.clear();
    };
    socket.onerror = () => {};
  }

  private setStatus(s: BridgeStatus): void {
    this.status = s;
    this.options.onStatus?.(s);
  }

  /** Send a message that expects exactly one result. */
  request(body: Record<string, unknown>): Promise<ResultMsg> {
    const id = `c${(this.seq += 1)}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, ...body }));
    });
  }

  command(command: unknown): Promise<ResultMsg> {
    return this.request({ type: "command", command });
  }
  transaction(label: string, commands: unknown[]): Promise<ResultMsg> {
    return this.request({ type: "transaction", label, commands });
  }
  undo(): Promise<ResultMsg> {
    return this.request({ type: "undo" });
  }
  redo(): Promise<ResultMsg> {
    return this.request({ type: "redo" });
  }
  select(ids: string[]): Promise<ResultMsg> {
    return this.request({ type: "select", ids });
  }
  tool(name: string, args: Record<string, unknown>): Promise<ResultMsg> {
    return this.request({ type: "tool", name, args });
  }
  requestSnapshot(): Promise<ResultMsg> {
    return this.request({ type: "get", what: "snapshot" });
  }
  /**
   * Tell the host what the person did, for the session log (ADR-019 D4). The one message that expects no
   * result: there is nothing to wait for, and a gesture with nowhere to go is dropped rather than queued.
   */
  gesture(gestures: { what: string; detail?: Record<string, unknown> }[]): void {
    if (this.status !== "open" || gestures.length === 0) return;
    try {
      this.socket.send(JSON.stringify({ type: "gesture", gestures }));
    } catch {
      // the log is never worth an exception in the editor
    }
  }

  handle(text: string): void {
    let msg: HostMessage;
    try {
      msg = JSON.parse(text) as HostMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "welcome": {
        this.welcome = msg;
        const hello = this.pending.get(msg.id);
        if (hello) {
          this.pending.delete(msg.id);
          hello.resolve({ id: msg.id, type: "result", ok: true, result: msg });
        }
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          this.socket.close(
            CLOSE_VERSION_MISMATCH,
            `client speaks protocol ${PROTOCOL_VERSION}, host ${msg.protocolVersion}`,
          );
        }
        return;
      }
      case "result": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
        return;
      }
      case "snapshot":
        this.replica.applySnapshot(msg);
        return;
      case "changes":
        if (!this.replica.applyChanges(msg)) void this.requestSnapshot();
        return;
      // Through the setters, not the fields: a bare assignment updates the value without telling any
      // subscriber, which left every React reader showing stale data indefinitely.
      case "problems":
        this.replica.setProblems(msg.problems);
        return;
      case "project.state":
        this.replica.setProjectState(msg);
        return;
      case "selection":
        this.replica.setSelection(msg.ids);
        return;
      case "render.request":
        void this.answerRender(msg);
        return;
      case "draft":
        this.options.onDraft?.(msg);
        return;
      default:
        return;
    }
  }

  private async answerRender(req: RenderRequestMsg): Promise<void> {
    if (!this.options.onRender) return;
    try {
      const images = await this.options.onRender(req);
      await this.request({ type: "render.result", requestId: req.requestId, images });
    } catch (e) {
      await this.request({ type: "render.result", requestId: req.requestId, images: [] }).catch(() => {});
      throw e;
    }
  }

  close(): void {
    this.socket.close(1000, "client closed");
  }
}

/** Where the bridge lives relative to the page that loaded the app. */
export function bridgeUrl(location: { protocol: string; host: string }): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/bridge`;
}

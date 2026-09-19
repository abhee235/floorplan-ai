// One HTTP server for the web app's static files and the bridge WebSocket upgrade (ADR-005 D2, D7).
// Loopback only unless asked otherwise. Nothing else listens.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Bridge, type RecentEntry } from "./bridge.js";
import type { Session } from "./session.js";

export const DEFAULT_PORT = 4310;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".glb": "model/gltf-binary",
  ".ico": "image/x-icon",
};

export interface ServeOptions {
  port?: number;
  host?: string;
  /** Directory with the built web app (apps/web/dist by default). */
  webDir?: string;
  projectPath?: () => string | null;
  /** Texture images by id, served at /textures/<id> for the viewer (P3-5). */
  textures?: (id: string) => { bytes: Uint8Array; type: string } | null;
  /** The lately-opened projects, for File ▸ Open recent; read fresh on every request. */
  recent?: () => RecentEntry[];
}

export interface Served {
  server: Server;
  bridge: Bridge;
  port: number;
  url: string;
  close(): Promise<void>;
}

export function defaultWebDir(): string {
  return resolve(fileURLToPath(new URL("../../web/dist/", import.meta.url)));
}

const NOT_BUILT =
  "<!doctype html><meta charset=utf-8><title>floorplan-ai</title><body style='font:14px system-ui;padding:2em'>" +
  "<h1>floorplan-ai host</h1><p>The web app is not built. Run <code>corepack pnpm web:build</code> and reload, " +
  "or start <code>corepack pnpm web:dev</code> for the Vite dev server (it proxies the bridge to this host).</p>" +
  "<p>The bridge is live at <code>/bridge</code>.</p>";

function serveStatic(webDir: string, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  if (path === "/" || path === "\\") path = "/index.html";
  const file = join(webDir, path);
  if (!file.startsWith(webDir)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(NOT_BUILT);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-cache",
  });
  createReadStream(file).pipe(res);
}

/** A texture image: `/textures/<library>/<slug>`, the texture's catalog id after the prefix. */
function serveTexture(textures: ServeOptions["textures"], req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const id = decodeURIComponent(url.pathname.slice("/textures/".length));
  const image = /^[a-z0-9-]+\/[a-z0-9-]+$/.test(id) ? textures?.(id) : null;
  if (!image) {
    res.writeHead(404, { "content-type": "text/plain" }).end(`no texture ${id}`);
    return;
  }
  res
    .writeHead(200, {
      "content-type": image.type,
      "content-length": image.bytes.byteLength,
      "cache-control": "no-cache",
    })
    .end(image.bytes);
}

/** Start serving the session: static web app plus `/bridge`. Resolves once listening. */
export function serve(session: Session, options: ServeOptions = {}): Promise<Served> {
  const webDir = resolve(options.webDir ?? defaultWebDir());
  const host = options.host ?? "127.0.0.1";
  const bridge = new Bridge(session, options.projectPath ?? (() => null), {
    ...(options.recent ? { recent: options.recent } : {}),
  });
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/bridge")) {
      res.writeHead(426, { "content-type": "text/plain" }).end("websocket only");
      return;
    }
    if (req.url?.startsWith("/textures/")) {
      serveTexture(options.textures, req, res);
      return;
    }
    serveStatic(webDir, req, res);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/bridge")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => bridge.attach(ws));
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PORT, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (options.port ?? DEFAULT_PORT);
      resolvePromise({
        server,
        bridge,
        port,
        url: `http://${host}:${port}/`,
        close: () =>
          new Promise<void>((done) => {
            bridge.close();
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}

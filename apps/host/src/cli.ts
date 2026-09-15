// Host entry point. `--mcp` serves the tool registry over stdio for an MCP client (Claude Code during
// development); `--serve` serves the web viewer and the bridge on one port. Both flags together give
// the one process the product deploys as: no sidecar, no separate service (ADR-005).

import { join } from "node:path";
import { AV_CORE, ensureSeed } from "@fpv/catalog";
import { CatalogStore } from "@fpv/catalog/store";
import { PROTOCOL_VERSION } from "@fpv/commands";
import type { ToolReliability } from "@fpv/tools";
import { FileExportWriter } from "./exports.js";
import { ProjectFileStore } from "./files.js";
import { serveStdio } from "./mcp.js";
import { dataPaths } from "./paths.js";
import { FilePlanReader } from "./plans.js";
import { createReader, loadReaderConfig } from "./reader.js";
import { DEFAULT_PORT, serve } from "./server.js";
import { createSession } from "./session.js";
import { createVerifier, loadHostConfig } from "./verifier.js";

export interface CliArgs {
  mcp: boolean;
  serve: boolean;
  port: number;
  project: string | null;
  profile: ToolReliability;
  /** Data directory for the catalog database and libraries; null picks the platform default. */
  data: string | null;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = {
    mcp: false,
    serve: false,
    port: DEFAULT_PORT,
    project: null,
    profile: "high",
    data: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--mcp") out.mcp = true;
    else if (a === "--serve") out.serve = true;
    else if (a === "--port") {
      const n = Number(argv[i + 1]);
      if (Number.isInteger(n) && n >= 0 && n < 65536) out.port = n;
      i += 1;
    } else if (a === "--project") {
      out.project = argv[i + 1] ?? null;
      i += 1;
    } else if (a === "--profile") {
      const v = argv[i + 1];
      if (v === "high" || v === "medium" || v === "low") out.profile = v;
      i += 1;
    } else if (a === "--data") {
      out.data = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return out;
}

/** Open the catalog database in the data directory and make sure the seed library is installed. */
export function openCatalog(
  dir: string | null,
  now: () => string,
): { store: CatalogStore; path: string; dir: string; seeded: boolean } {
  const paths = dataPaths(dir ?? undefined);
  const store = CatalogStore.open(paths.catalogDb);
  const seeded = ensureSeed(store, now());
  return { store, path: paths.catalogDb, dir: paths.dir, seeded };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (!args.mcp && !args.serve) {
    process.stderr.write(
      "usage: host [--mcp] [--serve] [--port <n>] [--project <project.json>] [--profile high|medium|low] [--data <dir>]\n" +
        "  --mcp    serve the tool registry over stdio for an MCP client\n" +
        "  --serve  serve the web viewer and the bridge on http://127.0.0.1:<port>/ (default 4310)\n" +
        "  --data   directory for the catalog database and libraries (default: the platform data dir)\n" +
        "Both flags together give one process that Claude Code drives while a browser tab watches.\n",
    );
    process.exitCode = 2;
    return;
  }
  // the catalog database lives in the data directory; the seed library is installed on first run
  const now = () => new Date().toISOString();
  const catalog = openCatalog(args.data, now);
  process.stderr.write(
    `floorplan-viz catalog: ${catalog.path}${catalog.seeded ? " (seed installed)" : ""}\n`,
  );
  // one file store per session; a project given on the command line is opened before anything listens
  const files = new ProjectFileStore();
  const opened = args.project ? await files.open(args.project) : null;
  if (opened?.recoveryAt)
    process.stderr.write(
      `a recovery file from ${opened.recoveryAt} is newer; open with recover: true to use it\n`,
    );
  // product verification: search and model are optional; without them callers pass sources and a proposal
  const loaded = loadHostConfig({ dataDir: catalog.dir });
  for (const note of loaded.notes) process.stderr.write(`floorplan-viz config: ${note}\n`);
  const verification = createVerifier(catalog.store, loaded.config, { now });
  process.stderr.write(`floorplan-viz verifier: ${verification.describe}\n`);
  const readerConfig = loadReaderConfig({ dataDir: catalog.dir });
  for (const note of readerConfig.notes) process.stderr.write(`floorplan-viz config: ${note}\n`);
  const planReaderSetup = createReader(readerConfig.model);
  process.stderr.write(`floorplan-viz reader: ${planReaderSetup.describe}\n`);
  const session = createSession({
    files,
    now,
    catalog: catalog.store,
    verifier: verification.verifier,
    rules: AV_CORE,
    writer: new FileExportWriter({ baseDir: () => files.path() ?? join(catalog.dir, "exports") }),
    plans: new FilePlanReader({ baseDir: () => process.cwd(), raster: planReaderSetup.reader }),
    ...(opened ? { project: opened.project } : {}),
  });
  files.startAutosave();
  if (args.serve) {
    const served = await serve(session, { port: args.port, projectPath: () => files.path() });
    // stdout may be the MCP transport, so the URL goes to stderr
    process.stderr.write(`floorplan-viz viewer: ${served.url}\n`);
    await files.writeSession(served.port, PROTOCOL_VERSION);
    const bye = () => {
      files.stopAutosave();
      catalog.store.close();
      void files.closeSession().finally(() => process.exit(0));
    };
    process.once("SIGINT", bye);
    process.once("SIGTERM", bye);
  }
  if (args.mcp) await serveStdio(session, { profile: args.profile });
  // stdio and the http server keep the process alive; closing them ends it
}

if (process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js")) {
  main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  });
}

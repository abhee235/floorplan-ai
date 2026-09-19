// Host entry point. `--mcp` serves the tool registry over stdio for an MCP client (Claude Code during
// development); `--serve` serves the web viewer and the bridge on one port. Both flags together give
// the one process the product deploys as: no sidecar, no separate service (ADR-005).

import { join } from "node:path";
import { openAICompatible } from "@fpv/agents";
import { AV_CORE, ensureSeed } from "@fpv/catalog";
import { CatalogStore } from "@fpv/catalog/store";
import { PROTOCOL_VERSION } from "@fpv/commands";
import type { ToolReliability } from "@fpv/tools";
import { describeEvent, loadAgentConfig, runAgentTask } from "./agent.js";
import { HOST_VERSION } from "./bridge.js";
import { loadDotEnv } from "./env.js";
import { FileExportWriter } from "./exports.js";
import { libraryRoot } from "./library.js";
import { createLog, type LogLevel } from "./log.js";
import { formatEntry, formatRuns, pickRun, readFrom, readRun, runs } from "./log-read.js";
import { serveStdio } from "./mcp.js";
import { dataPaths } from "./paths.js";
import { FilePlanReader } from "./plans.js";
import { ProjectRegistry } from "./projects.js";
import { createReader, loadReaderConfig } from "./reader.js";
import { DEFAULT_PORT, serve } from "./server.js";
import { TextureImages } from "./textures.js";
import { createVerifier, loadHostConfig } from "./verifier.js";
import { Workspace } from "./workspace.js";

export interface CliArgs {
  mcp: boolean;
  serve: boolean;
  port: number;
  project: string | null;
  profile: ToolReliability;
  /** Data directory for the catalog database and libraries; null picks the platform default. */
  data: string | null;
  /** Where this person's projects live; null takes FPV_PROJECTS_DIR, else Documents. */
  projects: string | null;
  /** A task for the in-app agent to run once (PRD P1-7); null runs none. */
  agent: string | null;
  /** Step budget for --agent. */
  steps: number | null;
  /** How much of what happens is written down (ADR-019); null takes FPV_LOG, which defaults to info. */
  log: LogLevel | null;
  /** Read the log back instead of running: true lists the runs, a name or "last" prints one. */
  logs: boolean;
  run: string | null;
  /** With a run, keep printing as it grows. */
  follow: boolean;
  /** With a run, only the lines holding this text. */
  find: string | null;
}

/** FPV_LOG, when it says something this understands; otherwise everything is written down. */
export function readLogLevel(value: string | undefined): LogLevel {
  return value === "off" || value === "verbose" || value === "info" ? value : "info";
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = {
    mcp: false,
    serve: false,
    port: DEFAULT_PORT,
    project: null,
    profile: "high",
    data: null,
    projects: null,
    agent: null,
    steps: null,
    log: null,
    logs: false,
    run: null,
    follow: false,
    find: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--mcp") out.mcp = true;
    else if (a === "--serve") out.serve = true;
    else if (a === "--port") {
      const n = Number(argv[i + 1]);
      if (Number.isInteger(n) && n >= 0 && n < 65536) out.port = n;
      i += 1;
    } else if (a === "--log") {
      const level = argv[i + 1];
      if (level === "off" || level === "info" || level === "verbose") out.log = level;
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
    } else if (a === "--projects") {
      out.projects = argv[i + 1] ?? null;
      i += 1;
    } else if (a === "--agent") {
      out.agent = argv[i + 1] ?? null;
      i += 1;
    } else if (a === "--logs") {
      out.logs = true;
      // An optional value: the run to print. Anything starting with a dash is the next flag, not a run.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        out.run = next;
        i += 1;
      }
    } else if (a === "--follow") out.follow = true;
    else if (a === "--find") {
      out.find = argv[i + 1] ?? null;
      i += 1;
    } else if (a === "--steps") {
      const n = Number(argv[i + 1]);
      if (Number.isInteger(n) && n > 0) out.steps = n;
      i += 1;
    }
  }
  return out;
}

/** How often a followed run is looked at again. */
const FOLLOW_MS = 250;

/**
 * `--logs`: the runs, or one of them, read back (ADR-019). This is the other half of keeping a log —
 * a file nobody can read is a file nobody reads — and on Windows there is no `tail -f` to fall back on.
 */
function showLogs(args: CliArgs): void {
  const dir = join(dataPaths(args.data ?? undefined).dir, "logs");
  const out = (text: string): void => void process.stdout.write(text);
  if (!args.run) {
    out(`${formatRuns(runs(dir)).join("\n")}\n`);
    if (runs(dir).length > 0) out("\n--logs last prints the newest; add --follow to watch it.\n");
    return;
  }
  const run = pickRun(dir, args.run);
  if (!run) {
    process.stderr.write(`no run matches "${args.run}" in ${dir}\n`);
    process.exitCode = 1;
    return;
  }
  out(`${run.path}\n`);
  let at = readRun(run.path, { find: args.find, write: out });
  if (!args.follow) return;
  // Following: the host appends to this file as it goes, and only whole lines are taken, so a line
  // caught half written waits for the rest rather than printing as nonsense.
  const timer = setInterval(() => {
    const { text, end } = readFrom(run.path, at);
    at = end;
    for (const line of text.split("\n"))
      if (line.trim() && (!args.find || line.includes(args.find)))
        for (const formatted of formatEntry(line)) out(`${formatted}\n`);
  }, FOLLOW_MS);
  const stop = (): void => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
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
  // Reading the log back is a job of its own: it loads no configuration, opens no catalog, starts no
  // server and writes nothing, so that nothing it prints is in front of the lines that were asked for.
  if (args.logs) {
    showLogs(args);
    return;
  }
  // model providers, keys and roles come from the nearest .env; the shell environment wins
  const dotenv = loadDotEnv();
  if (dotenv.file) process.stderr.write(`floorplan-ai env: ${dotenv.file}\n`);
  for (const note of dotenv.notes) process.stderr.write(`floorplan-ai env: ${note}\n`);
  if ((!args.mcp && !args.serve && !args.agent) || (args.mcp && args.agent)) {
    process.stderr.write(
      "usage: host [--mcp] [--serve] [--port <n>] [--project <project.json>] [--profile high|medium|low] [--data <dir>]\n" +
        "            [--agent <task> [--steps <n>]]\n" +
        "  --log    off | info | verbose: how much of what happens is written to <data>/logs (default info)\n" +
        "  --logs   list the runs written so far; --logs last prints the newest, --logs <name> one by name\n" +
        "           with --follow it keeps printing as the run goes on; --find <text> keeps only the\n" +
        "           lines holding that text, which is how to follow one object through a session\n" +
        "  --mcp    serve the tool registry over stdio for an MCP client\n" +
        "  --serve  serve the web viewer and the bridge on http://127.0.0.1:<port>/ (default 4310)\n" +
        "  --data   directory for the catalog database and libraries (default: the platform data dir)\n" +
        "  --projects where this person's projects live: the folder the picker starts in and\n" +
        "           Save as suggests (default: Documents/floorplan-viz; also FPV_PROJECTS_DIR)\n" +
        "  --agent  run one task with the configured designer model (roles.designer or FPV_AGENT_*);\n" +
        "           with --serve a browser tab watches it; not together with --mcp\n" +
        "Both --mcp and --serve together give one process that Claude Code drives while a browser tab watches.\n",
    );
    process.exitCode = 2;
    return;
  }
  // the catalog database lives in the data directory; the seed library is installed on first run
  const now = () => new Date().toISOString();
  const catalog = openCatalog(args.data, now);
  process.stderr.write(`floorplan-ai catalog: ${catalog.path}${catalog.seeded ? " (seed installed)" : ""}\n`);
  // What this run did, written down as it happens (ADR-019). The first line says what is running, so a
  // log answers "which code was this?" without anyone having to remember.
  const level = args.log ?? readLogLevel(process.env.FPV_LOG);
  const log = createLog({ dir: join(catalog.dir, "logs"), level });
  if (log.path) process.stderr.write(`floorplan-ai log: ${log.path}\n`);
  log.write("host", "host", {
    event: "started",
    hostVersion: HOST_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    node: process.version,
    data: catalog.dir,
    argv: [...argv],
  });
  // Every project this session opens or saves is remembered by its own id (ADR-020 D1), so a link
  // keeps working after the folder is moved and File ▸ Open recent has something to offer.
  const projects = ProjectRegistry.open(catalog.dir);
  // Where this installation keeps projects (ADR-021). The editor addresses them by id and never sees
  // a path; an installation may put the library elsewhere, which is an administrator's decision.
  const library = libraryRoot(catalog.dir, args.projects);
  process.stderr.write(`floorplan-ai library: ${library}
`);
  // product verification: search and model are optional; without them callers pass sources and a proposal
  const loaded = loadHostConfig({ dataDir: catalog.dir });
  for (const note of loaded.notes) process.stderr.write(`floorplan-ai config: ${note}\n`);
  const verification = createVerifier(catalog.store, loaded.config, { now });
  process.stderr.write(`floorplan-ai verifier: ${verification.describe}\n`);
  const readerConfig = loadReaderConfig({ dataDir: catalog.dir });
  for (const note of readerConfig.notes) process.stderr.write(`floorplan-ai config: ${note}\n`);
  const planReaderSetup = createReader(readerConfig.model);
  process.stderr.write(`floorplan-ai reader: ${planReaderSetup.describe}\n`);
  // Several projects can be open at once (ADR-020 D4). A host started with --project holds that one
  // to begin with, and a tab can open others without disturbing it.
  const workspace = new Workspace({
    now,
    log,
    registry: projects,
    library,
    catalog: catalog.store,
    verifier: verification.verifier,
    rules: AV_CORE,
    writer: (store) => new FileExportWriter({ baseDir: () => store.path() ?? join(catalog.dir, "exports") }),
    plans: new FilePlanReader({ baseDir: () => process.cwd(), raster: planReaderSetup.reader }),
  });
  const first = args.project ? await workspace.open(args.project) : await workspace.create();
  const files = first.files;
  const session = first.session;
  if (args.project) {
    const recoveryAt = files.recoveryAt();
    if (recoveryAt)
      process.stderr.write(
        `a recovery file from ${recoveryAt} is newer; open with recover: true to use it\n`,
      );
    log.write("file", "host", { event: "opened", path: args.project, recoveryAt });
  }
  if (args.serve) {
    const images = new TextureImages(catalog.store, catalog.dir);
    const served = await serve(workspace, {
      port: args.port,

      textures: (id) => images.image(id),
      // Read fresh per request: another host may have opened something since this one started.
      library: () => projects.recentPresent(),
    });
    // stdout may be the MCP transport, so the URL goes to stderr
    process.stderr.write(`floorplan-ai viewer: ${served.url}\n`);
    await files.writeSession(served.port, PROTOCOL_VERSION);
    const bye = () => {
      workspace.closeAll();
      projects.close();
      catalog.store.close();
      log.write("host", "host", { event: "stopping" });
      log.close();
      void files.closeSession().finally(() => process.exit(0));
    };
    process.once("SIGINT", bye);
    process.once("SIGTERM", bye);
  }
  if (args.agent) {
    const agentConfig = loadAgentConfig({ dataDir: catalog.dir });
    for (const note of agentConfig.notes) process.stderr.write(`floorplan-ai config: ${note}\n`);
    if (!agentConfig.model) {
      process.stderr.write(
        "floorplan-ai agent: no designer model; set roles.designer in config.json or FPV_AGENT_BASE_URL and FPV_AGENT_MODEL\n",
      );
      process.exitCode = 2;
    } else {
      const provider = openAICompatible(agentConfig.model);
      process.stderr.write(`floorplan-ai agent: ${provider.model} at ${agentConfig.model.baseUrl}\n`);
      const { run, transcriptPath } = await runAgentTask(session, provider, args.agent, {
        transcriptDir: join(catalog.dir, "transcripts"),
        ...(args.steps ? { maxSteps: args.steps } : {}),
        now,
        onEvent: (event) => {
          const line = describeEvent(event);
          if (line) process.stderr.write(`${line}\n`);
        },
      });
      if (transcriptPath) process.stderr.write(`floorplan-ai agent transcript: ${transcriptPath}\n`);
      process.stdout.write(
        `${run.text ?? `(no answer: ${run.reason}${run.error ? `, ${run.error}` : ""})`}\n`,
      );
      if (run.reason !== "done") process.exitCode = 1;
    }
    if (!args.serve) {
      files.stopAutosave();
      catalog.store.close();
    }
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

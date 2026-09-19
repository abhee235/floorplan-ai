// The in-app agent (ADR-007 D3, PRD P1-7): the provider named by roles.designer in <data>/config.json, or
// FPV_AGENT_BASE_URL and FPV_AGENT_MODEL (with FPV_AGENT_API_KEY, FPV_AGENT_EXTRA_BODY as JSON,
// FPV_AGENT_RELIABILITY high|medium|low, FPV_AGENT_TIMEOUT_MS). The runner calls the session's registry
// in-process; every event is appended to a JSONL transcript as it happens, so a crashed run keeps its record.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentEvent,
  type AgentRun,
  DESIGNER_SYSTEM,
  type Provider,
  type ProviderConfig,
  registryToolSpecs,
  runAgent,
  toolResultText,
} from "@fpv/agents";
import type { ToolReliability } from "@fpv/tools";
import type { Session } from "./session.js";
import { HostConfigFile } from "./verifier.js";

/** A tool-calling turn on a local model can take minutes. */
export const AGENT_TIMEOUT_MS = 300_000;

const reliabilityOf = (v: string | undefined): ToolReliability | undefined =>
  v === "high" || v === "medium" || v === "low" ? v : undefined;

export function loadAgentConfig(options: { dataDir: string; env?: NodeJS.ProcessEnv; file?: string }): {
  model: ProviderConfig | null;
  notes: string[];
} {
  const env = options.env ?? process.env;
  const notes: string[] = [];
  if (env.FPV_AGENT_BASE_URL && env.FPV_AGENT_MODEL) {
    let extraBody: Record<string, unknown> | undefined;
    if (env.FPV_AGENT_EXTRA_BODY) {
      try {
        extraBody = JSON.parse(env.FPV_AGENT_EXTRA_BODY) as Record<string, unknown>;
      } catch {
        notes.push("FPV_AGENT_EXTRA_BODY is not JSON and was ignored");
      }
    }
    const reliability = reliabilityOf(env.FPV_AGENT_RELIABILITY);
    if (env.FPV_AGENT_RELIABILITY && !reliability)
      notes.push("FPV_AGENT_RELIABILITY must be high, medium or low; medium is used");
    return {
      model: {
        id: "env-agent",
        baseUrl: env.FPV_AGENT_BASE_URL,
        model: env.FPV_AGENT_MODEL,
        apiKey: env.FPV_AGENT_API_KEY ?? null,
        profile: { toolCalls: true, toolReliability: reliability ?? "medium" },
        timeoutMs: Number(env.FPV_AGENT_TIMEOUT_MS) || AGENT_TIMEOUT_MS,
        ...(extraBody ? { extraBody } : {}),
      },
      notes,
    };
  }
  const path = options.file ?? join(options.dataDir, "config.json");
  if (!existsSync(path)) return { model: null, notes };
  const parsed = HostConfigFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) return { model: null, notes: [`${path} is not valid; the agent is off`] };
  const name = parsed.data.roles.designer;
  if (!name) return { model: null, notes };
  const entry = parsed.data.providers[name];
  if (!entry) return { model: null, notes: [`roles.designer names ${name}, which is not in providers`] };
  if (entry.profile?.toolCalls === false)
    notes.push(`roles.designer names ${name}, whose profile says it cannot call tools`);
  const apiKey = entry.apiKey ?? (entry.apiKeyEnv ? env[entry.apiKeyEnv] : undefined);
  return {
    model: {
      id: name,
      baseUrl: entry.baseUrl,
      model: entry.model,
      apiKey: apiKey ?? null,
      ...(entry.profile ? { profile: entry.profile as NonNullable<ProviderConfig["profile"]> } : {}),
      timeoutMs: entry.timeoutMs ?? AGENT_TIMEOUT_MS,
      ...(entry.extraBody ? { extraBody: entry.extraBody } : {}),
    },
    notes,
  };
}

export interface AgentTaskOptions {
  /** Directory for the JSONL transcript; null records nothing on disk. */
  transcriptDir?: string | null;
  maxSteps?: number;
  reliability?: ToolReliability;
  system?: string;
  signal?: AbortSignal;
  onEvent?(event: AgentEvent): void;
  now?(): string;
}

export interface AgentTaskResult {
  run: AgentRun;
  transcriptPath: string | null;
  reliability: ToolReliability;
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);

/** Run one task with the session's registry and record it (ADR-007 D3). */
export async function runAgentTask(
  session: Session,
  provider: Provider,
  task: string,
  options: AgentTaskOptions = {},
): Promise<AgentTaskResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const reliability = options.reliability ?? provider.profile.toolReliability;
  const tools = registryToolSpecs(session.registry, reliability);
  const system = options.system ?? DESIGNER_SYSTEM;
  let transcriptPath: string | null = null;
  const write = (record: unknown) => {
    if (transcriptPath)
      appendFileSync(transcriptPath, `${toolResultText(record, Number.POSITIVE_INFINITY)}\n`, "utf8");
  };
  if (options.transcriptDir) {
    mkdirSync(options.transcriptDir, { recursive: true });
    const stamp = now().replace(/[:.]/g, "-");
    transcriptPath = join(options.transcriptDir, `${stamp}-${slug(provider.model)}.jsonl`);
    write({
      type: "start",
      at: now(),
      provider: provider.id,
      model: provider.model,
      profile: provider.profile,
      reliability,
      task,
      system,
      tools: tools.map((t) => t.name),
      maxSteps: options.maxSteps ?? null,
    });
  }
  const run = await runAgent({
    provider,
    tools,
    system,
    task,
    callTool: (name, args) => session.registry.call(name, args),
    now,
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    onEvent: (event) => {
      write(event);
      options.onEvent?.(event);
    },
  });
  return { run, transcriptPath, reliability };
}

/** One line per event for a terminal. */
export function describeEvent(event: AgentEvent): string | null {
  switch (event.type) {
    case "reply":
      return `step ${event.step}: ${event.toolCalls.length ? event.toolCalls.map((c) => c.name).join(", ") : "answer"} (${Math.round(event.durationMs / 100) / 10} s, ${event.usage.promptTokens}+${event.usage.completionTokens} tokens)`;
    case "tool.finished":
      return event.ok
        ? null
        : `  ${event.name} failed: ${(event.result as { error?: { message?: string } }).error?.message ?? "?"}`;
    case "plan.updated":
      return `  plan: ${event.items.filter((i) => i.status === "done").length} of ${event.items.length} done`;
    case "question":
      return `  asking: ${event.request.question}`;
    case "reminder":
      return `  ${event.gate} gate: ${event.text.slice(0, 80)}`;
    case "warning":
      return `  warning: ${event.message}`;
    case "retry":
      return `  retry after ${event.waitMs} ms: ${event.error}`;
    case "done":
      return `done: ${event.reason} after ${event.steps} steps, ${event.toolCalls} tool calls (${event.failedCalls} failed), ${event.usage.promptTokens}+${event.usage.completionTokens} tokens${event.error ? `: ${event.error}` : ""}`;
    default:
      return null;
  }
}

// Runs task cards against models and records the scores (ADR-007 D5, PRD P1-8). Every run starts from a fresh
// session; each score is appended to docs/eval/agent-results.jsonl, its transcript goes to docs/eval/transcripts,
// and the table in docs/eval/agent-runs.md is rebuilt from all recorded scores.
//
// Usage:
//   corepack pnpm exec tsx tools/eval/run.ts --models ollama:qwen3.8:27b,ollama:qwen3.6:35b
//     [--cards boardroom,import-office] [--reliability low|medium|high] [--think] [--steps <n>]
// Models: ollama:<model> (http://127.0.0.1:11434/v1, reasoning switched off unless --think),
//         openai:<model> (OPENAI_API_KEY), openrouter:<model> (OPENROUTER_API_KEY),
//         config:<name> (a provider in the host data directory's config.json).
// Keys and the default model list (FPV_EVAL_MODELS) come from the nearest .env; see .env.example.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openAICompatible, type ProviderConfig, runArchitect } from "@fpv/agents";
import type { ToolReliability } from "@fpv/tools";
import { AGENT_TIMEOUT_MS, describeEvent, runAgentTask } from "../../apps/host/src/agent.js";
import { loadDotEnv } from "../../apps/host/src/env.js";
import { dataPaths } from "../../apps/host/src/paths.js";
import { HostConfigFile } from "../../apps/host/src/verifier.js";
import { type CardScore, loadCards, mergeRunsSection, renderRunsTable, scoreCard } from "./cards.js";
import { evalSession } from "./session.js";

const EVAL = fileURLToPath(new URL("../../docs/eval/", import.meta.url));
const RESULTS = join(EVAL, "agent-results.jsonl");
const TABLE = join(EVAL, "agent-runs.md");

const argValue = (flag: string) => {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const list = (v: string | undefined) =>
  v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

/**
 * How long one model call may take, from FPV_AGENT_TIMEOUT_MS or five minutes.
 *
 * The host has read this since the agent existed and the cards did not, which is how a local model
 * came to fail a card on a wall the host would not have hit: one turn of a reasoning model on a big
 * prompt takes longer than five minutes on consumer hardware, and the card had no way to say so.
 */
const timeoutMs = Number(process.env.FPV_AGENT_TIMEOUT_MS) || AGENT_TIMEOUT_MS;

function providerFor(spec: string, think: boolean, reliability: ToolReliability | undefined): ProviderConfig {
  const colon = spec.indexOf(":");
  const kind = colon < 0 ? "" : spec.slice(0, colon);
  const name = spec.slice(colon + 1);
  const profile = { toolCalls: true, toolReliability: reliability ?? ("medium" as ToolReliability) };
  switch (kind) {
    case "ollama":
      return {
        id: `ollama:${name}`,
        baseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1",
        model: name,
        profile,
        timeoutMs,
        ...(think ? {} : { extraBody: { reasoning_effort: "none" } }),
      };
    case "openai":
    case "openrouter": {
      const env = kind === "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY";
      const apiKey = process.env[env];
      if (!apiKey) throw new Error(`${spec} needs ${env}`);
      return {
        id: spec,
        baseUrl: kind === "openai" ? "https://api.openai.com/v1" : "https://openrouter.ai/api/v1",
        model: name,
        apiKey,
        profile: { ...profile, toolReliability: reliability ?? "high" },
        timeoutMs,
      };
    }
    case "config": {
      const file = join(dataPaths().dir, "config.json");
      const entry = HostConfigFile.parse(JSON.parse(readFileSync(file, "utf8"))).providers[name];
      if (!entry) throw new Error(`${file} has no provider named ${name}`);
      const apiKey = entry.apiKey ?? (entry.apiKeyEnv ? process.env[entry.apiKeyEnv] : undefined);
      return {
        id: `config:${name}`,
        baseUrl: entry.baseUrl,
        model: entry.model,
        apiKey: apiKey ?? null,
        profile: {
          ...profile,
          ...(Object.fromEntries(
            Object.entries(entry.profile ?? {}).filter(([, v]) => v !== undefined),
          ) as Partial<NonNullable<ProviderConfig["profile"]>>),
          ...(reliability ? { toolReliability: reliability } : {}),
        },
        timeoutMs: entry.timeoutMs ?? timeoutMs,
        ...(entry.extraBody ? { extraBody: entry.extraBody } : {}),
      };
    }
    default:
      throw new Error(`model "${spec}" must start with ollama:, openai:, openrouter: or config:`);
  }
}

/** A model server that does not answer is skipped, not scored: a connection failure says nothing about the model. */
async function unreachable(config: ProviderConfig): Promise<string | null> {
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function readScores(): CardScore[] {
  if (!existsSync(RESULTS)) return [];
  return readFileSync(RESULTS, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CardScore);
}

async function main() {
  const dotenv = loadDotEnv();
  for (const note of dotenv.notes) console.log(`env: ${note}`);
  const models = list(argValue("--models") ?? process.env.FPV_EVAL_MODELS);
  if (models.length === 0) {
    console.error(
      "usage: tools/eval/run.ts --models ollama:<model>[,...] [--cards <ids>] [--reliability low|medium|high] [--think] [--steps <n>]",
    );
    process.exit(2);
  }
  const rel = argValue("--reliability");
  const reliability = rel === "low" || rel === "medium" || rel === "high" ? rel : undefined;
  const think = process.argv.includes("--think");
  const stepsArg = Number(argValue("--steps"));
  const cards = loadCards(list(argValue("--cards")));
  mkdirSync(join(EVAL, "transcripts"), { recursive: true });
  for (const spec of models) {
    const config = providerFor(spec, think, reliability);
    const down = await unreachable(config);
    if (down) {
      console.log(`\nskipped ${spec}: ${config.baseUrl} does not answer (${down}); nothing recorded`);
      continue;
    }
    const provider = openAICompatible(config);
    for (const card of cards) {
      const { session, close } = evalSession();
      const at = new Date().toISOString();
      const started = Date.now();
      console.log(`\n${card.id} on ${spec} (${provider.profile.toolReliability})`);
      // The architect, so a card measures the path the product ships rather than the tools alone.
      // Without it design_layout answers "unavailable" and the model quietly does something else,
      // which would make the suite green about a road nobody travels (ADR-024 D6).
      session.ctx.subagent = {
        run: (request) =>
          runArchitect(provider, session.registry, request, {
            ...(reliability ? { reliability } : {}),
            onEvent: (event) => {
              const line = describeEvent(event);
              if (line) console.log(`  architect ${line}`);
            },
          }),
      };
      try {
        const {
          run,
          transcriptPath,
          reliability: used,
        } = await runAgentTask(session, provider, card.task, {
          transcriptDir: join(EVAL, "transcripts"),
          maxSteps: Number.isInteger(stepsArg) && stepsArg > 0 ? stepsArg : card.maxSteps,
          onEvent: (event) => {
            const line = describeEvent(event);
            if (line) console.log(line);
          },
        });
        const score = scoreCard(card, session, run, {
          model: config.model,
          provider: config.id,
          reliability: used,
          at,
          seconds: (Date.now() - started) / 1000,
          transcript: transcriptPath ? transcriptPath.slice(EVAL.length).replaceAll("\\", "/") : null,
        });
        if (run.reason === "provider-error" && run.usage.promptTokens === 0) {
          console.log(`not recorded: the provider failed before the model answered (${run.error})`);
          continue;
        }
        appendFileSync(RESULTS, `${JSON.stringify(score)}\n`, "utf8");
        console.log(
          `${score.pass ? "PASS" : "FAIL"}: ${score.missing.length ? `missing ${score.missing.join("; ")}` : "nothing missing"}, ${score.validationErrors} validation errors`,
        );
        if (run.text) console.log(`answer: ${run.text.slice(0, 400)}`);
        if (provider.adaptations?.length)
          console.log(`provider adapted its requests: ${provider.adaptations.join("; ")}`);
      } finally {
        close();
      }
    }
  }
  const table = renderRunsTable(readScores());
  const current = existsSync(TABLE) ? readFileSync(TABLE, "utf8") : "# Agent evaluation (PRD P1-8)\n";
  writeFileSync(TABLE, mergeRunsSection(current, table), "utf8");
  console.log(`\n${table}`);
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("tools/eval/run.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  });
}

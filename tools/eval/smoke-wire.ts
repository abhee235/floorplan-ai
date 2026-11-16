// A live check of one provider through the real loop: two turns, one tool call, reasoning on.
// Usage: tsx tools/eval/smoke-wire.ts <provider> <model> [reasoning]
//   e.g. tsx tools/eval/smoke-wire.ts openai gpt-6-luna medium
// Reads keys from .env like the host does. Costs a fraction of a cent on a hosted model.
import { createProvider, runAgent } from "@fpv/agents";
import { loadDotEnv, PROVIDERS } from "../../apps/host/src/env.js";

loadDotEnv();
const [name = "openai", model = "gpt-6-luna", reasoning] = process.argv.slice(2);
const defaults = PROVIDERS[name];
if (!defaults) throw new Error(`unknown provider ${name}`);
const apiKey = defaults.keyVar ? process.env[defaults.keyVar] : undefined;
if (defaults.keyVar && !apiKey) throw new Error(`${defaults.keyVar} is not set`);
const provider = createProvider({
  id: name,
  baseUrl: defaults.baseUrl(process.env),
  model,
  apiKey: apiKey ?? null,
  ...(reasoning ? { reasoning: reasoning as "none" | "low" | "medium" | "high" } : {}),
  profile: { toolReliability: "high" },
  timeoutMs: 120_000,
});
const started = Date.now();
const run = await runAgent({
  provider,
  tools: [
    {
      name: "add",
      description: "Add two numbers and return the sum.",
      parameters: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    },
  ],
  callTool: async (_tool, args) => {
    const { a, b } = args as { a: number; b: number };
    return { ok: true, result: { sum: a + b }, warnings: [] };
  },
  system: "You are terse. Use the add tool for any addition.",
  task: "Work out 17*23 and 19*29 yourself, then use the tool to add the two products. Reply with the sum only.",
  gates: { plan: false, verify: false, idle: false },
  maxSteps: 6,
});
const kept = run.messages
  .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
  .filter((b) => b.type === "reasoning");
console.log(
  JSON.stringify(
    {
      wire: provider.adaptations,
      reason: run.reason,
      answer: run.text,
      steps: run.steps,
      toolCalls: run.toolCalls,
      reasoningBlocksKept: kept.length,
      usage: run.usage,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      error: run.error,
    },
    null,
    2,
  ),
);

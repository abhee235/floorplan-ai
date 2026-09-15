// The .env file (ADR-007 D1 configuration): model providers, keys and roles in one place. The host, the evaluation
// harness and the scoring scripts load it at start. Values already in the environment win; empty values count as
// unset. FPV_<ROLE>_PROVIDER picks a provider by name for the agent, the plan reader or the product verifier,
// and fills in the FPV_<ROLE>_BASE_URL, FPV_<ROLE>_API_KEY and (for Ollama) FPV_<ROLE>_EXTRA_BODY variables the
// role loaders read, so a role is configured with a provider name and a model name.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";

export const MODEL_ROLES = ["AGENT", "READER", "VERIFIER"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

interface ProviderDefaults {
  baseUrl(env: NodeJS.ProcessEnv): string;
  /** The variable holding the API key; null when the provider needs none. */
  keyVar: string | null;
  /** Request fields sent unless FPV_<ROLE>_EXTRA_BODY says otherwise. */
  extraBody: Record<string, unknown> | null;
}

export const PROVIDERS: Readonly<Record<string, ProviderDefaults>> = {
  ollama: {
    baseUrl: (env) => env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1",
    keyVar: null,
    // Qwen models on Ollama think before every answer unless told not to; tool turns are far faster without
    extraBody: { reasoning_effort: "none" },
  },
  openai: {
    baseUrl: (env) => env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    keyVar: "OPENAI_API_KEY",
    extraBody: null,
  },
  openrouter: {
    baseUrl: (env) => env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    keyVar: "OPENROUTER_API_KEY",
    extraBody: null,
  },
};

/** FPV_ENV_FILE when set, else the first .env found from `start` up to the filesystem root. */
export function findEnvFile(
  start: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.FPV_ENV_FILE) return existsSync(env.FPV_ENV_FILE) ? resolve(env.FPV_ENV_FILE) : null;
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface DotEnvResult {
  /** The file read, or null when there is none. */
  file: string | null;
  /** Names set from the file (values are never reported). */
  applied: string[];
  notes: string[];
}

/** Load a .env file into `env` without overriding what is set, then expand provider shortcuts. */
export function loadDotEnv(
  options: { file?: string | null; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): DotEnvResult {
  const env = options.env ?? process.env;
  const notes: string[] = [];
  const applied: string[] = [];
  const file = options.file === undefined ? findEnvFile(options.cwd, env) : options.file;
  if (file) {
    let parsed: NodeJS.Dict<string> = {};
    try {
      parsed = parseEnv(readFileSync(file, "utf8"));
    } catch (e) {
      notes.push(`${file} could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const [name, value] of Object.entries(parsed)) {
      if (value === undefined || value === "") continue;
      if (env[name] !== undefined && env[name] !== "") continue;
      env[name] = value;
      applied.push(name);
    }
  }
  notes.push(...expandProviderShortcuts(env));
  return { file, applied, notes };
}

/** FPV_<ROLE>_PROVIDER to base URL, key and extra body variables; returns notes about missing pieces. */
export function expandProviderShortcuts(env: NodeJS.ProcessEnv): string[] {
  const notes: string[] = [];
  const unset = (name: string) => env[name] === undefined || env[name] === "";
  for (const role of MODEL_ROLES) {
    const name = env[`FPV_${role}_PROVIDER`];
    if (!name) continue;
    const provider = PROVIDERS[name.toLowerCase()];
    if (!provider) {
      notes.push(`FPV_${role}_PROVIDER is ${name}; use ${Object.keys(PROVIDERS).join(", ")}`);
      continue;
    }
    if (unset(`FPV_${role}_MODEL`)) {
      notes.push(
        `FPV_${role}_PROVIDER is ${name} but FPV_${role}_MODEL is empty, so the ${role.toLowerCase()} model is off`,
      );
      continue;
    }
    if (unset(`FPV_${role}_BASE_URL`)) env[`FPV_${role}_BASE_URL`] = provider.baseUrl(env);
    if (provider.keyVar && unset(`FPV_${role}_API_KEY`)) {
      const key = env[provider.keyVar];
      if (key) env[`FPV_${role}_API_KEY`] = key;
      else notes.push(`FPV_${role}_PROVIDER is ${name} but ${provider.keyVar} is empty`);
    }
    if (provider.extraBody && unset(`FPV_${role}_EXTRA_BODY`))
      env[`FPV_${role}_EXTRA_BODY`] = JSON.stringify(provider.extraBody);
  }
  return notes;
}

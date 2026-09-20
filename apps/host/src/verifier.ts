// Host configuration for product verification (ADR-007 D1, ADR-008 D3) and the verifier built from it.
// Everything runs inside the host process: the search provider and the model are remote HTTP APIs the
// installation already chose, never a sidecar. Without them, verify_product still works from sources
// and a proposal the calling agent supplies, which is how Claude Code drives it during development.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openAICompatible, type ProviderConfig, verifierExtractor } from "@fpv/agents";
import {
  braveSearch,
  type PageFetcher,
  type ProposalExtractor,
  type SearchProvider,
  searxngSearch,
  type VerifyStore,
  verifyProduct,
} from "@fpv/catalog";
import { httpPageFetcher } from "@fpv/catalog/store";
import type { ProductVerifier } from "@fpv/tools";
import { z } from "zod";

const ProviderEntry = z.object({
  baseUrl: z.string().url(),
  model: z.string().min(1),
  apiKey: z.string().optional(),
  /** Name of an environment variable holding the key, so config.json never has to contain it. */
  apiKeyEnv: z.string().optional(),
  profile: z
    .object({
      vision: z.boolean(),
      toolCalls: z.boolean(),
      toolReliability: z.enum(["high", "medium", "low"]),
      contextTokens: z.number().int().positive(),
      jsonMode: z.boolean(),
    })
    .partial()
    .optional(),
  timeoutMs: z.number().int().positive().optional(),
  /** A cap on one reply's length, so a model that thinks forever does not outlast the timeout. */
  maxTokens: z.number().int().positive().optional(),
  extraBody: z.record(z.unknown()).optional(),
});

const SearchEntry = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("brave"), apiKey: z.string().optional(), apiKeyEnv: z.string().optional() }),
  z.object({ kind: z.literal("searxng"), baseUrl: z.string().url() }),
]);

export const HostConfigFile = z.object({
  providers: z.record(ProviderEntry).default({}),
  roles: z
    .object({
      verifier: z.string().optional(),
      designer: z.string().optional(),
      reader: z.string().optional(),
    })
    .default({}),
  search: SearchEntry.nullable().default(null),
  verifier: z
    .object({
      allowPrivatePages: z.boolean().default(false),
      maxPages: z.number().int().min(1).max(5).default(3),
    })
    .default({}),
});
export type HostConfigFile = z.infer<typeof HostConfigFile>;

export type SearchConfig = { kind: "brave"; apiKey: string } | { kind: "searxng"; baseUrl: string };

export interface VerifierConfig {
  search: SearchConfig | null;
  model: ProviderConfig | null;
  allowPrivatePages: boolean;
  maxPages: number;
}

export interface LoadedConfig {
  config: VerifierConfig;
  /** The config file read, or null when there is none. */
  file: string | null;
  notes: string[];
}

/**
 * `<data>/config.json` first, then environment variables on top:
 * FPV_SEARCH (brave | searxng), FPV_SEARCH_URL, FPV_SEARCH_API_KEY or BRAVE_SEARCH_API_KEY;
 * FPV_VERIFIER_BASE_URL, FPV_VERIFIER_MODEL, FPV_VERIFIER_API_KEY.
 */
export function loadHostConfig(options: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  file?: string;
}): LoadedConfig {
  const env = options.env ?? process.env;
  const notes: string[] = [];
  const path = options.file ?? join(options.dataDir, "config.json");
  let parsed: HostConfigFile = HostConfigFile.parse({});
  let file: string | null = null;
  if (existsSync(path)) {
    const result = HostConfigFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!result.success)
      throw new Error(
        `${path}: ${result.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ")}`,
      );
    parsed = result.data;
    file = path;
  }
  const keyOf = (entry: { apiKey?: string | undefined; apiKeyEnv?: string | undefined }) =>
    entry.apiKey ?? (entry.apiKeyEnv ? env[entry.apiKeyEnv] : undefined);

  let search: SearchConfig | null = null;
  const kind = env.FPV_SEARCH ?? parsed.search?.kind;
  if (kind === "brave") {
    const apiKey =
      env.FPV_SEARCH_API_KEY ??
      env.BRAVE_SEARCH_API_KEY ??
      (parsed.search?.kind === "brave" ? keyOf(parsed.search) : undefined);
    if (apiKey) search = { kind: "brave", apiKey };
    else notes.push("search is brave but no API key is set (FPV_SEARCH_API_KEY)");
  } else if (kind === "searxng") {
    const baseUrl =
      env.FPV_SEARCH_URL ?? (parsed.search?.kind === "searxng" ? parsed.search.baseUrl : undefined);
    if (baseUrl) search = { kind: "searxng", baseUrl };
    else notes.push("search is searxng but no URL is set (FPV_SEARCH_URL)");
  } else if (kind) notes.push(`unknown search provider ${kind}; use brave or searxng`);

  let model: ProviderConfig | null = null;
  if (env.FPV_VERIFIER_BASE_URL && env.FPV_VERIFIER_MODEL) {
    model = {
      id: "env-verifier",
      baseUrl: env.FPV_VERIFIER_BASE_URL,
      model: env.FPV_VERIFIER_MODEL,
      apiKey: env.FPV_VERIFIER_API_KEY ?? null,
    };
  } else if (parsed.roles.verifier) {
    const name = parsed.roles.verifier;
    const entry = parsed.providers[name];
    if (!entry) notes.push(`roles.verifier names ${name}, which is not in providers`);
    else
      model = {
        id: name,
        baseUrl: entry.baseUrl,
        model: entry.model,
        apiKey: keyOf(entry) ?? null,
        ...(entry.profile ? { profile: entry.profile as NonNullable<ProviderConfig["profile"]> } : {}),
        ...(entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : {}),
        ...(entry.extraBody ? { extraBody: entry.extraBody } : {}),
      };
  }
  return {
    config: {
      search,
      model,
      allowPrivatePages: parsed.verifier.allowPrivatePages,
      maxPages: parsed.verifier.maxPages,
    },
    file,
    notes,
  };
}

export interface VerifierParts {
  now: () => string;
  search?: SearchProvider | null;
  fetcher?: PageFetcher;
  extractor?: ProposalExtractor | null;
}

/** The verifier for a session, and one line describing what it can do. */
export function createVerifier(
  store: VerifyStore,
  config: VerifierConfig,
  parts: VerifierParts,
): { verifier: ProductVerifier; describe: string } {
  const search =
    parts.search !== undefined
      ? parts.search
      : config.search?.kind === "brave"
        ? braveSearch({ apiKey: config.search.apiKey })
        : config.search?.kind === "searxng"
          ? searxngSearch({ baseUrl: config.search.baseUrl })
          : null;
  const extractor =
    parts.extractor !== undefined
      ? parts.extractor
      : config.model
        ? verifierExtractor(openAICompatible(config.model))
        : null;
  const fetcher = parts.fetcher ?? httpPageFetcher({ allowPrivate: config.allowPrivatePages });
  const verifier: ProductVerifier = {
    verify: (req) =>
      verifyProduct(
        {
          store,
          search,
          fetcher,
          extractor,
          now: parts.now,
          newRunId: () => `vrun_${randomUUID()}`,
          maxPages: config.maxPages,
        },
        req,
      ),
  };
  const describe = [
    search ? `search ${search.id}` : "no search provider (callers pass sources)",
    extractor ? `model ${extractor.id}` : "no verifier model (callers pass a proposal)",
  ].join(", ");
  return { verifier, describe };
}

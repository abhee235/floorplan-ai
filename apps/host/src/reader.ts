// The Plan Reader model for raster plans (ADR-007 D1, ADR-011 D2): the provider named by roles.reader in
// <data>/config.json, or FPV_READER_BASE_URL and FPV_READER_MODEL (with FPV_READER_API_KEY,
// FPV_READER_EXTRA_BODY as JSON, FPV_READER_TIMEOUT_MS). Remote or local HTTP only; never a sidecar.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type PlanReaderRole, type ProviderConfig, planReader, providerFor } from "@fpv/agents";
import { HostConfigFile } from "./verifier.js";

/** Local vision models take minutes on a laptop CPU; the default leaves room for that. */
export const READER_TIMEOUT_MS = 600_000;

export function loadReaderConfig(options: { dataDir: string; env?: NodeJS.ProcessEnv; file?: string }): {
  model: ProviderConfig | null;
  notes: string[];
} {
  const env = options.env ?? process.env;
  const notes: string[] = [];
  if (env.FPV_READER_BASE_URL && env.FPV_READER_MODEL) {
    let extraBody: Record<string, unknown> | undefined;
    if (env.FPV_READER_EXTRA_BODY) {
      try {
        extraBody = JSON.parse(env.FPV_READER_EXTRA_BODY) as Record<string, unknown>;
      } catch {
        notes.push("FPV_READER_EXTRA_BODY is not JSON and was ignored");
      }
    }
    return {
      model: {
        id: "env-reader",
        baseUrl: env.FPV_READER_BASE_URL,
        model: env.FPV_READER_MODEL,
        apiKey: env.FPV_READER_API_KEY ?? null,
        profile: {
          vision: true,
          ...(Number(env.FPV_READER_CONTEXT_TOKENS) > 0
            ? { contextTokens: Number(env.FPV_READER_CONTEXT_TOKENS) }
            : {}),
        },
        timeoutMs: Number(env.FPV_READER_TIMEOUT_MS) || READER_TIMEOUT_MS,
        ...(extraBody ? { extraBody } : {}),
      },
      notes,
    };
  }
  const path = options.file ?? join(options.dataDir, "config.json");
  if (!existsSync(path)) return { model: null, notes };
  const parsed = HostConfigFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) return { model: null, notes: [`${path} is not valid; the reader is off`] };
  const name = parsed.data.roles.reader;
  if (!name) return { model: null, notes };
  const entry = parsed.data.providers[name];
  if (!entry) return { model: null, notes: [`roles.reader names ${name}, which is not in providers`] };
  if (entry.profile?.vision === false)
    notes.push(`roles.reader names ${name}, whose profile says it cannot read images`);
  const apiKey = entry.apiKey ?? (entry.apiKeyEnv ? env[entry.apiKeyEnv] : undefined);
  return {
    model: {
      id: name,
      baseUrl: entry.baseUrl,
      model: entry.model,
      apiKey: apiKey ?? null,
      profile: {
        ...(entry.profile as NonNullable<ProviderConfig["profile"]> | undefined),
        vision: entry.profile?.vision ?? true,
      },
      timeoutMs: entry.timeoutMs ?? READER_TIMEOUT_MS,
      ...(entry.extraBody ? { extraBody: entry.extraBody } : {}),
    },
    notes,
  };
}

export function createReader(model: ProviderConfig | null): {
  reader: PlanReaderRole | null;
  describe: string;
} {
  if (!model) return { reader: null, describe: "no reader model (image plans are refused; DXF plans work)" };
  return {
    reader: planReader(providerFor(model)),
    describe: `${model.model} at ${model.baseUrl}${model.profile?.vision === false ? " (not marked as vision)" : ""}`,
  };
}

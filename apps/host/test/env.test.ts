// The .env file: loaded without overriding the environment, empty values ignored, and FPV_<ROLE>_PROVIDER expanded
// into the base URL, key and extra body variables the role loaders read.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentConfig } from "../src/agent.js";
import { expandProviderShortcuts, findEnvFile, loadDotEnv } from "../src/env.js";
import { loadReaderConfig } from "../src/reader.js";

function envFile(text: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "fpv-env-"));
  const file = join(dir, ".env");
  writeFileSync(file, text);
  return { dir, file };
}

describe(".env configuration", () => {
  it("loads values that are not already set, skips empty ones, and never reports values", () => {
    const { file } = envFile(
      '# models\nFPV_AGENT_MODEL=qwen3.8:27b\nOPENAI_API_KEY=\nFPV_DATA_DIR="C:/data dir"\nKEEP=from-file\n',
    );
    const env: NodeJS.ProcessEnv = { KEEP: "from-shell" };
    const result = loadDotEnv({ file, env });
    expect(result.file).toBe(file);
    expect(result.applied.sort()).toEqual(["FPV_AGENT_MODEL", "FPV_DATA_DIR"]);
    expect(env).toMatchObject({
      FPV_AGENT_MODEL: "qwen3.8:27b",
      FPV_DATA_DIR: "C:/data dir",
      KEEP: "from-shell",
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("finds the nearest .env walking up, or FPV_ENV_FILE", () => {
    const { dir, file } = envFile("A=1\n");
    const deep = join(dir, "apps", "host");
    mkdirSync(deep, { recursive: true });
    expect(findEnvFile(deep, {})).toBe(file);
    expect(findEnvFile(deep, { FPV_ENV_FILE: file })).toBe(file);
    expect(findEnvFile(deep, { FPV_ENV_FILE: join(dir, "missing.env") })).toBeNull();
  });

  it("a provider name and a model configure a role; missing keys and models are reported", () => {
    const env: NodeJS.ProcessEnv = {
      FPV_AGENT_PROVIDER: "openai",
      FPV_AGENT_MODEL: "gpt-4.1-mini",
      OPENAI_API_KEY: "sk-test",
      FPV_READER_PROVIDER: "ollama",
      FPV_READER_MODEL: "qwen3.8:27b",
      FPV_VERIFIER_PROVIDER: "openrouter",
      FPV_VERIFIER_MODEL: "openai/gpt-4.1-mini",
    };
    const notes = expandProviderShortcuts(env);
    expect(env).toMatchObject({
      FPV_AGENT_BASE_URL: "https://api.openai.com/v1",
      FPV_AGENT_API_KEY: "sk-test",
      FPV_READER_BASE_URL: "http://127.0.0.1:11434/v1",
      FPV_READER_EXTRA_BODY: '{"reasoning_effort":"none"}',
      FPV_VERIFIER_BASE_URL: "https://openrouter.ai/api/v1",
    });
    expect(env.FPV_AGENT_EXTRA_BODY).toBeUndefined();
    expect(notes).toEqual(["FPV_VERIFIER_PROVIDER is openrouter but OPENROUTER_API_KEY is empty"]);
    expect(expandProviderShortcuts({ FPV_AGENT_PROVIDER: "ollama" })).toEqual([
      "FPV_AGENT_PROVIDER is ollama but FPV_AGENT_MODEL is empty, so the agent model is off",
    ]);
    expect(expandProviderShortcuts({ FPV_READER_PROVIDER: "gemini", FPV_READER_MODEL: "x" })[0]).toContain(
      "use ollama, openai, openrouter",
    );

    const agent = loadAgentConfig({ dataDir: tmpdir(), env });
    expect(agent.model).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      apiKey: "sk-test",
    });
    const reader = loadReaderConfig({ dataDir: tmpdir(), env });
    expect(reader.model).toMatchObject({ model: "qwen3.8:27b", extraBody: { reasoning_effort: "none" } });
  });

  it("explicit base URLs and extra bodies win over the provider defaults", () => {
    const env: NodeJS.ProcessEnv = {
      FPV_AGENT_PROVIDER: "ollama",
      FPV_AGENT_MODEL: "qwen3.5:9b",
      FPV_AGENT_BASE_URL: "http://gpu-box:11434/v1",
      FPV_AGENT_EXTRA_BODY: "{}",
    };
    expect(expandProviderShortcuts(env)).toEqual([]);
    expect(env).toMatchObject({ FPV_AGENT_BASE_URL: "http://gpu-box:11434/v1", FPV_AGENT_EXTRA_BODY: "{}" });
  });
});

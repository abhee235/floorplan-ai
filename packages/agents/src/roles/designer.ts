// The Space Designer role (ADR-007 D3): the workflow prompt, the registry's tools for the provider's reliability
// profile (ADR-006 D6) as JSON Schema, and the runner calling the registry in-process.
import { type Registry, type ToolReliability, WORKFLOW_PROMPT } from "@fpv/tools";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Provider, ToolSpec } from "../provider.js";
import { type AgentOptions, type AgentRun, runAgent } from "../runner.js";

export const DESIGNER_SYSTEM = [
  WORKFLOW_PROMPT,
  "You are the Space Designer: you change the project only through the tools, and every length is in millimetres.",
  "Each tool returns a JSON envelope. When ok is false, read error.message and error.hint and correct the call; never repeat a failing call unchanged.",
  "Tools that need a service this session lacks (a viewer for render, a search provider for verify_product) say so; skip them and carry on.",
  "When the task is done, reply in plain text without calling a tool: what you built, any validation problems left, and any unverified bill of materials lines.",
].join("\n\n");

/** The registry's advertised tools for a reliability profile, as OpenAI function parameters. */
export function registryToolSpecs(registry: Registry, profile: ToolReliability): ToolSpec[] {
  return registry.advertised(profile).map((def) => {
    const schema = zodToJsonSchema(def.input, { $refStrategy: "none", target: "jsonSchema7" }) as Record<
      string,
      unknown
    >;
    delete schema.$schema;
    // unknown keys are reported as warnings by the registry rather than rejected (spec 04 section 1)
    delete schema.additionalProperties;
    return { name: def.name, description: def.description, parameters: schema };
  });
}

export type DesignerOptions = Omit<AgentOptions, "provider" | "tools" | "callTool" | "system" | "task"> & {
  /** Overrides the provider profile's reliability for which tools are advertised. */
  reliability?: ToolReliability;
  system?: string;
};

/** Run one design task against a session's registry. */
export function runDesigner(
  provider: Provider,
  registry: Registry,
  task: string,
  options: DesignerOptions = {},
): Promise<AgentRun> {
  const { reliability, system, ...rest } = options;
  return runAgent({
    ...rest,
    provider,
    tools: registryToolSpecs(registry, reliability ?? provider.profile.toolReliability),
    callTool: (name, args) => registry.call(name, args),
    system: system ?? DESIGNER_SYSTEM,
    task,
  });
}

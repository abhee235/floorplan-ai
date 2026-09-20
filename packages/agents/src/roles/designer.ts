// The Space Designer role (ADR-007 D3): the system prompt, the registry's tools for the provider's
// reliability profile (ADR-006 D6) as JSON Schema, and the runner calling the registry in-process.
import type { Registry, ToolReliability } from "@fpv/tools";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Provider, ToolSpec } from "../provider.js";
import { type AgentOptions, type AgentRun, runAgent } from "../runner.js";
import {
  asking,
  checking,
  choosing,
  designing,
  dwellings,
  envelope,
  IDENTITY,
  join,
  order,
  reporting,
  theModel,
  type WorldOptions,
  workplaces,
} from "./sections.js";

export type { WorldOptions } from "./sections.js";

/**
 * The prompt for one session's world.
 *
 * The first version of this was eight lines long and described an office. It produced, from "a three
 * bedroom apartment with hall and lobby", three 8 m² bedrooms, no kitchen, no bathroom, and
 * twenty-four walls around nothing -- not because the model was weak but because nothing had told it
 * how big a bedroom is, that a hall is a living room, or that a plan is designed before it is drawn.
 * Most of what is below is that missing knowledge.
 */
export function designerSystem(world: WorldOptions = {}): string {
  return join([
    IDENTITY,
    theModel(),
    envelope(world),
    order(world),
    designing(),
    dwellings(),
    workplaces(),
    choosing(world),
    checking(world),
    asking(world),
    reporting(),
  ]);
}

/** The prompt with nothing connected: the one MCP advertises and the tests pin. */
export const DESIGNER_SYSTEM = designerSystem({ rules: true, viewer: true, vision: true });

/**
 * The registry's advertised tools for a reliability profile, as OpenAI function parameters.
 *
 * `granted` narrows the list further, for a role that may only use some of them (ADR-022 D1a). It
 * is not only a matter of obedience: the schemas are re-sent on every step, and they were 78 per
 * cent of a measured nine-room run, so a role carrying six tools costs a seventh of what one
 * carrying thirty-one costs, every step.
 */
export function registryToolSpecs(
  registry: Registry,
  profile: ToolReliability,
  granted?: ReadonlySet<string>,
): ToolSpec[] {
  return registry
    .advertised(profile)
    .filter((def) => !granted || granted.has(def.name))
    .map((def) => {
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
  /** What this session has, for the prompt; ignored when `system` is given. */
  world?: WorldOptions;
};

/** Run one design task against a session's registry. */
export function runDesigner(
  provider: Provider,
  registry: Registry,
  task: string,
  options: DesignerOptions = {},
): Promise<AgentRun> {
  const { reliability, system, world, ...rest } = options;
  const profile = reliability ?? provider.profile.toolReliability;
  return runAgent({
    ...rest,
    provider,
    tools: registryToolSpecs(registry, profile),
    callTool: (name, args, released) => registry.call(name, args, { released }),
    system:
      system ?? designerSystem({ vision: provider.profile.vision, low: profile === "low", ...(world ?? {}) }),
    task,
  });
}

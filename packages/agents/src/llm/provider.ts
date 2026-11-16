// The provider-neutral seam (ADR-029 D2). The runner, the roles and the host depend on this file and on
// messages.ts, never on an adapter; `factory.ts` is the only place that knows which adapters exist.

import type { Message, ReasoningBlock } from "./messages.js";
import type { StreamEvent } from "./sse.js";

export interface ProviderProfile {
  vision: boolean;
  toolCalls: boolean;
  toolReliability: "high" | "medium" | "low";
  contextTokens: number;
  /** Ask for the wire's JSON mode; never relied upon (ADR-007 D2). */
  jsonMode: boolean;
  /**
   * Whether replies may be streamed. Optional, and absent means yes: a profile written before there
   * was any streaming means "stream if you can", not "never". A server that cannot, or a run that
   * wants one whole answer, sets it false and the loop asks for a complete reply instead.
   */
  streaming?: boolean;
}

export const DEFAULT_PROFILE: ProviderProfile = {
  vision: false,
  toolCalls: true,
  toolReliability: "medium",
  contextTokens: 32_000,
  jsonMode: false,
  streaming: true,
};

/** A call as the loop works with it: the arguments are the text the model wrote. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  system?: string;
  messages: Message[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  signal?: AbortSignal;
}

export interface Usage {
  /** The whole prompt, cached or not. */
  promptTokens: number;
  completionTokens: number;
  /** The part of the prompt read from the server's cache, when the wire says. */
  cacheReadTokens?: number;
  /** The part of the prompt written to the server's cache, when the wire says. */
  cacheWriteTokens?: number;
}

export interface Completion {
  text: string | null;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage;
  /**
   * Reasoning to keep with the reply and send back on the next request, for a wire that carries it
   * across turns (ADR-029 D1). The loop stores it on the assistant message and never reads it.
   */
  reasoning?: ReasoningBlock[];
  /**
   * Earlier thinking the server left out of this request because the conversation before it changed
   * since it was written (Claude's preserved thinking). Absent is none.
   */
  thinkingDropped?: number;
  raw: unknown;
}

export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  readonly profile: ProviderProfile;
  /** Which wire it speaks, once known: decides the context economics (ADR-031 D3). */
  readonly wire?: WireApi | undefined;
  /** Things the provider learnt or decided about its server, in words, e.g. which wire it chose. */
  readonly adaptations?: readonly string[];
  /**
   * Settle anything that has to be asked of the server before the profile can be trusted.
   *
   * On Ollama this asks the model what context it was built with, so until it has happened
   * `profile.contextTokens` is still the default. A caller that budgets against the profile has to
   * wait for this, and one that does not can ignore it.
   */
  ready?(): Promise<void>;
  complete(req: CompletionRequest): Promise<Completion>;
  /**
   * The same request, answered in pieces as the model produces them (ADR-022).
   *
   * Optional so a provider written for something else still satisfies this interface; the loop falls
   * back to `complete` when it is missing or when the profile says not to stream.
   */
  stream?(req: CompletionRequest): AsyncIterable<StreamEvent>;
}

/** The name the rest of the code has always used for a ModelProvider. */
export type Provider = ModelProvider;

/** The wires there are adapters for (ADR-029 D2). */
export type WireApi = "openai-chat" | "openai-responses" | "anthropic" | "ollama";

/** How hard a model is asked to think, said once and translated by each adapter (ADR-029 D4). */
export type ReasoningEffort = "none" | "low" | "medium" | "high";

export interface ProviderConfig {
  /** A label for logs and errors: the provider's name ("openai", "anthropic") or a configured name. */
  id: string;
  /** e.g. https://api.openai.com/v1, https://openrouter.ai/api/v1, http://127.0.0.1:11434/v1 */
  baseUrl: string;
  apiKey?: string | null;
  model: string;
  /**
   * Which wire to speak. Absent, the factory decides from the provider's name, and an address with no
   * name it recognises is asked whether it is Ollama (ADR-029 D2).
   */
  api?: WireApi;
  /** Absent means the vendor's own default. */
  reasoning?: ReasoningEffort;
  profile?: Partial<ProviderProfile>;
  timeoutMs?: number;
  /**
   * A cap on what one reply may generate, when the caller has not named one.
   *
   * The reason is the clock, not the bill. A reasoning model left to itself will think for as long
   * as it likes, and on local hardware one turn can outlast the request timeout, which ends the run
   * with nothing to show. A cap turns that into a short reply the loop can carry on from. It is sent
   * as the wire's own field, so the quirk that renames it is honoured.
   */
  maxTokens?: number;
  /**
   * The sampling temperature when a request does not name one. Absent is 0, greedy, which is
   * reproducible and what every eval here was measured at. Qwen's own guidance is 0.7 with thinking
   * off: greedy decoding, it says, degrades output and can repeat without end, and a live architect
   * did exactly that -- one design, word for word, six times. Wires whose models refuse a
   * temperature (Responses, Claude) leave it out.
   */
  temperature?: number;
  /** Extra top-level request fields a server understands, sent as they are on the compatible wire. */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | null,
    message: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = "ProviderError";
  }
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The reasoning a configuration asks for: the explicit setting, else an old-style
 * `reasoning_effort` in the extra body, so an existing `.env` keeps meaning what it meant (ADR-029 D4).
 */
export function reasoningOf(config: ProviderConfig): ReasoningEffort | undefined {
  if (config.reasoning) return config.reasoning;
  const old = config.extraBody?.reasoning_effort;
  return old === "none" || old === "low" || old === "medium" || old === "high" ? old : undefined;
}

/**
 * The extra body without the compatible wire's reasoning field, for a wire that says reasoning its
 * own way (ADR-029 D4). An `.env` written for chat completions sets `reasoning_effort` there; that
 * setting is read by `reasoningOf` and translated, and the field itself would be refused.
 */
export function extraBodyOf(config: ProviderConfig): Record<string, unknown> {
  const { reasoning_effort: _translated, ...rest } = config.extraBody ?? {};
  return rest;
}

/**
 * One request's timeout joined to the caller's abort, and a way to tell which fired.
 *
 * A reply that outlasts the timeout is not a broken server: it is a model still writing. Said as a
 * timeout, with the seconds, so the loop asks for a shorter reply instead of ending the run on what
 * reads as an unknown network fault (ADR-028 D11).
 */
export function requestSignal(
  config: ProviderConfig,
  req: CompletionRequest,
): { signal: AbortSignal; failure(e: unknown): ProviderError } {
  const ms = config.timeoutMs ?? 120_000;
  const timer = AbortSignal.timeout(ms);
  const signal = req.signal ? AbortSignal.any([req.signal, timer]) : timer;
  return {
    signal,
    failure(e) {
      const timedOut = timer.aborted && !req.signal?.aborted;
      return new ProviderError(
        config.id,
        null,
        timedOut
          ? `the request timed out after ${Math.round(ms / 1000)}s while the model was still writing`
          : e instanceof Error
            ? e.message
            : String(e),
      );
    },
  };
}

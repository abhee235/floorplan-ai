// Which wire an address speaks (ADR-007 D1, amended 2026-09-20).
//
// Its own file because the alternative is provider.ts and ollama.ts importing each other, and a
// cycle between two modules that both export runtime values is a thing that works until the day the
// bundler changes its mind about evaluation order.

import { looksLikeOllama, ollamaNative, probeModel } from "./ollama.js";
import { openAICompatible, type Provider, type ProviderConfig, ProviderError } from "./provider.js";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * A provider for an address, on whichever wire that address actually speaks.
 *
 * The choice is made once, lazily, on the first call, and by asking the server rather than by
 * reading configuration: what decides which wire works is what is listening, not what somebody
 * typed. Ollama gets its own wire because the OpenAI-compatible one cannot carry the context a
 * model is loaded with, and on a local machine that number decides whether the model loads at all
 * (ADR-007 D1, amended). Everything else -- OpenAI, OpenRouter, vLLM, LM Studio -- stays where it
 * was, and so does an Ollama server that cannot be reached to be asked.
 */
export function providerFor(
  config: ProviderConfig,
  fetchFn: FetchFn = globalThis.fetch as FetchFn,
): Provider {
  const compatible = openAICompatible(config, fetchFn);
  let chosen: Promise<Provider> | null = null;
  let settled: Provider | null = null;
  const pick = (): Promise<Provider> => {
    chosen ??= (async () => {
      if (!(await looksLikeOllama(config.baseUrl, fetchFn))) return compatible;
      // A context has to be asked for on this wire, so it has to be a number rather than a default
      // that happens to be there. A profile that names one is a person's decision and is obeyed;
      // otherwise the model is asked what it was built with, and what comes back is capped, because
      // the declaration is what a model was trained for and not what will fit beside its weights.
      const named = config.profile?.contextTokens;
      const limits = named ? null : await probeModel(config.baseUrl, config.model, fetchFn);
      const withContext = limits
        ? { ...config, profile: { ...config.profile, contextTokens: limits.contextTokens } }
        : config;
      return ollamaNative(withContext, fetchFn);
    })().then((provider) => {
      settled = provider;
      return provider;
    });
    return chosen;
  };
  return {
    id: config.id,
    model: config.model,
    // Read before the first call this is the compatible provider's, which is the honest answer:
    // nothing has asked the server anything yet. After that it is whichever wire won, whose context
    // may have come from the model rather than from the default.
    get profile() {
      return settled?.profile ?? compatible.profile;
    },
    // Read before the first call this is the compatible provider's empty list, because nothing has
    // been learnt yet and nothing has been asked. After that it is the winning wire's own list,
    // which is what says which wire won and what context it settled on.
    get adaptations(): readonly string[] {
      return (settled ?? compatible).adaptations ?? [];
    },
    async complete(req) {
      return (await pick()).complete(req);
    },
    async *stream(req) {
      const provider = await pick();
      if (!provider.stream) throw new ProviderError(config.id, null, "this provider does not stream");
      yield* provider.stream(req);
    },
  };
}

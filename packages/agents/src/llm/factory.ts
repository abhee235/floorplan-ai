// Which adapter speaks for a configuration (ADR-029 D2). The only file that knows the adapters exist.
//
// An explicit `api` wins. Otherwise the provider's name decides -- OpenAI is the Responses wire, Claude
// is Anthropic's Messages API, Ollama is its native wire -- and an address with no name we recognise
// is asked whether it is Ollama, as it always was, and otherwise spoken to on the compatible wire.
// Adding a vendor that speaks the compatible format needs nothing here; adding one that does not is
// one adapter and one line.

import { anthropicMessages } from "./anthropic.js";
import { looksLikeOllama, ollamaNative, probeModel } from "./ollama.js";
import { openAIChat } from "./openai-chat.js";
import { openAIResponses } from "./openai-responses.js";
import { type FetchFn, type Provider, type ProviderConfig, ProviderError, type WireApi } from "./provider.js";

/** The wire a provider's name means, when it means one. */
export function wireForName(name: string): WireApi | null {
  const n = name.trim().toLowerCase();
  if (n === "openai") return "openai-responses";
  if (n === "anthropic" || n === "claude") return "anthropic";
  if (n === "ollama") return "ollama";
  if (n === "openrouter") return "openai-chat";
  return null;
}

/** A provider for a configuration, on the wire its `api` or its name says. */
export function createProvider(
  config: ProviderConfig,
  fetchFn: FetchFn = globalThis.fetch as FetchFn,
): Provider {
  const api = config.api ?? wireForName(config.id);
  switch (api) {
    case "openai-responses":
      return openAIResponses(config, fetchFn);
    case "anthropic":
      return anthropicMessages(config, fetchFn === globalThis.fetch ? undefined : fetchFn);
    case "openai-chat":
      return openAIChat(config, fetchFn);
    case "ollama":
      return settled(config, fetchFn, async () => nativeOllama(config, fetchFn));
    default:
      return providerFor(config, fetchFn);
  }
}

/**
 * Ollama's native wire with the context and sight the model reports about itself.
 *
 * A context has to be asked for on this wire, so it has to be a number rather than a default that
 * happens to be there. A profile that names one is a person's decision and is obeyed; otherwise the
 * model is asked what it was built with, and what comes back is capped, because the declaration is
 * what a model was trained for and not what will fit beside its weights. Always asked, even when the
 * context was named, because the probe answers a second question the context does not: whether the
 * model can see. A profile that says either thing on purpose is obeyed; the probe fills in only what
 * was left unsaid.
 */
async function nativeOllama(config: ProviderConfig, fetchFn: FetchFn): Promise<Provider> {
  const limits = await probeModel(config.baseUrl, config.model, fetchFn);
  const profile = {
    ...config.profile,
    ...(config.profile?.contextTokens === undefined && limits ? { contextTokens: limits.contextTokens } : {}),
    ...(config.profile?.vision === undefined && limits
      ? { vision: limits.capabilities.includes("vision") }
      : {}),
  };
  return ollamaNative({ ...config, profile }, fetchFn);
}

/**
 * A provider for an address, on whichever wire that address actually speaks (ADR-007 D1, amended).
 *
 * For an address with no provider name: asked once, lazily, on the first call. What decides which wire
 * works is what is listening, not what somebody typed. An Ollama server gets its own wire, because the
 * compatible one cannot carry the context a model is loaded with; everything else, and an Ollama server
 * that cannot be reached to be asked, stays on the compatible wire.
 */
export function providerFor(
  config: ProviderConfig,
  fetchFn: FetchFn = globalThis.fetch as FetchFn,
): Provider {
  const compatible = openAIChat(config, fetchFn);
  return settled(
    config,
    fetchFn,
    async () =>
      (await looksLikeOllama(config.baseUrl, fetchFn)) ? nativeOllama(config, fetchFn) : compatible,
    compatible,
  );
}

/** A provider whose wire is decided by asking the server, the first time anything is asked of it. */
function settled(
  config: ProviderConfig,
  _fetchFn: FetchFn,
  decide: () => Promise<Provider>,
  before: Provider = openAIChat(config, _fetchFn),
): Provider {
  let chosen: Promise<Provider> | null = null;
  let done: Provider | null = null;
  const pick = (): Promise<Provider> => {
    chosen ??= decide().then((provider) => {
      done = provider;
      return provider;
    });
    return chosen;
  };
  return {
    id: config.id,
    model: config.model,
    // Read before the first call this is the fallback's, which is the honest answer: nothing has
    // asked the server anything yet. After that it is whichever wire won, whose context may have
    // come from the model rather than from the default.
    get profile() {
      return done?.profile ?? before.profile;
    },
    get wire() {
      return (done ?? before).wire;
    },
    // Which wire won and what context it settled on, once there is an answer.
    get adaptations(): readonly string[] {
      return (done ?? before).adaptations ?? [];
    },
    async ready() {
      await pick();
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

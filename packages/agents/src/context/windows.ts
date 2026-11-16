// context/windows.ts — best-effort model → context-window map. Ported from Cascade
// (packages/core/src/llm/contextWindows.ts, ADR-012) under ADR-031 D1.
//
// A FALLBACK: the window a person set (profile.contextTokens) wins, then what the server says about the
// model (Ollama /api/show num_ctx, probed by the Ollama adapter), and only then this map. Hosted models
// have known windows; local guesses stay conservative.
//
// NOTE (Cascade ADR-039/038): the *usable* window is the model's allocated `num_ctx`, NOT its trained max —
// and two variants of the same base can differ. SPECIFIC variants must precede the generic family rule
// (first match wins).

const WINDOWS: [RegExp, number][] = [
  // ── ADR-031 D2.9: the models this project runs on, ahead of the generic families they would match. ──
  [/gpt-6|gpt-5\.6/i, 400_000], // conservative until measured on the owner's key
  [/claude-haiku-4/i, 200_000],
  [/claude-(opus|sonnet|fable|mythos)-[5-9]|claude-opus-4-[6-9]|claude-sonnet-4-6/i, 1_000_000],
  // ── Cascade's map, unchanged ──
  [/gpt-5/i, 400_000], // gpt-5 / 5-mini / 5-nano / 5.x: 400k total (272k input + 128k output)
  [/gpt-4\.1/i, 1_000_000], // gpt-4.1 family: ~1M context — must precede the generic gpt-4 rules
  [/\bo[134]\b|\bo[134]-/i, 200_000], // o1/o3/o4(-mini): 200k. \b so "gpt-4o"/"llama3" never match
  [/gpt-4o|gpt-4-turbo/i, 128_000],
  [/gpt-4/i, 8_192],
  [/gpt-3\.5/i, 16_385],
  [/claude/i, 200_000],
  // Hosted large-context coder models (NVIDIA NIM / OpenRouter / Together). NATIVE windows; a specific
  // endpoint MAY serve less than native — override with the profile's contextTokens.
  [/kimi[ ._-]?k2\.[56]/i, 262_144], // Kimi K2.5 / K2.6: 256k
  [/kimi.*k2.*(0905|thinking)/i, 262_144], // Kimi K2 Instruct-0905 / K2 Thinking: 256k
  [/kimi[ ._-]?k2/i, 131_072], // Kimi K2 Instruct (base): 128k — must follow the 256k variants above
  [/qwen ?3-?coder/i, 262_144], // Qwen3-Coder-480B-A35B: 256k native — MUST precede the generic qwen 32k rule
  [/deepseek[ ._-]?(v3|r1|chat)/i, 131_072], // DeepSeek V3 / V3.1 / R1: 128k — MUST precede the generic deepseek rule
  [/llama[ ._-]?(3\.[13]|4|nemotron)/i, 131_072], // Llama 3.1 / 3.3 / 4 / Nemotron: 128k
  [/coding-qwen ?3\.?6/i, 131_072],
  [/qwen ?36-agentic/i, 131_072],
  [/qwen ?2\.5|qwen ?3|qwen2|qwen36/i, 32_768],
  [/llama ?3|llama3/i, 8_192],
  [/mistral|mixtral/i, 32_768],
  [/gemma ?2|gemma/i, 8_192],
  [/deepseek/i, 32_768],
  [/phi ?3|phi3/i, 4_096],
];

/** A known window for the model, or undefined (caller falls back to a configured value or a safe default). */
export function contextWindowForModel(model: string): number | undefined {
  for (const [re, win] of WINDOWS) if (re.test(model)) return win;
  return undefined;
}

// ── Window tiers (Cascade ADR-037 / ADR-039) ─────────────────────────────────────────────────────────────
// One coarse switch: 32k/64k must SPEND their window on the task; 128k+ can afford everything.
export type WindowTier = "minimal" | "lean" | "full";
/** Below this a rich preamble would eat too much of the window → strip to essentials. */
export const MINIMAL_TIER_MAX = 24_000;
/** At/above this the full behavioural prompt is affordable (128k, 200k, 1M). Below → lean (32k, 64k). */
export const FULL_TIER_MIN = 96_000;

/** Map an allocated context window (tokens) to a coarse tier. 8k→minimal, 32k/64k→lean, 128k/200k→full. */
export function windowTier(window: number): WindowTier {
  if (window < MINIMAL_TIER_MAX) return "minimal";
  if (window < FULL_TIER_MIN) return "lean";
  return "full";
}

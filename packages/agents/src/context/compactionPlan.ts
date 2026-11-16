// context/compactionPlan.ts — sizing/thresholds for compaction as a PURE function of the model (Cascade
// ADR-039). Ported verbatim from Cascade (packages/core/src/context/compactionPlan.ts) under ADR-031 D1; ADR
// numbers in the comments below are Cascade's.
//
// The problem (ADR-039 Context): a flat ratio ("compact at 80% of window") regresses BIG models (reserves
// 40k on a 200k window) and under-serves SMALL ones. The fix is ONE parameterized plan whose large-window
// limit *is* Claude Code's behaviour — so a strong model never regresses, by construction.
//
// Each tier is `max(proportional, absolute)` (ported from qwen-code's computeThresholds):
//   - LARGE windows are dominated by the ABSOLUTE branch (`effectiveWindow − buffer`) = Claude Code.
//   - SMALL windows fall back to the PROPORTIONAL branch (`pct · window`) automatically.
// Buffer constants come straight from CC (src/services/compact/autoCompact.ts) so the absolute branch is
// bit-for-bit CC. The convergence is locked by a golden test (compactionPlan.test.ts).

import { contextWindowForModel, type WindowTier, windowTier } from "./windows.js";

/** Output cap assumed when the caller pins none (Cascade's providers send 16,384; the wire wall below needs
 *  a number). ADR-031 D2: a local constant here, where Cascade imports it from its chat adapter. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

// ── Buffer constants, sourced from Claude Code (autoCompact.ts) ──────────────────────────────────────────
/** Tokens reserved for the compaction summary output. CC `MAX_OUTPUT_TOKENS_FOR_SUMMARY` (autoCompact.ts:30). */
export const SUMMARY_OUTPUT_RESERVE = 20_000;
/** Distance from effectiveWindow to the auto threshold. CC `AUTOCOMPACT_BUFFER_TOKENS` (autoCompact.ts:62). */
export const AUTOCOMPACT_BUFFER = 13_000;
/** Distance from auto to warn. CC `WARNING_THRESHOLD_BUFFER_TOKENS` (autoCompact.ts:63). */
export const WARN_BUFFER = 20_000;
/** Distance from effectiveWindow to hard. CC `MANUAL_COMPACT_BUFFER_TOKENS` (autoCompact.ts:65). */
export const HARD_BUFFER = 3_000;

// ── Small-window fallbacks (qwen-code) ──────────────────────────────────────────────────────────────────
/** Proportional trigger used when the absolute branch goes degenerate on small windows. qwen `DEFAULT_PCT`. */
export const DEFAULT_PROPORTIONAL_PCT = 0.7;
/** warn-pct = pct − this. qwen `WARN_PCT_OFFSET`. */
export const WARN_PCT_OFFSET = 0.1;
/** Fraction of the (effective) window kept verbatim as recent messages. */
export const DEFAULT_KEEP_RECENT_RATIO = 0.25;
/** RECENCY SHIELD: eviction layers never touch the last N compactable tool results. CC keepRecent
 *  (timeBasedMCConfig.ts:33). The token-based recent window alone fails when ONE big read exceeds it —
 *  it lands "older" the moment it arrives and gets evicted before the model can use it (live incident:
 *  8k window, changelog masked 6,983→341 right after being read). */
export const KEEP_RECENT_RESULTS = 5;

// A small window can't reserve a full 20k for the summary — cap the reserve at this fraction of the window.
// This also guarantees `auto ≤ effectiveWindow` (proven in the ADR): reserve ≤ 0.25·window ⇒ effectiveWindow
// ≥ 0.75·window ≥ 0.7·window = the proportional floor, so we always compact before exhausting the input budget.
const RESERVE_WINDOW_FRACTION = 0.25;
// Big old tool outputs are masked to at most ~1% of the window (in chars); small windows mask harder.
const TOOL_RESULT_WINDOW_FRACTION = 0.01;
const MIN_TOOL_RESULT_CHARS = 1_000;
const MAX_TOOL_RESULT_CHARS = 8_000;
/** Fallback window when the model is unknown and no override is set (matches the old ADR-012 default). */
export const DEFAULT_WINDOW = 8_192;

// ── ADR-078: constrained (KV-wall) economics ────────────────────────────────────────────────────────────
// On a backend where every prefix rewrite costs a FULL re-prefill (local Ollama, hybrid-attention models),
// the hosted stopping rule ("free the minimum, stop at auto") is inverted economics — measured 2026-07-25:
// four compactions freed 0.5–6.5% of the window each (one freed 701 tokens), re-triggered after 21/1/6
// responses, and each cost a 38–45s re-prefill. Constrained mode compacts RARELY and DEEP instead.
/** Post-compaction usage target: at least this fraction of the window must be FREE after a deep compaction. */
export const CONSTRAINED_FREE_TARGET = 0.45;
/** Trigger when fewer than ~this many turns of headroom remain (× live-measured per-turn growth). */
export const CONSTRAINED_TRIGGER_TURNS = 8;
/** Per-turn context growth fallback (tokens) until the session has live samples. Safe direction: high. */
export const FALLBACK_TURN_GROWTH = 1_200;

/**
 * A compaction layer, run in escalation order until the history fits (ADR-039). Cheapest / least-lossy first:
 *   collapse      — clear results of SUPERSEDED reads/searches (dedupe; near-lossless)
 *   mask          — clear oversized old tool_result content (size gate)
 *   microcompact  — clear ALL remaining compactable tool_result content (evict observations)
 *   snip          — reclaim large tool_use INPUTS (Write/Edit/Bash bodies) → one-line stub
 *   summarize     — LLM side-query summary of the older half (the heavy, last resort)
 * The first four are pure/no-LLM and live in compactionLayers.ts.
 */
export type CompactionLayer = "collapse" | "mask" | "microcompact" | "snip" | "summarize";

/** Every layer, in escalation order. The full stack (Claude Code A2 parity, plus input-reclaiming `snip`). */
export const ALL_COMPACTION_LAYERS: readonly CompactionLayer[] = [
  "collapse",
  "mask",
  "microcompact",
  "snip",
  "summarize",
];

export interface CompactionPlan {
  /** Total context window (tokens) this plan is sized for. */
  window: number;
  /** Window minus the output reserve — the budget available for input + the summary. */
  effectiveWindow: number;
  /** UI warn tier (tokens). */
  warn: number;
  /** Auto-compaction trigger (tokens) — the load-bearing threshold. */
  auto: number;
  /** Force-compaction tier (tokens); bounded by the window. */
  hard: number;
  /** Keep this many of the most-recent tokens verbatim; older messages are compacted. */
  keepRecentTokens: number;
  /** Never evict the last N compactable tool results, regardless of the token boundary (CC keepRecent). */
  keepRecentResults: number;
  /** Max chars a single old tool_result may keep before it's masked. */
  toolResultMaxChars: number;
  /** Which layers are enabled for this window size (cheapest first). */
  layers: Set<CompactionLayer>;
  /** 'layered' = mask/summarize in place; 'fresh-context' = Ralph-style reset (tiny windows; deferred). */
  mode: "layered" | "fresh-context";
  /** ADR-078: which cost model governs the STOPPING RULE. 'hosted' (default) = CC behavior, free the minimum
   *  and stop at `auto` (right when a cache break is cheap). 'constrained' = KV-wall backends: compact rarely,
   *  compact DEEP — run all layers + summarize down to `deepTarget` in ONE event, amortizing the re-prefill. */
  economics: "hosted" | "constrained";
  /** ADR-078 (constrained only; = auto otherwise): post-compaction usage target — ≥CONSTRAINED_FREE_TARGET of
   *  the window free after a deep event, floored so tiny windows never target below what keepRecent occupies. */
  deepTarget: number;
  /** Coarse window band (shared with the system-prompt generator, ADR-037): minimal | lean | full. The
   *  thresholds above are continuous, but the tier is recorded for the UI/logs and to keep the prompt in step. */
  tier: WindowTier;
}

export interface PlanInput {
  /** Effective, allocated context window (tokens). */
  window: number;
  /** Model's max output tokens — caps the summary reserve. Optional until ADR-038 profiles land. */
  maxOutputTokens?: number | undefined;
  /** Proportional trigger fraction (default 0.7). */
  pct?: number | undefined;
  /** Fraction of the effective window kept verbatim (default 0.25). */
  keepRecentRatio?: number | undefined;
  /** ADR-078: cost model for the stopping rule. Default 'hosted' — existing behavior, byte-for-byte. */
  economics?: "hosted" | "constrained" | undefined;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * Derive a CompactionPlan from a window (+ optional profile hints). Pure — no I/O, safe to call repeatedly.
 *
 * Convergence guarantee: as `window → large`, the absolute branch dominates and `auto → window −
 * SUMMARY_OUTPUT_RESERVE − AUTOCOMPACT_BUFFER` (exactly CC's `autoCompact.ts` formula). See the golden test.
 */
export function planCompaction(input: PlanInput): CompactionPlan {
  const window = Math.max(0, Math.floor(input.window));
  const pct = clamp(input.pct ?? DEFAULT_PROPORTIONAL_PCT, 0, 1);
  const keepRecentRatio = clamp(input.keepRecentRatio ?? DEFAULT_KEEP_RECENT_RATIO, 0, 1);

  // Reserve for the summary output: the CC cap (20k), never more than the model can emit, never more than a
  // quarter of the window (so tiny models don't reserve their whole window). Large windows resolve to 20k.
  const reserveOutput = Math.min(
    SUMMARY_OUTPUT_RESERVE,
    input.maxOutputTokens ?? SUMMARY_OUTPUT_RESERVE,
    Math.floor(window * RESERVE_WINDOW_FRACTION),
  );
  const effectiveWindow = Math.max(0, window - reserveOutput);

  // max(proportional, absolute): absolute wins on big windows (= CC); proportional wins on small ones.
  let auto = Math.floor(Math.max(pct * window, effectiveWindow - AUTOCOMPACT_BUFFER));
  // THE WIRE WALL. Providers always send an output cap (the user's, or their 16,384 default), and strict
  // servers (vLLM) reject any request where input + cap exceeds the window. If `auto` sits above
  // window − cap, there is a DEAD ZONE where the prompt is too big for the cap but too small to trigger
  // compaction — measured as an unrecoverable 400 loop at 24,577 tokens on a 40,960 window (auto was
  // 28,672; the wall was 24,576). Compaction must fire before the wall, not after it. Only applied when
  // the cap is a minority share of the window — on tiny windows the provider-side clamp is the guard,
  // and halving their trigger would change long-standing behavior for no benefit.
  const generationCap = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const WALL_MARGIN = 1024;
  if (generationCap + WALL_MARGIN < Math.floor(window / 2))
    auto = Math.min(auto, window - generationCap - WALL_MARGIN);
  const warn = Math.min(
    Math.floor(Math.max(0, Math.max((pct - WARN_PCT_OFFSET) * window, auto - WARN_BUFFER))),
    Math.max(0, auto - 2000),
  );
  const hard = Math.floor(Math.min(window, Math.max(effectiveWindow - HARD_BUFFER, auto + HARD_BUFFER)));

  const keepRecentTokens = Math.floor(effectiveWindow * keepRecentRatio);
  // ADR-078 deep target: post-compaction usage ≤ (1 − FREE_TARGET) of the USABLE window, floored so it
  // never demands less than the verbatim recent region + a summary's worth of room.
  //
  // "Usable" matters when the wire wall clamped `auto` below the proportional point: freeing 45% of the
  // NOMINAL window then lands a target (0.55 × 40,960 ≈ 22.5k) a hair under a 23.5k trigger — one deep
  // compaction buys two turns and the thrash continues. Deriving the base from auto/pct recovers the
  // window the trigger actually governs; where the wall does not bind, auto/pct ≥ window and this is
  // byte-for-byte the old formula.
  const usableWindow = Math.min(window, Math.floor(auto / Math.max(pct, 0.1)));
  const deepTarget = Math.max(
    keepRecentTokens + Math.min(2_000, Math.floor(window / 8)),
    Math.floor(usableWindow * (1 - CONSTRAINED_FREE_TARGET)),
  );

  return {
    window,
    effectiveWindow,
    warn,
    auto,
    hard,
    keepRecentTokens,
    keepRecentResults: KEEP_RECENT_RESULTS,
    toolResultMaxChars: clamp(
      Math.floor(window * 4 * TOOL_RESULT_WINDOW_FRACTION),
      MIN_TOOL_RESULT_CHARS,
      MAX_TOOL_RESULT_CHARS,
    ),
    layers: new Set<CompactionLayer>(ALL_COMPACTION_LAYERS), // full stack by default; the executor stops early
    mode: "layered",
    economics: input.economics ?? "hosted",
    deepTarget: (input.economics ?? "hosted") === "constrained" ? Math.min(deepTarget, auto) : auto,
    tier: windowTier(window),
  };
}

/**
 * ADR-078: the constrained-mode trigger, computed LIVE from measured per-turn growth (the session feeds the
 * p75 of real `inputTokens` deltas). Fires when fewer than ~CONSTRAINED_TRIGGER_TURNS turns of headroom
 * remain — early enough that the summarize side-query itself still fits. Clamped to [half the window, the
 * hosted `auto`]: never later than hosted (the CC trigger already guarantees wire safety), never degenerate
 * on tiny windows. Pure; called per compaction check so live growth is always current.
 */
export function constrainedAutoThreshold(plan: CompactionPlan, turnGrowth?: number): number {
  const growth = Math.max(1, turnGrowth ?? FALLBACK_TURN_GROWTH);
  const calculated = plan.window - Math.max(plan.window - plan.auto, CONSTRAINED_TRIGGER_TURNS * growth);
  return Math.max(Math.floor(plan.window / 2), Math.min(plan.auto, Math.floor(calculated)));
}

/** Resolve a plan for a model: window = explicit override → known-model map → safe default. */
export function resolveCompactionPlan(opts: {
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  pct?: number;
  keepRecentRatio?: number;
  economics?: "hosted" | "constrained";
}): CompactionPlan {
  const window = opts.contextWindow ?? contextWindowForModel(opts.model) ?? DEFAULT_WINDOW;
  return planCompaction({
    window,
    maxOutputTokens: opts.maxOutputTokens,
    pct: opts.pct,
    keepRecentRatio: opts.keepRecentRatio,
    economics: opts.economics,
  });
}

// context/compactor.ts — keep the conversation within the model's window (Cascade ADR-012 / ADR-039 /
// ADR-078). The orchestrator runs an escalating stack of pure, no-LLM layers (collapse → mask → microcompact
// → snip; compactionLayers.ts) cheapest-first, stopping as soon as history is back under the plan's `auto`
// threshold; only if they don't free enough does it fall back to the LLM summary (the older half → one
// message, recent half kept verbatim). Returns NEW messages; the saved run and its transcript are untouched.
// Maps to Claude Code: src/services/compact/{autoCompact.ts, compact.ts, microCompact.ts, prompt.ts}.
//
// Ported from Cascade (packages/core/src/context/compactor.ts) under ADR-031 D1. Adaptations are marked
// "ADR-031 D2.n": our message blocks (ADR-029), our provider interface, and summary prompts about a building
// rather than a codebase.

import type { Message } from "../llm/messages.js";
import { type Provider, ProviderError } from "../llm/provider.js";
import {
  type CompactionKind,
  collapseSuperseded,
  maskObservations,
  microcompactToolResults,
  shieldedResultIds,
  snipLargeToolInputs,
  unconsumedReadIds,
} from "./compactionLayers.js";
import { type CompactionLayer, type CompactionPlan, constrainedAutoThreshold } from "./compactionPlan.js";

export {
  COMPACTABLE_TOOLS,
  type CompactionKind,
  collapseSuperseded,
  compactionKindLabel,
  isClearedContent,
  maskObservations,
  microcompactToolResults,
  snipLargeToolInputs,
  unconsumedReadIds,
} from "./compactionLayers.js";
export {
  ALL_COMPACTION_LAYERS,
  type CompactionLayer,
  type CompactionPlan,
  planCompaction,
  resolveCompactionPlan,
} from "./compactionPlan.js";

/** Cascade ADR-052 companion — MEASURED wire overhead. The backend reports the REAL prompt size after every
 *  call; the difference vs our chars/4 message estimate IS everything the wire adds (system + tool schemas +
 *  chat template + pictures + estimate error). EMA smooths run-to-run jitter; floor 0 (an overcounting
 *  estimate must not produce negative overhead). */
export function measureWireOverhead(
  prev: number | undefined,
  realInputTokens: number,
  sentEstimate: number,
): number {
  const measured = Math.max(0, realInputTokens - sentEstimate);
  return prev === undefined ? measured : Math.round(prev * 0.5 + measured * 0.5);
}

/** Rough token estimate (chars/4) over serialized content — no tokenizer dependency.
 *
 *  WIRE-ACCURATE (Cascade ADR-078 rung 1b): reasoning blocks are EXCLUDED — no wire replays past reasoning
 *  (ADR-031 D2.6), and counting it billed phantom tokens the model never sees. Pictures are not counted either
 *  (ADR-031 D2.5): their base64 length has nothing to do with what they cost, and the measured wire overhead
 *  absorbs what they really do cost. The summarize input still renders reasoning, so summarize-fit sizing uses
 *  estimateTokensWithThinking. */
export function estimateTokens(messages: readonly Message[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else
      for (const b of m.content) {
        if (b.type === "text") chars += b.text.length;
        else if (b.type === "tool_use") chars += b.arguments.length;
        else if (b.type === "tool_result") chars += b.content.length;
      }
  }
  return Math.ceil(chars / 4);
}

/** Token estimate INCLUDING reasoning text — for sizing things that really do carry it (the summarize
 *  side-query input), never for wire-facing trigger/threshold/boundary math. */
export function estimateTokensWithThinking(messages: readonly Message[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content !== "string")
      for (const b of m.content) if (b.type === "reasoning") chars += (b.text ?? "").length;
  }
  return estimateTokens(messages) + Math.ceil(chars / 4);
}

/** Index splitting [older | recent]: keep the most-recent messages that fit within keepRecentTokens verbatim;
 *  everything before is "older". Returns the boundary index (older = [0..idx), recent = [idx..]). */
export function olderBoundary(messages: readonly Message[], keepRecentTokens: number): number {
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateTokens([messages[i] as Message]);
    if (acc > keepRecentTokens) return i + 1; // including message i would overflow the recent window
  }
  return 0; // it all fits in the recent window → nothing older
}

/** Turn-align the SUMMARIZE split so the surviving history is a VALID message sequence for any provider.
 *  Summarize drops the older region and prepends one `user` summary; the recent region must therefore START
 *  on an assistant message. Otherwise recent[0] is a tool result whose call was just summarized away → an
 *  ORPHANED tool result (a hard 400 on Anthropic/OpenAI; silently accepted by Ollama). Walk the boundary back
 *  to the nearest assistant. If the older region has no assistant at all, keep the raw split. */
export function turnAlignedBoundary(messages: readonly Message[], boundary: number): number {
  let b = Math.min(boundary, messages.length);
  while (b > 0 && messages[b]?.role !== "assistant") b--;
  return b > 0 ? b : boundary;
}

// The structured summary prompt (Cascade's, adapted from Claude Code's 9-section partial-compact prompt).
// ADR-031 D2.7: the same sections, about a building being drawn rather than a codebase.
const COMPACT_SYSTEM = `You are summarizing the EARLIER part of a conversation in which an agent draws a building in a floor-plan tool, so it can be replaced by your summary while the recent messages are kept verbatim. Be thorough on the detail needed to continue the work without losing context. Respond with TEXT ONLY — do not call any tools.

Produce these sections:
1. Primary request & intent
2. Key decisions (scale, sizes, what was assumed and why)
3. What was built, with ids (walls, openings, rooms, items, designs) and why each matters
4. Errors & fixes (and any user feedback / corrections)
5. Problem solving
6. All user messages (non-tool-result)
7. Pending tasks
8. Current work (precisely what was happening just before this summary)
9. Next step — only if directly in line with the latest request; include a verbatim quote of where work left off to avoid drift.`;

// Cascade ADR-078 constrained-mode summary prompt: an <analysis> DRAFTING scratchpad (stripped before use) and
// an explicit LEDGER — deep compaction's main quality risk is the post-compaction re-read storm, and the ledger
// is the antidote. ADR-031 D2.7: an ENTITY ledger in place of Cascade's file ledger.
const CONSTRAINED_COMPACT_SYSTEM = `You are summarizing the EARLIER part of a conversation in which an agent draws a building in a floor-plan tool, so it can be replaced by your summary while the recent messages are kept verbatim. Your summary will be the agent's ONLY memory of everything before this point. Respond with TEXT ONLY — do not call any tools.

First, draft your reasoning inside an <analysis>...</analysis> block: walk the conversation chronologically and note requests, decisions, what was built, errors and their fixes. This block is DELETED before your summary is used — it is a scratchpad to make the summary better.

Then produce the final summary with EXACTLY these sections:
1. Primary request & intent (quote the user's own words where intent matters)
2. Key decisions (scale, sizes, assumptions) and WHY each was decided
3. ENTITY LEDGER — every level, wall, opening, room, item and design made or changed: its id, what it is, where. This section must be complete: the agent will trust it INSTEAD of reading the scene again.
4. Errors & fixes (verbatim error messages where quoted; user corrections especially)
5. All user messages (non-tool-result), in order — short ones like "ok" and "continue" included
6. Pending tasks
7. Current work — precisely what was happening just before this summary
8. Next step — only if directly in line with the latest request; include a verbatim quote of where work left off.`;

/** Strip the <analysis> drafting scratchpad from a raw summary before it enters history. SALVAGE (Cascade,
 *  measured 2026-07-26: 2 of 2 live summaries silently became `dropped`): a weak summarizer often puts
 *  EVERYTHING inside the block, or never closes the tag. If stripping empties a non-empty summary, the draft
 *  IS the best summary we have: return the block's inner content instead. */
export function stripAnalysisBlock(raw: string): string {
  const stripped = raw.replace(/<analysis>[\s\S]*?(<\/analysis>|$)/i, "").trim();
  if (stripped) return stripped;
  return raw.replace(/<\/?analysis>/gi, "").trim();
}

function serialize(messages: readonly Message[]): string {
  return messages
    .map((m) => {
      const text =
        typeof m.content === "string"
          ? m.content
          : m.content
              .map((b) =>
                b.type === "text"
                  ? b.text
                  : b.type === "reasoning"
                    ? b.text
                      ? `(thinking) ${b.text}`
                      : ""
                    : b.type === "tool_use"
                      ? `(tool ${b.name} ${b.arguments})`
                      : b.type === "tool_result"
                        ? `(result) ${b.content}`
                        : b.type === "image"
                          ? "(a picture)"
                          : "",
              )
              .join("\n");
      return `${m.role.toUpperCase()}: ${text}`;
    })
    .join("\n\n");
}

/** Transient failures the summarize side-query retries, as the loop does (ADR-031 D2: Cascade's
 *  completeWithRecovery, reduced to what our provider interface can say). */
const isTransient = (e: unknown) =>
  e instanceof ProviderError && (e.status === null || e.status === 429 || e.status >= 500);

async function summarize(older: readonly Message[], deps: CompactDeps): Promise<string> {
  const system = deps.plan.economics === "constrained" ? CONSTRAINED_COMPACT_SYSTEM : COMPACT_SYSTEM;
  // BOUNDED INPUT (Cascade ADR-078 cold-resume edge): the side-query's own prompt must fit the window it runs
  // in. Keep the head (task, early decisions) and the tail (recent work) and elide the middle.
  const serialized = serialize(older);
  const budgetChars = Math.max(8_000, (deps.plan.effectiveWindow - 1_500) * 4 - system.length);
  const input =
    serialized.length <= budgetChars
      ? serialized
      : `${serialized.slice(0, Math.floor(budgetChars * 0.6))}\n\n[... middle of the conversation omitted — it exceeded the summarizer's window. Summarize what IS shown; note the omission in Current work. ...]\n\n${serialized.slice(-Math.floor(budgetChars * 0.35))}`;
  const sleep = deps.sleepForTest ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await deps.provider.complete({
        system,
        messages: [{ role: "user", content: input }],
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      return stripAnalysisBlock((res.text ?? "").trim());
    } catch (e) {
      if (!isTransient(e) || attempt >= 2) throw e;
      deps.onRetry?.({ attempt: attempt + 1, delayMs: 1000 * 2 ** attempt });
      await sleep(1000 * 2 ** attempt);
    }
  }
}

// Cascade ADR-078 circuit breaker (qwen-code MAX_CONSECUTIVE_FAILURES): after 3 consecutive summarize
// failures, stop paying the side-query on AUTO compactions until one summarize succeeds. Keyed by the plan
// object (stable per run) so state never leaks across runs.
const SUMMARIZE_BREAKER_LIMIT = 3;
const summarizeFailures = new WeakMap<CompactionPlan, number>();

export interface CompactDeps {
  provider: Provider;
  plan: CompactionPlan;
  signal?: AbortSignal;
  /** Coupled curation (Cascade ADR-015/074): harvest durable facts from the OLDER messages before they're
   *  compressed. ADR-031 D2.8: no memory here yet; the hook stays, unset. */
  onDiscard?: (older: Message[]) => Promise<void>;
  /** Tokens the WIRE prompt carries beyond `messages`: system prompt + tool schemas + template + pictures.
   *  The plan's thresholds are window-relative, so ignoring this plans the whole window for messages. */
  overheadTokens?: number;
  onRetry?: (info: { attempt: number; delayMs: number }) => void;
  /** Injectable backoff sleep for deterministic tests. */
  sleepForTest?: (ms: number) => Promise<void>;
  /** Cascade ADR-078: live-measured per-turn context growth (p75 of real prompt-size deltas, tokens). */
  turnGrowth?: number;
}

// The pure, no-LLM layers in escalation order, each mapped to the kind it reports.
const CHEAP_LAYERS: {
  layer: CompactionLayer;
  kind: CompactionKind;
  apply: (m: Message[], older: number, plan: CompactionPlan, shield: Set<string>) => Message[];
}[] = [
  // collapse is unshielded on purpose: it only clears results a NEWER read of the same target supersedes —
  // the latest copy always survives, so there's no working-set loss even for a recent result.
  { layer: "collapse", kind: "collapsed", apply: (m, older) => collapseSuperseded(m, older) },
  {
    layer: "mask",
    kind: "masked",
    apply: (m, older, plan, shield) => maskObservations(m, older, plan.toolResultMaxChars, shield),
  },
  {
    layer: "microcompact",
    kind: "microcompacted",
    apply: (m, older, _plan, shield) => microcompactToolResults(m, older, shield),
  },
  {
    layer: "snip",
    kind: "snipped",
    apply: (m, older, plan, shield) => snipLargeToolInputs(m, older, plan.toolResultMaxChars, shield),
  },
];

/** Conservative estimate of the summary message's own size — used to decide whether summarizing HELPS. */
const EXPECTED_SUMMARY_TOKENS = 500;

/** Plain text of a user message (string content or text blocks); undefined for tool_result-only messages. */
function userText(m: Message): string | undefined {
  if (m.role !== "user") return undefined;
  if (typeof m.content === "string") return m.content || undefined;
  const texts = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/** The FIRST (task statement) and LAST (latest instruction / steering nudge) plain-text user messages in the
 *  region, for VERBATIM preservation across a summarize. A prior summary message is unwrapped back to its
 *  task head (repeat compaction must not nest headers) and never counts as the "latest instruction". */
function preservedUserTexts(older: readonly Message[]): { task?: string; lastInstruction?: string } {
  let task: string | undefined;
  let taskIdx = -1;
  for (let i = 0; i < older.length; i++) {
    const text = userText(older[i] as Message);
    if (!text) continue;
    taskIdx = i;
    task = text.startsWith("[Original task]\n")
      ? (text.split("\n\n[Earlier conversation compacted")[0] as string).slice("[Original task]\n".length)
      : text.startsWith("[Earlier conversation compacted")
        ? undefined
        : text;
    break;
  }
  for (let i = older.length - 1; i > taskIdx; i--) {
    const text = userText(older[i] as Message);
    if (!text || text.startsWith("[Original task]") || text.startsWith("[Earlier conversation compacted"))
      continue;
    return { ...(task !== undefined ? { task } : {}), lastInstruction: text.slice(0, 2000) };
  }
  return task !== undefined ? { task } : {};
}

/** First message index that contains a shielded tool_use or tool_result — the summarize boundary must not
 *  cross it, or the summary would eat the very results the cheap layers just protected. */
function firstShieldedIndex(messages: readonly Message[], shield: Set<string>): number {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as Message;
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (
        (b.type === "tool_use" && shield.has(b.id)) ||
        (b.type === "tool_result" && shield.has(b.toolUseId))
      )
        return i;
    }
  }
  return messages.length;
}

/**
 * Compact `messages` when they cross the plan's `auto` threshold (Cascade ADR-039). Runs the plan's enabled
 * layers in escalation order — collapse → mask → microcompact → snip (pure, no LLM) — stopping the moment
 * history is back under `auto`; only if those don't free enough does it fall back to `summarize`. `force`
 * (reactive overflow) bypasses the threshold gate and always compresses as hard as it can. Returns the
 * (possibly) new history and the kind of the most aggressive layer that ran.
 */
export async function compactIfNeeded(
  messages: Message[],
  deps: CompactDeps,
  opts?: { force?: boolean },
): Promise<{ messages: Message[]; kind: CompactionKind }> {
  const { plan } = deps;
  const force = opts?.force ?? false;
  const constrained = plan.economics === "constrained";
  // Cascade ADR-078: constrained mode computes its trigger LIVE from measured turn growth; hosted keeps the
  // CC-derived plan.auto. Hosted stops the moment it's back under the trigger (free the minimum); constrained
  // pushes on to deepTarget (free ≥45% of the window) so one event buys dozens of turns.
  const auto = constrained ? constrainedAutoThreshold(plan, deps.turnGrowth) : plan.auto;
  const stopAt = constrained ? Math.min(plan.deepTarget, auto) : auto;
  // The wire prompt = overhead (system + tool schemas + template) + messages; all thresholds compare the SUM.
  const overhead = deps.overheadTokens ?? 0;
  const usage = estimateTokens(messages) + overhead;
  if (!force && usage < auto) return { messages, kind: "none" };

  const boundary = olderBoundary(messages, plan.keepRecentTokens);
  if (boundary === 0) return { messages, kind: "none" }; // all fits in the recent window — nothing older

  // RECENCY SHIELD (CC keepRecent) + SURVIVAL MODE: at the ceiling (or reactive `force`) the prompt will NOT
  // fit on the wire — survival beats recency, the shield shrinks to the very last result (CC's floor of 1).
  const ceiling = Math.min(plan.hard, plan.effectiveWindow);
  const survival = force || usage >= ceiling;
  const shield = shieldedResultIds(messages, survival ? 1 : plan.keepRecentResults);
  // Cascade ADR-058: additionally shield the latest UNCONSUMED read per subject. Never in survival.
  if (!survival) for (const id of unconsumedReadIds(messages)) shield.add(id);

  // ── Cheap layers: escalate, stopping as soon as we're back under threshold. ──
  // These are length-preserving (they clear content / stub inputs, never drop messages), so `boundary` stays
  // valid across all of them. `kind` tracks the most aggressive layer that actually reduced tokens.
  let working = messages;
  let kind: CompactionKind = "none";
  for (const step of CHEAP_LAYERS) {
    if (!plan.layers.has(step.layer)) continue;
    const next = step.apply(working, boundary, plan, shield);
    if (estimateTokens(next) < estimateTokens(working)) {
      working = next;
      kind = step.kind;
    }
    if (!force && estimateTokens(working) + overhead < stopAt) return { messages: working, kind };
  }

  // ── Heavy layer: LLM summary of the older half, recent kept verbatim. ──
  if (plan.layers.has("summarize")) {
    const summarizeBoundary = turnAlignedBoundary(
      working,
      Math.min(olderBoundary(working, plan.keepRecentTokens), firstShieldedIndex(working, shield)),
    );
    if (summarizeBoundary > 0) {
      const older = working.slice(0, summarizeBoundary);
      const recent = working.slice(summarizeBoundary);
      // Only worth an LLM side-query if it can plausibly bring us back under `auto`; over-auto-but-under-HARD
      // is a SOFT state. Over hard there is no soft option (see survival above).
      const olderTokens = estimateTokens(older);
      const expectedSummary = Math.min(EXPECTED_SUMMARY_TOKENS, Math.floor(plan.window / 16));
      const canHelp = estimateTokens(working) + overhead - olderTokens + expectedSummary < auto;
      // PRE-GATE (Cascade, measured): only spend the LLM call when the older region is big enough to reclaim
      // several times the wrapper cost; `force` and over-the-ceiling bypass it.
      const stillOverCeiling = estimateTokens(working) + overhead >= ceiling;
      // Cascade ADR-078 constrained: summarize is THE strategy, not the fallback — no canHelp/worthIt gating.
      const worthIt = force || stillOverCeiling || constrained || olderTokens >= expectedSummary * 3;
      // Circuit breaker (auto only).
      const breakerTripped =
        (summarizeFailures.get(plan) ?? 0) >= SUMMARIZE_BREAKER_LIMIT && !force && !survival;
      if ((survival || canHelp || constrained) && worthIt && !breakerTripped) {
        if (deps.onDiscard) await deps.onDiscard(older);
        // The ORIGINAL TASK and the LATEST USER INSTRUCTION ride along VERBATIM — never entrusted to the
        // summary (Cascade, measured: a weak model's summary lost the task statement).
        const { task, lastInstruction } = preservedUserTexts(older);
        let summary: string | undefined;
        try {
          summary = await summarize(older, deps);
          summarizeFailures.set(plan, 0);
        } catch {
          // Summarizer unreachable even after retries: a dead round is worse than a lossy one. Drop the older
          // region, keeping the verbatim task + latest instruction; the scene is still there to be read.
          summary = undefined;
          summarizeFailures.set(plan, (summarizeFailures.get(plan) ?? 0) + 1);
        }
        const summaryMsg: Message = {
          role: "user",
          content: [
            task ? `[Original task]\n${task}` : "",
            summary
              ? `[Earlier conversation compacted to save context]\n\n${summary}`
              : "[Earlier conversation dropped to save context — its summary was unavailable. Read the scene (get_scene) for what exists; the task above and instruction below are verbatim.]",
            // Cascade ADR-078: after a DEEP compaction the biggest quality risk is the re-read storm.
            constrained && summary
              ? "[Note] History above was deeply compacted. Trust the ENTITY LEDGER and summary instead of re-reading the scene — read it again only before changing something."
              : "",
            lastInstruction ? `[Latest user instruction — still applies]\n${lastInstruction}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        };
        // MONOTONICITY GUARD: a summarize that doesn't SHRINK the history is pure loss.
        const swapped = [summaryMsg, ...recent];
        if (estimateTokens(swapped) >= estimateTokens(working)) return { messages: working, kind };
        return { messages: swapped, kind: summary ? "summarized" : "dropped" };
      }
    }
  }

  return { messages: working, kind };
}

/**
 * Is this provider failure the server saying the prompt is too big? Cascade's classifier (resilience.ts),
 * applied to our ProviderError: a yes forces a compaction and a retry instead of ending the run.
 */
export function isOverflowError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return /context (length|window)|num_ctx|exceed|too long|too many tokens|maximum context/.test(msg);
}

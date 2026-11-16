// Translated from Cascade's deepCompaction.test.ts under ADR-031 (tool names per D2.1, entity ledger per D2.7).
//
// Cascade ADR-078 — KV-wall-aware deep compaction. Measured motivation (2026-07-25, 131k remote build): four
// compactions freed 0.5–6.5% of the window each (one freed 701 tokens), re-triggered after 21/1/6 responses,
// each costing a 38–45s full re-prefill — and `summarize` (with the ADR-074 curation harvest coupled to it)
// never fired once. Constrained economics: compact rarely, compact DEEP (all layers + unconditional summarize
// down to `deepTarget`), thresholds calculated from live turn growth, thinking excluded from wire estimates.

import { describe, expect, it } from "vitest";
import { constrainedAutoThreshold } from "../../src/context/compactionPlan.js";
import {
  type CompactionPlan,
  compactIfNeeded,
  estimateTokens,
  estimateTokensWithThinking,
  planCompaction,
  stripAnalysisBlock,
} from "../../src/context/compactor.js";
import { type Message, toolResultMessage } from "../../src/llm/messages.js";
import { ProviderError } from "../../src/llm/provider.js";
import { createFakeProvider, type FakeProvider } from "./fakeProvider.js";

// ── plan math ────────────────────────────────────────────────────────────────────────────────────────────

describe("planCompaction — economics branch (ADR-078)", () => {
  it("hosted (default) is unchanged: deepTarget collapses to auto, economics=hosted", () => {
    const p = planCompaction({ window: 131072, maxOutputTokens: 16384 });
    expect(p.economics).toBe("hosted");
    expect(p.deepTarget).toBe(p.auto); // the executor's stop threshold degenerates to today's behavior
  });

  it("constrained: deepTarget demands ≥45% of the window free (131k golden)", () => {
    const p = planCompaction({ window: 131072, maxOutputTokens: 16384, economics: "constrained" });
    expect(p.economics).toBe("constrained");
    expect(p.deepTarget).toBe(Math.floor(131072 * 0.55)); // 72,089 — vs auto 101,688: ~30k deeper per event
    expect(p.deepTarget).toBeLessThan(p.auto);
  });

  it("tiny windows: the floor wins — never target below keepRecent + summary room", () => {
    const p = planCompaction({ window: 8192, economics: "constrained" });
    expect(p.deepTarget).toBeGreaterThanOrEqual(p.keepRecentTokens);
    expect(p.deepTarget).toBeLessThanOrEqual(p.auto);
  });
});

describe("constrainedAutoThreshold — trigger from LIVE turn growth", () => {
  const p = planCompaction({ window: 131072, maxOutputTokens: 16384, economics: "constrained" });
  it("at measured-normal growth (1088 tok/turn) it equals the hosted trigger (CC headroom dominates)", () => {
    expect(constrainedAutoThreshold(p, 1088)).toBe(p.auto);
  });
  it("a fast-growing session triggers EARLIER (8 turns of 5k growth > the CC buffer)", () => {
    const t = constrainedAutoThreshold(p, 5000);
    expect(t).toBeLessThan(p.auto);
    expect(t).toBe(131072 - 8 * 5000);
  });
  it("never later than hosted, never below half the window (degenerate-growth clamp)", () => {
    expect(constrainedAutoThreshold(p, 1)).toBeLessThanOrEqual(p.auto);
    expect(constrainedAutoThreshold(p, 1_000_000)).toBe(Math.floor(131072 / 2));
  });
});

// ── wire-accurate estimates (rung 1b) ────────────────────────────────────────────────────────────────────

describe("estimateTokens — thinking is phantom (never replayed on any wire path)", () => {
  // Cascade's thinking block → our reasoning block (ADR-029 D1), its readable text in `text`.
  const msgs: Message[] = [
    {
      role: "assistant",
      content: [
        { type: "reasoning", wire: "test", data: {}, text: "x".repeat(4000) },
        { type: "text", text: "y".repeat(400) },
      ],
    },
  ];
  it("excludes thinking from the wire estimate", () => {
    expect(estimateTokens(msgs)).toBe(100); // 400 chars text only
  });
  it("estimateTokensWithThinking includes it (summarize-input sizing)", () => {
    expect(estimateTokensWithThinking(msgs)).toBe(1100);
  });
});

describe("stripAnalysisBlock — scratchpad stripped, but a swallowed summary is SALVAGED", () => {
  it("strips a closed block when a real summary follows", () => {
    expect(stripAnalysisBlock("<analysis>draft chaos</analysis>REAL SUMMARY")).toBe("REAL SUMMARY");
  });
  it("SALVAGE: everything-inside-the-block returns the inner content (measured: 2/2 live summaries silently dropped)", () => {
    expect(stripAnalysisBlock("<analysis>the whole summary lives here</analysis>")).toBe(
      "the whole summary lives here",
    );
  });
  it("SALVAGE: an unterminated block returns its draft instead of empty", () => {
    expect(stripAnalysisBlock("<analysis>model ran out mid-draft")).toBe("model ran out mid-draft");
  });
});

// ── executor behavior ────────────────────────────────────────────────────────────────────────────────────

/** Synthetic plan: auto 800, deepTarget 550 — sized so the mask layer alone satisfies HOSTED but not DEEP. */
const constrainedPlan = (): CompactionPlan => ({
  window: 1000,
  effectiveWindow: 1000,
  warn: 600,
  auto: 800,
  hard: 970,
  keepRecentTokens: 100,
  keepRecentResults: 1,
  toolResultMaxChars: 500,
  layers: new Set(["mask", "summarize"]),
  mode: "layered",
  economics: "constrained",
  deepTarget: 550,
  tier: "full",
});
const hostedPlan = (): CompactionPlan => ({ ...constrainedPlan(), economics: "hosted", deepTarget: 800 });

/** History ≈880 tok. Older region: big task text + assistant + a maskable 800-char run_code result (NOT
 *  shielded: the recency shield protects the newer describe_room below instead). Recent tail: a shielded read
 *  + small texts. Cascade's Bash → run_code, its Read(file_path) → describe_room(roomId). */
const history = (): Message[] => [
  { role: "user", content: "T".repeat(1200) },
  { role: "assistant", content: "A".repeat(1200) },
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "b1", name: "run_code", arguments: JSON.stringify({ code: "ls" }) }],
  },
  toolResultMessage("b1", "R".repeat(800)),
  {
    role: "assistant",
    content: [
      { type: "tool_use", id: "r2", name: "describe_room", arguments: JSON.stringify({ roomId: "z" }) },
    ],
  },
  toolResultMessage("r2", "S".repeat(80)),
  { role: "assistant", content: "B".repeat(200) },
  { role: "user", content: "latest small instruction" },
];

const summarizer = (text: string): FakeProvider => createFakeProvider([], text);

/** Always fails, with an error the summarizer does not retry (a 400), so each event costs one call. */
const failing = (): FakeProvider => createFakeProvider([], new ProviderError("fake", 400, "summarizer down"));

const head = (m: Message | undefined): string => (typeof m?.content === "string" ? m.content : "");

describe("compactIfNeeded — constrained runs DEEP where hosted stops early (the 701-token fix)", () => {
  it("hosted: mask gets under auto → stops, summarize never paid (today, byte-for-byte)", async () => {
    const provider = summarizer("S");
    const r = await compactIfNeeded(history(), { provider, plan: hostedPlan() });
    expect(r.kind).toBe("masked");
    expect(provider.calls.length).toBe(0);
  });

  it("constrained: same input pushes past auto down to deepTarget via summarize, scratchpad stripped", async () => {
    const r = await compactIfNeeded(history(), {
      provider: summarizer("<analysis>chronological draft</analysis>ENTITY LEDGER: room-z — the kitchen"),
      plan: constrainedPlan(),
    });
    expect(r.kind).toBe("summarized");
    expect(estimateTokens(r.messages)).toBeLessThan(550); // hit the deep target, not just auto
    const text = head(r.messages[0]);
    expect(text).toContain("ENTITY LEDGER");
    expect(text).not.toContain("<analysis>"); // drafting scratchpad never enters history
    expect(text).toContain("Trust the ENTITY LEDGER"); // re-read-storm guidance rides along
    expect(text).toContain("[Original task]"); // verbatim task preserved outside the summary, as before
  });

  it("under the trigger nothing happens (deep mode must not compact eagerly)", async () => {
    const small: Message[] = [{ role: "user", content: "tiny" }];
    const r = await compactIfNeeded(small, { provider: summarizer("S"), plan: constrainedPlan() });
    expect(r.kind).toBe("none");
  });
});

describe("compactIfNeeded — summarize circuit breaker (3 strikes, resets on success)", () => {
  it("3 consecutive failures → the 4th event stops paying the dead side-query", async () => {
    const plan = constrainedPlan();
    plan.layers = new Set(["summarize"]); // no cheap relief — every event reaches the summarize path
    const provider = failing();
    const deps = { provider, plan, sleepForTest: async () => {} };
    for (let i = 0; i < 3; i++) {
      const r = await compactIfNeeded(history(), deps);
      expect(r.kind).toBe("dropped"); // summary unavailable → lossy-drop fallback, window still freed
    }
    const callsAfter3 = provider.calls.length;
    const r4 = await compactIfNeeded(history(), deps);
    expect(r4.kind).toBe("none"); // breaker tripped: no side-query, no drop — cheap state stands
    expect(provider.calls.length).toBe(callsAfter3); // the summarizer was NOT called again
  });

  it("a success resets the breaker", async () => {
    const plan = constrainedPlan();
    const provider = summarizer("GOOD");
    const r = await compactIfNeeded(history(), { provider, plan });
    expect(r.kind).toBe("summarized");
    expect(provider.calls.length).toBe(1);
  });
});

describe("summarize input is BOUNDED (cold-resume edge: restored history >> current window)", () => {
  it("an oversized older region reaches the summarizer elided head+tail, never raw", async () => {
    const plan = constrainedPlan(); // effectiveWindow 1000 → budget ≈ max(8000, …) = 8000 chars
    const provider = summarizer("S");
    const huge: Message[] = [
      { role: "user", content: "task ".repeat(4000) }, // ~20k chars — dwarfs the 1k-token window
      { role: "assistant", content: "work ".repeat(4000) },
      { role: "assistant", content: "tail-anchor" },
      { role: "user", content: "recent" },
    ];
    const r = await compactIfNeeded(huge, { provider, plan });
    expect(r.kind).toBe("summarized");
    const seen = String(provider.calls[0]?.messages[0]?.content);
    expect(seen.length).toBeLessThanOrEqual(8200); // bounded (budget + marker slack)
    expect(seen).toContain("middle of the conversation omitted");
    expect(seen.startsWith("USER: task")).toBe(true); // head kept
  });
});

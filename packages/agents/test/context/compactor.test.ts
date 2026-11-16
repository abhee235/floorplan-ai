// Translated from Cascade's compactor.test.ts under ADR-031 (tool names per D2.1, one tool result per message per ADR-029).
import { describe, expect, it } from "vitest";
import {
  type CompactionPlan,
  compactIfNeeded,
  estimateTokens,
  maskObservations,
  measureWireOverhead,
  olderBoundary,
  planCompaction,
  turnAlignedBoundary,
} from "../../src/context/compactor.js";
import { type Message, toolResultMessage, toolResultOf } from "../../src/llm/messages.js";
import { ProviderError } from "../../src/llm/provider.js";
import { createFakeProvider } from "./fakeProvider.js";

const use = (id: string, name: string, args: unknown): Message => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, arguments: JSON.stringify(args) }],
});
const res = (id: string, content: string): Message => toolResultMessage(id, content);
const resultContent = (m: Message | undefined): string => (m ? (toolResultOf(m)?.content ?? "") : "");
/** A message's content as text: the string itself, or its blocks serialized. */
const contentText = (m: Message | undefined): string =>
  m === undefined ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content);

/** Every tool_result in `messages` must have a matching tool_use somewhere before it — otherwise the sequence
 *  is invalid (an orphaned tool result 400s on Anthropic/OpenAI). Returns the orphaned ids (empty = valid). */
function orphanedToolResults(messages: Message[]): string[] {
  const useIds = new Set<string>();
  const orphans: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_use") useIds.add(b.id);
      else if (b.type === "tool_result" && !useIds.has(b.toolUseId)) orphans.push(b.toolUseId);
    }
  }
  return orphans;
}

// A tiny synthetic plan for the compactIfNeeded tests: compact at 80 tok, keep 25 tok recent.
// (Real sizing is covered by compactionPlan.test.ts.)
const plan: CompactionPlan = {
  window: 100,
  effectiveWindow: 100,
  warn: 60,
  auto: 80,
  hard: 97,
  keepRecentTokens: 25,
  keepRecentResults: 5,
  toolResultMaxChars: 2000,
  layers: new Set(["mask", "summarize"]),
  mode: "layered",
  economics: "hosted",
  deepTarget: 80,
  tier: "full",
};

describe("compactor — helpers", () => {
  it("estimateTokens ~ chars/4", () => {
    expect(estimateTokens([{ role: "user", content: "x".repeat(40) }])).toBe(10);
  });

  it("maskObservations masks large tool_results in the OLDER region only", () => {
    // Reshaped: Cascade masks bare results with no call; ours masks only compactable tools' results, so each
    // result gets a describe_room call, and the indices shift (older = [use 1, result 1]).
    const big = "A".repeat(5000);
    const msgs: Message[] = [
      use("1", "describe_room", { roomId: "room-1" }), // older (idx 0)
      res("1", big), // older (idx 1)
      use("2", "describe_room", { roomId: "room-2" }), // recent (idx 2)
      res("2", big), // recent (idx 3)
    ];
    const out = maskObservations(msgs, 2); // olderCount = 2
    expect(resultContent(out[1])).toMatch(/output masked/);
    expect(resultContent(out[3])).toBe(big); // recent untouched
  });

  it("olderBoundary splits [older | recent] by the keep-recent budget", () => {
    const msgs: Message[] = Array.from({ length: 5 }, () => ({
      role: "user" as const,
      content: "x".repeat(40),
    })); // 10 tok each
    expect(olderBoundary(msgs, 25)).toBe(3); // keeps last 2 (20 tok ≤ 25); a 3rd would overflow
  });

  it("turnAlignedBoundary walks a summarize split back to the nearest assistant (never orphans a tool_result)", () => {
    const msgs: Message[] = [
      { role: "user", content: "q" }, // 0
      use("A", "describe_room", {}), // 1
      res("A", "r"), // 2
      { role: "assistant", content: [{ type: "text", text: "done" }] }, // 3
    ];
    expect(turnAlignedBoundary(msgs, 2)).toBe(1); // raw split @2 = user(tool_result) → back to the assistant @1
    expect(turnAlignedBoundary(msgs, 3)).toBe(3); // already an assistant → unchanged
    expect(turnAlignedBoundary(msgs, 1)).toBe(1); // already an assistant → unchanged
    // Degenerate all-user history (no assistant, so no tool pairs to orphan) → keep the raw split.
    expect(
      turnAlignedBoundary(
        [
          { role: "user", content: "a" },
          { role: "user", content: "b" },
        ],
        1,
      ),
    ).toBe(1);
  });
});

describe("compactor — compactIfNeeded (plan-driven, ADR-039)", () => {
  it("under threshold ⇒ no change", async () => {
    const msgs: Message[] = [{ role: "user", content: "hi" }];
    const provider = createFakeProvider([]);
    const { kind } = await compactIfNeeded(msgs, { provider, plan });
    expect(kind).toBe("none");
  });

  it('Layer A: masking large old tool output is enough ⇒ kind "masked", no LLM call', async () => {
    // Reshaped: Cascade's bare result (no call) is never masked by ours, so it gets a describe_room call. With a
    // call it is compactable and so shielded as the newest result; a second, small read after it takes the
    // survival shield (the last result) so the big one is maskable, as it was in Cascade's fixture.
    const msgs: Message[] = [
      use("1", "describe_room", { roomId: "r1" }),
      res("1", "A".repeat(4000)), // ~1000 tok, older
      use("2", "describe_room", { roomId: "r2" }),
      res("2", "ok"),
      { role: "user", content: "recent question" },
      { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
    ];
    const provider = createFakeProvider([]); // summarize must NOT be called
    const { messages, kind } = await compactIfNeeded(msgs, { provider, plan });
    expect(kind).toBe("masked");
    expect(resultContent(messages[1])).toMatch(/output masked/);
    expect(provider.calls.length).toBe(0);
  });

  it("Layer B: summarizes the older half into one message, keeps recent verbatim", async () => {
    const older: Message[] = Array.from({ length: 7 }, (_, i) => ({
      role: "user" as const,
      content: `old message ${i} ${"x".repeat(36)}`,
    }));
    const recent: Message[] = [
      { role: "user", content: `recent ${"y".repeat(36)}` },
      { role: "assistant", content: [{ type: "text", text: `reply ${"z".repeat(36)}` }] },
      { role: "user", content: `latest ${"w".repeat(36)}` },
    ];
    const provider = createFakeProvider(["STRUCTURED SUMMARY OF OLDER"]);
    const discarded: Message[][] = [];
    const { messages, kind } = await compactIfNeeded([...older, ...recent], {
      provider,
      plan,
      onDiscard: async (o) => void discarded.push(o),
    });
    expect(kind).toBe("summarized");
    expect(contentText(messages[0])).toContain("STRUCTURED SUMMARY OF OLDER"); // summary replaces older
    expect(messages.length).toBeLessThan(older.length + recent.length); // history shrank
    expect(contentText(messages[messages.length - 1])).toContain("latest"); // most-recent message kept verbatim
    expect(discarded[0]?.length).toBeGreaterThan(0); // coupled-curation hook saw the older messages
  });

  it("summarizer UNREACHABLE → falls back to dropping older with task preserved — never throws (iterate-5)", async () => {
    // Measured: the raw summarize call was how a wedged backend killed whole rounds. Now it retries; if STILL
    // dead, compaction degrades to a task-preserving drop instead of throwing.
    // Reshaped: Cascade's `recover` (backend recycle) hook does not exist here; ours retries a transient
    // ProviderError twice with backoff and reports each through `onRetry`, which stands in for it.
    const older: Message[] = [
      { role: "user", content: `Draw the Harbour Cafe ground floor ${"x".repeat(30)}` }, // the task — must survive verbatim
      ...Array.from({ length: 6 }, (_, i) => ({
        role: "user" as const,
        content: `old message ${i} ${"x".repeat(36)}`,
      })),
    ];
    const recent: Message[] = [
      { role: "user", content: `recent ${"y".repeat(36)}` },
      { role: "assistant", content: [{ type: "text", text: `reply ${"z".repeat(36)}` }] },
      { role: "user", content: `latest instruction ${"w".repeat(36)}` },
    ];
    let retried = 0;
    const deadProvider = createFakeProvider(
      [],
      new ProviderError("fake", null, "fetch failed (Headers Timeout Error)"),
    );
    const { messages, kind } = await compactIfNeeded([...older, ...recent], {
      provider: deadProvider,
      plan,
      onRetry: () => void retried++, // retry attempted, backend still dead
      sleepForTest: async () => {},
    });
    expect(kind).toBe("dropped"); // degraded, honest — NOT a throw, NOT a dead round
    expect(contentText(messages[0])).toContain("[Original task]"); // the task rode along verbatim
    expect(contentText(messages[0])).toContain("Harbour Cafe");
    expect(contentText(messages[0])).toContain("dropped to save context"); // the model is told what happened
    expect(messages.length).toBeLessThan(older.length + recent.length); // the window was still freed
    expect(retried).toBeGreaterThanOrEqual(1); // a retry was tried before giving up
  });

  it("summarize never orphans a tool_result: recent starts on an assistant, pairs stay intact", async () => {
    // Boundary would naturally land on a user(tool_result) whose assistant(tool_use) is in the summarized older
    // region — the exact orphan case. After the fix, `recent` must start on the assistant so the pair survives.
    const big = "x".repeat(40); // ~10 tok each, so the ~25-tok recent budget lands the raw split on @4
    const msgs: Message[] = [
      { role: "user", content: `start ${big}` }, // 0 older
      {
        role: "assistant",
        content: [
          { type: "text", text: `reading ${big}` },
          { type: "tool_use", id: "A", name: "describe_room", arguments: JSON.stringify({ roomId: "a" }) },
        ],
      }, // 1
      res("A", `contents ${big}`), // 2
      {
        role: "assistant",
        content: [
          { type: "text", text: `editing ${big}` },
          {
            type: "tool_use",
            id: "B",
            name: "place_item",
            arguments: JSON.stringify({ roomId: "a", productId: "chair" }),
          },
        ],
      }, // 3 — must survive as recent[1]
      res("B", `placed ${big}`), // 4 — the raw boundary (orphan if unfixed)
      { role: "assistant", content: [{ type: "text", text: `done ${big}` }] }, // 5
    ];
    const provider = createFakeProvider(["SUMMARY OF OLDER"]);
    const { messages, kind } = await compactIfNeeded(msgs, { provider, plan }, { force: true });

    expect(kind).toBe("summarized");
    expect(contentText(messages[0])).toContain("SUMMARY OF OLDER"); // older → one user summary
    expect(messages[1]?.role).toBe("assistant"); // recent starts on an assistant (turn-aligned), not a tool_result
    expect(orphanedToolResults(messages)).toEqual([]); // and no tool_result is left without its tool_use
  });

  it("force: compacts even under the threshold (reactive overflow path)", async () => {
    // Force should summarize the older half regardless of `auto` — with enough older mass that the swap
    // genuinely shrinks (the monotonicity guard rightly rejects a wrapper bigger than a toy older region).
    const msgs: Message[] = [
      ...Array.from({ length: 4 }, (_, i) => ({
        role: "user" as const,
        content: `old ${i} ${"x".repeat(180)}`,
      })),
      { role: "user", content: `latest ${"w".repeat(36)}` },
    ];
    const provider = createFakeProvider(["FORCED SUMMARY"]);
    const { messages, kind } = await compactIfNeeded(msgs, { provider, plan }, { force: true });
    expect(kind).toBe("summarized");
    expect(contentText(messages[0])).toContain("FORCED SUMMARY");
  });
});

describe("measureWireOverhead — calibrate estimates against the backend's real prompt size", () => {
  it("first measurement taken whole; later ones EMA; overcounting estimates floor at 0", () => {
    // The live incident: est said 4,385, the wire said 8,191 — the wire adds ~3.8k we must not ignore.
    expect(measureWireOverhead(undefined, 8191, 4385)).toBe(3806);
    expect(measureWireOverhead(3806, 8000, 5000)).toBe(Math.round(3806 * 0.5 + 3000 * 0.5));
    expect(measureWireOverhead(3806, 1000, 5000)).toBe(Math.round(3806 * 0.5)); // real < est ⇒ measured floors at 0
  });
});

describe("compactor — recency shield (live-incident regression)", () => {
  // The incident (window-recheck, longctx-changelog-version): 8k window, the model's FIRST turn read the
  // changelog it needed; usage crossed `auto` (6,983 > 5,734) and the mask layer wiped the just-read file to
  // 341 tokens — the model had nothing left to answer from (0/3 after 8/8 pre-enforcement). The shield must
  // keep the newest results verbatim; over-auto-but-under-hard is a SOFT state, so nothing else may fire.
  const plan8k = planCompaction({ window: 8192 });

  /** The incident history: task → assistant fires a search + 2 reads → results incl. a ~5k-token room read.
   *  Cascade holds the three results in one user message; ours are one per message (ADR-029), so the
   *  results sit at indices 2, 3 and 4 where Cascade's are blocks 0, 1 and 2 of message 2. */
  const incident = (): Message[] => [
    { role: "user", content: "Furnish the hall from the brief and the catalogue." },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "g1", name: "search_catalog", arguments: JSON.stringify({ query: "sofa" }) },
        {
          type: "tool_use",
          id: "r1",
          name: "describe_room",
          arguments: JSON.stringify({ roomId: "room-hall" }),
        },
        {
          type: "tool_use",
          id: "r2",
          name: "describe_room",
          arguments: JSON.stringify({ roomId: "room-kitchen" }),
        },
      ],
    },
    res("g1", "sofa-3-seat\nsofa-corner"), // 2
    res("r1", `## room-hall\n${"furniture ".repeat(1900)}`), // 3 — ~19k chars ≈ 4.75k tok
    res("r2", `Level 1\n${"doorways, ".repeat(400)}`), // 4 — ~4k chars ≈ 1k tok
  ];

  it("over auto, under the ceiling, everything recent ⇒ NOTHING is evicted and no summary is attempted", async () => {
    const msgs = incident();
    expect(estimateTokens(msgs)).toBeGreaterThan(plan8k.auto); // the trigger really fires
    // …but the prompt still fits under the survival ceiling (effectiveWindow on small plans — output room).
    expect(estimateTokens(msgs)).toBeLessThan(Math.min(plan8k.hard, plan8k.effectiveWindow));
    const provider = createFakeProvider([]); // summarize must NOT be called
    const { messages, kind } = await compactIfNeeded(msgs, { provider, plan: plan8k });
    expect(kind).toBe("none");
    expect(resultContent(messages[3])).toContain("furniture"); // the read survives verbatim
    expect(provider.calls.length).toBe(0);
  });

  it("the shield rolls forward: once ≥5 newer results exist, the old big read IS evictable", async () => {
    const msgs = incident();
    for (let i = 0; i < 5; i++) {
      msgs.push(use(`n${i}`, "describe_room", { roomId: `room-f${i}` }), res(`n${i}`, `room ${i} contents`));
    }
    const provider = createFakeProvider([]);
    const { messages, kind } = await compactIfNeeded(msgs, { provider, plan: plan8k });
    expect(kind).toBe("masked");
    expect(resultContent(messages[3])).toMatch(/output masked/); // old room read reclaimed
    expect(resultContent(messages[6])).toContain("room 0 contents"); // shielded newer results intact
  });

  it("overheadTokens counts toward every threshold: same messages, overhead pushes past the ceiling", async () => {
    // Live incident (window-gate-5): ~4k of system+tools+template overhead in an 8k window — the compactor
    // planned messages-only, Ollama front-truncated the prompt to 8191/8192 and the model got ONE output token.
    const msgs = incident(); // soft-state WITHOUT overhead (asserted above)…
    const provider = createFakeProvider([]);
    const { messages, kind } = await compactIfNeeded(msgs, { provider, plan: plan8k, overheadTokens: 4000 });
    expect(kind).not.toBe("none"); // …but WITH real overhead the same history must be reclaimed
    expect(estimateTokens(messages) + 4000).toBeLessThan(8192); // and the wire prompt now fits the window
  });

  it("summarize is SKIPPED when the older region is too small to pay for the side-query", async () => {
    // Measured (json-repair-gate): late-game usage hovers just over auto (overhead counted), and every turn
    // paid a 60–120s summarize side-query — sometimes NET-NEGATIVE (wrapper > older; observed 2,114→2,797).
    // Two tasks timed out seconds from success. Tiny older ⇒ no LLM call at all.
    const msgs: Message[] = [
      { role: "user", content: "small task" }, // tiny older region
      use("r1", "describe_room", { roomId: "a" }),
      res("r1", "x".repeat(9000)), // shielded
    ];
    const provider = createFakeProvider([]); // any summarize attempt would be recorded
    const overhead = 3500; // pushes past auto with a tiny older region
    const { kind } = await compactIfNeeded(msgs, { provider, plan: plan8k, overheadTokens: overhead });
    expect(provider.calls.length).toBe(0); // the side-query was never spent
    expect(kind).not.toBe("summarized");
  });

  it("over the CEILING with nothing cheap left, summarize is MANDATORY (silent-truncation safety)", async () => {
    // Measured (item4-gate-2, delegate-prose): cheap layers reclaimed nothing (small results, old markers),
    // the worth-it pre-gate blocked summarize, and the loop proceeded over the ceiling — Ollama silently
    // front-truncated (input 8,159 + output 33 = exactly 8,192) and the model died with 33 tokens of room.
    const msgs: Message[] = [
      { role: "user", content: "the task" },
      // Text-heavy older region: only summarize can reclaim assistant text.
      ...Array.from({ length: 3 }, (_, i) => ({
        role: "assistant" as const,
        content: [{ type: "text" as const, text: `analysis ${i} ${"y".repeat(1600)}` }],
      })),
      use("r9", "describe_room", { roomId: "z" }),
      res("r9", "z".repeat(12000)), // shielded last read
    ];
    const provider = createFakeProvider(["COMPRESSED ANALYSIS"]);
    const { messages, kind } = await compactIfNeeded(msgs, { provider, plan: plan8k, overheadTokens: 3000 });
    expect(kind).toBe("summarized"); // worth-it was bypassed: over the ceiling there is no soft option
    expect(provider.calls.length).toBe(1);
    expect(estimateTokens(messages)).toBeLessThan(estimateTokens(msgs)); // and it genuinely shrank
  });

  it("a summarize that does not SHRINK the history is discarded (monotonicity guard)", async () => {
    const older: Message[] = Array.from({ length: 8 }, (_, i) => ({
      role: "user" as const,
      content: `old ${i} ${"x".repeat(36)}`,
    }));
    const recent: Message[] = [
      { role: "assistant", content: [{ type: "text", text: `r ${"z".repeat(36)}` }] },
      { role: "user", content: `latest ${"w".repeat(36)}` },
    ];
    // The fake model writes a summary far LARGER than the older region it replaces.
    const provider = createFakeProvider(["B".repeat(4000)]);
    const { messages, kind } = await compactIfNeeded(
      [...older, ...recent],
      { provider, plan },
      { force: true },
    );
    expect(kind).not.toBe("summarized"); // swap discarded — history may never GROW from compaction
    // Cascade's line here had no matcher (a no-op); the intent is asserted.
    expect(messages.some((m) => contentText(m).includes("old 0"))).toBe(true); // original older still present
  });

  it("force (reactive overflow) still reclaims: shield shrinks to the very last result", async () => {
    const provider = createFakeProvider([]);
    const { messages } = await compactIfNeeded(incident(), { provider, plan: plan8k }, { force: true });
    expect(resultContent(messages[3])).toMatch(/output masked/); // survival wins: the big read goes
    expect(resultContent(messages[4])).toContain("Level 1"); // …but the LAST result always survives (CC floor of 1)
  });

  it("summarize preserves the ORIGINAL TASK verbatim (weak summarizers lose it)", async () => {
    // Measured failure (window-gate-2, longctx-wire-modules): survival-mode summarize replaced the older
    // region — including the task statement — and the model's next reply was "please share the task".
    const older: Message[] = [
      { role: "user", content: "Lay out a 12-desk office in the east wing with a meeting room for eight." },
      ...Array.from({ length: 6 }, (_, i) => ({
        role: "user" as const,
        content: `noise ${i} ${"x".repeat(36)}`,
      })),
    ];
    const recent: Message[] = [
      { role: "assistant", content: [{ type: "text", text: `working ${"z".repeat(36)}` }] },
      { role: "user", content: `latest ${"w".repeat(36)}` },
    ];
    const provider = createFakeProvider(["SUMMARY WITHOUT THE TASK"]);
    const { messages, kind } = await compactIfNeeded(
      [...older, ...recent],
      { provider, plan },
      { force: true },
    );
    expect(kind).toBe("summarized");
    expect(contentText(messages[0])).toContain("Lay out a 12-desk office"); // the task survives VERBATIM
    expect(contentText(messages[0])).toContain("SUMMARY WITHOUT THE TASK"); // alongside the summary
  });

  it("summarize preserves the LATEST user instruction (harness steering) verbatim", async () => {
    // A just-injected steering message (delegation nudge, verify prompt) must survive a summarize that fires
    // before the model's next call — otherwise the harness steers into a void (caught by delegateNudge test).
    const older: Message[] = [
      { role: "user", content: "Original task here." },
      ...Array.from({ length: 5 }, (_, i) => ({
        role: "user" as const,
        content: `noise ${i} ${"x".repeat(36)}`,
      })),
      {
        role: "user",
        content: "REMINDER: ask the architect with design_layout instead of placing rooms by hand.",
      },
    ];
    const recent: Message[] = [
      { role: "assistant", content: [{ type: "text", text: `ok ${"z".repeat(36)}` }] },
      { role: "user", content: `latest ${"w".repeat(36)}` },
    ];
    const provider = createFakeProvider(["SUMMARY"]);
    const { messages } = await compactIfNeeded([...older, ...recent], { provider, plan }, { force: true });
    expect(contentText(messages[0])).toContain("Original task here.");
    expect(contentText(messages[0])).toContain("ask the architect with design_layout instead");
  });

  it("repeat compaction does NOT nest [Original task] headers (idempotent preservation)", async () => {
    const provider = createFakeProvider(["SUMMARY ONE", "SUMMARY TWO"]);
    const start: Message[] = [
      { role: "user", content: "The one true task." },
      ...Array.from({ length: 6 }, (_, i) => ({
        role: "user" as const,
        content: `noise ${i} ${"x".repeat(36)}`,
      })),
      { role: "assistant", content: [{ type: "text", text: `working ${"z".repeat(36)}` }] },
      { role: "user", content: `more ${"w".repeat(36)}` },
    ];
    const once = await compactIfNeeded(start, { provider, plan }, { force: true });
    const grown: Message[] = [
      ...once.messages,
      ...Array.from({ length: 6 }, (_, i) => ({
        role: "user" as const,
        content: `later ${i} ${"y".repeat(36)}`,
      })),
    ];
    const twice = await compactIfNeeded(grown, { provider, plan }, { force: true });
    const head = contentText(twice.messages[0]);
    expect(head.match(/\[Original task\]/g)?.length).toBe(1); // exactly one header
    expect(head).toContain("The one true task."); // …and the task itself survived two compactions
  });

  it("over HARD ⇒ survival mode: the shield must NOT hold the prompt above the wire ceiling", async () => {
    // The second live incident (window-gate-2, delegate-prose): ONE turn of 7 parallel reads hit ~32k estimated
    // in the 8k window. A 5-wide shield left 21k standing — over `hard`, so Ollama front-truncated the prompt
    // and the model lost its own history. Over hard the shield shrinks to 1 and the compactor MUST reclaim.
    // Cascade's seven results share one user message; ours are seven messages, at indices 2 to 8.
    const msgs: Message[] = [
      { role: "user", content: "Reconcile the seven room surveys into one ground floor." },
      {
        role: "assistant",
        content: Array.from({ length: 7 }, (_, i) => ({
          type: "tool_use" as const,
          id: `m${i}`,
          name: "describe_room",
          arguments: JSON.stringify({ roomId: `room-${i}` }),
        })),
      },
      ...Array.from({ length: 7 }, (_, i) => res(`m${i}`, `room-${i} survey ${"wall ".repeat(3600)}`)), // ~18k chars each
    ];
    expect(estimateTokens(msgs)).toBeGreaterThan(plan8k.hard); // the incident precondition
    const provider = createFakeProvider([]);
    const { messages } = await compactIfNeeded(msgs, { provider, plan: plan8k });
    expect(estimateTokens(messages)).toBeLessThan(plan8k.hard); // the invariant that was violated
    expect(resultContent(messages[8])).toContain("room-6 survey"); // CC's floor of 1: the last result still survives
  });
});

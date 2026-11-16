// Translated from Cascade's compactionLayers.test.ts under ADR-031 (tool names per D2.1, our message shape per ADR-029).
import { describe, expect, it } from "vitest";
import {
  CLEARED_MARKER,
  collapseSuperseded,
  compactionKindLabel,
  maskObservations,
  microcompactToolResults,
  SUPERSEDED_MARKER,
  snipLargeToolInputs,
} from "../../src/context/compactionLayers.js";
import { ALL_COMPACTION_LAYERS, type CompactionPlan, compactIfNeeded } from "../../src/context/compactor.js";
import { type Message, type ToolUseBlock, toolResultMessage, toolResultOf } from "../../src/llm/messages.js";
import { createFakeProvider } from "./fakeProvider.js";

// Helpers to build tool_use / tool_result exchanges in our message shape.
const use = (id: string, name: string, args: unknown): Message => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, arguments: JSON.stringify(args) }],
});
const res = (id: string, content: string): Message => toolResultMessage(id, content);
const resultContent = (m: Message | undefined): string => (m ? (toolResultOf(m)?.content ?? "") : "");

describe("layer: collapse (dedupe superseded reads/searches)", () => {
  it("clears the older read of a file that is read again later; keeps the latest", () => {
    const msgs: Message[] = [
      use("r1", "describe_room", { roomId: "room-a" }),
      res("r1", "A".repeat(400)),
      use("r2", "describe_room", { roomId: "room-a" }),
      res("r2", "B".repeat(400)),
    ];
    const out = collapseSuperseded(msgs, 4);
    expect(resultContent(out[1])).toBe(SUPERSEDED_MARKER); // stale earlier read cleared
    expect(resultContent(out[3])).toBe("B".repeat(400)); // latest read kept
  });

  it("leaves unique reads untouched", () => {
    const msgs: Message[] = [use("r1", "describe_room", { roomId: "room-a" }), res("r1", "A".repeat(400))];
    expect(collapseSuperseded(msgs, 2)).toBe(msgs); // no change → same reference
  });
});

describe("layer: microcompact (evict compactable tool results, keep load-bearing ones)", () => {
  it("clears compactable results but never TodoWrite/Memory results", () => {
    // Cascade's Grep → search_catalog; its TodoWrite → plan_work (load-bearing, never evicted).
    const msgs: Message[] = [
      use("g1", "search_catalog", { query: "x" }),
      res("g1", "search output"),
      use("t1", "plan_work", { todos: [] }),
      res("t1", "todos updated"),
    ];
    const out = microcompactToolResults(msgs, 4);
    // Evicted — with a SELF-DESCRIBING stub (delegate-scatter: anonymous stubs read as "nothing happened").
    expect(resultContent(out[1])).toContain(CLEARED_MARKER);
    expect(resultContent(out[1])).toContain("search_catalog x"); // names the tool and its target
    // and the recovery path (ADR-031 D2.2: an observation's stub says to call it again; Cascade's "Re-run the tool")
    expect(resultContent(out[1])).toContain("Call the tool again");
    expect(resultContent(out[3])).toBe("todos updated"); // plan_work result preserved
  });

  it("does not touch the recent region (idx ≥ olderCount)", () => {
    const msgs: Message[] = [use("g1", "search_catalog", { query: "x" }), res("g1", "search output")];
    const out = microcompactToolResults(msgs, 0); // nothing is "older"
    expect(resultContent(out[1])).toBe("search output");
  });
});

describe("self-describing mask stubs (delegate-scatter rung)", () => {
  it("a masked read names the tool, the file, the size, and both recovery paths", () => {
    const msgs: Message[] = [
      use("r1", "describe_room", { roomId: "room-kitchen" }),
      res("r1", "v".repeat(5000)),
    ];
    const out = maskObservations(msgs, 2, 1000);
    const stub = resultContent(out[1]);
    expect(stub).toContain("describe_room room-kitchen");
    expect(stub).toContain("5000 chars");
    expect(stub).toContain("Call the tool again");
    // Cascade also asserted the stub names its second recovery path, the Subagent tool. Ours has one path
    // (call the tool again, ADR-031 D2.2) and no subagent, so that assertion has nothing to map onto.
    // Idempotent: a described stub is recognized as already-cleared and never re-masked or re-described.
    expect(resultContent(maskObservations(out, 2, 1000)[1])).toBe(stub);
    expect(resultContent(microcompactToolResults(out, 2)[1])).toBe(stub);
  });
});

describe("layer: snip (reclaim large tool INPUTS)", () => {
  it("stubs a large Write input while preserving the record", () => {
    // Cascade's Write(file_path, content) → run_code, whose target is the first line of its script.
    const big = `// draw the kitchen\n${"x".repeat(5000)}`;
    const msgs: Message[] = [use("w1", "run_code", { code: big }), res("w1", "ok")];
    const out = snipLargeToolInputs(msgs, 2, 1000);
    const tu = (out[0]?.content as ToolUseBlock[])[0] as ToolUseBlock;
    const input = JSON.parse(tu.arguments) as { _compacted?: boolean; note?: string };
    expect(input._compacted).toBe(true);
    expect(input.note).toContain("// draw the kitchen");
    expect(tu.arguments.length).toBeLessThan(1000); // body reclaimed
  });

  it("leaves small inputs and the recent region alone", () => {
    // Cascade's small Edit → place_item; a small run_code is added so a large-input tool is exercised too.
    const msgs: Message[] = [
      use("e1", "place_item", { roomId: "room-a", productId: "chair" }),
      res("e1", "ok"),
      use("c1", "run_code", { code: "print(1)" }),
      res("c1", "1"),
    ];
    expect(snipLargeToolInputs(msgs, 4, 1000)).toBe(msgs); // small input → unchanged reference
  });
});

describe("compactionKindLabel", () => {
  it("maps each kind to a human label", () => {
    expect(compactionKindLabel("collapsed")).toMatch(/superseded/);
    expect(compactionKindLabel("microcompacted")).toMatch(/cleared/);
    expect(compactionKindLabel("snipped")).toMatch(/inputs/);
    expect(compactionKindLabel("summarized")).toMatch(/summarized/);
    expect(compactionKindLabel("weird")).toBe("compacted context");
  });
});

describe("pipeline: cheapest layer that suffices wins (no LLM call)", () => {
  it('collapse alone brings history under threshold ⇒ kind "collapsed", provider untouched', async () => {
    const plan: CompactionPlan = {
      window: 1000,
      effectiveWindow: 1000,
      warn: 150,
      auto: 200,
      hard: 900,
      keepRecentTokens: 40,
      // keepRecentResults, economics, deepTarget and tier are required by the plan type; Cascade's fixture
      // predates them.
      keepRecentResults: 5,
      toolResultMaxChars: 2000,
      layers: new Set(ALL_COMPACTION_LAYERS),
      mode: "layered",
      economics: "hosted",
      deepTarget: 200,
      tier: "minimal",
    };
    // r1 (older) is a big read of room-a, superseded by r2 (recent, tiny). Clearing r1 drops us under auto=200.
    const msgs: Message[] = [
      use("r1", "describe_room", { roomId: "room-a" }),
      res("r1", "A".repeat(1200)), // ~300 tokens, older
      use("r2", "describe_room", { roomId: "room-a" }),
      res("r2", "ok"), // recent
      { role: "user", content: "what next?" },
    ];
    const provider = createFakeProvider([]); // summarize must NOT run
    const { messages, kind } = await compactIfNeeded(msgs, { provider, plan });
    expect(kind).toBe("collapsed");
    expect(provider.calls.length).toBe(0);
    expect(resultContent(messages[1])).toBe(SUPERSEDED_MARKER);
  });
});

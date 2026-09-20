// Compaction (ADR-025), against the scenarios that chose it.
//
// Compaction is the one thing in the loop that can quietly make an agent stupid: nothing fails, the
// run just gets worse, and by the time anybody notices there is nothing to point at. So these tests
// are about what survives, not about how much was saved.
import { describe, expect, it } from "vitest";
import {
  type Budget,
  type ChatMessage,
  compact,
  conversationBudget,
  conversationTokens,
  needsCompaction,
  outputRoom,
} from "../src/index.js";

/**
 * The real numbers: a 32,768-token window, 15,655 of it tool schemas and system prompt, 2,048 held
 * back for the reply. That leaves 15,065 for the conversation, which is more than the shield needs
 * and less than a long run produces -- which is the whole situation this code is for.
 */
const budget: Budget = { contextTokens: 32_768, fixedTokens: 15_655, reserve: 2_048 };

const call = (id: string, name: string, args: unknown = {}) => ({
  id,
  name,
  arguments: JSON.stringify(args),
});
const asked = (id: string, name: string, args?: unknown): ChatMessage => ({
  role: "assistant",
  content: null,
  toolCalls: [call(id, name, args)],
});
const answered = (id: string, body: unknown): ChatMessage => ({
  role: "tool",
  toolCallId: id,
  content: JSON.stringify(body),
});
const said = (text: string): ChatMessage => ({ role: "user", content: text });

/** A result fat enough to matter, the size `describe_room` actually returns. */
const fat = (extra: Record<string, unknown> = {}) => ({
  ok: true,
  result: { note: "x".repeat(2_400), ...extra },
  warnings: [],
  changed: null,
});

/**
 * A conversation of n build steps, each a call and a fat answer.
 *
 * `same` makes every call identical, which is what a model re-reading one room looks like; by
 * default each call is about a different thing, which is what a model working through a flat looks
 * like. The difference decides whether one answer supersedes another, so both shapes are needed.
 */
function conversation(n: number, name = "place_item", same = false): ChatMessage[] {
  const out: ChatMessage[] = [said("build a one bedroom flat with an open kitchen")];
  for (let i = 0; i < n; i += 1) {
    out.push(asked(`c${i}`, name, same ? { roomId: "room_1" } : { roomId: `room_${i}` }));
    out.push(answered(`c${i}`, fat({ id: `item_${i}` })));
  }
  return out;
}

const bodies = (ms: readonly ChatMessage[]) => ms.map((m) => String(m.content ?? ""));

describe("the budget", () => {
  it("leaves room for the reply, because the reply is inside the window too", () => {
    expect(conversationBudget(budget)).toBe(32_768 - 15_655 - 2_048);
  });

  it("clamps what a reply may generate to what is actually left", () => {
    // A configured cap is a ceiling, never a promise of room.
    expect(outputRoom({ contextTokens: 32_768, fixedTokens: 0 }, 30_000, 8_000)).toBe(2_768);
    expect(outputRoom({ contextTokens: 32_768, fixedTokens: 0 }, 1_000, 8_000)).toBe(8_000);
    expect(outputRoom({ contextTokens: 32_768, fixedTokens: 0 }, 40_000, 8_000)).toBe(0);
  });

  it("asks about the prompt that is about to be sent, not the one that was", () => {
    const small = conversation(1);
    expect(needsCompaction(small, budget)).toBe(false);
    // One more step of the measured size would not fit, so it is time.
    expect(needsCompaction(small, budget, conversationBudget(budget))).toBe(true);
  });
});

describe("a conversation that fits", () => {
  it("is not touched at all, because touching it costs a prefill", () => {
    const messages = conversation(1);
    const out = compact(messages, budget);
    expect(out.compacted).toBe(false);
    expect(out.messages).toEqual(messages);
    expect(out.before).toBe(out.after);
  });
});

describe("what is never dropped", () => {
  const long = () => {
    const messages = conversation(30);
    messages.splice(1, 0, said("no separate dining room, we eat in the living room"));
    return messages;
  };

  it("keeps every word the person said, however old (scenario S3)", () => {
    const out = compact(long(), budget);
    expect(out.compacted).toBe(true);
    const mine = out.messages.filter((m) => m.role === "user").map((m) => String(m.content));
    expect(mine).toEqual([
      "build a one bedroom flat with an open kitchen",
      "no separate dining room, we eat in the living room",
    ]);
  });

  it("keeps every tool call, so the model still knows what it has done", () => {
    const before = long();
    const out = compact(before, budget);
    const calls = (ms: readonly ChatMessage[]) => ms.flatMap((m) => m.toolCalls ?? []);
    expect(calls(out.messages)).toEqual(calls(before));
  });

  it("keeps a failure in full however old, because a failure is not re-readable (S5)", () => {
    const messages = conversation(30);
    messages[2] = answered("c0", {
      ok: false,
      error: { code: "args.invalid", message: "place_item: recipe.kind is wrong", hint: "use bed" },
      warnings: [],
    });
    const out = compact(messages, budget);
    expect(String(out.messages[2]?.content)).toContain("recipe.kind is wrong");
    expect(String(out.messages[2]?.content)).toContain("use bed");
  });

  it("keeps the newest results in full, and the shield is how many", () => {
    const out = compact(conversation(30), budget, { shield: 3 });
    const results = out.messages.filter((m) => m.role === "tool");
    const whole = results.filter((m) => String(m.content).length > 500);
    expect(whole).toHaveLength(3);
    expect(results.indexOf(whole[0] as ChatMessage)).toBe(results.length - 3);
  });
});

describe("what a receipt keeps", () => {
  it("keeps the identifiers a later call will need (scenario S4)", () => {
    // The catalogue search is the case that matters: it changes nothing, it is one of the fattest
    // results there is, and the product ids inside it are what place_item needs twelve steps later.
    const messages = conversation(30);
    messages[2] = answered("c0", {
      ok: true,
      result: {
        hits: [
          { id: "generic-wardrobe-1200", name: "Generic wardrobe 1200", note: "y".repeat(1_200) },
          { id: "generic-bed-double", name: "Generic double bed", note: "y".repeat(1_200) },
        ],
      },
      warnings: [],
    });
    const out = compact(messages, budget);
    const receipt = String(out.messages[2]?.content);
    expect(receipt).toContain("generic-wardrobe-1200");
    expect(receipt).toContain("generic-bed-double");
    expect(receipt.length).toBeLessThan(400);
  });

  it("names the tool, so the model can tell one receipt from another", () => {
    const messages = conversation(30, "furnish_room");
    const out = compact(messages, budget);
    expect(String(out.messages[2]?.content)).toContain("furnish_room");
  });

  it("says the detail can be read again, where the model will see it", () => {
    // The whole reason receipts are safe here and would not be in a coding agent, said at the
    // moment it is needed rather than far away in the system prompt.
    const out = compact(conversation(30), budget);
    expect(String(out.messages[2]?.content)).toContain("describe_room");
  });

  it("never makes a message longer than it was", () => {
    const messages = conversation(30);
    messages[2] = answered("c0", { ok: true, result: {}, warnings: [] });
    const before = String(messages[2]?.content).length;
    const out = compact(messages, budget);
    expect(String(out.messages[2]?.content).length).toBeLessThanOrEqual(before);
  });
});

describe("a newer answer makes an older one worthless", () => {
  it("drops an earlier read of the same thing even inside the shield", () => {
    const messages = conversation(30, "get_scene", true);
    const out = compact(messages, budget, { shield: 4 });
    const results = out.messages.filter((m) => m.role === "tool");
    const kept = results.filter((m) => String(m.content).length > 500);
    // Only the newest get_scene survives, however wide the shield is.
    expect(kept).toHaveLength(1);
    expect(results.at(-1)).toBe(kept[0]);
    expect(out.dropped.superseded).toBeGreaterThan(0);
  });

  it("leaves a tool that does not supersede itself alone", () => {
    const out = compact(conversation(30, "describe_room"), budget, { shield: 4 });
    const kept = out.messages.filter((m) => m.role === "tool" && String(m.content).length > 500);
    expect(kept).toHaveLength(4);
  });
});

describe("going all the way down rather than just far enough", () => {
  it("leaves enough room that the next compaction is many steps away", () => {
    // The fault the owner found in the first draft. Stopping at the line means paying a prefill on
    // every step; going to the floor means paying it once in a while. The measure that matters is
    // not how many tokens were saved but how many steps of headroom are left, so that is what this
    // asserts: at the measured 545 tokens a step, at least ten more steps before it is needed again.
    const out = compact(conversation(30), budget);
    const GROWTH_PER_STEP = 545;
    const headroom = (conversationBudget(budget) - out.after) / GROWTH_PER_STEP;
    expect(headroom).toBeGreaterThan(10);
    expect(out.overflows).toBe(false);
  });

  it("says so when even the floor will not fit, rather than sending it anyway", () => {
    // A window with no room for the shield at all: the caller has to stop, not hope.
    const tiny: Budget = { contextTokens: 32_768, fixedTokens: 32_000, reserve: 2_048 };
    const out = compact(conversation(30), tiny);
    expect(out.overflows).toBe(true);
  });

  it("reports what it did, so the chat can say it rather than shifting silently", () => {
    const out = compact(conversation(30), budget);
    expect(out.before).toBeGreaterThan(out.after);
    expect(out.dropped["tool-result"]).toBeGreaterThan(0);
    expect(conversationTokens(out.messages)).toBe(out.after);
  });
});

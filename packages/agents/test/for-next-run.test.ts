// What a finished run leaves for the next message in the same chat (ADR-025 D5, kept by ADR-031 D4).
import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  forNextRun,
  type Message,
  textOf,
  toolResultMessage,
  toolResultOf,
  toolUsesOf,
} from "../src/index.js";

const body = (m: Message | undefined): string => (m ? (toolResultOf(m)?.content ?? textOf(m)) : "undefined");
const isResult = (m: Message) => toolResultOf(m) !== null;

const asked = (id: string, name: string, args: unknown = {}): Message => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, arguments: JSON.stringify(args) }],
});
const answered = (id: string, result: unknown): Message => toolResultMessage(id, JSON.stringify(result));
const said = (text: string): Message => ({ role: "user", content: text });

/** A result fat enough to matter, the size `describe_room` actually returns. */
const fat = (extra: Record<string, unknown> = {}) => ({
  ok: true,
  result: { note: "x".repeat(2_400), ...extra },
  warnings: [],
  changed: null,
});

function chat(): Message[] {
  const out: Message[] = [said("build a one bedroom flat with an open kitchen")];
  for (let i = 0; i < 20; i += 1) {
    out.push(asked(`c${i}`, "place_item", { roomId: `room_${i}` }));
    out.push(answered(`c${i}`, fat({ id: `item_${i}` })));
  }
  out.push({ role: "assistant", content: "I built a one bedroom flat with a hall." });
  return out;
}

describe("what a finished run leaves for the next message (scenario S2)", () => {
  it("keeps what was asked and what was answered", () => {
    const out = forNextRun(chat());
    expect(out.filter((m) => m.role === "user" && !isResult(m)).map((m) => body(m))).toEqual([
      "build a one bedroom flat with an open kitchen",
    ]);
    expect(out.at(-1)?.content).toBe("I built a one bedroom flat with a hall.");
  });

  it("is small enough that a third message does not start over the line", () => {
    const before = estimateTokens(chat());
    const after = estimateTokens(forNextRun(chat()));
    expect(after).toBeLessThan(before / 4);
    // Three exchanges of this size used to be over a 32,768-token window before the model spoke: the
    // measured prompt then was 15,655 tokens of schemas and system prompt and 2,048 held for the reply.
    expect(after * 3).toBeLessThan(32_768 - 15_655 - 2_048);
  });

  it("keeps the newest results as receipts, so their identifiers survive", () => {
    const out = forNextRun(chat(), { shield: 2 });
    const results = out.filter(isResult);
    expect(results).toHaveLength(2);
    expect(body(results[0])).toContain("item_18");
  });

  it("never leaves a result whose call is gone, or a call whose result is gone", () => {
    const out = forNextRun(chat(), { shield: 3 });
    const askedIds = new Set(out.flatMap((m) => toolUsesOf(m).map((c) => c.id)));
    const answeredIds = out.filter(isResult).map((m) => toolResultOf(m)?.toolUseId);
    for (const id of answeredIds) expect(askedIds.has(id as string)).toBe(true);
    expect(askedIds.size).toBe(answeredIds.length);
  });

  it("drops the reasoning of a run that is over", () => {
    const messages = chat();
    messages.splice(1, 1, {
      role: "assistant",
      content: [
        { type: "reasoning", wire: "anthropic", data: { type: "thinking" }, text: "plan it" },
        { type: "tool_use", id: "c0", name: "place_item", arguments: "{}" },
      ],
    });
    const out = forNextRun(messages, { shield: 40 });
    expect(JSON.stringify(out)).not.toContain('"reasoning"');
  });
});

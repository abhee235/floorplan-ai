// What a finished run leaves for the next message in the same chat (ADR-025 D5).
//
// Compaction INSIDE a run is Cascade's (context/, ADR-031). This is the other half, which Cascade does not
// have: between runs of the same conversation. Once a run is over its detail is history, and what a person
// remembers of a conversation is what they asked and what they were told, not forty tool calls.

import { type Message, textOf, toolResultOf, toolUsesOf, withResultText } from "./llm/messages.js";

/** Results kept, as receipts, newest first. */
export const DEFAULT_SHIELD = 8;

export interface ForNextRunOptions {
  /** Results kept as receipts, newest first (default DEFAULT_SHIELD). */
  shield?: number;
}

const isToolResult = (m: Message) => toolResultOf(m) !== null;
const resultText = (m: Message) => toolResultOf(m)?.content ?? "";

/** Would this replacement actually be smaller? */
function shorter(m: Message, replacement: string): boolean {
  return replacement.length < resultText(m).length;
}

/** Which call a result answered, when the assistant turn before it says so. */
function askedBy(messages: readonly Message[]): Map<number, { name: string; args: string }> {
  const out = new Map<number, { name: string; args: string }>();
  const byId = new Map<string, { name: string; args: string }>();
  for (const m of messages)
    for (const c of toolUsesOf(m)) byId.set(c.id, { name: c.name, args: c.arguments });
  for (const [i, m] of messages.entries()) {
    const r = toolResultOf(m);
    const call = r ? byId.get(r.toolUseId) : undefined;
    if (call) out.set(i, call);
  }
  return out;
}

/** Keys whose string values are identifiers something later may need to name. */
const ID_KEYS = new Set([
  "id",
  "productId",
  "itemId",
  "roomId",
  "wallId",
  "levelId",
  "openingId",
  "designId",
  "zoneId",
  "groupId",
]);
const MAX_IDS = 20;

/** Ids buried anywhere in a result, in order, capped. */
function idsIn(value: unknown, into: string[] = [], depth = 0): string[] {
  if (into.length >= MAX_IDS || depth > 6 || value === null || typeof value !== "object") return into;
  if (Array.isArray(value)) {
    for (const v of value) idsIn(v, into, depth + 1);
    return into;
  }
  for (const [k, v] of Object.entries(value)) {
    if (into.length >= MAX_IDS) break;
    if (typeof v === "string" && ID_KEYS.has(k)) {
      if (!into.includes(v)) into.push(v);
    } else if (typeof v === "object") idsIn(v, into, depth + 1);
  }
  return into;
}

/** A result reduced to what it named, so the identifiers survive the detail. */
function receipt(m: Message, name: string | undefined): string {
  let ids: string[] = [];
  try {
    ids = idsIn(JSON.parse(resultText(m)));
  } catch {
    // Not our envelope; the receipt still says it happened.
  }
  const what = name ? `${name} ok` : "ok";
  const named = ids.length ? `; ${ids.join(" ")}` : "";
  return JSON.stringify({
    ok: true,
    note: `${what}${named}. Detail dropped to make room; call get_scene, describe_room or search_catalog again to read what you need.`,
  });
}

/**
 * Every word the person said, every answer the agent gave, the newest few results as receipts so the
 * identifiers survive, and nothing else. Without this a chat that has been going all afternoon replays
 * every result it ever saw and is over the window before the model has done anything.
 */
export function forNextRun(messages: readonly Message[], options: ForNextRunOptions = {}): Message[] {
  const shield = options.shield ?? DEFAULT_SHIELD;
  const calls = askedBy(messages);
  const resultAt = messages.map((m, i) => (isToolResult(m) ? i : -1)).filter((i) => i >= 0);
  const keep = new Set(resultAt.slice(-shield));
  // The assistant turn that asked for a result we are keeping has to be kept with it: a result whose call
  // is gone is a message answering nothing.
  const byId = new Map<string, number>();
  for (const [i, m] of messages.entries()) for (const c of toolUsesOf(m)) byId.set(c.id, i);
  const askedFor = new Set<number>();
  for (const i of keep) {
    const r = messages[i] ? toolResultOf(messages[i] as Message) : null;
    const at = r ? byId.get(r.toolUseId) : undefined;
    if (at !== undefined) askedFor.add(at);
  }

  const out: Message[] = [];
  for (const [i, m] of messages.entries()) {
    if (isToolResult(m)) {
      if (!keep.has(i)) continue;
      const line = receipt(m, calls.get(i)?.name);
      out.push(shorter(m, line) ? withResultText(m, line) : { ...m });
      continue;
    }
    if (m.role === "user") {
      out.push({ ...m });
      continue;
    }
    // An assistant turn: kept whole when a kept result answers one of its calls, else only its words.
    // Its reasoning goes with the rest: it belonged to a run that is over.
    const text = textOf(m);
    if (askedFor.has(i))
      out.push({
        role: "assistant",
        content: typeof m.content === "string" ? m.content : m.content.filter((b) => b.type !== "reasoning"),
      });
    else if (text.trim()) out.push({ role: "assistant", content: text });
  }
  return out;
}

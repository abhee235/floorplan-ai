// Compaction: what to drop when the conversation outgrows the window (ADR-025).
//
// Pure: messages in, messages out, no model call and no I/O. That is deliberate. Compaction is the
// one thing in the loop that can quietly make an agent stupid, so it has to be the thing that is
// easiest to test.
//
// Two facts decided the shape of this, and both were measured rather than assumed.
//
// Forty-eight per cent of every prompt is tool schemas and the system prompt, re-sent on every step.
// Compaction can only ever touch the other half, and the floor it can reach is therefore an absolute
// number rather than a percentage of the window.
//
// Eighty-seven per cent of the conversation is tool results, and our tool results are not a coding
// agent's file reads. They describe a project that is still there: a result saying a wall was made
// is worthless the moment the wall exists, because the scene can be read again exactly. So old
// results become one line each, for nothing, where a coding agent would have to pay a model to
// summarise them.

import type { ChatMessage } from "./provider.js";

/** Results kept in full, newest first. Eight is about 3,100 tokens at the measured average. */
export const DEFAULT_SHIELD = 8;

/**
 * Room left for the reply, in tokens.
 *
 * The window holds the prompt and what the model generates, so a budget that counts only the prompt
 * is wrong twice over. Measured, our replies ran 40 to 219 tokens a step and the architect's longest
 * was 766; this is generous without being wasteful.
 */
export const REPLY_RESERVE = 2_048;

/**
 * Characters per token, for estimating a prompt that has not been sent yet.
 *
 * Measured at 3.57 on a real run against a Qwen build; rounded down, because guessing a prompt is
 * smaller than it is loses a run and guessing it is bigger only compacts slightly early. Every
 * estimate is corrected by what the server reports as soon as a reply comes back.
 */
const CHARS_PER_TOKEN = 3.4;

const SUPERSEDED = '{"ok":true,"note":"a later call answered this; read it there"}';
const DISCARDED = '{"ok":true,"note":"answered, and dropped to make room"}';

/** Tools whose newest answer makes every older answer about the same thing worthless. */
const SUPERSEDING = new Set(["get_scene", "describe_room", "validate", "measure", "project"]);

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** What one message costs on the wire, near enough to budget with. */
export function messageTokens(m: ChatMessage): number {
  const content = typeof m.content === "string" ? m.content : m.content ? JSON.stringify(m.content) : "";
  const calls = m.toolCalls?.length ? JSON.stringify(m.toolCalls) : "";
  // Four for the role, the delimiters and the rest of the envelope, which is small but not nothing
  // over forty messages.
  return estimateTokens(content) + estimateTokens(calls) + 4;
}

export function conversationTokens(messages: readonly ChatMessage[]): number {
  let n = 0;
  for (const m of messages) n += messageTokens(m);
  return n;
}

export interface Budget {
  /** The model's whole window. */
  contextTokens: number;
  /** What the prompt costs before a word of conversation: system prompt plus tool schemas. */
  fixedTokens: number;
  /** Room left for the reply (default REPLY_RESERVE). */
  reserve?: number;
}

/** The largest a conversation may be and still leave room for the fixed prompt and a reply. */
export function conversationBudget(budget: Budget): number {
  return Math.max(0, budget.contextTokens - budget.fixedTokens - (budget.reserve ?? REPLY_RESERVE));
}

/**
 * How much a reply may generate, given what the prompt actually costs.
 *
 * A configured cap is a ceiling, never a promise of room: a model allowed eight thousand tokens
 * cannot have them in a window with three thousand left, and a server asked for the impossible
 * either refuses or truncates mid-sentence.
 */
export function outputRoom(budget: Budget, promptTokens: number, cap: number | undefined): number {
  const left = Math.max(0, budget.contextTokens - promptTokens);
  return cap ? Math.min(cap, left) : left;
}

export type Reason = "tool-result" | "superseded" | "receipt";

export interface CompactionResult {
  messages: ChatMessage[];
  /** True when anything was changed at all. */
  compacted: boolean;
  before: number;
  after: number;
  /** How many messages each layer touched, for the note the chat shows. */
  dropped: Record<Reason, number>;
  /** True when even the floor does not fit, so the caller must stop rather than send it. */
  overflows: boolean;
}

export interface CompactionOptions {
  /** Results kept in full, newest first (default DEFAULT_SHIELD). */
  shield?: number;
}

const isToolResult = (m: ChatMessage) => m.role === "tool";

/**
 * Would this replacement actually be smaller?
 *
 * Every layer asks, because a result can be shorter than the note explaining that it was removed,
 * and spending tokens to say a token was saved is the one outcome worse than doing nothing.
 */
function shorter(m: ChatMessage, replacement: string): boolean {
  return replacement.length < String(m.content ?? "").length;
}

/** A result the model said failed: kept forever, because it is the one kind that is not re-readable. */
function isFailure(m: ChatMessage): boolean {
  if (typeof m.content !== "string") return false;
  // The envelope is `{"ok":false,...}` or a plain string when a tool threw; both matter.
  return m.content.includes('"ok":false') || m.content.includes('"ok": false');
}

/** Which call a result answered, when the assistant turn before it says so. */
function askedBy(messages: readonly ChatMessage[]): Map<number, { name: string; args: string }> {
  const out = new Map<number, { name: string; args: string }>();
  const byId = new Map<string, { name: string; args: string }>();
  for (const m of messages)
    for (const c of m.toolCalls ?? []) byId.set(c.id, { name: c.name, args: c.arguments });
  for (const [i, m] of messages.entries()) {
    if (!isToolResult(m)) continue;
    const call = m.toolCallId ? byId.get(m.toolCallId) : undefined;
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

/** Ids buried anywhere in a result, newest-first order preserved, capped. */
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

const MAX_IDS = 20;

/**
 * What a result named, so dropping the body does not drop the identifiers that came with it.
 *
 * Ids are collected from anywhere in the result, not only from the list of what changed. A catalog
 * search changes nothing and is one of the fattest results there is, and the product ids inside it
 * are exactly what a later call needs; a receipt that kept only the changed refs would have thrown
 * them away and left the model naming a product it can no longer spell.
 */
function receipt(m: ChatMessage, name: string | undefined): string {
  const body = typeof m.content === "string" ? m.content : "";
  let ids: string[] = [];
  try {
    ids = idsIn(JSON.parse(body));
  } catch {
    // Not our envelope; the receipt still says it happened.
  }
  const what = name ? `${name} ok` : "ok";
  const named = ids.length ? `; ${ids.join(" ")}` : "";
  // The last clause is why this is safe here and would not be in a coding agent, said at the moment
  // it is needed rather than far away in the system prompt.
  return JSON.stringify({
    ok: true,
    note: `${what}${named}. Detail dropped to make room; call get_scene, describe_room or search_catalog again to read what you need.`,
  });
}

/**
 * Compact a conversation until it fits, and then keep going until it cannot go further.
 *
 * Both halves of that matter, and the second is the one that is easy to get wrong. Compaction
 * rewrites the middle of the message array, so the server's cached prefix survives only as far as
 * the first message that changed and everything after it is prefilled again. Stopping the moment the
 * prompt fits means paying that on the very next step too. Measured on one machine: stopping early
 * compacts every step at about 48 seconds each; going to the floor compacts once every seventeen
 * steps at about eighteen. So once the decision is made, every layer runs.
 */
export function compact(
  messages: readonly ChatMessage[],
  budget: Budget,
  options: CompactionOptions = {},
): CompactionResult {
  const before = conversationTokens(messages);
  const limit = conversationBudget(budget);
  const dropped: Record<Reason, number> = { "tool-result": 0, superseded: 0, receipt: 0 };
  if (before <= limit)
    return { messages: [...messages], compacted: false, before, after: before, dropped, overflows: false };

  const calls = askedBy(messages);
  const out = messages.map((m) => ({ ...m }));
  const shield = options.shield ?? DEFAULT_SHIELD;

  // Which results are inside the shield: the newest `shield` results, counted from the end.
  const resultAt = out.map((m, i) => (isToolResult(m) ? i : -1)).filter((i) => i >= 0);
  const shielded = new Set(resultAt.slice(-shield));

  // Layer 1: everything outside the shield becomes a receipt, failures excepted.
  for (const i of resultAt) {
    const m = out[i] as ChatMessage;
    if (shielded.has(i) || isFailure(m)) continue;
    const line = receipt(m, calls.get(i)?.name);
    if (!shorter(m, line)) continue;
    m.content = line;
    dropped["tool-result"] += 1;
  }

  // Layer 2: a newer read of the same thing makes an older one worthless, shield or not.
  // Keyed on the arguments as well as the name, and that is not a detail: describing the bedroom
  // says nothing about the kitchen, so two describe_room calls only supersede each other when they
  // are about the same room.
  const seen = new Set<string>();
  for (const i of [...resultAt].reverse()) {
    const call = calls.get(i);
    if (!call || !SUPERSEDING.has(call.name)) continue;
    const m = out[i] as ChatMessage;
    if (isFailure(m)) continue;
    const key = `${call.name}:${call.args}`;
    if (seen.has(key)) {
      if (shorter(m, SUPERSEDED)) {
        m.content = SUPERSEDED;
        dropped.superseded += 1;
      }
    } else seen.add(key);
  }

  // Layer 3: the receipts themselves go, oldest first, and only as far as is needed. Unlike the
  // layers above this one loses the fact that a call was answered at all, so it is not run to the
  // floor for its own sake.
  if (conversationTokens(out) > limit) {
    for (const i of resultAt) {
      if (conversationTokens(out) <= limit) break;
      if (shielded.has(i)) continue;
      const m = out[i] as ChatMessage;
      if (isFailure(m) || !shorter(m, DISCARDED)) continue;
      m.content = DISCARDED;
      dropped.receipt += 1;
    }
  }

  const after = conversationTokens(out);
  // Layer 4 is the caller's: there is nothing left to remove that would not remove the task.
  return { messages: out, compacted: true, before, after, dropped, overflows: after > limit };
}

/**
 * Should this conversation be compacted before the next step?
 *
 * As late as is safe, and no earlier: a conversation that fits is never touched, because touching it
 * costs a prefill. `expectedGrowth` is what one more step is likely to add, so the answer is about
 * the prompt that is about to be sent rather than the one that already was.
 */
export function needsCompaction(
  messages: readonly ChatMessage[],
  budget: Budget,
  expectedGrowth = 0,
): boolean {
  return conversationTokens(messages) + expectedGrowth > conversationBudget(budget);
}

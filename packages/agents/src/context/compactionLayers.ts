// context/compactionLayers.ts — the pure, no-LLM compaction layers (Cascade ADR-039). Each is a history
// transform that reclaims tokens from the OLDER region (indices < olderCount) while leaving the
// recent-verbatim window and all reasoning/text untouched. The orchestrator (compactor.ts) runs the enabled
// layers cheapest-first, escalating to the LLM summary only if they don't free enough.
//
// Ported from Cascade (packages/core/src/context/compactionLayers.ts) under ADR-031 D1. The layers, their
// order, the shields and the stubs' shape are Cascade's. What had to change is marked "ADR-031 D2.n":
// Cascade's tools are Read/Grep/Glob/Edit/Write/Bash, ours are a floor-plan registry; our tool arguments are
// the text the model wrote (ADR-029 D1) rather than an object; and a change to a building cannot be
// "re-run" to get its result back, so its stub keeps the ids it named instead.
//
// Traced (by Cascade) from Claude Code's stack (src/services/compact/microCompact.ts, apiMicrocompact.ts).
// Improvement over CC's cheap layers: they all clear tool *outputs*; `snip` ALSO reclaims large tool
// *inputs* — here a whole run_code script or a batch of two hundred calls.

import type { Block, Message, ToolResultBlock, ToolUseBlock } from "../llm/messages.js";

// ── Which tools are which (ADR-031 D2.1) ────────────────────────────────────────────────────────────────

/**
 * Observations: bulky, re-derivable reads of a project that is still there. Their stub says to call the
 * tool again. Cascade's equivalents: Read, Grep, Glob.
 */
export const OBSERVATION_TOOLS = new Set<string>([
  "get_scene",
  "describe_room",
  "measure",
  "validate",
  "search_catalog",
  "project",
  "history",
  "get_bom",
  "query_design",
  "look_at",
  "preview_design",
  "render",
  "read_page",
  "web_search",
  "read_skill",
]);

/**
 * Actions: their result says what was done and names what was made. Calling one again does it again (a
 * second chair), so their stub keeps the ids and says to read the scene instead (ADR-031 D2.2).
 * Cascade's equivalents: Edit, Write, Bash.
 */
export const ACTION_TOOLS = new Set<string>([
  "create_walls",
  "modify_wall",
  "delete",
  "add_opening",
  "create_room",
  "modify_room",
  "place_item",
  "modify_item",
  "arrange",
  "create_room_from_brief",
  "furnish_room",
  "verify_product",
  "batch",
  "export",
  "import_plan",
  "finish_opening",
  "modify_opening",
  "finish_wall",
  "finish_item",
  "add_level",
  "plan_rooms",
  "check_design",
  "build_design",
  "revise_design",
  "tidy_design",
  "run_code",
]);

/**
 * Tools whose results are safe to evict. Deliberately EXCLUDES results that are load-bearing state the model
 * must keep verbatim: plan_work, notes, ask_user (a person's answer) and design_layout (the architect's
 * design, which build_design names by id). Mirrors Claude Code's COMPACTABLE_TOOLS (microCompact.ts:41).
 */
export const COMPACTABLE_TOOLS = new Set<string>([...OBSERVATION_TOOLS, ...ACTION_TOOLS]);

/** Reads that dedupe cleanly by what they asked (used by `collapse`). Pictures are left out: two previews
 *  of the same level at different moments are two different pictures. */
const READ_SEARCH_TOOLS = new Set<string>([
  "get_scene",
  "describe_room",
  "measure",
  "validate",
  "search_catalog",
  "project",
  "get_bom",
  "query_design",
  "read_page",
  "web_search",
  "read_skill",
]);

/** Tools whose INPUT can be huge — targeted by `snip`. Cascade's: Write, Edit, Bash. */
const LARGE_INPUT_TOOLS = new Set<string>([
  "run_code",
  "batch",
  "check_design",
  "revise_design",
  "design_layout",
  "plan_rooms",
  "create_walls",
  "import_plan",
]);

// Content markers. Kept human-readable so the model understands why the bytes are gone (and so `snip` can
// recognise an already-spent result). `isClearedContent` is the single source of truth for "already evicted".
const MASK_PREFIX = "[output masked";
export const SUPERSEDED_MARKER =
  "[Superseded — a newer call of the same tool with the same arguments appears later; this stale copy was cleared to save context.]";
/** Prefix of a microcompact-cleared result (the full text is per-block: it names the tool + target). */
export const CLEARED_MARKER = "[Old tool result cleared";

/** True if a tool_result's content was already evicted by an earlier layer (mask/collapse/microcompact). */
export function isClearedContent(content: string): boolean {
  return (
    content.startsWith(MASK_PREFIX) || content === SUPERSEDED_MARKER || content.startsWith(CLEARED_MARKER)
  );
}

/** The arguments of a call as an object; ADR-031 D2.4 — ours are the text the model wrote. */
export function argsOf(use: ToolUseBlock | undefined): Record<string, unknown> {
  if (!use) return {};
  try {
    const v = JSON.parse(use.arguments);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Keys that name what a call was about, first match wins (ADR-031 D2.1; Cascade: file_path, pattern…). */
const TARGET_KEYS = [
  "roomId",
  "itemId",
  "wallId",
  "openingId",
  "designId",
  "levelId",
  "attachmentId",
  "name",
  "query",
  "url",
  "brief",
  "detail",
  "scope",
];

/** Short "what was this" descriptor from a tool_use input — SELF-DESCRIBING STUBS. Measured (Cascade,
 *  delegate-scatter, three gates): a weak model shown six anonymous "[output masked — N chars elided]"
 *  stubs concluded nothing had happened. A stub must answer what was masked and how to get it back. */
function targetOf(use: ToolUseBlock | undefined): string {
  const a = argsOf(use);
  if (use?.name === "run_code" && typeof a.code === "string") {
    const first = a.code.trim().split("\n")[0] ?? "";
    return first ? ` ${first.slice(0, 80)}` : "";
  }
  for (const k of TARGET_KEYS) {
    const t = a[k];
    if (typeof t === "string" && t.length > 0) return ` ${t.slice(0, 80)}`;
  }
  return "";
}

/** Keys whose string values are identifiers a later call may need to name (ADR-025 D6's receipt). */
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

/**
 * RECENCY SHIELD (CC parity — microCompact.ts keepRecent, default 5): the ids of the last `keepCount`
 * compactable tool calls. Eviction layers must never touch these — the newest observations are the model's
 * working set, and clearing them leaves it with nothing (CC: "clearing ALL results leaves the model with zero
 * working context"). Live incident (Cascade): an 8k-window task read a changelog, the mask layer fired at
 * 6,983 tokens and wiped the just-read file to 341 tokens; the model had nothing left to answer from.
 */
export function shieldedResultIds(messages: Message[], keepCount: number): Set<string> {
  const ids: string[] = [];
  for (const m of messages) {
    const blocks = asBlocks(m);
    if (!blocks) continue;
    for (const b of blocks) {
      if (b.type === "tool_use" && COMPACTABLE_TOOLS.has(b.name)) ids.push(b.id);
    }
  }
  return new Set(ids.slice(-Math.max(1, keepCount))); // floor 1 = CC's "always keep at least the last"
}

/** Ids that name the thing a call is about, for the unconsumed-read shield (ADR-031 D2.3). */
const SUBJECT_KEYS = ["roomId", "wallId", "levelId", "itemId", "openingId"];

/**
 * UNCONSUMED-READ SHIELD (Cascade ADR-058, the Simmer live-lock): ids of the latest read of each subject that
 * has NOT been acted on since. The flat recency shield protects "the last N results" — but a model that reads,
 * then narrates for two turns, watches that read get masked before it acts, and has to read again. A read
 * whose subject was since changed is CONSUMED (the healthy cycle) and needs no protection; the read still
 * waiting to drive a change is the working set.
 *
 * ADR-031 D2.3: Cascade's read is Read(file_path) and its change Write/Edit(file_path). Here a read is an
 * observation that names a room, wall, level, item or opening, and it is consumed by an action naming the
 * same one.
 *
 * Bounded on purpose: only the last `horizon` messages are scanned, and at most `cap` subjects are shielded
 * (pressure must stay reclaimable). Never applied in survival mode (compactor policy: survival beats recency).
 */
export function unconsumedReadIds(messages: Message[], cap = 3, horizon = 16): Set<string> {
  const errored = new Set<string>();
  for (const m of messages) {
    const blocks = asBlocks(m);
    if (!blocks) continue;
    for (const b of blocks) if (b.type === "tool_result" && b.isError) errored.add(b.toolUseId);
  }
  const lastRead = new Map<string, { id: string; pos: number }>();
  const lastMutate = new Map<string, number>();
  let pos = 0;
  for (let i = Math.max(0, messages.length - horizon); i < messages.length; i++) {
    const blocks = asBlocks(messages[i] as Message);
    if (!blocks) continue;
    for (const b of blocks) {
      if (b.type !== "tool_use") continue;
      pos++;
      const a = argsOf(b);
      const subjects = SUBJECT_KEYS.map((k) => a[k]).filter(
        (v): v is string => typeof v === "string" && v !== "",
      );
      if (subjects.length === 0) continue;
      for (const s of subjects) {
        if (OBSERVATION_TOOLS.has(b.name) && !errored.has(b.id)) lastRead.set(s, { id: b.id, pos });
        else if (ACTION_TOOLS.has(b.name)) lastMutate.set(s, pos);
      }
    }
  }
  const unconsumed = [...lastRead.entries()]
    .filter(([subject, read]) => (lastMutate.get(subject) ?? -1) < read.pos)
    .sort((a, b) => a[1].pos - b[1].pos);
  return new Set(unconsumed.slice(-cap).map(([, read]) => read.id));
}

export type CompactionKind =
  | "none"
  | "collapsed"
  | "masked"
  | "microcompacted"
  | "snipped"
  | "summarized"
  /** Summarize's no-model FALLBACK: the summarizer itself was unreachable, so the older region is dropped
   *  with only the verbatim task + latest instruction preserved. Lossy — but a degraded round beats a dead
   *  one (Cascade iterate-5: two rounds died here). */
  | "dropped";

/** Human label for the `compacted` event (single source of truth for the chat and the log). */
export function compactionKindLabel(kind: string): string {
  switch (kind) {
    case "collapsed":
      return "collapsed superseded reads";
    case "masked":
      return "masked large old tool output";
    case "microcompacted":
      return "cleared old tool results";
    case "snipped":
      return "snipped large tool inputs";
    case "summarized":
      return "summarized older turns";
    case "dropped":
      return "dropped older turns (summarizer unavailable; task preserved)";
    default:
      return "compacted context";
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────

const asBlocks = (m: Message): Block[] | null => (typeof m.content === "string" ? null : m.content);

/** Map tool_use id → the tool_use block across the whole history (results carry only the id; the eviction
 *  stubs need the NAME and the input's target to self-describe). */
function toolUseById(messages: Message[]): Map<string, ToolUseBlock> {
  const map = new Map<string, ToolUseBlock>();
  for (const m of messages) {
    const blocks = asBlocks(m);
    if (!blocks) continue;
    for (const b of blocks) if (b.type === "tool_use") map.set(b.id, b);
  }
  return map;
}

/**
 * The self-describing eviction stub: what was evicted, and how to get it back.
 *
 * ADR-031 D2.2: an observation is got back by calling it again (Cascade's wording). An action is not --
 * calling it again does it again -- so its stub keeps the ids the result named and points at the scene.
 */
function describeEvicted(
  use: ToolUseBlock | undefined,
  prefix: string,
  content: string,
  chars?: number,
): string {
  const what = use ? ` — ${use.name}${targetOf(use)}` : "";
  const size = chars !== undefined ? `, ${chars} chars elided` : "";
  if (use && ACTION_TOOLS.has(use.name)) {
    let ids: string[] = [];
    try {
      ids = idsIn(JSON.parse(content));
    } catch {
      // not our envelope; the stub still says it happened
    }
    const failed = /"ok"\s*:\s*false/.test(content);
    const named = ids.length ? ` It named: ${ids.join(" ")}.` : "";
    return `${prefix}${what}${size}. ${failed ? "It failed." : "It was done; do not repeat it."}${named} Read the scene (get_scene, describe_room) for the current state.]`;
  }
  return `${prefix}${what}${size}. Call the tool again if you still need this content.]`;
}

/** A stable dedupe key for a read, or null if it isn't dedupable: the tool and its arguments, key-sorted. */
function dedupeKey(block: ToolUseBlock): string | null {
  if (!READ_SEARCH_TOOLS.has(block.name)) return null;
  return `${block.name}:${canonical(argsOf(block))}`;
}

function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sort(value));
}

/** Rewrite the tool_result blocks of `message` whose id is in `ids` (and not already cleared) to `marker`. */
function clearResults(message: Message, ids: Set<string>, marker: string): Message {
  const blocks = asBlocks(message);
  if (!blocks) return message;
  let touched = false;
  const next = blocks.map((b) => {
    if (b.type === "tool_result" && ids.has(b.toolUseId) && !isClearedContent(b.content)) {
      touched = true;
      return { ...b, content: marker };
    }
    return b;
  });
  return touched ? { ...message, content: next } : message;
}

// ── Layer: collapse (dedup superseded reads) ─────────────────────────────────────────────────────────────
/**
 * Clear the results of reads that are SUPERSEDED — the same tool was called with the same arguments later in
 * the conversation. The freshest copy is kept; the stale earlier copies (in the OLDER region) are cleared.
 * Lossless in practice: the newer read reflects current state. Cheapest, safest layer.
 */
export function collapseSuperseded(messages: Message[], olderCount: number): Message[] {
  const latestIdForKey = new Map<string, string>();
  for (const m of messages) {
    const blocks = asBlocks(m);
    if (!blocks) continue;
    for (const b of blocks) {
      if (b.type !== "tool_use") continue;
      const key = dedupeKey(b);
      if (key) latestIdForKey.set(key, b.id); // later occurrences overwrite → holds the latest
    }
  }
  const superseded = new Set<string>();
  for (const m of messages) {
    const blocks = asBlocks(m);
    if (!blocks) continue;
    for (const b of blocks) {
      if (b.type !== "tool_use") continue;
      const key = dedupeKey(b);
      if (key && latestIdForKey.get(key) !== b.id) superseded.add(b.id);
    }
  }
  if (superseded.size === 0) return messages;
  return messages.map((m, idx) => (idx < olderCount ? clearResults(m, superseded, SUPERSEDED_MARKER) : m));
}

// ── Layer: mask (size-gated eviction of any oversized old tool output) ──────────────────────────────────────
/**
 * Replace tool_result blocks in the OLDER region whose content exceeds `maxToolChars` with a short
 * placeholder. Name-agnostic on purpose: the size gate is the safety valve (small, load-bearing results stay).
 */
export function maskObservations(
  messages: Message[],
  olderCount: number,
  maxToolChars = 2000,
  shield?: Set<string>,
): Message[] {
  const uses = toolUseById(messages);
  let changed = false;
  const out = messages.map((m, idx) => {
    if (idx >= olderCount) return m;
    const blocks = asBlocks(m);
    if (!blocks) return m;
    let touched = false;
    const next = blocks.map((b) => {
      if (b.type === "tool_result" && shield?.has(b.toolUseId)) return b; // recency shield
      // ADR-031 D2.1: name-agnostic like Cascade, except the load-bearing few are never masked.
      if (b.type === "tool_result" && !COMPACTABLE_TOOLS.has(uses.get(b.toolUseId)?.name ?? "")) return b;
      if (b.type === "tool_result" && !isClearedContent(b.content) && b.content.length > maxToolChars) {
        touched = true;
        return {
          ...b,
          content: describeEvicted(uses.get(b.toolUseId), MASK_PREFIX, b.content, b.content.length),
        };
      }
      return b;
    });
    if (!touched) return m;
    changed = true;
    return { ...m, content: next };
  });
  return changed ? out : messages; // no-op ⇒ same reference (uniform with the other layers)
}

// ── Layer: microcompact (evict all remaining compactable tool results) ──────────────────────────────────────
/**
 * Clear the content of EVERY remaining compactable tool_result in the OLDER region, regardless of size — the
 * aggressive observation-eviction layer. Ported from Claude Code's microcompact (microCompact.ts): keyed on the
 * tool NAME (COMPACTABLE_TOOLS) so load-bearing results (plan_work, notes, ask_user, design_layout) are never
 * touched.
 */
export function microcompactToolResults(
  messages: Message[],
  olderCount: number,
  shield?: Set<string>,
): Message[] {
  const uses = toolUseById(messages);
  let changed = false;
  const out = messages.map((m, idx) => {
    if (idx >= olderCount) return m;
    const blocks = asBlocks(m);
    if (!blocks) return m;
    let touched = false;
    const next = blocks.map((b) => {
      if (b.type === "tool_result" && shield?.has(b.toolUseId)) return b; // recency shield
      if (
        b.type === "tool_result" &&
        !isClearedContent(b.content) &&
        COMPACTABLE_TOOLS.has(uses.get(b.toolUseId)?.name ?? "")
      ) {
        touched = true;
        return { ...b, content: describeEvicted(uses.get(b.toolUseId), CLEARED_MARKER, b.content) };
      }
      return b;
    });
    if (!touched) return m;
    changed = true;
    return { ...m, content: next };
  });
  return changed ? out : messages; // no-op ⇒ same reference
}

// ── Layer: snip (reclaim large tool INPUTS) ─────────────────────────────────────────────────────────────────
/**
 * Reclaim the largest bytes the output-clearing layers can't touch: big tool_use INPUTS (a run_code script, a
 * batch of calls, a whole design) in the OLDER region. The input is replaced with a compact stub that
 * PRESERVES the record ("run_code — input elided (8,200 chars)") so the model still knows the operation
 * happened. This is Cascade's step beyond Claude Code's cheap layers, which only ever clear outputs.
 */
export function snipLargeToolInputs(
  messages: Message[],
  olderCount: number,
  maxInputChars: number,
  shield?: Set<string>,
): Message[] {
  let changed = false;
  const out = messages.map((m, idx) => {
    if (idx >= olderCount) return m;
    const blocks = asBlocks(m);
    if (!blocks) return m;
    let touched = false;
    const next = blocks.map((b) => {
      if (b.type !== "tool_use" || !LARGE_INPUT_TOOLS.has(b.name)) return b;
      if (shield?.has(b.id)) return b; // recency shield
      if (b.arguments.length <= maxInputChars) return b;
      const stub = stubForToolUse(b);
      if (stub === b.arguments) return b;
      touched = true;
      return { ...b, arguments: stub };
    });
    if (!touched) return m;
    changed = true;
    return { ...m, content: next };
  });
  return changed ? out : messages; // no-op ⇒ same reference
}

/** A tiny descriptor for a large tool_use input, keeping the identifying field, dropping the body. */
function stubForToolUse(block: ToolUseBlock): string {
  const a = argsOf(block);
  if (a._compacted) return block.arguments; // already snipped — idempotent
  return JSON.stringify({
    _compacted: true,
    note: `${block.name}${targetOf(block)} — input elided (${block.arguments.length} chars) to save context`,
  });
}

// Re-export the block subtypes callers occasionally need.
export type { ToolResultBlock, ToolUseBlock };

// The conversation, in a form that belongs to no vendor (ADR-029 D1).
//
// The runner, compaction, the saved conversation and every role hold messages in this shape, and each
// adapter translates it at its own edge. The vocabulary is content blocks -- text, image, tool_use,
// tool_result -- because that is the richest of the four wires we speak, and translating down from it
// loses nothing a wire can carry, where translating up from OpenAI's chat format had to invent things.
//
// Two rules are ours and every adapter relies on them:
//
// - A tool result is a user message of its own, holding exactly one tool_result block. Compaction
//   (ADR-025) replaces and drops results one at a time by index, and the adapters merge a run of
//   results into whatever their wire wants.
// - Reasoning is kept as an opaque block tagged with the wire that made it, and only that wire is sent
//   it back. The loop keeps it and never reads it.

export type TextBlock = { type: "text"; text: string };
/** A picture: a data: URL (data:image/png;base64,...) or an http(s) address. */
export type ImageBlock = { type: "image"; url: string };
/** A call the model made. `arguments` is the text it wrote, which may not even be JSON. */
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; arguments: string };
export type ToolResultBlock = { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };
/**
 * A model's reasoning, as the wire that produced it wants it back: a Claude thinking block with its
 * signature, an OpenAI reasoning item with its encrypted content. `text` is a readable summary, when
 * the server gave one, for transcripts only.
 */
export type ReasoningBlock = { type: "reasoning"; wire: string; data: unknown; text?: string };

export type Block = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | ReasoningBlock;

export interface Message {
  role: "user" | "assistant";
  content: string | Block[];
}

/** The blocks of a message, a plain string read as one text block. */
export function blocksOf(m: Pick<Message, "content">): Block[] {
  if (typeof m.content === "string") return m.content ? [{ type: "text", text: m.content }] : [];
  return m.content;
}

/** The text of a message, its text blocks joined by blank lines. */
export function textOf(m: Pick<Message, "content">): string {
  return blocksOf(m)
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}

export function toolUsesOf(m: Pick<Message, "content">): ToolUseBlock[] {
  return blocksOf(m).filter((b): b is ToolUseBlock => b.type === "tool_use");
}

export function imagesOf(m: Pick<Message, "content">): ImageBlock[] {
  return blocksOf(m).filter((b): b is ImageBlock => b.type === "image");
}

export function reasoningOf(m: Pick<Message, "content">, wire: string): ReasoningBlock[] {
  return blocksOf(m).filter((b): b is ReasoningBlock => b.type === "reasoning" && b.wire === wire);
}

/** The result a message carries, when it is a tool-result message (see the rules above). */
export function toolResultOf(m: Message): ToolResultBlock | null {
  if (m.role !== "user" || typeof m.content === "string") return null;
  const first = m.content[0];
  return m.content.length === 1 && first?.type === "tool_result" ? first : null;
}

export function toolResultMessage(toolUseId: string, content: string, isError = false): Message {
  return {
    role: "user",
    content: [{ type: "tool_result", toolUseId, content, ...(isError ? { isError: true } : {}) }],
  };
}

/** The same tool-result message with different text; any other message comes back unchanged. */
export function withResultText(m: Message, content: string): Message {
  const r = toolResultOf(m);
  return r ? { role: "user", content: [{ ...r, content }] } : m;
}

/**
 * The conversation with every call paired to its result: a call nobody answered and a result whose
 * call is gone are both left out.
 *
 * Every wire with call ids refuses either (Claude and OpenAI with a 400, which then replays on every
 * later turn because the bad pair is in the saved history), and a real history has both: compaction
 * keeps a turn whose other results it dropped, and a run stopped mid-turn is saved with calls that
 * never ran. The adapters send what this returns, never the raw conversation.
 */
export function pairedCalls(messages: readonly Message[]): Message[] {
  const answered = new Set<string>();
  const asked = new Set<string>();
  for (const m of messages) {
    const r = toolResultOf(m);
    if (r) answered.add(r.toolUseId);
    for (const c of toolUsesOf(m)) asked.add(c.id);
  }
  const out: Message[] = [];
  for (const m of messages) {
    const r = toolResultOf(m);
    if (r) {
      if (asked.has(r.toolUseId)) out.push(m);
      continue;
    }
    if (
      m.role === "assistant" &&
      typeof m.content !== "string" &&
      m.content.some((b) => b.type === "tool_use")
    ) {
      const content = m.content.filter((b) => b.type !== "tool_use" || answered.has(b.id));
      if (content.length) out.push({ role: "assistant", content });
      continue;
    }
    out.push(m);
  }
  return out;
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/** A data: URL split into its media type and base64 body; null for an ordinary address. */
export function dataUrl(url: string): { mime: string; base64: string } | null {
  const m = DATA_URL.exec(url);
  return m ? { mime: m[1] as string, base64: m[2] as string } : null;
}

/**
 * A conversation saved before ADR-029, in OpenAI's chat shape, read as ours (ADR-029 D5).
 *
 * Messages already in this shape pass through untouched, so a file with both is read correctly: the
 * first turn after upgrading is appended in the new shape to a file written in the old one.
 */
export function fromLegacyMessages(messages: readonly unknown[]): Message[] {
  const out: Message[] = [];
  for (const raw of messages) {
    const m = raw as {
      role?: string;
      content?: unknown;
      toolCalls?: { id: string; name: string; arguments: string }[];
      toolCallId?: string;
    };
    // The system prompt is rebuilt on every run; an old file that saved one has nothing to add.
    if (m.role === "system") continue;
    if (m.role === "tool") {
      out.push(toolResultMessage(m.toolCallId ?? "", typeof m.content === "string" ? m.content : ""));
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") continue;
    const blocks: Block[] = [];
    if (typeof m.content === "string") {
      if (m.content) blocks.push({ type: "text", text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content as { type?: string; text?: string; image_url?: { url?: string } }[]) {
        if (p.type === "image_url" && p.image_url?.url) blocks.push({ type: "image", url: p.image_url.url });
        else if (p.type === "text" && typeof p.text === "string") blocks.push({ type: "text", text: p.text });
        // Already one of ours: kept as it is.
        else if (
          p.type === "image" ||
          p.type === "tool_use" ||
          p.type === "tool_result" ||
          p.type === "reasoning"
        )
          blocks.push(p as Block);
      }
    }
    for (const c of m.toolCalls ?? [])
      blocks.push({ type: "tool_use", id: c.id, name: c.name, arguments: c.arguments });
    // A user turn that is one plain text stays a string, which is what every writer produces.
    const only = blocks[0];
    out.push({
      role: m.role,
      content: blocks.length === 1 && only?.type === "text" && m.role === "user" ? only.text : blocks,
    });
  }
  return out;
}

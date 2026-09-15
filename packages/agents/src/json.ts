// Structured output is ours, not the vendor's (ADR-007 D2): ask for JSON with the schema in the prompt,
// parse and validate it ourselves, feed the error back, and give up after three attempts.
import type { ZodType, ZodTypeDef } from "zod";
import type { ChatMessage, Provider, Usage } from "./provider.js";

export class JsonOutputError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly lastText: string | null,
  ) {
    super(message);
    this.name = "JsonOutputError";
  }
}

/** Reasoning blocks some local models print before answering. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*?<\/think>/i, "");
}

/**
 * The JSON value in a model reply: a fenced block if there is one, else the first balanced object or
 * array. Throws with a short reason when there is none.
 */
export function extractJson(text: string): unknown {
  const clean = stripThinking(text).trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(clean);
  const candidate = fenced ? (fenced[1] as string).trim() : clean;
  try {
    return JSON.parse(candidate);
  } catch {
    // fall through to a balanced scan
  }
  const start = candidate.search(/[{[]/);
  if (start < 0) throw new Error("the reply contains no JSON object");
  const open = candidate[start] as "{" | "[";
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        const slice = candidate.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch (e) {
          throw new Error(`the JSON is malformed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }
  throw new Error("the JSON object is not closed");
}

export interface CompleteJsonOptions<T> {
  system: string;
  prompt: string;
  schema: ZodType<T, ZodTypeDef, unknown>;
  maxAttempts?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface JsonResult<T> {
  value: T;
  attempts: number;
  usage: Usage;
}

export async function completeJson<T>(
  provider: Provider,
  options: CompleteJsonOptions<T>,
): Promise<JsonResult<T>> {
  const maxAttempts = options.maxAttempts ?? 3;
  const messages: ChatMessage[] = [{ role: "user", content: options.prompt }];
  const usage: Usage = { promptTokens: 0, completionTokens: 0 };
  let lastText: string | null = null;
  let lastError = "no reply";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const reply = await provider.complete({
      system: options.system,
      messages,
      temperature: 0,
      json: true,
      ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    usage.promptTokens += reply.usage.promptTokens;
    usage.completionTokens += reply.usage.completionTokens;
    lastText = reply.text;
    try {
      const value = extractJson(reply.text ?? "");
      const parsed = options.schema.safeParse(value);
      if (parsed.success) return { value: parsed.data, attempts: attempt, usage };
      lastError = parsed.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    messages.push({ role: "assistant", content: reply.text ?? "" });
    messages.push({
      role: "user",
      content: `That reply cannot be used: ${lastError}. Reply with only the corrected JSON object, nothing else.`,
    });
  }
  throw new JsonOutputError(
    `no valid JSON after ${maxAttempts} attempts: ${lastError}`,
    maxAttempts,
    lastText,
  );
}

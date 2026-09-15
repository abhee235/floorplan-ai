// One provider interface over the OpenAI chat completions wire format (ADR-007 D1). The same code talks
// to OpenAI, OpenRouter and local servers (Ollama, vLLM, LM Studio) hosting Qwen models. No vendor SDK.

export interface ProviderProfile {
  vision: boolean;
  toolCalls: boolean;
  toolReliability: "high" | "medium" | "low";
  contextTokens: number;
  /** Ask for response_format json_object; never relied upon (ADR-007 D2). */
  jsonMode: boolean;
}

export const DEFAULT_PROFILE: ProviderProfile = {
  vision: false,
  toolCalls: true,
  toolReliability: "medium",
  contextTokens: 32_000,
  jsonMode: false,
};

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ToolCall {
  id: string;
  name: string;
  /** The raw JSON string the model produced; the runner parses and validates it. */
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface Completion {
  text: string | null;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage;
  raw: unknown;
}

export interface Provider {
  readonly id: string;
  readonly model: string;
  readonly profile: ProviderProfile;
  complete(req: CompletionRequest): Promise<Completion>;
}

export interface ProviderConfig {
  id: string;
  /** e.g. https://openrouter.ai/api/v1, http://127.0.0.1:11434/v1 */
  baseUrl: string;
  apiKey?: string | null;
  model: string;
  profile?: Partial<ProviderProfile>;
  timeoutMs?: number;
  /** Extra top-level request fields a server understands (for example a reasoning switch). */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | null,
    message: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = "ProviderError";
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

interface WireMessage {
  role: string;
  content: string | ContentPart[] | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function toWire(m: ChatMessage): WireMessage {
  const w: WireMessage = { role: m.role, content: m.content };
  if (m.toolCalls?.length)
    w.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
    }));
  if (m.toolCallId) w.tool_call_id = m.toolCallId;
  return w;
}

export function openAICompatible(
  config: ProviderConfig,
  fetchFn: FetchFn = globalThis.fetch as FetchFn,
): Provider {
  const profile = { ...DEFAULT_PROFILE, ...config.profile };
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    id: config.id,
    model: config.model,
    profile,
    async complete(req) {
      const messages: WireMessage[] = [];
      if (req.system) messages.push({ role: "system", content: req.system });
      messages.push(...req.messages.map(toWire));
      const body: Record<string, unknown> = {
        model: config.model,
        messages,
        temperature: req.temperature ?? 0,
        stream: false,
        ...config.extraBody,
      };
      if (req.maxTokens) body.max_tokens = req.maxTokens;
      if (req.tools?.length)
        body.tools = req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      if (req.json && profile.jsonMode) body.response_format = { type: "json_object" };
      const timer = AbortSignal.timeout(config.timeoutMs ?? 120_000);
      const signal = req.signal ? AbortSignal.any([req.signal, timer]) : timer;
      let res: Response;
      try {
        res = await fetchFn(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
            ...config.headers,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        throw new ProviderError(config.id, null, e instanceof Error ? e.message : String(e));
      }
      const text = await res.text();
      if (!res.ok)
        throw new ProviderError(config.id, res.status, `HTTP ${res.status}: ${text.slice(0, 500)}`);
      let raw: {
        choices?: {
          finish_reason?: string | null;
          message?: {
            content?: string | null;
            tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
          };
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        raw = JSON.parse(text);
      } catch {
        throw new ProviderError(config.id, res.status, `the response is not JSON: ${text.slice(0, 200)}`);
      }
      const choice = raw.choices?.[0];
      if (!choice?.message) throw new ProviderError(config.id, res.status, "the response has no message");
      return {
        text: choice.message.content ?? null,
        toolCalls: (choice.message.tool_calls ?? []).map((c, i) => ({
          id: c.id ?? `call_${i}`,
          name: c.function?.name ?? "",
          arguments: c.function?.arguments ?? "{}",
        })),
        finishReason: choice.finish_reason ?? null,
        usage: {
          promptTokens: raw.usage?.prompt_tokens ?? 0,
          completionTokens: raw.usage?.completion_tokens ?? 0,
        },
        raw,
      };
    },
  };
}

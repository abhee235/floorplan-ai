// A scripted Provider for the context tests, translated from Cascade's test/fakeProvider.ts under ADR-031.
//
// Each call to complete() takes the next scripted turn: a string is the reply's text, an Error is thrown.
// Past the end of the script the fallback answers (Cascade's fake replies with empty text there). Every
// request is recorded so a test can assert what the compactor sent, or that it sent nothing.

import type { Completion, CompletionRequest, Provider } from "../../src/llm/provider.js";
import { DEFAULT_PROFILE } from "../../src/llm/provider.js";

export interface FakeProvider extends Provider {
  /** Requests captured per call. */
  readonly calls: CompletionRequest[];
}

export type Turn = string | Error;

export function completion(text: string): Completion {
  return {
    text,
    toolCalls: [],
    finishReason: "stop",
    usage: { promptTokens: 0, completionTokens: 0 },
    raw: null,
  };
}

export function createFakeProvider(turns: Turn[], fallback: Turn = ""): FakeProvider {
  let i = 0;
  const calls: CompletionRequest[] = [];
  return {
    id: "fake",
    model: "fake",
    profile: DEFAULT_PROFILE,
    calls,
    async complete(req: CompletionRequest): Promise<Completion> {
      calls.push(req);
      const turn = i < turns.length ? (turns[i] as Turn) : fallback;
      i += 1;
      if (turn instanceof Error) throw turn;
      return completion(turn);
    },
  };
}

// Transcript recording and replay (ADR-007 D4, spec 04 section 11): a session driven by hand becomes a
// regression test by replaying the same calls against a fresh project.
import type { TranscriptEntry, TranscriptRecorder } from "./context.js";
import type { Registry } from "./registry.js";

export interface Transcript extends TranscriptRecorder {
  readonly entries: TranscriptEntry[];
  toJSON(): TranscriptEntry[];
}

export function createTranscript(): Transcript {
  const entries: TranscriptEntry[] = [];
  return {
    entries,
    record(e) {
      entries.push(e);
    },
    toJSON() {
      return entries;
    },
  };
}

/** Re-issue recorded calls in order; returns the results so a test can compare projects or envelopes. */
export async function replay(registry: Registry, entries: readonly Pick<TranscriptEntry, "tool" | "args">[]) {
  const out = [];
  for (const e of entries) out.push(await registry.call(e.tool, e.args));
  return out;
}

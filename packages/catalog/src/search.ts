// Search helpers (ADR-008 D4, spec 02 section 5): normalisation, the alias table, slugs and cursors.

/** Words a model might use for a category or product family (ADR-008 D4 alias table). */
export const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  tv: ["display"],
  television: ["display"],
  screen: ["display"],
  monitor: ["display"],
  panel: ["display"],
  couch: ["sofa"],
  settee: ["sofa"],
  mic: ["microphone"],
  mics: ["microphone"],
  microphones: ["microphone"],
  speakers: ["speaker"],
  loudspeaker: ["speaker"],
  chairs: ["chair"],
  seat: ["chair"],
  seating: ["chair"],
  tables: ["table"],
  boardroom: ["boardroom", "meeting"],
  conference: ["meeting", "boardroom"],
  videobar: ["video-bar", "video bar"],
  soundbar: ["soundbar", "sound bar"],
  cam: ["camera"],
  webcam: ["camera"],
  cupboard: ["storage", "cabinet"],
  cabinet: ["storage"],
  credenza: ["storage"],
  bin: ["storage"],
};

export function normaliseText(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").trim();
}

/** Model numbers compare without spaces, dashes or case: "QM 75C" is "qm-75c" (ADR-008 D3 step 1). */
export function modelKey(model: string): string {
  return normaliseText(model).replace(/[^a-z0-9]/g, "");
}

/** A product id from make and model: "Samsung" + "QM75C" -> "samsung-qm75c". */
export function slug(...parts: string[]): string {
  return parts
    .map((p) =>
      normaliseText(p)
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean)
    .join("-");
}

export function tokens(query: string): string[] {
  return normaliseText(query)
    .split(/[^a-z0-9.-]+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((t) => t.length > 0);
}

/** Query words plus their synonyms, deduplicated, original words first. */
export function expandTokens(words: readonly string[]): string[] {
  const out: string[] = [];
  const push = (w: string) => {
    if (!out.includes(w)) out.push(w);
  };
  for (const w of words) push(w);
  for (const w of words) for (const s of SYNONYMS[w] ?? []) push(s);
  return out;
}

/** An FTS5 query: every token quoted, joined by OR, prefix-matched, so punctuation never breaks the parser. */
export function ftsQuery(words: readonly string[]): string | null {
  const quoted = words.map((w) => `"${w.replace(/"/g, '""')}"*`);
  return quoted.length > 0 ? quoted.join(" OR ") : null;
}

export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined | null): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isInteger(n) || n < 0) throw new Error(`bad cursor: ${cursor}`);
  return n;
}

export const SEARCH_LIMIT = 20;

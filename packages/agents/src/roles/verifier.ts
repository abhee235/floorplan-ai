// The Catalog Verifier role (ADR-007 D3): read fetched pages and return a ProductProposal. The model is
// told to copy values from the pages only; the catalog's scoring then checks every value against the
// same pages, so a guess that slips through the prompt still cannot become a verified record.
import {
  type ExtractInput,
  PRODUCT_PROPOSAL_JSON_SCHEMA,
  ProductProposal,
  type ProposalExtractor,
} from "@fpv/catalog";
import { completeJson } from "../json.js";
import type { Provider } from "../provider.js";

export const VERIFIER_SYSTEM =
  "You extract product facts from web pages for an audio-visual and office furniture catalog. " +
  "Use only what the pages state; never use memory or guess. If the pages do not describe exactly the requested make and model, " +
  'reply {"found": false, "make": ..., "model": ...}. Convert lengths to whole millimetres and weights to kilograms. ' +
  "Dimensions are the product without stand or mount: w across the front, d front to back, h bottom to top. " +
  "For every value you give, name the page URL it came from in fieldSources. Reply with one JSON object only.";

export function verifierPrompt(input: ExtractInput): string {
  const pages = input.pages.map((p, i) => `=== PAGE ${i + 1}: ${p.url} ===\n${p.text}`).join("\n\n");
  return [
    `Requested product: make "${input.make}", model "${input.model}"${input.category ? `, category "${input.category}"` : ""}.`,
    "",
    "Return JSON matching this schema:",
    JSON.stringify(PRODUCT_PROPOSAL_JSON_SCHEMA),
    "",
    "Pages:",
    pages,
  ].join("\n");
}

export interface VerifierOptions {
  maxAttempts?: number;
  maxTokens?: number;
  /** Characters of page text sent in total; pages are trimmed evenly to fit. */
  maxPageChars?: number;
}

export function verifierExtractor(provider: Provider, options: VerifierOptions = {}): ProposalExtractor {
  const budget = options.maxPageChars ?? Math.max(8_000, Math.floor(provider.profile.contextTokens * 2.5));
  return {
    id: `${provider.id}:${provider.model}`,
    async extract(input) {
      const per = Math.floor(budget / Math.max(1, input.pages.length));
      const trimmed = {
        ...input,
        pages: input.pages.map((p) => ({ url: p.url, text: p.text.slice(0, per) })),
      };
      const result = await completeJson(provider, {
        system: VERIFIER_SYSTEM,
        prompt: verifierPrompt(trimmed),
        schema: ProductProposal,
        maxAttempts: options.maxAttempts ?? 3,
        maxTokens: options.maxTokens ?? 2_000,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return result.value;
    },
  };
}

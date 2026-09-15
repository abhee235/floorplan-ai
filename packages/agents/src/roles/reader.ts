// The Plan Reader role (ADR-007 D3, ADR-011 D2, D4): send a plan image to a vision model with the reader-v1
// contract, validate its JSON with retries, and turn it into a cleaned-up PlanDraft. Scale is never trusted
// from the model alone: the draft asks for it unless two readable dimensions agree (ADR-011 D3).
import {
  type GrayBitmap,
  type ImageInfo,
  type PlanDraft,
  type RasterDraftOptions,
  RasterReply,
  READER_PROMPT_VERSION,
  type RefineReport,
  rasterReplyToDraft,
  readerSystemPrompt,
  readerUserPrompt,
  refineRasterDraft,
} from "@fpv/importers";
import { completeJson } from "../json.js";
import type { Provider, Usage } from "../provider.js";

export interface RasterImage {
  /** data:<mime>;base64,<bytes> */
  dataUrl: string;
  info: ImageInfo;
  fileName: string;
  kind?: RasterDraftOptions["kind"];
  /** The decoded pixels, when the caller has them: the model's walls are then snapped to the image. */
  bitmap?: GrayBitmap | null;
}

export interface PlanReading {
  draft: PlanDraft;
  reply: RasterReply;
  /** What refinement against the image changed; null when no pixels were given. */
  refined: RefineReport | null;
  attempts: number;
  usage: Usage;
}

export interface PlanReaderRole {
  readonly id: string;
  read(image: RasterImage, options?: { signal?: AbortSignal }): Promise<PlanReading>;
}

export class ReaderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReaderUnavailableError";
  }
}

export interface PlanReaderOptions {
  maxAttempts?: number;
  maxTokens?: number;
}

export function planReader(provider: Provider, options: PlanReaderOptions = {}): PlanReaderRole {
  return {
    id: `${provider.id}:${provider.model}`,
    async read(image, readOptions = {}) {
      if (!provider.profile.vision)
        throw new ReaderUnavailableError(
          `the reader model ${provider.model} (${provider.id}) is not marked as able to read images; set profile.vision to true for it`,
        );
      const result = await completeJson(provider, {
        system: readerSystemPrompt(),
        prompt: readerUserPrompt(image.info),
        images: [image.dataUrl],
        schema: RasterReply,
        maxAttempts: options.maxAttempts ?? 3,
        maxTokens: options.maxTokens ?? 8_000,
        ...(readOptions.signal ? { signal: readOptions.signal } : {}),
      });
      const draft = rasterReplyToDraft(result.value, image.info, {
        file: image.fileName,
        kind: image.kind ?? "image",
        reader: { providerId: provider.id, model: provider.model, promptVersion: READER_PROMPT_VERSION },
      });
      const refinement = image.bitmap ? refineRasterDraft(draft, image.bitmap) : null;
      return {
        draft: refinement ? refinement.draft : draft,
        reply: result.value,
        refined: refinement ? refinement.report : null,
        attempts: result.attempts,
        usage: result.usage,
      };
    },
  };
}

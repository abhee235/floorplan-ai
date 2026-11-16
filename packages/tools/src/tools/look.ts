// A look at a picture, on demand (ADR-027 D3).
//
// An attached image reaches the model once, in the message that attached it, and the first render
// takes it away again to keep the window small. The architect, in its own sub-run, never saw it at
// all. This tool hands the picture back whenever the model asks: the result carries the image in the
// shape render uses, so the runner lifts it into the conversation for a model that can see, and the
// chat shows it on the card. A picture on the web comes through the same guarded fetcher the product
// verifier uses, so an image search result can be looked at too.
//
// It is for seeing, not measuring. A line drawing to be traced into walls is import_plan's job.
import { z } from "zod";
import { invalidArg, ToolError, unavailable } from "../envelope.js";
import { defineTool, TIMEOUTS } from "../registry.js";

/** Bigger than this is refused: a model is shown a picture, not a print file. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** Width and height from a PNG or JPEG header, or nulls; no image library is needed for that. */
export function imageSize(bytes: Uint8Array): { width: number | null; height: number | null } {
  const none = { width: null, height: null };
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // walk the JPEG segments to the first frame header
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return none;
      const marker = bytes[at + 1] as number;
      const length = ((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = ((bytes[at + 5] as number) << 8) | (bytes[at + 6] as number);
        const width = ((bytes[at + 7] as number) << 8) | (bytes[at + 8] as number);
        return { width, height };
      }
      at += 2 + length;
    }
  }
  return none;
}

export const lookAt = defineTool({
  name: "look_at",
  description:
    "Show yourself a picture: an attachment by its id (a photo, an illustration, a sketch, a plan somebody drew), or a picture on the web by url, such as one web_search found. You get the image to look at; say in question what you want from it, and write what it showed into your notes, because the picture leaves the conversation again and the notes do not. For a line drawing you mean to trace into walls, use import_plan instead: look_at is for seeing, not for measuring.",
  tier: "both",
  mutating: false,
  timeoutMs: TIMEOUTS.slow,
  resultCapBytes: 12 * 1024 * 1024,
  input: z.object({
    attachmentId: z.string().optional().describe("e.g. a1, from the message that attached it"),
    url: z.string().url().optional().describe("an http or https image address"),
    question: z.string().optional().describe("what you want to learn from it, in a few words"),
  }),
  output: z.object({
    name: z.string(),
    mime: z.string(),
    bytes: z.number(),
    width: z.number().nullable(),
    height: z.number().nullable(),
    /** What the runner says when it puts the picture in front of the model. */
    caption: z.string(),
    images: z.array(
      z.object({
        name: z.string(),
        mime: z.string(),
        pngBase64: z.string(),
        width: z.number().nullable(),
        height: z.number().nullable(),
      }),
    ),
  }),
  async run(args, call) {
    if (!args.attachmentId && !args.url) throw invalidArg("attachmentId", "give an attachmentId or a url");
    if (args.attachmentId && args.url) throw invalidArg("url", "give an attachmentId or a url, not both");
    let name: string;
    let mime: string;
    let bytes: Uint8Array;
    if (args.attachmentId) {
      const store = call.ctx.attachments;
      if (!store) throw unavailable("look_at", "nothing was attached in this conversation", null);
      const a = store.get(args.attachmentId);
      if (!a) {
        const known = store.list().map((x) => `${x.id} (${x.name})`);
        throw invalidArg(
          "attachmentId",
          `no attachment "${args.attachmentId}"`,
          known.length ? `attached: ${known.join(", ")}` : "nothing is attached",
        );
      }
      name = a.name;
      mime = a.mime;
      bytes = a.bytes;
    } else {
      const web = call.ctx.web;
      if (!web?.fetcher.fetchBytes)
        throw unavailable(
          "look_at",
          "this session cannot fetch from the web",
          "look at an attachment instead",
        );
      const got = await web.fetcher.fetchBytes(args.url as string, { maxBytes: MAX_IMAGE_BYTES });
      if (got.status >= 400)
        throw new ToolError("web.status", `${args.url} answered ${got.status}`, null, "try another picture");
      name = args.url as string;
      mime = got.contentType.split(";")[0]?.trim() || "application/octet-stream";
      bytes = got.bytes;
      if (got.truncated)
        throw new ToolError(
          "image.too-large",
          `${args.url} is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB`,
          null,
          "try a smaller picture",
        );
    }
    if (!mime.startsWith("image/"))
      throw new ToolError(
        "image.not-an-image",
        `${name} is ${mime}, not a picture`,
        null,
        mime === "application/pdf" ? "a PDF plan is read with import_plan" : "look_at shows pictures",
      );
    if (bytes.length > MAX_IMAGE_BYTES)
      throw new ToolError(
        "image.too-large",
        `${name} is ${Math.round(bytes.length / 1e6)} MB`,
        null,
        "attach a smaller copy",
      );
    const size = imageSize(bytes);
    const caption = args.question?.trim()
      ? `${name}, which you asked to look at: ${args.question.trim()}`
      : `${name}, which you asked to look at.`;
    return {
      name,
      mime,
      bytes: bytes.length,
      ...size,
      caption,
      images: [{ name, mime, pngBase64: base64(bytes), ...size }],
    };
  },
});

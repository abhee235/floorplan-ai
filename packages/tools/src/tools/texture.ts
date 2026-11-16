// import_texture (ADR-010 D10, PRD P3-8): a picture a person brings, a photo of their own carpet or a
// scan of a laminate, made into a texture the catalog offers beside the ones the app draws. The bytes come
// from the editor's file picker or from a file attached to the agent's conversation.
import { imageInfo } from "@fpv/importers";
import { z } from "zod";
import { invalidArg, ToolError, unavailable } from "../envelope.js";
import { defineTool, TIMEOUTS } from "../registry.js";

/** A real-world width when none is given: a typical tile or board, which a person then corrects. */
export const DEFAULT_TEXTURE_WIDTH_MM = 200;
/** Past this many pixels on the long side, a picture costs the viewer memory for detail nobody sees. */
export const LARGE_TEXTURE_PX = 2048;

const MIMES = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;

/** A texture's name from a file's: "oak-plank_02.jpg" reads "Oak plank 02". */
export function nameFromFile(fileName: string | undefined): string {
  const bare = (fileName ?? "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : "Imported texture";
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/^data:[^,]*,/, "").replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export const importTexture = defineTool({
  name: "import_texture",
  description:
    "Make a picture into a texture, as when a person brings a photo of their own carpet or wood: PNG, JPEG or WebP from attachmentId, or contentBase64 with fileName. widthMm is how wide the pictured surface is in reality (default 200); its height follows the picture's shape. The same picture again returns the texture already made from it. Returns the texture id to give a finish as textureId.",
  tier: "both",
  mutating: false,
  timeoutMs: TIMEOUTS.command,
  input: z.object({
    attachmentId: z.string().min(1).optional().describe("a picture attached to the conversation"),
    contentBase64: z.string().min(1).optional().describe("the picture's bytes in base64, from the editor"),
    fileName: z
      .string()
      .optional()
      .describe("the picture's file name, which names the texture when name does not"),
    name: z.string().min(1).max(80).optional(),
    widthMm: z
      .number()
      .int()
      .min(10)
      .max(100_000)
      .optional()
      .describe("how wide the pictured surface is in reality, in mm; default 200"),
    tags: z.array(z.string().min(1).max(30)).max(8).optional().describe("e.g. floor, wall, fabric"),
  }),
  output: z.object({
    id: z.string(),
    name: z.string(),
    widthMm: z.number(),
    heightMm: z.number(),
    transparent: z.boolean(),
    existing: z.boolean(),
    pixels: z.object({ width: z.number(), height: z.number() }),
  }),
  async run(args, call) {
    const { ctx } = call;
    if (!ctx.textures)
      throw unavailable(
        "import_texture",
        "this session cannot keep pictures",
        "choose one of the catalog's textures",
      );
    let bytes: Uint8Array;
    let fileName = args.fileName;
    if (args.attachmentId !== undefined) {
      const found = ctx.attachments?.get(args.attachmentId) ?? null;
      if (!found) {
        const have = (ctx.attachments?.list() ?? []).map((a) => `${a.id} (${a.name})`);
        throw new ToolError(
          "import.attachment-unknown",
          `no attachment "${args.attachmentId}" in this conversation`,
          null,
          have.length ? `attached: ${have.join(", ")}` : "nothing is attached to this conversation",
        );
      }
      bytes = found.bytes;
      fileName ??= found.name;
    } else if (args.contentBase64 !== undefined) {
      try {
        bytes = decodeBase64(args.contentBase64);
      } catch {
        throw invalidArg("contentBase64", "is not base64", "send the file's bytes in base64");
      }
    } else
      throw invalidArg(
        "attachmentId",
        "no picture was given",
        "give attachmentId, or contentBase64 with fileName",
      );

    // What the bytes are, not what the name says: a renamed file is still the file it was.
    const info = imageInfo(bytes);
    const mime = info && info.format in MIMES ? MIMES[info.format as keyof typeof MIMES] : null;
    if (!info || !mime)
      throw new ToolError(
        "texture.format",
        info ? `a ${info.format.toUpperCase()} picture cannot be a texture` : "the file is not a picture",
        null,
        "use a PNG, JPEG or WebP",
      );
    if (info.width < 1 || info.height < 1)
      throw new ToolError("texture.format", "the picture has no pixels", null, "use another picture");
    const widthMm = args.widthMm ?? DEFAULT_TEXTURE_WIDTH_MM;
    const heightMm = Math.max(1, Math.round((widthMm * info.height) / info.width));
    if (Math.max(info.width, info.height) > LARGE_TEXTURE_PX)
      call.warn(
        `The picture is ${info.width} by ${info.height} pixels. Above ${LARGE_TEXTURE_PX} on its long side it costs the viewer memory for detail nobody sees at room scale; a smaller copy would look the same.`,
      );
    const { texture, existing } = ctx.textures.add({
      bytes,
      mime,
      name: args.name?.trim() || nameFromFile(fileName),
      widthMm,
      heightMm,
      tags: args.tags ?? [],
    });
    if (existing) call.warn(`This picture is already the texture "${texture.name}"; that one is used.`);
    return {
      id: texture.id,
      name: texture.name,
      widthMm: texture.widthMm,
      heightMm: texture.heightMm,
      transparent: texture.transparent,
      existing,
      pixels: { width: info.width, height: info.height },
    };
  },
});

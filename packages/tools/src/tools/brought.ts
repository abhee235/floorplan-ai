// The bytes of a file a person brought, for the import tools: one attached to the agent's conversation,
// named by its id, or the editor's own, sent in base64 with its file name.
import type { ToolContext } from "../context.js";
import { invalidArg, ToolError } from "../envelope.js";

export interface BroughtArgs {
  attachmentId?: string | undefined;
  contentBase64?: string | undefined;
  fileName?: string | undefined;
}

/** A name from a file's: "oak-plank_02.jpg" reads "Oak plank 02"; `fallback` when there is none. */
export function nameFromFile(fileName: string | undefined, fallback: string): string {
  const bare = (fileName ?? "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : fallback;
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/^data:[^,]*,/, "").replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** The file's bytes and name. `noun` says what was expected ("picture", "model") in what goes wrong. */
export function broughtFile(
  args: BroughtArgs,
  ctx: ToolContext,
  noun: string,
): { bytes: Uint8Array; fileName: string | undefined } {
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
    return { bytes: found.bytes, fileName: args.fileName ?? found.name };
  }
  if (args.contentBase64 !== undefined) {
    try {
      return { bytes: decodeBase64(args.contentBase64), fileName: args.fileName };
    } catch {
      throw invalidArg("contentBase64", "is not base64", "send the file's bytes in base64");
    }
  }
  throw invalidArg(
    "attachmentId",
    `no ${noun} was given`,
    "give attachmentId, or contentBase64 with fileName",
  );
}

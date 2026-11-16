// run_code (ADR-030): somewhere for the model to think in code, with the pictures and the tools in reach.
//
// Everything a script does to the project goes through `tools.call`, which is the registry's own call
// path -- validation, consent (ADR-023), history and the log -- so the sandbox gives the model no power
// it did not already have one call at a time (D4). What it adds is arithmetic, loops and measurement.

import { z } from "zod";
import { defineTool, TIMEOUTS } from "../registry.js";
import { type RunOutput, Sandboxes } from "../sandbox/sandbox.js";

const sandboxes = new Sandboxes();

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export const runCode = defineTool({
  name: "run_code",
  description: [
    "Run JavaScript in a sandbox that keeps its variables between calls, to measure, compute and act in a loop instead of one call at a time.",
    'In reach: console.log(...); attachments(); image(id) -> { width, height, gray: Uint8Array (0 black..255 white, row by row), scale }; crop(img, { x, y, w, h, scale?, grid? }) -> an enlarged region under a grid labelled in the picture\'s own pixels; draw(img, [{ line|rect|poly|circle|point, colour, label }]) -> the picture with your marks over it; show(picture, caption) hands a picture back so you can see it; tools.call(name, args) calls any tool you are offered and returns its envelope; project() is the scene as data; scaleFrom([{ kind: "door", px: 45 }, { kind: "desk", px: 70 }, ...]) -> the mm per pixel most of your measurements of known things agree on, and which ones disagree.',
    "tools.call is synchronous: no await. The value of the last expression is returned. There is no file system, network or require.",
    "For a plan in a picture, read the skill reading-a-picture-with-code first.",
  ].join(" "),
  tier: "both",
  mutating: true,
  // The script's own limit is thirty seconds of running; its tool calls may take their own time.
  timeoutMs: TIMEOUTS.subrun,
  resultCapBytes: 24 * 1024 * 1024,
  input: z.object({
    code: z.string().min(1).max(100_000).describe("JavaScript; the value of its last expression is returned"),
    reset: z.boolean().optional().describe("start with a fresh sandbox, dropping every variable"),
  }),
  output: z.object({
    ok: z.boolean(),
    printed: z.string(),
    value: z.unknown(),
    error: z.string().nullable(),
    fresh: z.boolean(),
    calls: z.array(z.object({ name: z.string(), ok: z.boolean(), error: z.string().optional() })),
    ms: z.number(),
    caption: z.string(),
    images: z.array(
      z.object({
        name: z.string(),
        mime: z.string(),
        pngBase64: z.string(),
        width: z.number(),
        height: z.number(),
      }),
    ),
  }),
  async run(args, call) {
    const { box, fresh } = await sandboxes.of(call.ctx.store, args.reset === true);
    const out: RunOutput = await box.run(args.code, {
      attachments: () => [...(call.ctx.attachments?.list() ?? [])],
      attachmentBytes: (id) => call.ctx.attachments?.get(id)?.bytes ?? null,
      project: () => call.ctx.store.project,
      callTool: async (name, toolArgs) => {
        const r = await call.tools.call(name, toolArgs);
        for (const w of r.warnings) call.warn(`${name}: ${w}`);
        return r;
      },
    });
    if (fresh && !args.reset)
      call.warn("this is a new sandbox: variables from earlier calls, if there were any, are gone");
    if (!out.ok && out.error) call.warn(`the script stopped: ${out.error}`);
    // Something may have changed through tools.call; the registry works out what from the history.
    if (out.calls.length) call.changed(null);
    const captions = out.pictures.map((p, i) => `${i + 1}: ${p.caption || "a picture from the script"}`);
    return {
      ok: out.ok,
      printed: out.printed,
      value: out.value,
      error: out.error,
      fresh,
      calls: out.calls,
      ms: out.ms,
      caption: captions.length ? `Pictures from run_code -- ${captions.join("; ")}` : "",
      images: out.pictures.map((p, i) => ({
        name: `run_code-${i + 1}.png`,
        mime: "image/png",
        pngBase64: base64(p.png),
        width: p.width,
        height: p.height,
      })),
    };
  },
});

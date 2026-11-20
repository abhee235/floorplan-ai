// import_model (ADR-010 D10, PRD P3-8): a 3D model a person brings, a chair they own or a product its
// maker publishes as glTF, made into a product the catalog offers beside its own. The bytes come from the
// editor's import dialog or from a file attached to the agent's conversation.
import { GltfError, MAX_BYTES, MAX_TRIANGLES } from "@fpv/assets";
import { Category } from "@fpv/catalog";
import { z } from "zod";
import { ToolError, unavailable } from "../envelope.js";
import { defineTool, TIMEOUTS } from "../registry.js";
import { broughtFile, nameFromFile } from "./brought.js";

/** Past this a file is refused: the editor sends it in one message, and a viewer has to hold it. */
export const MAX_MODEL_BYTES = 64 * 1024 * 1024;

/** Metres in one of a file's units. glTF says metres; a file ten or a hundred times too big says otherwise. */
export const MODEL_UNITS = { m: 1, cm: 0.01, mm: 0.001, in: 0.0254 } as const;

/** What an imported model can be: anything a product can, but a door or window, which needs an opening. */
export const IMPORTABLE_CATEGORY = Category.exclude(["door", "window"]);

const Mm = z.number().int().min(1).max(100_000);

export const importModel = defineTool({
  name: "import_model",
  description:
    "Make a 3D model a person brings into a product the catalog offers: a binary glTF (.glb) from attachmentId, or contentBase64 with fileName. category says what it is (default other). turn (0-3 quarter turns, counter-clockwise seen from above) brings its front to face +z, the way products face; tip (0-3) stands up a model that arrives lying on its back. units is what the file's numbers mean: m by default, cm or mm for a model that comes in far too big. size in mm overrides the model's own. The same model at the same size returns the product already made of it. Returns the product id to place with place_item.",
  tier: "both",
  mutating: false,
  timeoutMs: TIMEOUTS.command,
  input: z.object({
    attachmentId: z.string().min(1).optional().describe("a model attached to the conversation"),
    contentBase64: z.string().min(1).optional().describe("the model's bytes in base64, from the editor"),
    fileName: z
      .string()
      .optional()
      .describe("the model's file name, which names the product when name does not"),
    name: z.string().min(1).max(80).optional(),
    category: IMPORTABLE_CATEGORY.optional().describe(
      "what the model is, e.g. chair or table; default other",
    ),
    turn: z.number().int().min(0).max(3).optional(),
    tip: z.number().int().min(0).max(3).optional(),
    units: z.enum(["m", "cm", "mm", "in"]).optional(),
    size: z.object({ w: Mm, d: Mm, h: Mm }).optional().describe("the product's size in mm"),
    tags: z.array(z.string().min(1).max(30)).max(8).optional(),
  }),
  output: z.object({
    productId: z.string(),
    name: z.string(),
    category: z.string(),
    dims: z.object({ w: z.number(), d: z.number(), h: z.number() }),
    assetKey: z.string(),
    triangles: z.number(),
    parts: z.array(z.string()),
    existing: z.boolean(),
  }),
  async run(args, call) {
    const { ctx } = call;
    if (!ctx.models)
      throw unavailable(
        "import_model",
        "this session cannot keep models",
        "choose one of the catalog's products",
      );
    const { bytes, fileName } = broughtFile(args, ctx, "model");
    if (bytes.length > MAX_MODEL_BYTES)
      throw new ToolError(
        "model.too-large",
        `the model is ${Math.round(bytes.length / 1048576)} MB; at most ${MAX_MODEL_BYTES / 1048576} MB is taken`,
        null,
        "export it with fewer polygons or smaller textures",
      );
    let made: ReturnType<NonNullable<typeof ctx.models>["add"]>;
    try {
      made = ctx.models.add({
        bytes,
        name: args.name?.trim() || nameFromFile(fileName, "Imported model"),
        category: args.category ?? "other",
        turn: args.turn ?? 0,
        tip: args.tip ?? 0,
        metresPerUnit: MODEL_UNITS[args.units ?? "m"],
        size: args.size ?? null,
        tags: args.tags ?? [],
      });
    } catch (e) {
      if (e instanceof GltfError) throw new ToolError(e.code, e.message, null, e.hint);
      throw e;
    }
    for (const w of made.warnings) call.warn(w);
    if (made.triangles > MAX_TRIANGLES)
      call.warn(
        `The model has ${made.triangles.toLocaleString("en")} triangles; a catalog model keeps under ${MAX_TRIANGLES.toLocaleString("en")}. A room of copies will slow the 3D view.`,
      );
    if (bytes.length > MAX_BYTES)
      call.warn(
        `The file is ${(bytes.length / 1048576).toFixed(1)} MB; a catalog model keeps under 2 MB. It costs every viewer that time and memory to load.`,
      );
    if (made.existing)
      call.warn(`This model at this size is already "${made.product.name}"; that product is used.`);
    return {
      productId: made.product.id,
      name: made.product.name,
      category: made.product.category,
      dims: made.product.dims,
      assetKey: made.assetKey,
      triangles: made.triangles,
      parts: made.slots,
      existing: made.existing,
    };
  },
});

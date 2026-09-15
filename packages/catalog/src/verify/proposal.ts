// ProductProposal (spec 02 section 6): the JSON a verifier returns for one make and model, with the URL
// each field was read from. Lengths in millimetres, mass in kilograms, whatever the page used.
import { MountKind } from "@fpv/ir";
import { z } from "zod";
import { Category, SpecValue } from "../schema.js";

const Url = z.string().url();

export const ProductProposal = z.object({
  /** False when the pages do not describe this exact make and model. */
  found: z.boolean(),
  make: z.string().min(1),
  model: z.string().min(1),
  name: z.string().min(1).nullable().default(null),
  category: Category.nullable().default(null),
  /** Outer dimensions in whole millimetres: w across the front, d front to back, h bottom to top. */
  dims: z
    .object({ w: z.number().positive(), d: z.number().positive(), h: z.number().positive() })
    .nullable()
    .default(null),
  weightKg: z.number().positive().nullable().default(null),
  mount: z
    .object({ kinds: z.array(MountKind).min(1), vesa: z.string().nullable().default(null) })
    .nullable()
    .default(null),
  specs: z.record(SpecValue).default({}),
  price: z
    .object({ amount: z.number().positive(), currency: z.string().length(3), sourceUrl: Url })
    .nullable()
    .default(null),
  lifecycle: z.enum(["active", "discontinued", "unknown"]).default("unknown"),
  /** Field name ("dims", "weightKg", "price", "specs.diagonalIn") to the page URL it came from. */
  fieldSources: z.record(Url).default({}),
});

export type ProductProposal = z.infer<typeof ProductProposal>;
export type ProductProposalInput = z.input<typeof ProductProposal>;

/** The JSON Schema shown to a model (ADR-007 D2), written by hand so the prompt stays short and stable. */
export const PRODUCT_PROPOSAL_JSON_SCHEMA = {
  type: "object",
  required: ["found", "make", "model"],
  properties: {
    found: { type: "boolean", description: "false if the pages do not describe this exact make and model" },
    make: { type: "string" },
    model: { type: "string", description: "model number exactly as the manufacturer writes it" },
    name: { type: ["string", "null"], description: "short product name" },
    category: { type: ["string", "null"], enum: [...Category.options, null] },
    dims: {
      type: ["object", "null"],
      description: "outer size in whole millimetres, without stand; convert inches (x 25.4) and cm (x 10)",
      properties: { w: { type: "number" }, d: { type: "number" }, h: { type: "number" } },
      required: ["w", "d", "h"],
    },
    weightKg: { type: ["number", "null"], description: "without stand; convert lb (x 0.4536)" },
    mount: {
      type: ["object", "null"],
      properties: {
        kinds: { type: "array", items: { enum: MountKind.options } },
        vesa: { type: ["string", "null"], description: "e.g. 400x400" },
      },
    },
    specs: {
      type: "object",
      description:
        "category keys: display diagonalIn, resolution, vesa, powerW; video-bar fovDeg, maxRoomDepthMm, interfaces; ceiling-mic coverageRadiusMm, channels; ceiling-speaker coverageRadiusMm, impedanceOhm, powerW",
      additionalProperties: { type: ["string", "number", "boolean"] },
    },
    price: {
      type: ["object", "null"],
      properties: { amount: { type: "number" }, currency: { type: "string" }, sourceUrl: { type: "string" } },
    },
    lifecycle: { enum: ["active", "discontinued", "unknown"] },
    fieldSources: {
      type: "object",
      description: "field name to the URL of the page it was read from; only URLs of the pages given",
      additionalProperties: { type: "string" },
    },
  },
} as const;

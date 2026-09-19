// Asset manifest and licence records (spec 02 section 3, ADR-010 D1, D2, D6).
import { AssetKey } from "@fpv/ir";
import { z } from "zod";

/** Only licences that permit redistribution in a product; never NC, ND or copyleft art licences. */
export const LicenceId = z.enum(["CC0-1.0", "CC-BY-3.0", "CC-BY-4.0", "generated", "own"]);

export const Licence = z.object({
  id: LicenceId,
  author: z.string().nullable(),
  sourceUrl: z.string().url().nullable(),
  /** Text rendered in credits, verbatim. Required for CC-BY. */
  attribution: z.string().nullable(),
});

export const Articulation = z.object({
  node: z.string().min(1),
  kind: z.enum(["hinge", "slide", "lift", "tilt"]),
  axis: z.enum(["x", "y", "z"]),
  min: z.number(),
  max: z.number(),
  unit: z.enum(["deg", "mm"]),
});

export const RecipeKind = z.enum([
  "box",
  "cylinder",
  "table",
  "chair",
  "display",
  "video-bar",
  "ceiling-speaker",
  "ceiling-mic",
  "bed",
  "sofa",
]);

/** Budgets for one glTF entry (ADR-010 D6). */
export const MAX_TRIANGLES = 30_000;
export const MAX_BYTES = 2_097_152;

export const AssetEntry = z.object({
  key: AssetKey,
  kind: z.enum(["gltf", "recipe"]),
  /** Relative path under assets/files for gltf; null for recipe. */
  file: z.string().nullable(),
  recipe: RecipeKind.nullable(),
  /** Metres, after normalisation. */
  bbox: z.object({ w: z.number().positive(), d: z.number().positive(), h: z.number().positive() }),
  triangles: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  /** glTF material names, unique. */
  materialSlots: z.array(z.string()),
  articulations: z.array(Articulation),
  /** preset name -> node -> value */
  presets: z.record(z.record(z.number())),
  /** Relative path to a PNG rendered top-down; null lets the plan draw the footprint (C-039). */
  planIcon: z.string().nullable(),
  licence: Licence,
  tags: z.array(z.string()),
});

export const AssetManifest = z.object({ version: z.literal(1), entries: z.array(AssetEntry) });

export type LicenceId = z.infer<typeof LicenceId>;
export type Licence = z.infer<typeof Licence>;
export type Articulation = z.infer<typeof Articulation>;
export type RecipeKind = z.infer<typeof RecipeKind>;
export type AssetEntry = z.infer<typeof AssetEntry>;
export type AssetManifest = z.infer<typeof AssetManifest>;

export interface ManifestProblem {
  code: string;
  key: string | null;
  message: string;
}

/** Problems with a licence record on its own: CC-BY needs attribution text (ADR-010 D2). */
export function licenceProblems(licence: Licence, key: string | null): ManifestProblem[] {
  const out: ManifestProblem[] = [];
  if (licence.id.startsWith("CC-BY") && !licence.attribution?.trim())
    out.push({
      code: "licence.attribution",
      key,
      message: `${key ?? "licence"}: CC-BY requires attribution text`,
    });
  return out;
}

/**
 * Constraints beyond the shape (spec 02 section 3): unique keys, gltf entries carry a file and a
 * hash and stay within budget, recipe entries name a recipe, material slots unique, CC-BY attributed.
 */
export function validateManifest(manifest: AssetManifest): ManifestProblem[] {
  const out: ManifestProblem[] = [];
  const seen = new Set<string>();
  for (const e of manifest.entries) {
    const key = e.key;
    if (seen.has(key)) out.push({ code: "key.duplicate", key, message: `${key}: duplicate asset key` });
    seen.add(key);
    if (e.kind === "gltf") {
      if (!e.file) out.push({ code: "gltf.file", key, message: `${key}: a gltf entry needs a file` });
      if (!e.sha256) out.push({ code: "gltf.sha256", key, message: `${key}: a gltf entry needs a sha256` });
      if (e.triangles > MAX_TRIANGLES)
        out.push({
          code: "gltf.triangles",
          key,
          message: `${key}: ${e.triangles} triangles exceeds ${MAX_TRIANGLES}`,
        });
      if (e.bytes > MAX_BYTES)
        out.push({ code: "gltf.bytes", key, message: `${key}: ${e.bytes} bytes exceeds ${MAX_BYTES}` });
    } else {
      if (!e.recipe)
        out.push({ code: "recipe.kind", key, message: `${key}: a recipe entry names its recipe` });
      if (e.file) out.push({ code: "recipe.file", key, message: `${key}: a recipe entry has no file` });
    }
    if (new Set(e.materialSlots).size !== e.materialSlots.length)
      out.push({ code: "materialSlots.duplicate", key, message: `${key}: material slots must be unique` });
    out.push(...licenceProblems(e.licence, key));
  }
  return out;
}

// Product, texture and library records (spec 02 sections 1, 2, 4; ADR-008 D1, D2).
import { AssetManifest, Licence } from "@fpv/assets";
import {
  AssetKey,
  Fraction,
  Mm,
  MmNonNegative,
  MmPositive,
  MountKind,
  ProductId,
  Size3,
  TextureId,
  Timestamp,
} from "@fpv/ir";
import { z } from "zod";

export const CATEGORIES = [
  "display",
  "video-bar",
  "camera",
  "ceiling-mic",
  "table-mic",
  "ceiling-speaker",
  "soundbar",
  "amplifier",
  "dsp",
  "controller",
  "touch-panel",
  "scheduler",
  "mount",
  "cable",
  "connector",
  "switch",
  "rack",
  "table",
  "desk",
  "chair",
  "sofa",
  "storage",
  "whiteboard",
  "door",
  "window",
  "partition",
  "lighting",
  "appliance",
  "plant",
  "other",
] as const;
export const Category = z.enum(CATEGORIES);

export const MountPoint = z.object({
  name: z.string().min(1),
  kind: z.enum(["surface", "wall-face", "ceiling-face"]),
  /** For "surface": fraction of the height where dropped items land; null: nothing stacks here (C-009). */
  dropRatio: Fraction.nullable(),
  offset: z.object({ x: Mm, y: Mm, z: Mm }).nullable(),
});

/** Sash angles are signed degrees: a sash may open clockwise (O-087 uses -90 to 270). */
export const DegSigned = z.number().finite().gt(-360).lt(360);
/** Axes are ratios of the width or depth and may lie outside the leaf (a hinge past the frame). */
export const Sash = z.object({
  xAxis: z.number().finite(),
  yAxis: z.number().finite(),
  width: Fraction,
  startAngle: DegSigned,
  endAngle: DegSigned,
});

/** Embed fractions default to a door as deep as its wall, flush, full width and height (O-001, O-002, O-007, O-008). */
export const Embed = z.object({
  thickness: Fraction.default(1),
  distance: Fraction.default(0),
  width: Fraction.default(1),
  left: Fraction.default(0),
  height: Fraction.default(1),
  top: Fraction.default(0),
});

export const OpeningSpec = z.object({
  embed: Embed.default({}),
  /** SVG path in the unit square, y down; null means rectangle (O-011 reversed). */
  cutOutPath: z.string().nullable().default(null),
  /** Default true: a door thinner than its wall still cuts both faces (O-009, C-011). */
  cutBothSides: z.boolean().default(true),
  sashes: z.array(Sash).default([]),
});

export const Price = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().length(3),
  type: z.enum(["list", "street", "quote"]),
  sourceUrl: z.string().url().nullable(),
  capturedAt: Timestamp,
  expiresAt: Timestamp,
});

export const VerificationStatus = z.enum(["verified", "unverified", "rejected", "manual"]);
export const Verification = z.object({
  status: VerificationStatus,
  confidence: Fraction,
  sources: z.array(z.string().url()),
  verifiedAt: Timestamp.nullable(),
  notes: z.string().nullable(),
});

export const SpecValue = z.union([z.string(), z.number(), z.boolean()]);

/** Slug: lowercase make and model, e.g. "samsung-qm75c". */
export const ProductSlug = ProductId.regex(
  /^[a-z0-9][a-z0-9-]*$/,
  "product ids are lowercase slugs [a-z0-9-]",
);

export const Product = z.object({
  id: ProductSlug,
  make: z.string().min(1),
  model: z.string().min(1),
  variant: z.string().nullable().default(null),
  name: z.string().min(1),
  category: Category,
  /** All > 0 (C-006 reversed). */
  dims: Size3,
  weightKg: z.number().positive().nullable().default(null),
  mount: z.object({
    kinds: z.array(MountKind).min(1),
    vesa: z.string().nullable().default(null),
    defaultHeight: MmNonNegative.nullable().default(null),
  }),
  mountPoints: z.array(MountPoint).default([]),
  clearance: z
    .object({ front: MmNonNegative, back: MmNonNegative, left: MmNonNegative, right: MmNonNegative })
    .nullable()
    .default(null),
  /** Non-uniform scaling allowed (O-010, product level). */
  deformable: z.boolean().default(true),
  /** Row-major 3x3; null means identity (C-017 reversed: exactly nine numbers or nothing). */
  meshRotation: z.array(z.number().finite()).length(9).nullable().default(null),
  /** null: resolved from category and size class (spec 02 section 3.1). */
  assetKey: AssetKey.nullable().default(null),
  materialSlots: z.array(z.string()).default([]),
  presets: z.array(z.string()).default([]),
  /** Required when category is door or window, forbidden otherwise (validated). */
  opening: OpeningSpec.nullable().default(null),
  specs: z.record(SpecValue).default({}),
  price: Price.nullable().default(null),
  verification: Verification,
  lifecycle: z.enum(["active", "discontinued", "unknown"]).default("unknown"),
  tags: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const ProductSnapshot = Product.pick({
  id: true,
  make: true,
  model: true,
  name: true,
  category: true,
  dims: true,
  weightKg: true,
  mount: true,
  mountPoints: true,
  clearance: true,
  deformable: true,
  meshRotation: true,
  assetKey: true,
  materialSlots: true,
  opening: true,
  specs: true,
  price: true,
  verification: true,
}).extend({ snapshotAt: Timestamp });

export const Texture = z.object({
  /** "<library>/<slug>" */
  id: TextureId.regex(/^[a-z0-9-]+\/[a-z0-9-]+$/, "texture ids are <library>/<slug>"),
  name: z.string().min(1),
  /**
   * The image: a library file by its hash, "sha256:<hex>", or "generated:<name>" for one the app draws
   * itself (@fpv/assets GENERATED_TEXTURES), which has no file.
   */
  image: z.string().regex(/^(sha256:[0-9a-f]{64}|generated:[a-z0-9-]+)$/),
  widthMm: MmPositive,
  heightMm: MmPositive,
  transparent: z.boolean().default(false),
  creator: z.string().nullable().default(null),
  licence: Licence,
  tags: z.array(z.string()).default([]),
});
export const TextureSnapshot = Texture;

export const LibraryManifest = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  licence: Licence,
  provider: z.string().nullable().default(null),
  products: z.array(Product),
  textures: z.array(Texture).default([]),
  assets: AssetManifest.default({ version: 1, entries: [] }),
  /** locale -> product or texture id -> localised name (C-034; never dimensions, C-035). */
  localized: z.record(z.record(z.string())).default({}),
});

/** Required spec keys per category, first release (spec 02 section 1.2). Rules in spec 07 read them. */
export const REQUIRED_SPECS: Readonly<Partial<Record<Category, readonly string[]>>> = {
  display: ["diagonalIn", "resolution", "vesa", "powerW"],
  "video-bar": ["fovDeg", "maxRoomDepthMm", "interfaces"],
  camera: ["fovDeg", "maxRoomDepthMm", "interfaces"],
  "ceiling-mic": ["coverageRadiusMm", "channels"],
  "table-mic": ["coverageRadiusMm", "channels"],
  "ceiling-speaker": ["coverageRadiusMm", "impedanceOhm", "powerW"],
  soundbar: ["coverageRadiusMm", "impedanceOhm", "powerW"],
  amplifier: ["channels", "powerPerChannelW"],
  dsp: ["inputs", "outputs", "dante"],
  switch: ["ports", "poeBudgetW"],
  cable: ["type", "lengthMm", "connectors"],
  table: ["seats"],
  desk: ["seats"],
};

export type Category = z.infer<typeof Category>;
export type MountPoint = z.infer<typeof MountPoint>;
export type Sash = z.infer<typeof Sash>;
export type Embed = z.infer<typeof Embed>;
export type OpeningSpec = z.infer<typeof OpeningSpec>;
export type Price = z.infer<typeof Price>;
export type Verification = z.infer<typeof Verification>;
export type VerificationStatus = z.infer<typeof VerificationStatus>;
export type SpecValue = z.infer<typeof SpecValue>;
export type Product = z.infer<typeof Product>;
export type ProductInput = z.input<typeof Product>;
export type ProductSnapshot = z.infer<typeof ProductSnapshot>;
export type Texture = z.infer<typeof Texture>;
export type TextureInput = z.input<typeof Texture>;
export type LibraryManifest = z.infer<typeof LibraryManifest>;
export type LibraryManifestInput = z.input<typeof LibraryManifest>;

export function isOpeningCategory(category: string): boolean {
  return category === "door" || category === "window";
}

/** Snapshot of a product for a project's catalogRefs (spec 02 section 1.1). */
export function snapshotOf(product: Product, snapshotAt: string): ProductSnapshot {
  return ProductSnapshot.parse({ ...product, snapshotAt });
}

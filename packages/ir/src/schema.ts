// Scene IR schema. Normative source: docs/spec/01-scene-ir.md (ADR-001).
// Lengths are integer millimetres, angles degrees in [0, 360), fractions in [0, 1].
// Plan coordinates: x right, y up; rotation counter-clockwise positive.

import { z } from "zod";
import { PROJECT_ID_PATTERN } from "./project-id.js";

// ---- primitives ---------------------------------------------------------

export const Mm = z.number().int().finite();
export const MmPositive = Mm.min(1);
export const MmNonNegative = Mm.min(0);
export const Deg = z.number().finite().min(0).lt(360);
export const Fraction = z.number().finite().min(0).max(1);
export const Rgb = z.string().regex(/^#[0-9A-F]{6}$/);
export const Timestamp = z.string().datetime({ offset: true });

const idOf = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-z]{6}$`));
export const LevelId = idOf("level");
export const WallId = idOf("wall");
export const OpeningId = idOf("opening");
export const RoomId = idOf("room");
export const ItemId = idOf("item");
export const ZoneId = idOf("zone");
export const AnnotationId = idOf("annot");
export const ProductId = z.string().min(1);
export const TextureId = z.string().min(1);
export const AssetKey = z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9x-]+$/);

export const Point = z.object({ x: Mm, y: Mm });
export const Polygon = z.array(Point).min(3);
export const Size3 = z.object({ w: MmPositive, d: MmPositive, h: MmPositive });

/** Normalise any angle into [0, 360). */
export function normalizeDeg(a: number): number {
  return ((a % 360) + 360) % 360;
}

// ---- finishes -----------------------------------------------------------

export const FinishPlacement = z.object({
  offsetX: Fraction,
  offsetY: Fraction,
  angle: Deg,
  scale: z.number().positive(),
  fit: z.enum(["tile", "stretch"]),
});

export const FinishRef = z.object({
  color: Rgb.nullable(),
  textureId: TextureId.nullable(),
  placement: FinishPlacement.nullable(),
  mirrorForLeftSide: z.boolean(),
  shininess: Fraction.nullable(),
});

// ---- entities -----------------------------------------------------------

export const Level = z.object({
  id: LevelId,
  name: z.string().min(1),
  elevation: Mm,
  height: MmPositive,
  floorThickness: MmNonNegative,
  index: z.number().int().min(0),
  viewable: z.boolean(),
  backgroundImage: z
    .object({ assetRef: z.string(), scaleMmPerPx: z.number().positive(), origin: Point, angle: Deg })
    .nullable(),
});

export const WallKind = z.enum(["exterior", "interior", "partition", "glass"]);
/**
 * How the plan fills a wall's cut: solid, hatched with one set of diagonals or two, or only its outline, as
 * drawings tell new, existing and temporary walls apart. The plan alone reads it; nothing in 3D does (W-121).
 */
export const WallPattern = z.enum(["solid", "hatch", "cross-hatch", "outline"]);
export const WallEnd = z.enum(["start", "end"]);
export const Join = z.object({ wallId: WallId, end: WallEnd });
/** A baseboard. `color` null takes the colour of the side it runs along (W-112). */
export const Skirting = z.object({ thickness: MmPositive, height: MmPositive, color: Rgb.nullable() });

export const Wall = z.object({
  id: WallId,
  levelId: LevelId,
  start: Point,
  end: Point,
  thickness: MmPositive,
  height: MmPositive.nullable(),
  heightAtEnd: MmPositive.nullable(),
  arcExtent: z.number().finite().min(-270).max(270).nullable(),
  kind: WallKind,
  pattern: WallPattern,
  joins: z.object({ start: Join.nullable(), end: Join.nullable() }),
  finishes: z.object({ left: FinishRef.nullable(), right: FinishRef.nullable(), top: FinishRef.nullable() }),
  skirting: z.object({ left: Skirting.nullable(), right: Skirting.nullable() }),
  properties: z.record(z.string()),
});

export const OpeningKind = z.enum(["door", "window", "passage"]);

export const Opening = z.object({
  id: OpeningId,
  levelId: LevelId,
  wallId: WallId,
  kind: OpeningKind,
  position: Fraction,
  width: MmPositive,
  height: MmPositive,
  sill: MmNonNegative,
  swing: z.object({ hinge: WallEnd, direction: z.enum(["left", "right"]) }).nullable(),
  mirrored: z.boolean(),
  productId: ProductId.nullable(),
  recipe: z.object({ style: z.enum(["single", "double", "sliding", "glazed", "plain"]) }).nullable(),
  finishes: z.object({ frame: FinishRef.nullable(), leaf: FinishRef.nullable() }),
  properties: z.record(z.string()),
});

export const RoomPurpose = z.enum([
  "meeting",
  "huddle",
  "boardroom",
  "training",
  "open-office",
  "focus",
  "reception",
  "cafeteria",
  "corridor",
  "utility",
  "storage",
  "restroom",
  "other",
]);

export const Room = z.object({
  id: RoomId,
  levelId: LevelId,
  name: z.string().nullable(),
  polygon: Polygon,
  holes: z.array(Polygon),
  purpose: RoomPurpose,
  capacity: z.number().int().min(0).nullable(),
  ceilingHeight: MmPositive.nullable(),
  finishes: z.object({ floor: FinishRef.nullable(), ceiling: FinishRef.nullable() }),
  floorVisible: z.boolean(),
  ceilingVisible: z.boolean(),
  label: z.object({ offset: Point, angle: Deg, showArea: z.boolean() }),
  source: z.enum(["manual", "detected", "imported"]),
  boundingWallIds: z.array(WallId),
  properties: z.record(z.string()),
});

export const PrimitiveRecipe = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("box"), size: Size3, label: z.string() }),
  z.object({ kind: z.literal("cylinder"), diameter: MmPositive, height: MmPositive, label: z.string() }),
  z.object({ kind: z.literal("table"), size: Size3, shape: z.enum(["rect", "round", "boat"]) }),
  z.object({ kind: z.literal("chair"), size: Size3 }),
  z.object({ kind: z.literal("display"), diagonalIn: z.number().positive(), bezelMm: MmNonNegative }),
  z.object({ kind: z.literal("video-bar"), size: Size3 }),
  z.object({ kind: z.literal("ceiling-speaker"), diameter: MmPositive }),
  z.object({ kind: z.literal("ceiling-mic"), size: Size3 }),
]);

export const MountKind = z.enum(["floor", "wall", "ceiling", "table", "item"]);

export const ItemRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("product"), productId: ProductId }),
  z.object({ kind: z.literal("recipe"), recipe: PrimitiveRecipe }),
]);

export const Item = z.object({
  id: ItemId,
  levelId: LevelId,
  ref: ItemRef,
  position: Point,
  rotation: Deg,
  elevation: Mm,
  size: Size3.nullable(),
  mirrored: z.boolean(),
  mount: z.object({
    kind: MountKind,
    targetId: z.union([WallId, ItemId]).nullable(),
    height: MmNonNegative.nullable(),
  }),
  parentId: ItemId.nullable(),
  roomId: RoomId.nullable(),
  finish: FinishRef.nullable(),
  materials: z.record(FinishRef),
  pose: z.string().nullable(),
  visible: z.boolean(),
  tags: z.array(z.string()),
  properties: z.record(z.string()),
});

export const ArrangementRule = z.object({
  pattern: z.enum(["grid", "rows", "u-shape", "boardroom", "classroom", "bench"]),
  productId: ProductId.nullable(),
  recipe: PrimitiveRecipe.nullable(),
  count: z.number().int().min(1),
  spacing: z.object({ x: MmNonNegative, y: MmNonNegative }),
  facing: Deg,
  margin: MmNonNegative,
});

export const Zone = z.object({
  id: ZoneId,
  levelId: LevelId,
  name: z.string().nullable(),
  polygon: Polygon,
  kind: z.enum(["desk-cluster", "circulation", "av-coverage", "other"]),
  rule: ArrangementRule.nullable(),
  generatedItemIds: z.array(ItemId),
  properties: z.record(z.string()),
});

const annotationBase = { id: AnnotationId, levelId: LevelId };
export const Annotation = z.discriminatedUnion("kind", [
  z.object({ ...annotationBase, kind: z.literal("scale-bar"), from: Point, to: Point, lengthMm: MmPositive }),
  z.object({ ...annotationBase, kind: z.literal("north"), position: Point, angle: Deg }),
  z.object({
    ...annotationBase,
    kind: z.literal("label"),
    position: Point,
    text: z.string(),
    angle: Deg,
    elevation: Mm.nullable(),
  }),
  z.object({ ...annotationBase, kind: z.literal("dimension"), from: Point, to: Point, offset: Mm }),
  z.object({
    ...annotationBase,
    kind: z.literal("note"),
    position: Point,
    text: z.string(),
    author: z.string().nullable(),
  }),
]);

export const Provenance = z.object({
  sourceFile: z.string().nullable(),
  reader: z.string().nullable(),
  confidence: Fraction.nullable(),
  questions: z.array(z.string()),
  importedAt: Timestamp.nullable(),
});

export const Meta = z.object({
  /**
   * The project's own identity (ADR-020 D1), twelve base36 characters. It lives in the document so that
   * a link to a project survives the folder being moved, renamed or copied to another machine; a
   * registry keyed by location cannot do that.
   */
  id: z.string().regex(PROJECT_ID_PATTERN, "a project id is twelve characters, 0-9 and a-z"),
  name: z.string().min(1),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  currency: z.string().length(3),
  north: Deg,
  units: z.literal("mm"),
});

// Product and texture snapshots are owned by spec 02; the IR only needs to carry them opaquely.
// They are typed loosely here and validated against the catalog schemas by the catalog package.
export const ProductSnapshot = z.object({ id: ProductId, snapshotAt: Timestamp }).passthrough();
export const TextureSnapshot = z.object({ id: TextureId }).passthrough();

export const SCHEMA_VERSION = 4 as const;

export const Project = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  meta: Meta,
  levels: z.array(Level).min(1),
  walls: z.array(Wall),
  openings: z.array(Opening),
  rooms: z.array(Room),
  items: z.array(Item),
  zones: z.array(Zone),
  annotations: z.array(Annotation),
  catalogRefs: z.record(ProductId, ProductSnapshot),
  textures: z.record(TextureId, TextureSnapshot),
  provenance: Provenance.nullable(),
  properties: z.record(z.string()),
});

export type Project = z.infer<typeof Project>;
export type Level = z.infer<typeof Level>;
export type Wall = z.infer<typeof Wall>;
export type Join = z.infer<typeof Join>;
export type Opening = z.infer<typeof Opening>;
export type WallPattern = z.infer<typeof WallPattern>;
export type Room = z.infer<typeof Room>;
export type Item = z.infer<typeof Item>;
export type Zone = z.infer<typeof Zone>;
export type Annotation = z.infer<typeof Annotation>;
export type Point = z.infer<typeof Point>;
export type Size3 = z.infer<typeof Size3>;
export type FinishRef = z.infer<typeof FinishRef>;
export type PrimitiveRecipe = z.infer<typeof PrimitiveRecipe>;

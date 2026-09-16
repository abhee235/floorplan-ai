// Command payload schemas (spec 03). Every mutation of a project is one of these commands.
import {
  AnnotationId,
  Annotation as AnnotationSchema,
  ArrangementRule,
  Deg,
  FinishRef,
  Fraction,
  ItemId,
  ItemRef,
  Join,
  LevelId,
  Mm,
  MmNonNegative,
  MmPositive,
  MountKind,
  OpeningId,
  OpeningKind,
  Point,
  Polygon,
  PrimitiveRecipe,
  ProductId,
  RoomId,
  RoomPurpose,
  Size3,
  Skirting,
  WallId,
  WallKind,
  ZoneId,
} from "@fpv/ir";
import { z } from "zod";

// ---- shared fragments -----------------------------------------------------

const WallEnd = z.enum(["start", "end"]);
export const Compass = z.enum(["north", "south", "east", "west"]);

export const Anchor = z.union([
  z.enum([
    "center",
    "against-north-wall",
    "against-south-wall",
    "against-east-wall",
    "against-west-wall",
    "north-east-corner",
    "north-west-corner",
    "south-east-corner",
    "south-west-corner",
  ]),
  z.object({ alongWall: WallId, atMm: MmNonNegative }),
  z.object({ on: ItemId, dropRatio: Fraction.optional() }),
]);

const MountPayload = z.object({
  kind: MountKind,
  targetId: z.union([WallId, ItemId]).nullable().optional(),
  height: MmNonNegative.nullable().optional(),
});

// ---- walls ----------------------------------------------------------------

export const WallCreate = z.object({
  levelId: LevelId,
  start: Point,
  end: Point,
  thickness: MmPositive.optional(),
  height: MmPositive.nullable().optional(),
  heightAtEnd: MmPositive.nullable().optional(),
  arcExtent: z.number().finite().min(-270).max(270).nullable().optional(),
  kind: WallKind.optional(),
  joinStart: Join.nullable().optional(),
  joinEnd: Join.nullable().optional(),
});

export const WallCreateChain = z.object({
  levelId: LevelId,
  points: z.array(Point).min(2),
  closed: z.boolean(),
  thickness: MmPositive.optional(),
  height: MmPositive.nullable().optional(),
  kind: WallKind.optional(),
  snapMm: MmNonNegative.optional(),
});

export const WallModify = z.object({
  wallId: WallId,
  changes: z
    .object({
      start: Point,
      end: Point,
      thickness: MmPositive,
      height: MmPositive.nullable(),
      heightAtEnd: MmPositive.nullable(),
      arcExtent: z.number().finite().min(-270).max(270).nullable(),
      kind: WallKind,
      finishes: z.object({
        left: FinishRef.nullable(),
        right: FinishRef.nullable(),
        top: FinishRef.nullable(),
      }),
      skirting: z.object({ left: Skirting.nullable(), right: Skirting.nullable() }),
      properties: z.record(z.string()),
    })
    .partial(),
});

export const WallMove = z.object({ wallIds: z.array(WallId).min(1), dx: Mm, dy: Mm });
export const WallSplit = z.object({ wallId: WallId, at: Fraction.optional() });
export const WallJoin = z.object({ a: Join, b: Join });
export const WallReverse = z.object({ wallIds: z.array(WallId).min(1) });
export const WallDelete = z.object({ wallIds: z.array(WallId).min(1) });

// ---- openings -------------------------------------------------------------

export const OpeningAdd = z.object({
  wallId: WallId,
  kind: OpeningKind,
  position: Fraction.optional(),
  atMm: MmNonNegative.optional(),
  width: MmPositive.optional(),
  height: MmPositive.optional(),
  sill: MmNonNegative.optional(),
  swing: z
    .object({ hinge: WallEnd, direction: z.enum(["left", "right"]) })
    .nullable()
    .optional(),
  mirrored: z.boolean().optional(),
  productId: ProductId.nullable().optional(),
  recipe: z
    .object({ style: z.enum(["single", "double", "sliding", "glazed", "plain"]) })
    .nullable()
    .optional(),
});

export const OpeningModify = z.object({
  openingId: OpeningId,
  changes: z
    .object({
      kind: OpeningKind,
      position: Fraction,
      width: MmPositive,
      height: MmPositive,
      sill: MmNonNegative,
      swing: z.object({ hinge: WallEnd, direction: z.enum(["left", "right"]) }).nullable(),
      mirrored: z.boolean(),
      productId: ProductId.nullable(),
      finishes: z.object({ frame: FinishRef.nullable(), leaf: FinishRef.nullable() }),
      properties: z.record(z.string()),
    })
    .partial(),
});

export const OpeningMove = z.object({
  openingId: OpeningId,
  wallId: WallId.optional(),
  position: Fraction.optional(),
  atMm: MmNonNegative.optional(),
});

export const OpeningDelete = z.object({ openingIds: z.array(OpeningId).min(1) });

// ---- rooms ----------------------------------------------------------------

export const RoomCreate = z.object({
  levelId: LevelId,
  polygon: Polygon.optional(),
  rect: z.object({ x: Mm, y: Mm, w: MmPositive, d: MmPositive }).optional(),
  atPoint: Point.optional(),
  name: z.string().nullable().optional(),
  purpose: RoomPurpose.optional(),
  capacity: z.number().int().min(0).nullable().optional(),
  gapToleranceMm: MmNonNegative.optional(),
});

export const RoomDetectAll = z.object({
  levelId: LevelId,
  gapToleranceMm: MmNonNegative.optional(),
  replaceStale: z.boolean().optional(),
});

export const RoomModify = z.object({
  roomId: RoomId,
  changes: z
    .object({
      name: z.string().nullable(),
      purpose: RoomPurpose,
      capacity: z.number().int().min(0).nullable(),
      ceilingHeight: MmPositive.nullable(),
      finishes: z.object({ floor: FinishRef.nullable(), ceiling: FinishRef.nullable() }),
      floorVisible: z.boolean(),
      ceilingVisible: z.boolean(),
      label: z.object({ offset: Point, angle: Deg, showArea: z.boolean() }),
      properties: z.record(z.string()),
    })
    .partial(),
});

export const RoomSetPolygon = z.object({
  roomId: RoomId,
  polygon: Polygon,
  holes: z.array(Polygon).optional(),
});
export const RoomAddPoint = z.object({ roomId: RoomId, point: Point });
export const RoomMovePoint = z.object({ roomId: RoomId, index: z.number().int().min(0), point: Point });
export const RoomRemovePoint = z.object({ roomId: RoomId, index: z.number().int().min(0) });
export const RoomDelete = z.object({ roomIds: z.array(RoomId).min(1) });

// ---- levels ---------------------------------------------------------------

export const LevelAdd = z.object({
  name: z.string().optional(),
  elevation: Mm.optional(),
  height: MmPositive.optional(),
  floorThickness: MmNonNegative.optional(),
  sameAs: LevelId.optional(),
});

export const LevelModify = z.object({
  levelId: LevelId,
  changes: z
    .object({
      name: z.string().min(1),
      elevation: Mm,
      height: MmPositive,
      floorThickness: MmNonNegative,
      index: z.number().int().min(0),
      viewable: z.boolean(),
    })
    .partial(),
});

export const LevelDelete = z.object({ levelId: LevelId });

// ---- items ----------------------------------------------------------------

export const ItemPlace = z.object({
  levelId: LevelId,
  ref: ItemRef,
  position: Point.optional(),
  roomId: RoomId.optional(),
  anchor: Anchor.optional(),
  rotation: Deg.optional(),
  elevation: Mm.optional(),
  mount: MountPayload.optional(),
  parentId: ItemId.nullable().optional(),
  tags: z.array(z.string()).optional(),
  /** Run the placement pipeline (spec 05 section 5); false keeps the exact position. Default true. */
  magnetism: z.boolean().optional(),
});

export const ItemMove = z.object({
  itemIds: z.array(ItemId).min(1),
  dx: Mm,
  dy: Mm,
  dz: Mm.optional(),
  /** Placement pipeline on a single moved item without re-orienting (F-076, F-077). Default true. */
  magnetism: z.boolean().optional(),
});

export const ItemRotate = z.object({
  itemIds: z.array(ItemId).min(1),
  angle: Deg.optional(),
  delta: z.number().finite().optional(),
  about: Point.optional(),
});

export const ItemResize = z.object({
  itemId: ItemId,
  size: Size3.nullable(),
  anchor: z.enum(["center", "back-left"]).optional(),
});

export const ItemSetElevation = z.object({ itemIds: z.array(ItemId).min(1), elevation: Mm });
export const ItemSetParent = z.object({
  itemId: ItemId,
  parentId: ItemId.nullable(),
  dropRatio: Fraction.optional(),
});
export const ItemSetProduct = z.object({ itemId: ItemId, ref: ItemRef });
export const ItemMirror = z.object({ itemIds: z.array(ItemId).min(1) });
export const ItemSetFinish = z.object({
  itemIds: z.array(ItemId).min(1),
  finish: FinishRef.nullable().optional(),
  materials: z.record(FinishRef.nullable()).optional(),
});
export const ItemDuplicate = z.object({
  itemIds: z.array(ItemId).min(1),
  dx: Mm.optional(),
  dy: Mm.optional(),
});
export const ItemDelete = z.object({
  itemIds: z.array(ItemId).min(1),
  withDescendants: z.boolean().optional(),
});
export const ItemAlign = z.object({
  itemIds: z.array(ItemId).min(2),
  leadId: ItemId,
  edge: z.enum([
    "north",
    "south",
    "east",
    "west",
    "front",
    "back",
    "left-side",
    "right-side",
    "side-by-side",
  ]),
});
export const ItemDistribute = z.object({ itemIds: z.array(ItemId).min(3), axis: z.enum(["x", "y"]) });
export const ItemArrange = z.object({
  target: z.union([
    z.object({ roomId: RoomId }),
    z.object({ zoneId: ZoneId }),
    z.object({ polygon: Polygon, levelId: LevelId }),
  ]),
  rule: ArrangementRule,
  replace: z.boolean().optional(),
});

// ---- zones, annotations, project -----------------------------------------

export const ZoneCreate = z.object({
  levelId: LevelId,
  polygon: Polygon,
  kind: z.enum(["desk-cluster", "circulation", "av-coverage", "other"]),
  name: z.string().nullable().optional(),
  rule: ArrangementRule.nullable().optional(),
});
export const ZoneModify = z.object({
  zoneId: ZoneId,
  changes: z
    .object({
      name: z.string().nullable(),
      polygon: Polygon,
      kind: z.enum(["desk-cluster", "circulation", "av-coverage", "other"]),
      rule: ArrangementRule.nullable(),
      properties: z.record(z.string()),
    })
    .partial(),
});
export const ZoneRegenerate = z.object({ zoneId: ZoneId });
export const ZoneDelete = z.object({ zoneIds: z.array(ZoneId).min(1), deleteItems: z.boolean().optional() });

const AnnotationInput = z.discriminatedUnion("kind", [
  z.object({ levelId: LevelId, kind: z.literal("scale-bar"), from: Point, to: Point, lengthMm: MmPositive }),
  z.object({ levelId: LevelId, kind: z.literal("north"), position: Point, angle: Deg }),
  z.object({
    levelId: LevelId,
    kind: z.literal("label"),
    position: Point,
    text: z.string(),
    angle: Deg,
    elevation: Mm.nullable(),
  }),
  z.object({ levelId: LevelId, kind: z.literal("dimension"), from: Point, to: Point, offset: Mm }),
  z.object({
    levelId: LevelId,
    kind: z.literal("note"),
    position: Point,
    text: z.string(),
    author: z.string().nullable(),
  }),
]);
export const AnnotationAdd = z.object({ annotation: AnnotationInput });
export const AnnotationModify = z.object({ annotationId: AnnotationId, changes: z.record(z.unknown()) });
export const AnnotationDelete = z.object({ annotationIds: z.array(AnnotationId).min(1) });

export const ProjectSetMeta = z.object({
  changes: z.object({ name: z.string().min(1), currency: z.string().length(3), north: Deg }).partial(),
});
export const ProjectSetProvenance = z.object({
  provenance: z.object({
    sourceFile: z.string().nullable(),
    reader: z.string().nullable(),
    confidence: Fraction.nullable(),
    questions: z.array(z.string()),
    importedAt: z.string().nullable(),
  }),
});
export const CatalogRefresh = z.object({ productIds: z.array(ProductId).optional() });

// ---- the union ------------------------------------------------------------

const cmd = <T extends string, S extends z.ZodTypeAny>(type: T, payload: S) =>
  z.object({ type: z.literal(type), payload });

export const Command = z.discriminatedUnion("type", [
  cmd("wall.create", WallCreate),
  cmd("wall.createChain", WallCreateChain),
  cmd("wall.modify", WallModify),
  cmd("wall.move", WallMove),
  cmd("wall.split", WallSplit),
  cmd("wall.join", WallJoin),
  cmd("wall.reverse", WallReverse),
  cmd("wall.delete", WallDelete),
  cmd("opening.add", OpeningAdd),
  cmd("opening.modify", OpeningModify),
  cmd("opening.move", OpeningMove),
  cmd("opening.delete", OpeningDelete),
  cmd("room.create", RoomCreate),
  cmd("room.detectAll", RoomDetectAll),
  cmd("room.modify", RoomModify),
  cmd("room.setPolygon", RoomSetPolygon),
  cmd("room.addPoint", RoomAddPoint),
  cmd("room.movePoint", RoomMovePoint),
  cmd("room.removePoint", RoomRemovePoint),
  cmd("room.delete", RoomDelete),
  cmd("level.add", LevelAdd),
  cmd("level.modify", LevelModify),
  cmd("level.delete", LevelDelete),
  cmd("item.place", ItemPlace),
  cmd("item.move", ItemMove),
  cmd("item.rotate", ItemRotate),
  cmd("item.resize", ItemResize),
  cmd("item.setElevation", ItemSetElevation),
  cmd("item.setParent", ItemSetParent),
  cmd("item.setProduct", ItemSetProduct),
  cmd("item.mirror", ItemMirror),
  cmd("item.setFinish", ItemSetFinish),
  cmd("item.duplicate", ItemDuplicate),
  cmd("item.delete", ItemDelete),
  cmd("item.align", ItemAlign),
  cmd("item.distribute", ItemDistribute),
  cmd("item.arrange", ItemArrange),
  cmd("zone.create", ZoneCreate),
  cmd("zone.modify", ZoneModify),
  cmd("zone.regenerate", ZoneRegenerate),
  cmd("zone.delete", ZoneDelete),
  cmd("annotation.add", AnnotationAdd),
  cmd("annotation.modify", AnnotationModify),
  cmd("annotation.delete", AnnotationDelete),
  cmd("project.setMeta", ProjectSetMeta),
  cmd("project.setProvenance", ProjectSetProvenance),
  cmd("catalog.refresh", CatalogRefresh),
]);

export type Command = z.infer<typeof Command>;
export type CommandType = Command["type"];
export type PayloadOf<T extends CommandType> = Extract<Command, { type: T }>["payload"];
export type AnnotationType = z.infer<typeof AnnotationSchema>;
export type RecipeType = z.infer<typeof PrimitiveRecipe>;
export type CompassWord = z.infer<typeof Compass>;
export type AnchorSpec = z.infer<typeof Anchor>;

// The PlanDraft contract (spec 06 part A1, ADR-011 D1): what every plan reader produces and a person or the
// import tool confirms before anything becomes walls. Draft coordinates are floats in draft units, y up.
import { Fraction, OpeningKind, RoomPurpose, WallKind } from "@fpv/ir";
import { z } from "zod";

export const DraftUnits = z.enum(["mm", "cm", "m", "in", "ft", "unknown"]);
export const ScaleSource = z.enum(["dimension-text", "scale-bar", "header", "user", "guess"]);

const XY = z.object({ x: z.number(), y: z.number() });

export const DraftWall = z.object({
  idx: z.number().int(),
  /** Centreline polyline in draft units, y up. */
  points: z.array(XY).min(2),
  thickness: z.number().positive().nullable(),
  kind: WallKind.nullable(),
  confidence: Fraction,
  /** DXF handles, PDF path index, or image region. */
  sourceRef: z.string().nullable(),
});

export const DraftOpening = z.object({
  idx: z.number().int(),
  wallIdx: z.number().int().nullable(),
  /** Centre in draft units. */
  at: XY,
  kind: OpeningKind,
  width: z.number().positive().nullable(),
  height: z.number().positive().nullable(),
  /** The wall end the hinge jamb is nearer, relative to the draft wall's direction; null when not drawn. */
  hinge: z.enum(["start", "end"]).nullable(),
  /** The side of the wall the leaf opens to, looking from the wall start along it; null when not drawn. */
  swing: z.enum(["left", "right"]).nullable(),
  confidence: Fraction,
});

export const DraftRoom = z.object({
  idx: z.number().int(),
  polygon: z.array(XY).min(3).nullable(),
  labelAt: XY.nullable(),
  name: z.string().nullable(),
  purpose: RoomPurpose.nullable(),
  capacity: z.number().int().nullable(),
  confidence: Fraction,
});

export const DraftText = z.object({
  at: XY,
  text: z.string(),
  kind: z.enum(["room-name", "dimension", "scale", "other"]),
});

export const DraftQuestion = z.object({
  id: z.string(),
  text: z.string(),
  kind: z.enum(["scale", "dimension", "ambiguity", "missing"]),
  answer: z.string().nullable(),
});

export const PlanDraft = z.object({
  source: z.object({
    kind: z.enum(["dxf", "pdf-vector", "pdf-raster", "image", "sketch", "brief"]),
    file: z.string().nullable(),
    page: z.number().int().nullable(),
    pixelSize: z.object({ w: z.number(), h: z.number() }).nullable(),
  }),
  units: z.object({
    detected: DraftUnits,
    /** Millimetres per draft unit; null until known. */
    mmPerUnit: z.number().positive().nullable(),
    scaleSource: ScaleSource,
    checks: z.array(z.object({ text: z.string(), measuredUnits: z.number(), impliedMmPerUnit: z.number() })),
  }),
  levelName: z.string().nullable(),
  walls: z.array(DraftWall),
  openings: z.array(DraftOpening),
  rooms: z.array(DraftRoom),
  texts: z.array(DraftText),
  confidence: Fraction,
  questions: z.array(DraftQuestion),
  reader: z.object({ providerId: z.string(), model: z.string(), promptVersion: z.string() }).nullable(),
});

export type DraftUnits = z.infer<typeof DraftUnits>;
export type ScaleSource = z.infer<typeof ScaleSource>;
export type DraftWall = z.infer<typeof DraftWall>;
export type DraftOpening = z.infer<typeof DraftOpening>;
export type DraftRoom = z.infer<typeof DraftRoom>;
export type DraftText = z.infer<typeof DraftText>;
export type DraftQuestion = z.infer<typeof DraftQuestion>;
export type PlanDraft = z.infer<typeof PlanDraft>;

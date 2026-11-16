// The plan as shapes (ADR-003 D6, ADR-013 D5): what the editor's plan draws and what a layout drawing
// prints, worked out once from the IR so the two cannot disagree. Everything is in plan millimetres, y up.
//
// A shape says what it is, not how it is painted. The editor paints it on a canvas in screen pixels, the
// PDF on paper in points, the DXF on layers in model millimetres; each reads the same list, so a room the
// plan shows is a room the drawing prints, at the same corners.
import {
  difference,
  type PolyWithHoles,
  ringToMulti,
  triangulate,
  unionRings,
  wallFootprints,
} from "@fpv/geometry";
import {
  derive,
  type Item,
  type Opening,
  type Point,
  type Project,
  poly,
  type Wall,
  type WallPattern,
  type Zone,
} from "@fpv/ir";
import { skirtingOutlines } from "./walls.js";

/** The plan's inks, shared by every surface that draws it. */
export const PLAN_INK = {
  // the plan's own background, so a hatched or outlined wall hides the grid and the room edges under it
  paper: "#fbfaf7",
  wall: "#3a3a3a",
  wallGlass: "#7fb3d5",
  // a mid grey against the near-black wall: a baseboard is a thin second edge, not more wall
  skirting: "#9b958c",
  room: "rgba(214, 226, 240, 0.55)",
  roomEdge: "#8fa6bf",
  opening: "#ffffff",
  swing: "#6b6b6b",
  item: "rgba(140, 120, 90, 0.35)",
  itemEdge: "#6f5b3e",
  text: "#333333",
  // A zone is an instruction, not a thing that was built, so it is drawn in a colour nothing else uses
  // and never filled: a tint would wash over the desks standing inside it.
  zone: "#7a5cc4",
} as const;

export interface RoomShape {
  id: string;
  /** The outline first, then its holes. */
  rings: Point[][];
  /** What the plan calls it: its name, or its purpose when it has none. */
  name: string;
  areaM2: number;
  labelAt: Point;
}

/** One fused group of wall cuts: walls of one kind and pattern merge at their corners, as on a drawing. */
export interface WallCut {
  kind: Wall["kind"];
  pattern: WallPattern;
  glass: boolean;
  shape: PolyWithHoles[];
}

/** A door's swing: the leaf from the hinge, turning through a quarter circle from `start` by `sweep`. */
export interface SwingShape {
  hinge: Point;
  radius: number;
  /** Radians, counter-clockwise from +x, in plan space. */
  start: number;
  /** A quarter turn, positive counter-clockwise. */
  sweep: number;
}

export interface OpeningShape {
  id: string;
  kind: Opening["kind"];
  /** The gap through the wall, a little wider than the wall so it covers both faces. */
  gap: Point[];
  /** A window's glass along the wall's centre line, as wide as a third of the wall. */
  glazing: { a: Point; b: Point; widthMm: number } | null;
  swing: SwingShape | null;
}

export interface ItemShape {
  id: string;
  footprint: Point[];
  /** The front edge, front-right to front-left: the footprint's last edge. */
  front: [Point, Point];
  mount: Item["mount"]["kind"];
  /** What a drawing calls it: the product's short name, or the recipe's label or kind. */
  title: string;
  size: { w: number; d: number; h: number };
  /**
   * The height a fitter works to, above the level's floor: a wall item's centre line, a ceiling item's
   * ceiling. Null for anything standing on the floor or on another item. The same numbers the rules pack
   * measures cable runs with (connectionHeight in the catalog's facts).
   */
  mountHeight: number | null;
}

export interface ZoneShape {
  id: string;
  ring: Point[];
  label: string;
  /** The top-left corner of its bounds, where its name sits. */
  labelAt: Point;
}

export interface PlanStructure {
  rooms: RoomShape[];
  walls: WallCut[];
  /** Baseboards, each a set of rings. */
  skirting: Point[][];
  openings: OpeningShape[];
}

/** Rooms, walls, baseboards and openings on one level: the plan's structure layer. */
export function planStructure(project: Project, levelId: string): PlanStructure {
  const rooms: RoomShape[] = project.rooms
    .filter((r) => r.levelId === levelId)
    .map((r) => ({
      id: r.id,
      rings: [r.polygon, ...r.holes],
      name: r.name ?? r.purpose,
      areaM2: derive.roomArea(r) / 1e6,
      labelAt: derive.roomLabelAnchor(r),
    }));
  // walls as a fused union per kind and pattern: walls of one kind drawn alike merge at their corners, and
  // a change of either shows as a seam, as it does on a drawing
  const walls = project.walls.filter((w) => w.levelId === levelId);
  const fps = wallFootprints(walls);
  const groups = new Map<string, { kind: Wall["kind"]; pattern: WallPattern; rings: Point[][] }>();
  for (const w of walls) {
    const fp = fps.get(w.id);
    if (!fp || fp.length < 3) continue;
    const key = `${w.kind}|${w.pattern}`;
    const group = groups.get(key) ?? { kind: w.kind, pattern: w.pattern, rings: [] };
    group.rings.push(fp);
    groups.set(key, group);
  }
  const cuts: WallCut[] = [...groups.values()].map((g) => ({
    kind: g.kind,
    pattern: g.pattern,
    glass: g.kind === "glass",
    shape: unionRings(g.rings),
  }));
  // Baseboards, from the outlines the 3D faces are built from.
  const skirting: Point[][] = [];
  const level = project.levels.find((l) => l.id === levelId);
  if (level) {
    const lowest = derive.lowestLevel(project);
    const boards = skirtingOutlines(project.walls, project.openings, {
      level,
      isLowest: lowest.id === level.id,
      isHighest: true,
      footprints: fps,
    });
    for (const board of boards) skirting.push(...board.rings);
  }
  // openings: a gap through the wall plus the glass or the door swing
  const openings: OpeningShape[] = [];
  for (const o of project.openings) {
    const w = walls.find((x) => x.id === o.wallId);
    if (!w) continue;
    let glazing: OpeningShape["glazing"] = null;
    if (o.kind === "window") {
      const iv = derive.openingAlongInterval(o, w);
      const len = derive.wallLength(w);
      glazing = {
        a: derive.pointAlongWall(w, iv.from / len),
        b: derive.pointAlongWall(w, iv.to / len),
        widthMm: w.thickness / 3,
      };
    }
    openings.push({
      id: o.id,
      kind: o.kind,
      gap: derive.openingFootprint(o, w, 2),
      glazing,
      swing: o.kind === "window" ? null : swingOf(o, w),
    });
  }
  return { rooms, walls: cuts, skirting, openings };
}

/** Quarter-circle door swing from the hinge end, on the side the swing direction names. */
function swingOf(o: Opening, w: Wall): SwingShape | null {
  if (!o.swing) return null;
  const iv = derive.openingAlongInterval(o, w);
  const len = derive.wallLength(w);
  const hingeT = (o.swing.hinge === "start" ? iv.from : iv.to) / len;
  const angle = (derive.wallAngle(w) * Math.PI) / 180;
  const along = o.swing.hinge === "start" ? angle : angle + Math.PI;
  // "left" opens to the wall's left side (positive rotation from the along direction), "right" the other way
  const sign = (o.swing.direction === "left") !== (o.swing.hinge === "end") ? 1 : -1;
  return {
    hinge: derive.pointAlongWall(w, hingeT),
    radius: o.width,
    start: along,
    sweep: (sign * Math.PI) / 2,
  };
}

/** Visible items on one level, with what a drawing needs to label them: the plan's items layer. */
export function planItems(project: Project, levelId: string, sizes: derive.SizeSource): ItemShape[] {
  const level = project.levels.find((l) => l.id === levelId);
  const out: ItemShape[] = [];
  for (const it of project.items) {
    if (it.levelId !== levelId || !it.visible) continue;
    const size = derive.itemSize(it, sizes);
    if (!size) continue;
    const fp = derive.itemFootprint(it, size);
    out.push({
      id: it.id,
      footprint: fp,
      front: [fp[2] as Point, fp[3] as Point],
      mount: it.mount.kind,
      title: itemTitle(it, project),
      size: { w: size.w, d: size.d, h: size.h },
      mountHeight: mountHeightOf(it, size.h, project, level?.height ?? null),
    });
  }
  return out;
}

function mountHeightOf(it: Item, h: number, project: Project, levelHeight: number | null): number | null {
  if (it.mount.kind === "wall") return it.elevation + h / 2;
  if (it.mount.kind !== "ceiling") return null;
  const room =
    (it.roomId ? project.rooms.find((r) => r.id === it.roomId) : null) ??
    derive.containingRoom(project, it.levelId, it.position);
  return room?.ceilingHeight ?? levelHeight;
}

/** Zones on one level: a ring and the name it is shown with. */
export function planZones(project: Project, levelId: string): ZoneShape[] {
  return project.zones
    .filter((z) => z.levelId === levelId && z.polygon.length >= 3)
    .map((z) => {
      const b = poly.bounds(z.polygon);
      return { id: z.id, ring: z.polygon, label: zoneLabel(z, project), labelAt: { x: b.minX, y: b.maxY } };
    });
}

/**
 * What a zone is called on the plan: its own name if it has one, else the piece it lays out, and how many
 * are standing. A cluster of chairs reads "Chair · 24" rather than "Desk cluster", because what it holds
 * is the thing you need to know at a glance.
 */
export function zoneLabel(z: Zone, project?: Project): string {
  const count = z.generatedItemIds.length;
  const name = z.name ?? (project ? zonePieceName(z, project) : null) ?? kindWords(z.kind);
  return count > 0 ? `${name} · ${count}` : name;
}

/** The piece a zone lays out, in words, or null when it lays out nothing. */
function zonePieceName(z: Zone, project: Project): string | null {
  const rule = z.rule;
  if (!rule) return null;
  if (rule.productId) return productShortName(project, rule.productId);
  if (!rule.recipe) return null;
  const label = "label" in rule.recipe ? rule.recipe.label.trim() : "";
  return label !== "" ? label : kindWords(rule.recipe.kind);
}

/** What a drawing calls an item: the product's short name, or the recipe's label or kind. */
export function itemTitle(it: Item, project: Project): string {
  if (it.ref.kind === "product") return productShortName(project, it.ref.productId);
  const recipe = it.ref.recipe;
  const label = "label" in recipe ? recipe.label.trim() : "";
  return label !== "" ? label : kindWords(recipe.kind);
}

/** The part of a product's name before the first comma: a catalogue name is a sentence, and a plan has no room for one. */
function productShortName(project: Project, productId: string): string {
  const snap = project.catalogRefs[productId] as { name?: unknown } | undefined;
  const full = typeof snap?.name === "string" && snap.name.trim() !== "" ? snap.name : productId;
  return (full.split(",")[0] as string).trim();
}

function kindWords(kind: string): string {
  const words = kind.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The extent of everything drawn on a level, or null when nothing is. */
export function planBounds(
  structure: PlanStructure,
  items: readonly ItemShape[],
  zones: readonly ZoneShape[],
): poly.Rect | null {
  const pts: Point[] = [];
  for (const r of structure.rooms) pts.push(...(r.rings[0] ?? []));
  for (const c of structure.walls) for (const p of c.shape) pts.push(...p.outer);
  for (const it of items) pts.push(...it.footprint);
  for (const z of zones) pts.push(...z.ring);
  return pts.length ? poly.bounds(pts) : null;
}

/**
 * Hatch lines across a box, `step` apart measured across them, rising to the right for `slope` 1 and
 * falling for -1. Each line is y = slope * x + c; lines `step` apart are `step` times √2 apart in c, and c
 * runs on multiples of that, so the hatch stays anchored to the plan while a view pans.
 */
export function hatchLines(box: poly.Rect, step: number, slope: 1 | -1): [Point, Point][] {
  const dc = step * Math.SQRT2;
  const ends = [box.minX, box.maxX].flatMap((x) => [box.minY - slope * x, box.maxY - slope * x]);
  const first = Math.floor(Math.min(...ends) / dc) * dc;
  const last = Math.max(...ends);
  const out: [Point, Point][] = [];
  for (let c = first; c <= last; c += dc)
    out.push([
      { x: box.minX, y: slope * box.minX + c },
      { x: box.maxX, y: slope * box.maxX + c },
    ]);
  return out;
}

/**
 * A wall cut with its openings' gaps taken out. The canvas and the PDF paint a gap white over the wall; a
 * format that cannot paint white (a DXF) draws the wall already broken where its doors and windows are.
 */
export function withoutGaps(shape: PolyWithHoles[], gaps: readonly (readonly Point[])[]): PolyWithHoles[] {
  return gaps.length ? difference(shape, ...gaps.map((g) => ringToMulti(g))) : shape;
}

/** A shape as triangles, for a format whose only fill is a triangle. */
export function shapeTriangles(shape: readonly PolyWithHoles[]): [Point, Point, Point][] {
  const out: [Point, Point, Point][] = [];
  for (const part of shape) {
    const t = triangulate(part.outer, part.holes);
    for (let i = 0; i + 2 < t.indices.length; i += 3)
      out.push([
        t.points[t.indices[i] as number] as Point,
        t.points[t.indices[i + 1] as number] as Point,
        t.points[t.indices[i + 2] as number] as Point,
      ]);
  }
  return out;
}

/** Whether a point lies inside a shape, counting holes by the even-odd rule. */
function insideShape(p: Point, shape: readonly PolyWithHoles[]): boolean {
  let inside = false;
  for (const part of shape)
    for (const ring of [part.outer, ...part.holes]) if (poly.containsPoint(ring, p)) inside = !inside;
  return inside;
}

/**
 * The pieces of a segment that lie inside a shape. A format that cannot clip (a DXF) is given hatching
 * already cut to the wall, which is what the canvas and the PDF get by clipping.
 */
export function clipToShape(a: Point, b: Point, shape: readonly PolyWithHoles[]): [Point, Point][] {
  const ts = [0, 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const part of shape)
    for (const ring of [part.outer, ...part.holes])
      for (let i = 0; i < ring.length; i += 1) {
        const p = ring[i] as Point;
        const q = ring[(i + 1) % ring.length] as Point;
        const ex = q.x - p.x;
        const ey = q.y - p.y;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((p.x - a.x) * ey - (p.y - a.y) * ex) / den;
        const u = ((p.x - a.x) * dy - (p.y - a.y) * dx) / den;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
      }
  ts.sort((x, y) => x - y);
  const at = (t: number): Point => ({ x: a.x + dx * t, y: a.y + dy * t });
  const out: [Point, Point][] = [];
  for (let i = 0; i + 1 < ts.length; i += 1) {
    const t0 = ts[i] as number;
    const t1 = ts[i + 1] as number;
    if (t1 - t0 < 1e-9) continue;
    if (insideShape(at((t0 + t1) / 2), shape)) {
      const last = out.at(-1);
      // runs that meet are one piece
      if (last && Math.abs(last[1].x - at(t0).x) < 1e-9 && Math.abs(last[1].y - at(t0).y) < 1e-9)
        last[1] = at(t1);
      else out.push([at(t0), at(t1)]);
    }
  }
  return out;
}

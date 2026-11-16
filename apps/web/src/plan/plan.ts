// The 2D plan (ADR-003 D6): four stacked Canvas 2D layers (static, structure, items, overlay), one
// transform (scale, translate, y flip), all drawing in IR millimetres. The drawing context is an
// interface so tests can record calls without a DOM.
//
// What is drawn comes from the engine's plan shapes (planStructure, planItems, planZones), the same list
// a layout drawing prints (ADR-013 D5); this file decides only how they look on a screen.
import type { ChangeSet } from "@fpv/commands";
import {
  emptyRebuildSet,
  expand,
  hatchLines,
  type Layer,
  PLAN_INK,
  planItems,
  planStructure,
  planZones,
  type RebuildSet,
  type RoomShape,
  type SwingShape,
  type ZoneShape,
  zoneLabel,
} from "@fpv/engine";
import { type PolyWithHoles, wallFootprints } from "@fpv/geometry";
import type { Item, Point, Project, WallPattern, Zone } from "@fpv/ir";
import { derive, poly } from "@fpv/ir";

export { zoneLabel };

/** The subset of CanvasRenderingContext2D the plan uses. */
export interface Ctx2D {
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void;
  closePath(): void;
  fill(rule?: "nonzero" | "evenodd"): void;
  clip(rule?: "nonzero" | "evenodd"): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  setLineDash(segments: number[]): void;
  /** Present on a real canvas; the review draws a raster plan's image with it. */
  drawImage?(image: never, x: number, y: number, w: number, h: number): void;
  globalAlpha?: number;
}

export interface PlanView {
  /** pixels per mm */
  scale: number;
  /** screen x of plan x = 0 */
  offsetX: number;
  /** screen y of plan y = 0 */
  offsetY: number;
  width: number;
  height: number;
}

export type PlanLayers = Record<Layer, Ctx2D>;

/** The plan's own inks, plus what only the editor draws: the grid and the selection. */
const COLOURS = {
  ...PLAN_INK,
  grid: "#e6e3dd",
  gridMajor: "#d3cfc7",
  selection: "#1e88e5",
};

/** A zone's name sits this many screen pixels above its top-left corner, and is reachable there. */
const ZONE_LABEL_PX = 5;
const ZONE_LABEL_HEIGHT_PX = 13;

/** Hatch lines are this many screen pixels apart and this wide; an outlined cut is edged this wide. */
const HATCH_GAP_PX = 5;
const HATCH_LINE_PX = 1;
const OUTLINE_PX = 1.5;

export class PlanRenderer {
  private dirty: RebuildSet = emptyRebuildSet();
  private project: Project | null = null;
  private selection: string[] = [];
  private full = false;
  private levelId: string | null = null;
  view: PlanView;
  draws: Record<Layer, number> = { static: 0, structure: 0, items: 0, overlay: 0 };
  /** Extra drawing on the overlay layer in plan millimetres, e.g. a draft under review. */
  private overlayExtra: ((ctx: Ctx2D, view: PlanView) => void) | null = null;

  constructor(
    private readonly layers: PlanLayers,
    width: number,
    height: number,
    private readonly sizes: derive.SizeSource | null = null,
  ) {
    this.view = { scale: 0.05, offsetX: width / 2, offsetY: height / 2, width, height };
  }

  setProject(project: Project): void {
    this.project = project;
    if (!this.levelId || !project.levels.some((l) => l.id === this.levelId))
      this.levelId = derive.lowestLevel(project).id;
    this.full = true;
  }

  onChanges(changes: ChangeSet, project: Project): void {
    this.project = project;
    if (changes.updated.some((r) => r.type === "meta")) this.full = true;
    else expand(changes, project, this.dirty);
    // The selection outline is drawn from the geometry, so any change can move it: the selected entity
    // itself, or a wall it is mitred against. A drag never showed this, because it repaints the overlay on
    // every move; an edit typed into the properties panel, an undo or an agent's command left the outline
    // where the entity used to be. Nothing selected, nothing to redraw.
    if (this.selection.length > 0) this.dirty.layers.add("overlay");
  }

  setSelection(ids: string[]): void {
    this.selection = [...ids];
    this.dirty.layers.add("overlay");
  }

  setOverlayExtra(draw: ((ctx: Ctx2D, view: PlanView) => void) | null): void {
    this.overlayExtra = draw;
    this.dirty.layers.add("overlay");
  }

  /** Ask for the overlay layer to be drawn again on the next flush. */
  invalidateOverlay(): void {
    this.dirty.layers.add("overlay");
  }

  /** Zoom to a rectangle in plan millimetres with padding. */
  fitBounds(b: { minX: number; minY: number; maxX: number; maxY: number }, padding = 40): void {
    const w = Math.max(1, b.maxX - b.minX);
    const h = Math.max(1, b.maxY - b.minY);
    const scale = Math.min((this.view.width - 2 * padding) / w, (this.view.height - 2 * padding) / h);
    this.view = {
      ...this.view,
      scale,
      offsetX: this.view.width / 2 - ((b.minX + b.maxX) / 2) * scale,
      offsetY: this.view.height / 2 + ((b.minY + b.maxY) / 2) * scale,
    };
    this.full = true;
  }

  /** The level being drawn; chosen from the project when none was set. */
  get level(): string | null {
    return this.levelId;
  }

  setLevel(levelId: string): void {
    this.levelId = levelId;
    this.full = true;
  }

  resize(width: number, height: number): void {
    this.view = { ...this.view, width, height };
    this.full = true;
  }

  /** Zoom to the project bounds with padding. */
  fit(padding = 40): void {
    if (!this.project) return;
    const b = derive.projectBounds(this.project, this.sizes ?? derive.snapshotSizeSource(this.project));
    if (!b) return;
    const w = Math.max(1, b.maxX - b.minX);
    const h = Math.max(1, b.maxY - b.minY);
    const scale = Math.min((this.view.width - 2 * padding) / w, (this.view.height - 2 * padding) / h);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    this.view = {
      ...this.view,
      scale,
      offsetX: this.view.width / 2 - cx * scale,
      offsetY: this.view.height / 2 + cy * scale,
    };
    this.full = true;
  }

  panBy(dxPx: number, dyPx: number): void {
    this.view = { ...this.view, offsetX: this.view.offsetX + dxPx, offsetY: this.view.offsetY + dyPx };
    this.full = true;
  }

  zoomAt(px: number, py: number, factor: number): void {
    const before = this.toPlan(px, py);
    const scale = Math.min(2, Math.max(0.005, this.view.scale * factor));
    this.view = { ...this.view, scale };
    const after = this.toPlan(px, py);
    this.view = {
      ...this.view,
      offsetX: this.view.offsetX + (after.x - before.x) * scale,
      offsetY: this.view.offsetY - (after.y - before.y) * scale,
    };
    this.full = true;
  }

  toScreen(p: Point): { x: number; y: number } {
    return { x: this.view.offsetX + p.x * this.view.scale, y: this.view.offsetY - p.y * this.view.scale };
  }

  toPlan(px: number, py: number): Point {
    return { x: (px - this.view.offsetX) / this.view.scale, y: (this.view.offsetY - py) / this.view.scale };
  }

  /**
   * Entity under a plan point: items first, then walls, then rooms (smallest).
   *
   * `marginMm` is F-130's selection margin, and without it walls are effectively unselectable. A 100 mm
   * wall at 1:87 is about one screen pixel of FOOTPRINT, while the canvas strokes it several pixels wide,
   * so a click lands on the ink and misses the polygon. containsPoint alone therefore asks you to hit a
   * one-pixel target. The margin is a distance to the footprint's edges, so anything within it counts.
   */
  hitTest(p: Point, marginMm = 0): string | null {
    const project = this.project;
    if (!project || !this.levelId) return null;
    const near = (ring: readonly Point[]): boolean => {
      if (poly.containsPoint(ring, p)) return true;
      if (marginMm <= 0) return false;
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i] as Point;
        const b = ring[(i + 1) % ring.length] as Point;
        if (poly.distancePointSegment(p, a, b) <= marginMm) return true;
      }
      return false;
    };
    const sizes = this.sizes ?? derive.snapshotSizeSource(project);
    for (const it of project.items) {
      if (it.levelId !== this.levelId || !it.visible) continue;
      const size = derive.itemSize(it, sizes);
      if (size && near(derive.itemFootprint(it, size))) return it.id;
    }
    // A zone answers to its edge and to its name, never to its middle: it is an area with furniture
    // standing in it, and taking every click inside it would make the desks unselectable.
    for (const z of project.zones) {
      if (z.levelId !== this.levelId) continue;
      if (onEdge(z.polygon, p, Math.max(marginMm, 4 / this.view.scale))) return z.id;
      if (inBox(zoneLabelBox(z, this.view.scale, project), p)) return z.id;
    }
    const walls = project.walls.filter((w) => w.levelId === this.levelId);
    // An opening sits INSIDE its wall, so it has to be offered before the wall or the wall always wins
    // and a door can never be selected — which is exactly what happened: the panel has edited openings
    // since it was written, and nothing on the plan could reach it.
    const byId = new Map(walls.map((w) => [w.id, w]));
    for (const o of project.openings) {
      if (o.levelId !== this.levelId) continue;
      const w = byId.get(o.wallId);
      if (w && near(derive.openingFootprint(o, w))) return o.id;
    }
    for (const [id, fp] of wallFootprints(walls)) if (near(fp)) return id;
    // Rooms keep the strict test: they are large areas, and growing them by a margin would let a click
    // just outside a room take it in preference to nothing, which is the wrong answer on open plan.
    return derive.containingRoom(project, this.levelId, p)?.id ?? null;
  }

  /** Draw every dirty layer once. */
  flush(): void {
    const project = this.project;
    if (!project) return;
    const dirty = this.dirty;
    this.dirty = emptyRebuildSet();
    const full = this.full;
    this.full = false;
    const layers = new Set<Layer>(dirty.layers);
    if (full) for (const l of ["static", "structure", "items", "overlay"] as const) layers.add(l);
    if (dirty.walls.size || dirty.rooms.size || dirty.ground) layers.add("structure");
    if (dirty.items.size) layers.add("items");
    if (dirty.removed.length) {
      layers.add("structure");
      layers.add("items");
    }
    const level = this.levelId;
    if (!level) return;
    if (layers.has("static")) this.drawStatic();
    if (layers.has("structure")) this.drawStructure(project, level);
    if (layers.has("items")) this.drawItems(project, level);
    if (layers.has("overlay")) this.drawOverlay(project, level);
  }

  private begin(layer: Layer): Ctx2D {
    const ctx = this.layers[layer];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.view.width, this.view.height);
    // one transform for the layer: scale, translate, y flip (ADR-003 D6)
    ctx.setTransform(this.view.scale, 0, 0, -this.view.scale, this.view.offsetX, this.view.offsetY);
    this.draws[layer] += 1;
    return ctx;
  }

  private ring(ctx: Ctx2D, pts: readonly Point[]): void {
    pts.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
    ctx.closePath();
  }

  private multi(ctx: Ctx2D, mp: PolyWithHoles[]): void {
    ctx.beginPath();
    for (const pwh of mp) {
      this.ring(ctx, pwh.outer);
      for (const h of pwh.holes) this.ring(ctx, h);
    }
  }

  private drawStatic(): void {
    const ctx = this.begin("static");
    const step = this.view.scale < 0.02 ? 5000 : 1000;
    const tl = this.toPlan(0, 0);
    const br = this.toPlan(this.view.width, this.view.height);
    ctx.lineWidth = 1 / this.view.scale;
    for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
      ctx.strokeStyle = x % 5000 === 0 ? COLOURS.gridMajor : COLOURS.grid;
      ctx.beginPath();
      ctx.moveTo(x, br.y);
      ctx.lineTo(x, tl.y);
      ctx.stroke();
    }
    for (let y = Math.floor(br.y / step) * step; y <= tl.y; y += step) {
      ctx.strokeStyle = y % 5000 === 0 ? COLOURS.gridMajor : COLOURS.grid;
      ctx.beginPath();
      ctx.moveTo(tl.x, y);
      ctx.lineTo(br.x, y);
      ctx.stroke();
    }
  }

  private drawStructure(project: Project, levelId: string): void {
    const ctx = this.begin("structure");
    const shapes = planStructure(project, levelId);
    // rooms under walls
    for (const r of shapes.rooms) {
      ctx.beginPath();
      for (const ring of r.rings) this.ring(ctx, ring);
      ctx.fillStyle = COLOURS.room;
      ctx.fill("evenodd");
      ctx.strokeStyle = COLOURS.roomEdge;
      ctx.lineWidth = 1 / this.view.scale;
      ctx.stroke();
      this.label(ctx, r);
    }
    for (const cut of shapes.walls)
      this.wallCut(ctx, cut.shape, cut.glass ? COLOURS.wallGlass : COLOURS.wall, cut.pattern);
    // A baseboard is a centimetre or two deep, a fraction of a pixel at most plan scales, so each is stroked a
    // pixel wide as well as filled: it shows as a line along the face at a distance and as a strip close up.
    if (shapes.skirting.length > 0) {
      ctx.beginPath();
      for (const ring of shapes.skirting) this.ring(ctx, ring);
      ctx.fillStyle = COLOURS.skirting;
      ctx.fill();
      ctx.strokeStyle = COLOURS.skirting;
      ctx.lineWidth = 1 / this.view.scale;
      ctx.stroke();
    }
    // openings: a gap through the wall plus the glass or the door swing
    for (const o of shapes.openings) {
      ctx.beginPath();
      this.ring(ctx, o.gap);
      ctx.fillStyle = COLOURS.opening;
      ctx.fill();
      if (o.glazing) {
        ctx.beginPath();
        ctx.moveTo(o.glazing.a.x, o.glazing.a.y);
        ctx.lineTo(o.glazing.b.x, o.glazing.b.y);
        ctx.strokeStyle = COLOURS.wallGlass;
        ctx.lineWidth = Math.max(o.glazing.widthMm, 2 / this.view.scale);
        ctx.stroke();
      } else if (o.swing) {
        this.swing(ctx, o.swing);
      }
    }
  }

  /**
   * One fused group of wall cuts in its pattern (W-121). Hatching is spaced in screen pixels, as it is on
   * paper at any scale, and anchored to the plan so it stays put while the view pans. Only the part of the
   * group on screen is hatched, so a deep zoom does not draw thousands of lines nobody sees.
   */
  private wallCut(ctx: Ctx2D, shape: PolyWithHoles[], ink: string, pattern: WallPattern): void {
    this.multi(ctx, shape);
    const lined = pattern === "hatch" || pattern === "cross-hatch";
    // Anything else is solid, including no pattern at all: a project from a host older than the pattern
    // field draws as it always did.
    if (!lined && pattern !== "outline") {
      ctx.fillStyle = ink;
      ctx.fill("evenodd");
      return;
    }
    ctx.fillStyle = COLOURS.paper;
    ctx.fill("evenodd");
    if (lined) {
      const box = this.visible(shape);
      if (box) {
        ctx.save();
        ctx.clip("evenodd");
        ctx.beginPath();
        this.hatch(ctx, box, 1);
        if (pattern === "cross-hatch") this.hatch(ctx, box, -1);
        ctx.strokeStyle = ink;
        ctx.lineWidth = HATCH_LINE_PX / this.view.scale;
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.restore();
      }
      // the clip used the path up
      this.multi(ctx, shape);
    }
    ctx.strokeStyle = ink;
    ctx.lineWidth = OUTLINE_PX / this.view.scale;
    ctx.setLineDash([]);
    ctx.stroke();
  }

  /** The part of a shape's bounds on screen, in plan millimetres, or null when none of it is. */
  private visible(shape: PolyWithHoles[]): poly.Rect | null {
    const b = poly.bounds(shape.flatMap((p) => p.outer));
    const tl = this.toPlan(0, 0);
    const br = this.toPlan(this.view.width, this.view.height);
    const minX = Math.max(b.minX, tl.x);
    const maxX = Math.min(b.maxX, br.x);
    const minY = Math.max(b.minY, br.y);
    const maxY = Math.min(b.maxY, tl.y);
    return minX < maxX && minY < maxY ? { minX, minY, maxX, maxY } : null;
  }

  /** Diagonal lines across a box, rising to the right for `slope` 1 and falling for -1, added to the path. */
  private hatch(ctx: Ctx2D, box: poly.Rect, slope: 1 | -1): void {
    // HATCH_GAP_PX apart on screen at any zoom, as hatching is on paper at any scale.
    for (const [a, b] of hatchLines(box, HATCH_GAP_PX / this.view.scale, slope)) {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
  }

  /** Quarter-circle door swing from the hinge, closed back to it so both leaf positions show. */
  private swing(ctx: Ctx2D, s: SwingShape): void {
    ctx.beginPath();
    ctx.moveTo(s.hinge.x, s.hinge.y);
    ctx.arc(s.hinge.x, s.hinge.y, s.radius, s.start, s.start + s.sweep, s.sweep < 0);
    ctx.closePath();
    ctx.strokeStyle = COLOURS.swing;
    ctx.lineWidth = 1 / this.view.scale;
    ctx.setLineDash([]);
    ctx.stroke();
  }

  private label(ctx: Ctx2D, r: RoomShape): void {
    const px = 12 / this.view.scale;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const s = this.toScreen(r.labelAt);
    ctx.fillStyle = COLOURS.text;
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(r.name, s.x, s.y - px * this.view.scale * 0.6);
    ctx.fillText(`${r.areaM2.toFixed(1)} m²`, s.x, s.y + px * this.view.scale * 0.6);
    ctx.restore();
  }

  /**
   * A zone: a dashed ring and a name above its top-left corner, the way a design tool names a frame. The
   * ring goes on the overlay, over the desks it made, because the area is the thing being pointed at and
   * an outline under the furniture would be hidden by exactly what it stands for.
   */
  private zone(ctx: Ctx2D, z: ZoneShape): void {
    const px = 1 / this.view.scale;
    ctx.beginPath();
    this.ring(ctx, z.ring);
    ctx.strokeStyle = COLOURS.zone;
    ctx.lineWidth = 1.2 * px;
    ctx.setLineDash([8 * px, 5 * px]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const s = this.toScreen(z.labelAt);
    ctx.fillStyle = COLOURS.zone;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(z.label, s.x, s.y - ZONE_LABEL_PX);
    ctx.restore();
  }

  private drawItems(project: Project, levelId: string): void {
    const ctx = this.begin("items");
    const sizes = this.sizes ?? derive.snapshotSizeSource(project);
    for (const it of planItems(project, levelId, sizes)) {
      ctx.beginPath();
      this.ring(ctx, it.footprint);
      ctx.fillStyle = COLOURS.item;
      ctx.fill();
      ctx.strokeStyle = COLOURS.itemEdge;
      ctx.lineWidth = 1 / this.view.scale;
      ctx.stroke();
      // front edge marker: the footprint's last edge is the front (front-right to front-left)
      ctx.beginPath();
      ctx.moveTo(it.front[0].x, it.front[0].y);
      ctx.lineTo(it.front[1].x, it.front[1].y);
      ctx.lineWidth = 3 / this.view.scale;
      ctx.stroke();
    }
  }

  private drawOverlay(project: Project, levelId: string): void {
    const ctx = this.begin("overlay");
    const sizes = this.sizes ?? derive.snapshotSizeSource(project);
    for (const z of planZones(project, levelId)) this.zone(ctx, z);
    ctx.strokeStyle = COLOURS.selection;
    ctx.lineWidth = 2 / this.view.scale;
    ctx.setLineDash([6 / this.view.scale, 4 / this.view.scale]);
    for (const id of this.selection) {
      const outline = outlineOf(project, id, levelId, sizes);
      if (!outline) continue;
      ctx.beginPath();
      this.ring(ctx, outline);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (this.overlayExtra) {
      ctx.save();
      this.overlayExtra(ctx, this.view);
      ctx.restore();
    }
  }
}

/**
 * The outline of one entity in plan millimetres: a wall's footprint, a room's polygon, an item's or an
 * opening's footprint. Exported because the drag preview draws the same shapes translated, and recomputing them
 * separately would let the ghost and the selection outline disagree about what is selected.
 */
export function outlineOf(
  project: Project,
  id: string,
  levelId: string,
  sizes: derive.SizeSource,
): Point[] | null {
  const w = project.walls.find((x) => x.id === id);
  if (w)
    return w.levelId === levelId
      ? (wallFootprints(project.walls.filter((x) => x.levelId === levelId)).get(id) ?? null)
      : null;
  const r = project.rooms.find((x) => x.id === id);
  if (r) return r.levelId === levelId ? r.polygon : null;
  const it = project.items.find((x) => x.id === id) as Item | undefined;
  if (it && it.levelId === levelId) {
    const size = derive.itemSize(it, sizes);
    return size ? derive.itemFootprint(it, size) : null;
  }
  const o = project.openings.find((x) => x.id === id);
  if (o && o.levelId === levelId) {
    const host = project.walls.find((x) => x.id === o.wallId);
    return host ? derive.openingFootprint(o, host) : null;
  }
  const z = project.zones.find((x) => x.id === id);
  if (z) return z.levelId === levelId ? z.polygon : null;
  return null;
}

/** Within `toleranceMm` of one of the ring's edges, and not merely inside it. */
function onEdge(ring: readonly Point[], p: Point, toleranceMm: number): boolean {
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    if (poly.distancePointSegment(p, a, b) <= toleranceMm) return true;
  }
  return false;
}

/**
 * Where a zone's name sits, in plan millimetres. The text is drawn in screen pixels, so its box grows as
 * the plan zooms out — which is what makes a zone still reachable when its outline is a few pixels wide.
 */
export function zoneLabelBox(
  z: Zone,
  scale: number,
  project?: Project,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const b = poly.bounds(z.polygon);
  const width = (zoneLabel(z, project).length * 6.2) / scale;
  const bottom = b.maxY + ZONE_LABEL_PX / scale;
  return { minX: b.minX, minY: bottom, maxX: b.minX + width, maxY: bottom + ZONE_LABEL_HEIGHT_PX / scale };
}

function inBox(box: { minX: number; minY: number; maxX: number; maxY: number }, p: Point): boolean {
  return p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
}

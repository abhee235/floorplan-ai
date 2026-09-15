// The 2D plan (ADR-003 D6): four stacked Canvas 2D layers (static, structure, items, overlay), one
// transform (scale, translate, y flip), all drawing in IR millimetres. The drawing context is an
// interface so tests can record calls without a DOM.
import type { ChangeSet } from "@fpv/commands";
import { emptyRebuildSet, expand, type Layer, type RebuildSet } from "@fpv/engine";
import { type PolyWithHoles, unionRings, wallFootprints } from "@fpv/geometry";
import type { Item, Opening, Point, Project, Room, Wall } from "@fpv/ir";
import { derive, poly } from "@fpv/ir";

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

const COLOURS = {
  grid: "#e6e3dd",
  gridMajor: "#d3cfc7",
  wall: "#3a3a3a",
  wallGlass: "#7fb3d5",
  room: "rgba(214, 226, 240, 0.55)",
  roomEdge: "#8fa6bf",
  opening: "#ffffff",
  swing: "#6b6b6b",
  item: "rgba(140, 120, 90, 0.35)",
  itemEdge: "#6f5b3e",
  selection: "#1e88e5",
  text: "#333333",
};

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

  /** Entity under a plan point: items first, then walls, then rooms (smallest). */
  hitTest(p: Point): string | null {
    const project = this.project;
    if (!project || !this.levelId) return null;
    const sizes = this.sizes ?? derive.snapshotSizeSource(project);
    for (const it of project.items) {
      if (it.levelId !== this.levelId || !it.visible) continue;
      const size = derive.itemSize(it, sizes);
      if (size && poly.containsPoint(derive.itemFootprint(it, size), p)) return it.id;
    }
    const walls = project.walls.filter((w) => w.levelId === this.levelId);
    for (const [id, fp] of wallFootprints(walls)) if (poly.containsPoint(fp, p)) return id;
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
    // rooms under walls
    for (const r of project.rooms) {
      if (r.levelId !== levelId) continue;
      ctx.beginPath();
      this.ring(ctx, r.polygon);
      for (const h of r.holes) this.ring(ctx, h);
      ctx.fillStyle = COLOURS.room;
      ctx.fill("evenodd");
      ctx.strokeStyle = COLOURS.roomEdge;
      ctx.lineWidth = 1 / this.view.scale;
      ctx.stroke();
      this.label(ctx, r);
    }
    // walls as a fused union per kind
    const walls = project.walls.filter((w) => w.levelId === levelId);
    const fps = wallFootprints(walls);
    const kinds = new Map<string, Point[][]>();
    for (const w of walls) {
      const fp = fps.get(w.id);
      if (fp && fp.length >= 3)
        (kinds.get(w.kind) ?? (kinds.set(w.kind, []).get(w.kind) as Point[][])).push(fp);
    }
    for (const [kind, rings] of kinds) {
      this.multi(ctx, unionRings(rings));
      ctx.fillStyle = kind === "glass" ? COLOURS.wallGlass : COLOURS.wall;
      ctx.fill("evenodd");
    }
    // openings: a gap through the wall plus the door swing
    for (const o of project.openings) {
      const w = walls.find((x) => x.id === o.wallId);
      if (!w) continue;
      ctx.beginPath();
      this.ring(ctx, derive.openingFootprint(o, w, 2));
      ctx.fillStyle = COLOURS.opening;
      ctx.fill();
      if (o.kind === "window") {
        ctx.beginPath();
        const iv = derive.openingAlongInterval(o, w);
        const a = derive.pointAlongWall(w, iv.from / derive.wallLength(w));
        const b = derive.pointAlongWall(w, iv.to / derive.wallLength(w));
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = COLOURS.wallGlass;
        ctx.lineWidth = Math.max(w.thickness / 3, 2 / this.view.scale);
        ctx.stroke();
      } else if (o.swing) {
        this.swing(ctx, o, w);
      }
    }
  }

  /** Quarter-circle door swing from the hinge end, on the side the swing direction names. */
  private swing(ctx: Ctx2D, o: Opening, w: Wall): void {
    if (!o.swing) return;
    const iv = derive.openingAlongInterval(o, w);
    const len = derive.wallLength(w);
    const hingeT = (o.swing.hinge === "start" ? iv.from : iv.to) / len;
    const hinge = derive.pointAlongWall(w, hingeT);
    const angle = (derive.wallAngle(w) * Math.PI) / 180;
    const along = o.swing.hinge === "start" ? angle : angle + Math.PI;
    // "left" opens to the wall's left side (positive rotation from the along direction), "right" the other way
    const sign = (o.swing.direction === "left") !== (o.swing.hinge === "end") ? 1 : -1;
    const end = along + (sign * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo(hinge.x, hinge.y);
    ctx.arc(hinge.x, hinge.y, o.width, along, end, sign < 0);
    ctx.closePath();
    ctx.strokeStyle = COLOURS.swing;
    ctx.lineWidth = 1 / this.view.scale;
    ctx.setLineDash([]);
    ctx.stroke();
  }

  private label(ctx: Ctx2D, r: Room): void {
    const at = derive.roomLabelAnchor(r);
    const px = 12 / this.view.scale;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const s = this.toScreen(at);
    ctx.fillStyle = COLOURS.text;
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const area = (derive.roomArea(r) / 1e6).toFixed(1);
    ctx.fillText(r.name ?? r.purpose, s.x, s.y - px * this.view.scale * 0.6);
    ctx.fillText(`${area} m²`, s.x, s.y + px * this.view.scale * 0.6);
    ctx.restore();
  }

  private drawItems(project: Project, levelId: string): void {
    const ctx = this.begin("items");
    const sizes = this.sizes ?? derive.snapshotSizeSource(project);
    for (const it of project.items) {
      if (it.levelId !== levelId || !it.visible) continue;
      const size = derive.itemSize(it, sizes);
      if (!size) continue;
      const fp = derive.itemFootprint(it, size);
      ctx.beginPath();
      this.ring(ctx, fp);
      ctx.fillStyle = COLOURS.item;
      ctx.fill();
      ctx.strokeStyle = COLOURS.itemEdge;
      ctx.lineWidth = 1 / this.view.scale;
      ctx.stroke();
      // front edge marker: the footprint's last edge is the front (front-right to front-left)
      ctx.beginPath();
      ctx.moveTo((fp[2] as Point).x, (fp[2] as Point).y);
      ctx.lineTo((fp[3] as Point).x, (fp[3] as Point).y);
      ctx.lineWidth = 3 / this.view.scale;
      ctx.stroke();
    }
  }

  private drawOverlay(project: Project, levelId: string): void {
    const ctx = this.begin("overlay");
    const sizes = this.sizes ?? derive.snapshotSizeSource(project);
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

function outlineOf(project: Project, id: string, levelId: string, sizes: derive.SizeSource): Point[] | null {
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
  return null;
}

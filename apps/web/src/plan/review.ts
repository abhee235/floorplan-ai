// The draft review in the app (ADR-011 D3, D5): the draft drawn over the source line work at the current
// scale, the scale checks, a known-length tool, wall deletion and thickness edits. DOM-free so it is tested
// without a browser; the panel in review-panel.ts binds it to buttons and inputs.
import {
  applyAnswers,
  draftBounds,
  type PlanDraft,
  type PlanPreview,
  type ScaleInput,
  type ScaleStatus,
  scaleStatus,
  withScale,
} from "@fpv/importers";
import type { Ctx2D, PlanView } from "./plan.js";

export interface DraftOpenMsg {
  draftId: string | null;
  draft: unknown;
  preview: PlanPreview | null;
  warnings: string[];
}

export type ReviewLayer = "source" | "walls" | "openings" | "rooms" | "lengths";

const COLOURS = {
  source: "rgba(90, 90, 90, 0.45)",
  wall: "rgba(230, 120, 30, 0.55)",
  wallSelected: "rgba(30, 136, 229, 0.75)",
  door: "#2e7d32",
  window: "#1565c0",
  passage: "#6d4c41",
  room: "rgba(123, 31, 162, 0.8)",
  text: "#1f1f1f",
  bar: "#111111",
};

type P = { x: number; y: number };

function polylineLength(points: readonly P[]): number {
  let s = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i] as P;
    const b = points[i + 1] as P;
    s += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return s;
}

function distanceToPolyline(p: P, points: readonly P[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i] as P;
    const b = points[i + 1] as P;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

/** A "nice" scale bar length in millimetres for about `targetMm`. */
export function niceLength(targetMm: number): number {
  const exp = 10 ** Math.floor(Math.log10(Math.max(1, targetMm)));
  for (const m of [1, 2, 5, 10]) if (m * exp >= targetMm) return m * exp;
  return 10 * exp;
}

export class DraftReview {
  draftId: string | null = null;
  draft: PlanDraft | null = null;
  preview: PlanPreview | null = null;
  warnings: string[] = [];
  selectedWall: number | null = null;
  /** True once the draft differs from what the host sent, so the commit sends the edited draft. */
  edited = false;
  readonly visible: Record<ReviewLayer, boolean> = {
    source: true,
    walls: true,
    openings: true,
    rooms: true,
    lengths: true,
  };
  private readonly listeners = new Set<() => void>();

  get active(): boolean {
    return this.draft !== null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(edited = true): void {
    if (edited) this.edited = true;
    for (const l of this.listeners) l();
  }

  /** Open the review for a host draft message, or close it when the message carries no draft. */
  open(msg: DraftOpenMsg): void {
    if (!msg.draftId || !msg.draft) {
      this.close();
      return;
    }
    this.draftId = msg.draftId;
    this.draft = msg.draft as PlanDraft;
    this.preview = msg.preview;
    this.warnings = msg.warnings;
    this.selectedWall = null;
    this.edited = false;
    this.changed(false);
  }

  close(): void {
    this.draftId = null;
    this.draft = null;
    this.preview = null;
    this.warnings = [];
    this.selectedWall = null;
    this.edited = false;
    this.changed(false);
  }

  get status(): ScaleStatus {
    return this.draft ? scaleStatus(this.draft) : { confirmed: false, reason: "no draft is open" };
  }

  /** Millimetres per draft unit used for drawing: the draft's scale, or 1 until one is known. */
  get mmPerUnit(): number {
    return this.draft?.units.mmPerUnit ?? 1;
  }

  setScale(input: ScaleInput | "confirm"): void {
    if (!this.draft) return;
    this.draft = withScale(this.draft, input);
    this.changed();
  }

  /** The selected (or given) wall is really `lengthMm` long: derive the scale from it. */
  setKnownLength(lengthMm: number, wallIdx = this.selectedWall): void {
    if (!this.draft || wallIdx === null) throw new RangeError("select a wall first");
    const w = this.draft.walls.find((x) => x.idx === wallIdx);
    if (!w) throw new RangeError(`wall ${wallIdx} is not in the draft`);
    this.setScale({ measuredUnits: polylineLength(w.points), lengthMm });
  }

  answer(id: string, text: string): string[] {
    if (!this.draft) return [];
    const r = applyAnswers(this.draft, { [id]: text });
    this.draft = r.draft;
    this.changed();
    return [...r.unknownIds, ...r.unreadable];
  }

  deleteWall(idx: number): void {
    if (!this.draft) return;
    this.draft = {
      ...this.draft,
      walls: this.draft.walls.filter((w) => w.idx !== idx),
      openings: this.draft.openings.filter((o) => o.wallIdx !== idx),
    };
    if (this.selectedWall === idx) this.selectedWall = null;
    this.changed();
  }

  /** Set a wall's thickness in millimetres at the current scale. */
  setThickness(idx: number, mm: number): void {
    if (!this.draft || !(mm > 0)) return;
    const f = this.mmPerUnit;
    this.draft = {
      ...this.draft,
      walls: this.draft.walls.map((w) => (w.idx === idx ? { ...w, thickness: mm / f } : w)),
    };
    this.changed();
  }

  select(idx: number | null): void {
    this.selectedWall = idx;
    this.changed(false);
  }

  toggle(layer: ReviewLayer): void {
    this.visible[layer] = !this.visible[layer];
    this.changed(false);
  }

  /** The wall under a plan point in millimetres, within half its thickness or 12 screen pixels. */
  hitWall(pMm: P, pixelsPerMm: number): number | null {
    if (!this.draft) return null;
    const f = this.mmPerUnit;
    const p = { x: pMm.x / f, y: pMm.y / f };
    let best: { idx: number; d: number } | null = null;
    for (const w of this.draft.walls) {
      const d = distanceToPolyline(p, w.points) * f;
      const reach = Math.max(((w.thickness ?? 0) * f) / 2, 12 / pixelsPerMm);
      if (d <= reach && (!best || d < best.d)) best = { idx: w.idx, d };
    }
    return best?.idx ?? null;
  }

  wallLengthMm(idx: number): number | null {
    const w = this.draft?.walls.find((x) => x.idx === idx);
    return w ? polylineLength(w.points) * this.mmPerUnit : null;
  }

  /** Draft extent in plan millimetres at the current scale. */
  boundsMm(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (!this.draft) return null;
    const b = draftBounds(this.draft);
    const f = this.mmPerUnit;
    return b ? { minX: b.minX * f, minY: b.minY * f, maxX: b.maxX * f, maxY: b.maxY * f } : null;
  }

  /** Arguments for the confirming import_plan call. */
  commitArgs(levelId?: string): Record<string, unknown> {
    if (!this.draft || !this.draftId) throw new RangeError("no draft is open");
    return {
      draftId: this.draftId,
      confirm: true,
      ...(this.edited ? { draft: this.draft } : {}),
      ...(levelId ? { levelId } : {}),
    };
  }

  /** Draw on a layer whose transform maps plan millimetres to pixels with y up. */
  draw(ctx: Ctx2D, view: PlanView): void {
    const d = this.draft;
    if (!d) return;
    const f = this.mmPerUnit;
    const px = 1 / view.scale;
    if (this.visible.source && this.preview) {
      ctx.strokeStyle = COLOURS.source;
      ctx.lineWidth = px;
      ctx.setLineDash([]);
      ctx.beginPath();
      for (const [x1, y1, x2, y2] of this.preview.segments) {
        ctx.moveTo(x1 * f, y1 * f);
        ctx.lineTo(x2 * f, y2 * f);
      }
      ctx.stroke();
    }
    if (this.visible.rooms) {
      ctx.strokeStyle = COLOURS.room;
      ctx.lineWidth = 2 * px;
      ctx.setLineDash([8 * px, 5 * px]);
      for (const r of d.rooms) {
        if (!r.polygon) continue;
        ctx.beginPath();
        r.polygon.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x * f, q.y * f) : ctx.lineTo(q.x * f, q.y * f)));
        ctx.closePath();
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    if (this.visible.walls) {
      for (const w of d.walls) {
        ctx.strokeStyle = w.idx === this.selectedWall ? COLOURS.wallSelected : COLOURS.wall;
        ctx.lineWidth = Math.max((w.thickness ?? 0) * f, 3 * px);
        ctx.beginPath();
        w.points.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x * f, q.y * f) : ctx.lineTo(q.x * f, q.y * f)));
        ctx.stroke();
      }
    }
    if (this.visible.openings) {
      for (const o of d.openings) {
        ctx.fillStyle =
          o.kind === "door" ? COLOURS.door : o.kind === "window" ? COLOURS.window : COLOURS.passage;
        ctx.beginPath();
        ctx.arc(o.at.x * f, o.at.y * f, 5 * px, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // screen-space text: wall lengths at this scale, room names, and a scale bar
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const toScreen = (q: P) => ({
      x: view.offsetX + q.x * f * view.scale,
      y: view.offsetY - q.y * f * view.scale,
    });
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = COLOURS.text;
    if (this.visible.lengths)
      for (const w of d.walls) {
        const lengthMm = polylineLength(w.points) * f;
        if (lengthMm * view.scale < 60) continue;
        const mid = w.points[Math.floor((w.points.length - 1) / 2)] as P;
        const next = w.points[Math.floor((w.points.length - 1) / 2) + 1] as P;
        const s = toScreen({ x: (mid.x + next.x) / 2, y: (mid.y + next.y) / 2 });
        ctx.fillText(`${Math.round(lengthMm)}`, s.x, s.y - 10);
      }
    if (this.visible.rooms)
      for (const r of d.rooms) {
        if (!r.name || !r.labelAt) continue;
        const s = toScreen(r.labelAt);
        ctx.fillText(r.name, s.x, s.y);
      }
    const barMm = niceLength(120 / view.scale);
    const barPx = barMm * view.scale;
    const x0 = 16;
    const y0 = view.height - 20;
    ctx.strokeStyle = COLOURS.bar;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + barPx, y0);
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillStyle = COLOURS.bar;
    ctx.fillText(barMm >= 1000 ? `${barMm / 1000} m` : `${barMm} mm`, x0 + barPx + 8, y0);
    ctx.restore();
  }
}

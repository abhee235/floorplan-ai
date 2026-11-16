// Drawing rooms on the plan surface (P3-2): the pointer and keyboard gestures, the preview they paint,
// and the one room.create a finished ring sends. The rules are in room-tool.ts and tested there; this
// binds them to a canvas, a pointer and a keyboard.
//
// A sibling of wall-drawing.ts, and deliberately the same shape: the capture-phase press that beats the
// pan and select handlers, the focus handed back explicitly because preventDefault suppresses it, and an
// Escape that finishes without stopping propagation so the shell also returns to the select tool.
import type { Point, Project, Wall } from "@fpv/ir";
import type { Ctx2D, PlanRenderer, PlanView } from "../plan/plan.js";
import type { Announcer } from "./announce.js";
import { recordGesture } from "./gestures.js";
import { type RoomCreateCommand, type RoomDetectCommand, RoomTool } from "./room-tool.js";
import { formatMm } from "./status.js";
import { mountTypedEntry, screenOffset } from "./typed-entry.js";
import type { Aim, AimOptions } from "./wall-tool.js";

const ACCENT = "#1e88e5";
const ROOM_FILL = "rgba(214, 226, 240, 0.55)";
const ROOM_EDGE = "#8fa6bf";
const GUIDE = "#e05fa8";

export type RoomCommand = RoomCreateCommand | RoomDetectCommand;

export interface RoomDrawingDeps {
  plan: PlanRenderer;
  element: HTMLElement;
  announcer: Announcer;
  project(): Project | null;
  /** The snapping preference from the tool options bar. */
  settings(): { magnetism: boolean };
  /** True while the room tool is the active tool. */
  active(): boolean;
  send(command: RoomCommand): Promise<void>;
  redraw(): void;
  status(text: string): void;
  /** The ring as it stands, for the 3D view to show its floor while it is drawn; [] clears it. */
  preview3d(polygon: readonly Point[]): void;
}

export interface RoomDrawing {
  draw(ctx: Ctx2D, view: PlanView): void;
  readonly drawing: boolean;
  finish(): void;
  destroy(): void;
}

export function bindRoomDrawing(deps: RoomDrawingDeps): RoomDrawing {
  const { plan, element, announcer } = deps;
  let tool: RoomTool | null = null;
  let aim: Aim | null = null;
  let altHeld = false;
  let shiftHeld = false;

  const dpr = (): number => Math.min(2, window.devicePixelRatio);

  const walls = (): readonly Wall[] => {
    const project = deps.project();
    const level = plan.level;
    if (!project || !level) return [];
    return project.walls.filter((w) => w.levelId === level);
  };

  const aimOptions = (magnetism = deps.settings().magnetism): AimOptions => ({
    walls: walls(),
    pixelMm: 1 / plan.view.scale,
    magnetism,
    altHeld,
    shiftHeld,
  });

  const planPoint = (e: { clientX: number; clientY: number }): Point => {
    const rect = element.getBoundingClientRect();
    const ratio = dpr();
    return plan.toPlan((e.clientX - rect.left) * ratio, (e.clientY - rect.top) * ratio);
  };

  const ensureTool = (): RoomTool | null => {
    if (tool) return tool;
    const level = plan.level;
    if (!level) return null;
    tool = new RoomTool({ levelId: level });
    return tool;
  };

  // The same card the wall tool draws with (ADR-017 D4). RoomTool.seed and RoomTool.typedPoint were
  // written and tested with the wall tool's, and until now nothing called them: a wall chain could be
  // typed to the millimetre while a room had to be drawn by eye, which is exactly backwards for a plan
  // whose room dimensions are the numbers written on it.
  const entry = mountTypedEntry(element, { tool: "room" });

  const showCard = (): void => {
    const anchor = tool?.anchor ?? null;
    entry.show(tool, anchor ? screenOffset(plan.toScreen(anchor), dpr()) : null);
  };

  const pushPreview = (): void => {
    const t = tool;
    if (!t?.drawing) {
      deps.preview3d([]);
      return;
    }
    const pending = aim?.point;
    deps.preview3d(pending ? [...t.points, pending] : [...t.points]);
  };

  const report = (): void => {
    if (!tool?.drawing) {
      deps.status("");
      return;
    }
    deps.status(aim?.snapNote ? `Snap: ${aim.snapNote}` : `Drawing side ${tool.points.length}`);
  };

  const finish = (): void => {
    const t = tool;
    tool = null;
    aim = null;
    entry.hide();
    deps.preview3d([]);
    if (!t) return;
    const command = t.end();
    deps.redraw();
    report();
    if (!command) {
      // R-041: under three corners there is no room. Say so plainly rather than reporting a success, and
      // rather than silently discarding what was clicked.
      announcer.say("A room needs three corners. Nothing was drawn.");
      recordGesture("draw", { tool: "room", phase: "end", sent: [], because: "fewer than three corners" });
      return;
    }
    recordGesture("draw", {
      tool: "room",
      phase: "end",
      corners: command.payload.polygon.length,
      sent: command.type,
    });
    void deps
      .send(command)
      .then(() => announcer.say(`Room drawn, ${command.payload.polygon.length} corners.`))
      .catch((e: unknown) =>
        announcer.alert(`The room could not be drawn: ${e instanceof Error ? e.message : String(e)}`),
      );
  };

  /** Put a corner down, from wherever it came from, and keep the card and the preview in step. */
  const place = (point: Point, options = aimOptions()): void => {
    const t = ensureTool();
    if (!t) return;
    const result = t.place(point, options);
    announcer.say(result.announcement);
    if (result.closed) {
      finish();
      return;
    }
    aim = null;
    showCard();
    report();
    pushPreview();
    deps.redraw();
  };

  const placeTyped = (): void => {
    const t = ensureTool();
    if (!t) return;
    if (!t.drawing) {
      // With no pointer, the ring starts at the middle of the view, where the eye already is.
      const centre = plan.toPlan(plan.view.width / 2, plan.view.height / 2);
      place(centre, aimOptions(false));
      announcer.say("Ring started at the centre of the view. Type a length, Tab for the angle, Enter.");
      return;
    }
    const typed = entry.values();
    const point = t.typedPoint(typed.lengthMm, typed.angleDeg);
    if (point) place(point, aimOptions(false)); // a typed length and angle are exact, not magnetised
  };

  /** Clicking inside walls with no ring started fills the enclosure instead of beginning one. */
  const fillAt = (point: Point): void => {
    const t = ensureTool();
    if (!t) return;
    const command = t.detectAt(point);
    recordGesture("draw", {
      tool: "room",
      phase: "end",
      how: "filled from the walls",
      at: { x: Math.round(point.x), y: Math.round(point.y) },
      sent: command.type,
    });
    void deps
      .send(command)
      .then(() => announcer.say("Room filled from the walls around that point."))
      .catch((e: unknown) =>
        // The reducer refuses with room.not-enclosed and a hint, which is far more useful than silence:
        // it names the point and says to check for gaps.
        announcer.alert(`No room there: ${e instanceof Error ? e.message : String(e)}`),
      );
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (!deps.active() || e.button !== 0) return;
    if (e.target instanceof Node && entry.contains(e.target)) return;
    entry.touched();
    e.stopPropagation();
    e.preventDefault();
    element.focus();
    altHeld = e.altKey;
    shiftHeld = e.shiftKey;
    const point = planPoint(e);

    // Filling an enclosure is a double-click on empty ground with no ring started, not Alt-click: Alt is
    // already the snapping bypass (W-082), so overloading it would mean you could never fill AND bypass
    // snapping, and an Alt-click mid-ring would try to do two things at once.
    if (!tool?.drawing && e.detail >= 2) {
      fillAt(point);
      return;
    }

    // the card sits over the plan: a press on it belongs to the field being typed in, not to the ring
    if (e.target instanceof Node && entry.contains(e.target)) return;
    place(point);
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!deps.active()) return;
    altHeld = e.altKey;
    shiftHeld = e.shiftKey;
    const t = tool;
    if (!t) return;
    aim = t.aim(planPoint(e), aimOptions());
    announcer.say(aim.announcement);
    entry.touched();
    showCard();
    report();
    pushPreview();
    deps.redraw();
  };

  const onDoubleClick = (e: MouseEvent): void => {
    if (!deps.active() || !tool?.drawing) return;
    // Double-clicking a number in the card selects it, as it does in every other field; it must not end
    // the ring (the same exception the press handler makes).
    if (e.target instanceof Node && entry.contains(e.target)) return;
    e.stopPropagation();
    finish();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!deps.active()) return;
    if (e.key === "Escape" && tool?.drawing) {
      e.preventDefault();
      finish();
      // Deliberately not stopped: the shell takes the same Escape back to the select tool (ADR-017 D2).
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // Enter used to end the ring outright. It places a corner now, as it does for walls, and a second
      // Enter with nothing changed in between ends it (ADR-017 D4) — which is the same gesture the
      // pointer makes with a double-click. Escape still ends it in one press.
      if (tool?.drawing && entry.repeatedEnter()) {
        finish();
        return;
      }
      placeTyped();
      return;
    }
    if (e.key === "z" && (e.ctrlKey || e.metaKey) && tool?.drawing) {
      e.stopPropagation();
      e.preventDefault();
      if (tool.undoSegment()) announcer.say("Last corner taken back.");
      entry.touched();
      showCard();
      report();
      pushPreview();
      deps.redraw();
    }
  };

  const capture = element.parentElement ?? element;
  capture.addEventListener("pointerdown", onPointerDown, { capture: true });
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("dblclick", onDoubleClick, { capture: true });
  element.addEventListener("keydown", onKeyDown);

  // ---- the preview -------------------------------------------------------
  const draw = (ctx: Ctx2D, view: PlanView): void => {
    const t = tool;
    if (!t?.drawing) return;
    const px = 1 / view.scale;
    const ring = aim?.point ? [...t.points, aim.point] : [...t.points];

    // The ring so far, filled as the room it will become once it has an area to fill.
    if (ring.length >= 3) {
      ctx.beginPath();
      const first = ring[0] as Point;
      ctx.moveTo(first.x, first.y);
      for (const p of ring.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.fillStyle = ROOM_FILL;
      ctx.fill();
      ctx.strokeStyle = ROOM_EDGE;
      ctx.lineWidth = 1.5 * px;
      ctx.setLineDash([]);
      ctx.stroke();
    } else if (ring.length === 2) {
      // Two corners are a line, not a shape: draw it so the first side is visible while it is aimed.
      const a = ring[0] as Point;
      const b = ring[1] as Point;
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.6 * px;
      ctx.setLineDash([5 * px, 4 * px]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (aim?.guides.length && aim.point) {
      ctx.strokeStyle = GUIDE;
      ctx.lineWidth = 1 * px;
      ctx.setLineDash([4 * px, 3 * px]);
      for (const guide of aim.guides) {
        ctx.beginPath();
        ctx.moveTo(aim.point.x, aim.point.y);
        ctx.lineTo(guide.to.x, guide.to.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Where the ring began: the target for closing it.
    const start = t.points[0];
    if (start) ring2(ctx, start, 6 * px, ACCENT, px);

    // The side being drawn, written along it as a drawing writes it.
    const anchor = t.anchor;
    if (anchor && aim && aim.lengthMm > 0) {
      const mid = { x: (anchor.x + aim.point.x) / 2, y: (anchor.y + aim.point.y) / 2 };
      const at = { x: view.offsetX + mid.x * view.scale, y: view.offsetY - mid.y * view.scale };
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#333333";
      ctx.fillText(`${formatMm(aim.lengthMm)} mm`, at.x + 8, at.y - 8);
      ctx.restore();
    }
  };

  return {
    draw,
    get drawing() {
      return tool?.drawing ?? false;
    },
    finish,
    destroy: () => {
      capture.removeEventListener("pointerdown", onPointerDown, { capture: true });
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("dblclick", onDoubleClick, { capture: true });
      element.removeEventListener("keydown", onKeyDown);
      deps.preview3d([]);
    },
  };
}

function ring2(ctx: Ctx2D, at: Point, radius: number, colour: string, px: number): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.4 * px;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
  ctx.stroke();
}

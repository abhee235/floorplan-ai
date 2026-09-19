// Drawing walls on the plan surface (P3-1): the pointer and keyboard gestures, the preview they paint,
// and the one wall.createChain a finished chain sends (ADR-016 D5, ADR-017 D4). The rules are in
// wall-tool.ts and tested there; this binds them to a canvas, a pointer and a keyboard.
import type { Point, Project, Wall } from "@fpv/ir";
import type { Ctx2D, PlanRenderer, PlanView } from "../plan/plan.js";
import type { Announcer } from "./announce.js";
import { recordGesture } from "./gestures.js";
import { formatMm } from "./status.js";
import { mountTypedEntry, screenOffset } from "./typed-entry.js";
import { type Aim, type AimOptions, type WallChainCommand, WallTool } from "./wall-tool.js";

const ACCENT = "#1e88e5";
const WALL_INK = "#3a3a3a";
/** Guides are a different colour from the snap ring on purpose: one says "you are aligned with that",
 *  the other says "your point has been moved onto this". Same blue for both would conflate them. */
const GUIDE = "#e05fa8";

export interface WallDrawingDeps {
  plan: PlanRenderer;
  /** The element the plan canvases sit in; the entry card is placed inside it. */
  element: HTMLElement;
  announcer: Announcer;
  project(): Project | null;
  /** Thickness, kind and the snapping preference, read from the tool options bar. */
  settings(): { thickness: number; kind: string; magnetism: boolean };
  /** True while the wall tool is the active tool. */
  active(): boolean;
  send(command: WallChainCommand): Promise<void>;
  /** Asks for the overlay to be painted again. */
  redraw(): void;
  /** A short line for the status bar: what is being drawn, or what a snap caught. */
  status(text: string): void;
  /**
   * The chain as it stands, for the 3D view to show while it is being drawn; an empty array clears it.
   *
   * A callback rather than the binding itself, so this module still knows nothing about three.js and can
   * go on being tested without a WebGL context.
   */
  preview3d(points: readonly Point[]): void;
}

export interface WallDrawing {
  draw(ctx: Ctx2D, view: PlanView): void;
  readonly drawing: boolean;
  /** Ends the chain, keeping whatever is drawn (W-090). */
  finish(): void;
  destroy(): void;
}

export function bindWallDrawing(deps: WallDrawingDeps): WallDrawing {
  const { plan, element, announcer } = deps;
  let tool: WallTool | null = null;
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

  // ---- the floating length and angle card (ADR-017 D4) ----
  //
  // Shared with the room tool rather than owned here: both tools have had seed() and typedPoint() since
  // they were written, and only this one had anything to type into.
  const entry = mountTypedEntry(element, { tool: "wall" });

  const showCard = (): void => {
    const anchor = tool?.anchor ?? null;
    entry.show(tool, anchor ? screenOffset(plan.toScreen(anchor), dpr()) : null);
  };

  // ---- gestures ----------------------------------------------------------
  const planPoint = (e: { clientX: number; clientY: number }): Point => {
    const rect = element.getBoundingClientRect();
    const ratio = dpr();
    return plan.toPlan((e.clientX - rect.left) * ratio, (e.clientY - rect.top) * ratio);
  };

  const ensureTool = (): WallTool | null => {
    if (tool) return tool;
    const level = plan.level;
    if (!level) return null;
    const settings = deps.settings();
    tool = new WallTool({ levelId: level, thickness: settings.thickness, kind: settings.kind });
    return tool;
  };

  const place = (p: Point, magnetism?: boolean): void => {
    const t = ensureTool();
    if (!t) return;
    const result = t.place(p, aimOptions(magnetism));
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

  const report = (): void => {
    if (!tool?.drawing) {
      deps.status("");
      return;
    }
    const segment = tool.points.length;
    deps.status(aim?.snapNote ? `Snap: ${aim.snapNote}` : `Drawing wall ${segment} of chain`);
  };

  /** The confirmed chain plus the segment under the cursor, so 3D shows what the plan shows. */
  const pushPreview = (): void => {
    const t = tool;
    if (!t?.drawing) {
      deps.preview3d([]);
      return;
    }
    const pending = aim?.point;
    deps.preview3d(pending ? [...t.points, pending] : [...t.points]);
  };

  const finish = (): void => {
    const t = tool;
    tool = null;
    aim = null;
    entry.hide();
    // Clear before the command goes out, not after it returns: the committed walls arrive as a patch and
    // build themselves, and leaving the preview up until then would briefly show every wall twice.
    deps.preview3d([]);
    if (!t) return;
    const command = t.end();
    deps.redraw();
    report();
    if (!command) {
      announcer.say("Nothing drawn.");
      recordGesture("draw", { tool: "wall", phase: "end", sent: [], because: "nothing was drawn" });
      return;
    }
    const count = command.payload.closed ? command.payload.points.length : command.payload.points.length - 1;
    recordGesture("draw", {
      tool: "wall",
      phase: "end",
      walls: count,
      closed: command.payload.closed === true,
      sent: command.type,
    });
    void deps
      .send(command)
      .then(() => announcer.say(`${count} ${count === 1 ? "wall" : "walls"} drawn.`))
      .catch((e: unknown) =>
        announcer.alert(`The walls could not be drawn: ${e instanceof Error ? e.message : String(e)}`),
      );
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (!deps.active() || e.button !== 0) return;
    // the length and angle card sits over the plan: a press on it belongs to the field being typed in,
    // not to the drawing, or the fields could never be reached with a pointer at all
    if (e.target instanceof Node && entry.contains(e.target)) return;
    entry.touched();
    // the wall tool owns the press: the pan and select handlers on the plan must not also run
    e.stopPropagation();
    e.preventDefault();
    // preventDefault stops the press focusing the plan on its own, so do it here: the canvas is a focus
    // region and the keyboard has to follow the pointer into it
    element.focus();
    altHeld = e.altKey;
    shiftHeld = e.shiftKey;
    place(planPoint(e));
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!deps.active()) return;
    altHeld = e.altKey;
    shiftHeld = e.shiftKey;
    const t = tool;
    if (!t) return;
    aim = t.aim(planPoint(e), aimOptions());
    announcer.say(aim.announcement);
    report();
    pushPreview();
    deps.redraw();
  };

  const onDoubleClick = (e: MouseEvent): void => {
    if (!deps.active() || !tool?.drawing) return;
    // Not a double-click on the card: selecting a number by double-clicking it is how anybody edits a
    // field, and it used to end the chain instead. The press handler has always made this exception;
    // this one did not, so the card was usable with a pointer only if you never double-clicked in it.
    if (e.target instanceof Node && entry.contains(e.target)) return;
    e.stopPropagation();
    finish();
  };

  const placeTyped = (): void => {
    const t = ensureTool();
    if (!t) return;
    if (!t.drawing) {
      // With no pointer, the chain starts at the middle of the view, which is where the eye already is.
      const centre = plan.toPlan(plan.view.width / 2, plan.view.height / 2);
      place(centre, false);
      announcer.say("Chain started at the centre of the view. Type a length, Tab for the angle, Enter.");
      return;
    }
    const typed = entry.values();
    const point = t.typedPoint(typed.lengthMm, typed.angleDeg);
    if (point) place(point, false); // a typed length and angle are exact, not magnetised
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!deps.active()) return;
    if (e.key === "Escape" && tool?.drawing) {
      e.preventDefault();
      finish(); // W-090: what is drawn stays
      // Deliberately not stopped here: the shell takes the same Escape back to the select tool, so one
      // press both keeps the walls and puts the crosshair away (ADR-017 D2).
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // A second Enter with nothing changed in between ends the chain, which is what the pointer says
      // with a double-click (ADR-017 D4). Anything at all — a digit typed, the pointer moved, a wall
      // placed — makes the next Enter place again, so this cannot end a chain still being drawn.
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
      if (tool.undoSegment()) announcer.say("Last wall taken back.");
      showCard();
      report();
      pushPreview();
      deps.redraw();
    }
  };

  // Press handling has to beat the pan and select handlers the app bound on the plan itself, so it
  // listens on the parent during the capture phase, before the event reaches them.
  const capture = element.parentElement ?? element;
  capture.addEventListener("pointerdown", onPointerDown, { capture: true });
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("dblclick", onDoubleClick, { capture: true });
  // The card sits inside the plan, so its key events reach this listener by bubbling. Giving the card one
  // of its own as well ran the handler twice, placing two segments for every Enter.
  element.addEventListener("keydown", onKeyDown);

  // ---- the preview -------------------------------------------------------
  const draw = (ctx: Ctx2D, view: PlanView): void => {
    const t = tool;
    if (!t?.drawing) return;
    const px = 1 / view.scale;
    const points = t.points;
    const pending = aim?.point ?? null;

    // the chain so far, drawn as the walls it will become
    if (points.length >= 2) {
      ctx.strokeStyle = WALL_INK;
      ctx.lineWidth = deps.settings().thickness;
      ctx.setLineDash([]);
      ctx.beginPath();
      const first = points[0] as Point;
      ctx.moveTo(first.x, first.y);
      for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }

    const anchor = t.anchor;
    if (anchor && pending) {
      // the segment being drawn: the wall it would be, then its centre line
      if (ctx.globalAlpha !== undefined) ctx.globalAlpha = 0.35;
      ctx.strokeStyle = WALL_INK;
      ctx.lineWidth = deps.settings().thickness;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(anchor.x, anchor.y);
      ctx.lineTo(pending.x, pending.y);
      ctx.stroke();
      if (ctx.globalAlpha !== undefined) ctx.globalAlpha = 1;

      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.6 * px;
      ctx.setLineDash([5 * px, 4 * px]);
      ctx.beginPath();
      ctx.moveTo(anchor.x, anchor.y);
      ctx.lineTo(pending.x, pending.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // the alignment guides: a thin line from the point back to whatever it lined up with, so a snap
    // explains itself instead of the wall silently jumping (R-053, R-054)
    if (pending && aim?.guides.length) {
      ctx.strokeStyle = GUIDE;
      ctx.lineWidth = 1 * px;
      ctx.setLineDash([4 * px, 3 * px]);
      for (const guide of aim.guides) {
        ctx.beginPath();
        ctx.moveTo(pending.x, pending.y);
        ctx.lineTo(guide.to.x, guide.to.y);
        ctx.stroke();
        ring(ctx, guide.to, 3 * px, GUIDE, px);
      }
      ctx.setLineDash([]);
    }

    // where the chain began, and what the pointer has caught
    const start = points[0];
    if (start) ring(ctx, start, 6 * px, ACCENT, px);
    if (pending && aim && aim.snap !== "none" && aim.snap !== "angle") ring(ctx, pending, 7 * px, ACCENT, px);

    // the length, written along the segment as a drawing writes it
    if (anchor && pending && aim && aim.lengthMm > 0) {
      const mid = { x: (anchor.x + pending.x) / 2, y: (anchor.y + pending.y) / 2 };
      const at = toScreenPoint(view, mid);
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
      deps.preview3d([]); // a torn-down binding must not leave a half-drawn chain standing in the scene
      entry.destroy();
    },
  };
}

function ring(ctx: Ctx2D, at: Point, radius: number, colour: string, px: number): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.4 * px;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
  ctx.stroke();
}

/** The overlay is drawn in plan millimetres with y up; text has to be placed in screen pixels. */
function toScreenPoint(view: PlanView, p: Point): { x: number; y: number } {
  return { x: view.offsetX + p.x * view.scale, y: view.offsetY - p.y * view.scale };
}

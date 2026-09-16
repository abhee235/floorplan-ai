// Drawing walls on the plan surface (P3-1): the pointer and keyboard gestures, the preview they paint,
// and the one wall.createChain a finished chain sends (ADR-016 D5, ADR-017 D4). The rules are in
// wall-tool.ts and tested there; this binds them to a canvas, a pointer and a keyboard.
import type { Point, Project, Wall } from "@fpv/ir";
import type { Ctx2D, PlanRenderer, PlanView } from "../plan/plan.js";
import type { Announcer } from "./announce.js";
import { formatMm } from "./status.js";
import { type Aim, type AimOptions, type WallChainCommand, WallTool } from "./wall-tool.js";

const ACCENT = "#1e88e5";
const WALL_INK = "#3a3a3a";

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
  });

  // ---- the floating length and angle card (the design's keyboard entry) ----
  const card = document.createElement("div");
  card.className = "fpv-wall-entry";
  card.hidden = true;
  const lengthInput = numberField("Length", "mm");
  const angleInput = numberField("Angle", "°");
  const relativeNote = document.createElement("p");
  relativeNote.className = "fpv-wall-entry-note";
  relativeNote.textContent = "relative to the last wall";
  card.append(lengthInput.row, angleInput.row, relativeNote);
  element.append(card);

  const showCard = (): void => {
    if (!tool?.drawing) {
      card.hidden = true;
      return;
    }
    const seed = tool.seed();
    if (document.activeElement !== lengthInput.input && document.activeElement !== angleInput.input) {
      lengthInput.input.value = String(Math.round(seed.lengthMm));
      angleInput.input.value = String(Math.round(seed.angleDeg));
    }
    relativeNote.textContent =
      tool.points.length >= 2 ? "relative to the last wall" : "measured from the x axis";
    const anchor = tool.anchor;
    if (anchor) {
      const screen = plan.toScreen(anchor);
      card.style.left = `${screen.x / dpr() + 12}px`;
      card.style.top = `${screen.y / dpr() + 12}px`;
    }
    card.hidden = false;
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

  const finish = (): void => {
    const t = tool;
    tool = null;
    aim = null;
    card.hidden = true;
    if (!t) return;
    const command = t.end();
    deps.redraw();
    report();
    if (!command) {
      announcer.say("Nothing drawn.");
      return;
    }
    const count = command.payload.closed ? command.payload.points.length : command.payload.points.length - 1;
    void deps
      .send(command)
      .then(() => announcer.say(`${count} ${count === 1 ? "wall" : "walls"} drawn.`))
      .catch((e: unknown) =>
        announcer.alert(`The walls could not be drawn: ${e instanceof Error ? e.message : String(e)}`),
      );
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (!deps.active() || e.button !== 0) return;
    // the wall tool owns the press: the pan and select handlers on the plan must not also run
    e.stopPropagation();
    e.preventDefault();
    altHeld = e.altKey;
    place(planPoint(e));
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!deps.active()) return;
    altHeld = e.altKey;
    const t = tool;
    if (!t) return;
    aim = t.aim(planPoint(e), aimOptions());
    announcer.say(aim.announcement);
    report();
    deps.redraw();
  };

  const onDoubleClick = (e: MouseEvent): void => {
    if (!deps.active() || !tool?.drawing) return;
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
    const point = t.typedPoint(Number(lengthInput.input.value), Number(angleInput.input.value));
    if (point) place(point, false); // a typed length and angle are exact, not magnetised
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!deps.active()) return;
    if (e.key === "Escape" && tool?.drawing) {
      e.stopPropagation();
      e.preventDefault();
      finish(); // W-090: what is drawn stays
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      placeTyped();
      return;
    }
    if (e.key === "z" && (e.ctrlKey || e.metaKey) && tool?.drawing) {
      e.stopPropagation();
      e.preventDefault();
      if (tool.undoSegment()) announcer.say("Last wall taken back.");
      showCard();
      report();
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
      card.remove();
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

function numberField(name: string, unit: string): { row: HTMLElement; input: HTMLInputElement } {
  const row = document.createElement("label");
  row.className = "fpv-wall-entry-row";
  const caption = document.createElement("span");
  caption.textContent = name;
  const input = document.createElement("input");
  input.type = "number";
  input.className = "fpv-number";
  input.setAttribute("aria-label", `${name} in ${unit === "°" ? "degrees" : unit}`);
  const suffix = document.createElement("span");
  suffix.className = "fpv-wall-entry-unit";
  suffix.textContent = unit;
  row.append(caption, input, suffix);
  return { row, input };
}

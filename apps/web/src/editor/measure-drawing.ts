// Measuring on the plan: the pointer and keyboard gestures, the line they paint, and the reading. The
// rules are in measure-tool.ts and tested there; this binds them to a canvas.
//
// It sends nothing. The measure tool is the only one that changes nothing at all, which is what makes
// it usable on a drawing somebody does not want disturbed — and what makes it the tool for checking an
// imported plan's scale before trusting a single number that came out of it.
//
// A finished measurement stays on screen until the next one begins, because the reason to measure is
// usually to compare it with something else.

import type { Point, Project } from "@fpv/ir";
import type { Ctx2D, PlanRenderer, PlanView } from "../plan/plan.js";
import type { Announcer } from "./announce.js";
import { recordGesture } from "./gestures.js";
import { aimEnd, describe, formatDistance, type Measurement, measure, type Units } from "./measure-tool.js";

const LINE = "#b3261e";
const GUIDE = "rgba(179, 38, 30, 0.35)";
const LABEL_BG = "rgba(255, 255, 255, 0.92)";

export interface MeasureDrawingDeps {
  plan: PlanRenderer;
  element: HTMLElement;
  announcer: Announcer;
  project(): Project | null;
  /** The units and snapping preferences from the tool options bar. */
  settings(): { units: Units; magnetism: boolean };
  active(): boolean;
  redraw(): void;
  status(text: string): void;
}

export interface MeasureDrawing {
  draw(ctx: Ctx2D, view: PlanView): void;
  finish(): void;
  destroy(): void;
}

export function bindMeasureDrawing(deps: MeasureDrawingDeps): MeasureDrawing {
  const { plan, element, announcer } = deps;
  /** The first end, once it has been put down. */
  let from: Point | null = null;
  /** What is being measured now, or the last finished measurement. */
  let current: Measurement | null = null;
  /** True once the second end is down: the line is held until the next one starts. */
  let done = false;
  let shiftHeld = false;

  const dpr = (): number => Math.min(2, window.devicePixelRatio);
  const pixelMm = (): number => dpr() / Math.max(1e-9, plan.view.scale);

  const planPoint = (e: { clientX: number; clientY: number }): Point => {
    const rect = element.getBoundingClientRect();
    const ratio = dpr();
    return plan.toPlan((e.clientX - rect.left) * ratio, (e.clientY - rect.top) * ratio);
  };

  const settings = () => ({ ...deps.settings(), axisLocked: shiftHeld });

  const endAt = (raw: Point) => aimEnd(raw, deps.project(), plan.level, settings(), pixelMm(), from);

  const say = (): void => {
    const s = settings();
    deps.status(current ? describe(current, s.units) : "");
    deps.redraw();
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (!deps.active() || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    element.focus();
    shiftHeld = e.shiftKey;
    const landed = endAt(planPoint(e));
    if (from === null || done) {
      // A new measurement. The finished one stays up until this moment, not a moment less.
      from = landed.point;
      done = false;
      current = measure(from, from, settings().units, landed.note);
      recordGesture("measure", { phase: "begin", at: from, caught: landed.note });
      say();
      return;
    }
    current = measure(from, landed.point, settings().units, landed.note);
    done = true;
    recordGesture("measure", {
      phase: "end",
      mm: Math.round(current.distanceMm),
      across: Math.round(Math.abs(current.dxMm)),
      up: Math.round(Math.abs(current.dyMm)),
      caught: landed.note,
    });
    // Said out loud, because the number is the whole output of this tool.
    announcer.say(`${current.text}. ${formatDistance(Math.abs(current.dxMm), settings().units)} across.`);
    say();
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!deps.active()) return;
    shiftHeld = e.shiftKey;
    const landed = endAt(planPoint(e));
    if (from === null || done) {
      // Nothing is being measured yet; the readout follows the pointer so a corner announces itself.
      current = done ? current : null;
      if (!done) deps.status(landed.note ? `Start here, on a ${landed.note}` : "Press to start measuring");
      deps.redraw();
      return;
    }
    current = measure(from, landed.point, settings().units, landed.note);
    say();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!deps.active()) return;
    if (e.key === "Shift") {
      shiftHeld = true;
      return;
    }
    if (e.key === "Escape" && current) {
      // Escape clears the measurement rather than leaving the tool: leaving is the shell's Escape, and
      // this one is reached first only while something is measured.
      e.stopPropagation();
      from = null;
      current = null;
      done = false;
      say();
    }
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === "Shift") shiftHeld = false;
  };

  // Capture, as the other plan tools do: the plan's own pan and select handlers are bound to the plan
  // element and would otherwise take the press first.
  const capture = element.parentElement ?? element;
  capture.addEventListener("pointerdown", onPointerDown, { capture: true });
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("keydown", onKeyDown);
  element.addEventListener("keyup", onKeyUp);

  return {
    draw(ctx, view) {
      if (!deps.active() || !current) return;
      const m = current;
      const px = 1 / view.scale;
      if (m.distanceMm <= 0) return;

      // The two axis differences, thin and behind: on a plan "how far across" is asked as often as
      // "how far", and drawing them costs nothing.
      ctx.beginPath();
      ctx.moveTo(m.from.x, m.from.y);
      ctx.lineTo(m.to.x, m.from.y);
      ctx.lineTo(m.to.x, m.to.y);
      ctx.strokeStyle = GUIDE;
      ctx.lineWidth = 1 * px;
      ctx.setLineDash([4 * px, 4 * px]);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.moveTo(m.from.x, m.from.y);
      ctx.lineTo(m.to.x, m.to.y);
      ctx.strokeStyle = LINE;
      ctx.lineWidth = 2 * px;
      ctx.stroke();

      // A tick across each end, so the line reads as a measurement and not as a wall.
      const ux = (m.to.x - m.from.x) / m.distanceMm;
      const uy = (m.to.y - m.from.y) / m.distanceMm;
      const tick = 6 * px;
      for (const p of [m.from, m.to]) {
        ctx.beginPath();
        ctx.moveTo(p.x - uy * tick, p.y + ux * tick);
        ctx.lineTo(p.x + uy * tick, p.y - ux * tick);
        ctx.stroke();
      }

      // The number, upright and legible whatever the line's angle. Drawn in SCREEN space, as the plan
      // draws its room labels: the overlay's transform has a y flip in it, and text through a flip is
      // upside down. A plate behind it so it reads over a wall.
      const mid = {
        x: view.offsetX + ((m.from.x + m.to.x) / 2) * view.scale,
        y: view.offsetY - ((m.from.y + m.to.y) / 2) * view.scale,
      };
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.font = "600 13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // A plate sized from the text's own length: Ctx2D has no measureText, because it is the small
      // surface a fake canvas can implement, and a character estimate is enough for a backing plate.
      const half = Math.max(18, m.text.length * 4);
      ctx.beginPath();
      ctx.moveTo(mid.x - half, mid.y - 10);
      ctx.lineTo(mid.x + half, mid.y - 10);
      ctx.lineTo(mid.x + half, mid.y + 10);
      ctx.lineTo(mid.x - half, mid.y + 10);
      ctx.closePath();
      ctx.fillStyle = LABEL_BG;
      ctx.fill();
      ctx.fillStyle = LINE;
      ctx.fillText(m.text, mid.x, mid.y);
      ctx.restore();
    },
    finish() {
      from = null;
      current = null;
      done = false;
      say();
    },
    destroy() {
      capture.removeEventListener("pointerdown", onPointerDown, { capture: true });
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("keyup", onKeyUp);
    },
  };
}

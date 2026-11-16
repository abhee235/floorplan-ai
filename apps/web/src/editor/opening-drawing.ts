// Putting doors and windows in walls on the plan: the pointer and keyboard gestures, the ghost they
// paint, and the one `opening.add` a placement sends. The rules are in opening-tool.ts and tested there;
// this binds them to a canvas, the same way item-placing.ts does for items.
//
// The tool stays armed after a placement, so a run of windows is a run of clicks; Escape ends it.

import { derive, type Point, type Project, type Wall } from "@fpv/ir";
import type { Ctx2D, PlanRenderer, PlanView } from "../plan/plan.js";
import type { Announcer } from "./announce.js";
import { recordGesture } from "./gestures.js";
import {
  type AddOpeningCommand,
  addCommand,
  aimOnWall,
  aimOpening,
  FINE_SLIDE_MM,
  type OpeningAim,
  type OpeningKind,
  SLIDE_MM,
  slide,
} from "./opening-tool.js";

const ACCENT = "#1e88e5";
const GHOST_FILL = "rgba(30, 136, 229, 0.14)";
const REFUSED = "#d32f2f";
const REFUSED_FILL = "rgba(211, 47, 47, 0.12)";

export interface OpeningDrawingDeps {
  plan: PlanRenderer;
  element: HTMLElement;
  announcer: Announcer;
  project(): Project | null;
  /** The kind and width from the tool options bar. */
  settings(): { kind: OpeningKind; widthMm: number };
  /** True while the opening tool is the active tool. */
  active(): boolean;
  /** Sends the placement; resolves with the new opening's id. */
  send(command: AddOpeningCommand): Promise<string | null>;
  select(ids: string[]): void;
  redraw(): void;
  status(text: string): void;
}

export interface OpeningDrawing {
  draw(ctx: Ctx2D, view: PlanView): void;
  finish(): void;
  destroy(): void;
}

export function bindOpeningDrawing(deps: OpeningDrawingDeps): OpeningDrawing {
  const { plan, element, announcer } = deps;
  let aim: OpeningAim | null = null;
  /** The wall the aim is on, kept so the arrow keys can slide along it without the pointer. */
  let wall: Wall | null = null;
  let altHeld = false;

  const dpr = (): number => Math.min(2, window.devicePixelRatio);

  const planPoint = (e: { clientX: number; clientY: number }): Point => {
    const rect = element.getBoundingClientRect();
    const ratio = dpr();
    return plan.toPlan((e.clientX - rect.left) * ratio, (e.clientY - rect.top) * ratio);
  };

  const settings = () => ({ ...deps.settings(), freehand: altHeld });

  const say = (): void => {
    deps.status(aim ? (aim.refusal ? aim.refusal : aim.note) : "");
    deps.redraw();
  };

  const aimAt = (at: Point): void => {
    const project = deps.project();
    const level = plan.level;
    if (!project || !level) return;
    aim = aimOpening(project, level, at, settings());
    wall = aim ? (project.walls.find((w) => w.id === aim?.wallId) ?? null) : null;
    say();
  };

  const place = (): void => {
    const project = deps.project();
    if (!aim || !project) return;
    if (aim.refusal) {
      announcer.alert(aim.refusal);
      recordGesture("place", { what: "opening", sent: [], because: aim.refusal });
      return;
    }
    const command = addCommand(aim);
    if (!command) return;
    const kind = command.payload.kind;
    recordGesture("place", {
      what: "opening",
      kind,
      wall: command.payload.wallId,
      width: command.payload.width,
      sent: command.type,
    });
    void deps
      .send(command)
      .then((id) => {
        if (id) deps.select([id]);
        announcer.say(`${kind} placed. Place another, or press Escape to finish.`);
        // Re-aim on the same spot so the next one knows this one is there and refuses an overlap.
        const project2 = deps.project();
        if (project2 && wall) {
          const fresh = project2.walls.find((w) => w.id === wall?.id) ?? null;
          if (fresh) {
            wall = fresh;
            aim = aimOnWall(project2, fresh, aim?.position ?? 0.5, settings());
            say();
          }
        }
      })
      .catch((e: unknown) =>
        announcer.alert(`It could not be placed: ${e instanceof Error ? e.message : String(e)}`),
      );
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (!deps.active() || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    element.focus();
    altHeld = e.altKey;
    aimAt(planPoint(e));
    if (!aim) {
      announcer.alert("Press on a wall to put a door or a window in it.");
      return;
    }
    place();
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!deps.active()) return;
    altHeld = e.altKey;
    aimAt(planPoint(e));
  };

  const onPointerLeave = (): void => {
    if (!deps.active() || !aim) return;
    aim = null;
    wall = null;
    say();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!deps.active()) return;
    if (e.key === "Alt") {
      altHeld = true;
      return;
    }
    // Arrows slide the ghost along its wall, so it can be put exactly without a steady hand.
    const by = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      const project = deps.project();
      if (!aim || !wall || !project) return;
      e.preventDefault();
      aim = slide(project, wall, aim, by * (e.shiftKey ? FINE_SLIDE_MM : SLIDE_MM), settings());
      say();
      return;
    }
    if (e.key === "Enter" && aim) {
      e.preventDefault();
      place();
    }
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.key !== "Alt") return;
    altHeld = false;
    if (deps.active() && aim && wall) {
      const project = deps.project();
      if (project) {
        aim = aimOnWall(project, wall, aim.position, settings());
        say();
      }
    }
  };

  // Capture, for the same reason the other drawing tools do it: the plan's own pan and select handlers
  // are bound to the plan element itself and would otherwise see the press first.
  const capture = element.parentElement ?? element;
  capture.addEventListener("pointerdown", onPointerDown, { capture: true });
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerleave", onPointerLeave);
  element.addEventListener("keydown", onKeyDown);
  element.addEventListener("keyup", onKeyUp);

  return {
    draw(ctx, view) {
      if (!deps.active() || !aim) return;
      const points = aim.footprint;
      const [first, ...rest] = points;
      if (!first || points.length < 3) return;
      // The overlay is already in plan coordinates, so widths are scaled rather than points projected.
      const px = 1 / view.scale;
      const refused = aim.refusal !== null;
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (const q of rest) ctx.lineTo(q.x, q.y);
      ctx.closePath();
      ctx.fillStyle = refused ? REFUSED_FILL : GHOST_FILL;
      ctx.fill();
      ctx.strokeStyle = refused ? REFUSED : ACCENT;
      ctx.lineWidth = 1.5 * px;
      // Dashed while it is only an intention; the plan draws a committed opening solid.
      ctx.setLineDash([5 * px, 4 * px]);
      ctx.stroke();
      ctx.setLineDash([]);

      // A door says which way it opens, because that is the thing people get wrong and cannot see.
      if (wall && aim.preview.swing) {
        const centre = derive.openingCentre(aim.preview, wall);
        ctx.beginPath();
        ctx.arc(centre.x, centre.y, aim.widthMm / 2, 0, Math.PI * 2);
        ctx.lineWidth = 1 * px;
        ctx.setLineDash([3 * px, 5 * px]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    },
    finish() {
      aim = null;
      wall = null;
      say();
    },
    destroy() {
      capture.removeEventListener("pointerdown", onPointerDown, { capture: true });
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerleave", onPointerLeave);
      element.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("keyup", onKeyUp);
    },
  };
}

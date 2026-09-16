// Placing items on the plan surface (P3-5): the pointer and keyboard gestures, the ghost they paint, and
// the item.place a placement sends. The rules are in item-tool.ts and tested there; this binds them to a
// canvas, a pointer and a keyboard, the same way room-drawing.ts does for rooms.
//
// The tool stays armed after a placement, so a row of chairs is a row of clicks; Escape ends it and the
// shell returns to the select tool.
import type { Point, Project } from "@fpv/ir";
import type { Ctx2D, PlanRenderer, PlanView } from "../plan/plan.js";
import type { Announcer } from "./announce.js";
import {
  FINE_NUDGE_MM,
  type ItemAim,
  ItemPlacer,
  NUDGE_MM,
  type Placeable,
  type PlaceCommand,
  TURN_DEG,
  turned,
} from "./item-tool.js";

const ACCENT = "#1e88e5";
const GHOST_FILL = "rgba(30, 136, 229, 0.12)";

export interface ItemPlacingDeps {
  plan: PlanRenderer;
  element: HTMLElement;
  announcer: Announcer;
  project(): Project | null;
  /** The piece picked in the catalog, or null when none is. */
  piece(): Placeable | null;
  /** The snapping preference and the asked-for rotation, from the tool options bar. */
  settings(): { magnetism: boolean; rotation: number };
  setRotation(degrees: number): void;
  /** True while the item tool is the active tool. */
  active(): boolean;
  /** Sends the placement; resolves with the new item's id. */
  send(command: PlaceCommand): Promise<string | null>;
  select(ids: string[]): void;
  redraw(): void;
  status(text: string): void;
}

export interface ItemPlacing {
  draw(ctx: Ctx2D, view: PlanView): void;
  /** Starts the ghost in the middle of the view, for someone arriving by keyboard. */
  arm(): void;
  finish(): void;
  destroy(): void;
}

export function bindItemPlacing(deps: ItemPlacingDeps): ItemPlacing {
  const { plan, element, announcer } = deps;
  let placer: ItemPlacer | null = null;
  let aim: ItemAim | null = null;
  let altHeld = false;

  const dpr = (): number => Math.min(2, window.devicePixelRatio);

  const planPoint = (e: { clientX: number; clientY: number }): Point => {
    const rect = element.getBoundingClientRect();
    const ratio = dpr();
    return plan.toPlan((e.clientX - rect.left) * ratio, (e.clientY - rect.top) * ratio);
  };

  const settings = () => {
    const s = deps.settings();
    return { magnetism: s.magnetism && !altHeld, rotation: s.rotation };
  };

  /** The placer for the piece picked now, made afresh when the pick or the level changed. */
  const ensure = (at: Point): ItemPlacer | null => {
    const piece = deps.piece();
    const level = plan.level;
    if (!piece || !level) return null;
    if (!placer || placer.piece.id !== piece.id || placer.levelId !== level)
      placer = new ItemPlacer(piece, level, at);
    return placer;
  };

  const middle = (): Point => plan.toPlan(plan.view.width / 2, plan.view.height / 2);

  const refresh = (): void => {
    aim = placer ? placer.aim(deps.project(), settings()) : null;
    deps.status(aim ? `${placer?.piece.name}${aim.note ? `, ${aim.note}` : ""}` : "");
    deps.redraw();
  };

  const place = (): void => {
    const p = placer;
    if (!p) return;
    const command = p.command(settings());
    const name = p.piece.name;
    void deps
      .send(command)
      .then((id) => {
        if (id) deps.select([id]);
        announcer.say(`${name} placed. Place another, or press Escape to finish.`);
      })
      .catch((e: unknown) =>
        announcer.alert(`${name} could not be placed: ${e instanceof Error ? e.message : String(e)}`),
      );
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (!deps.active() || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    element.focus();
    altHeld = e.altKey;
    if (!ensure(planPoint(e))) {
      announcer.alert("Pick a piece in the catalog first.");
      return;
    }
    placer?.moveTo(planPoint(e));
    refresh();
    place();
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!deps.active()) return;
    altHeld = e.altKey;
    const p = ensure(planPoint(e));
    if (!p) return;
    p.moveTo(planPoint(e));
    refresh();
  };

  const onPointerLeave = (): void => {
    if (!deps.active() || !aim) return;
    // the ghost goes with the pointer; the keyboard brings it back with arm()
    aim = null;
    deps.status("");
    deps.redraw();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!deps.active()) return;
    const p = placer ?? ensure(middle());
    if (!p) return;
    const step = e.shiftKey ? FINE_NUDGE_MM : NUDGE_MM;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      e.stopPropagation();
      p.nudge(move[0], move[1]);
      refresh();
      announcer.say(
        `${aim?.note ? `${capital(aim.note)}. ` : ""}${Math.round(p.point.x)}, ${Math.round(p.point.y)}`,
      );
      return;
    }
    if (e.key === "[" || e.key === "]") {
      e.preventDefault();
      e.stopPropagation();
      const next = turned(deps.settings().rotation, aim?.rotation ?? 0, e.key === "]" ? TURN_DEG : -TURN_DEG);
      deps.setRotation(next);
      // the options bar re-renders first; read the new rotation straight from what was set
      aim = p.aim(deps.project(), { ...settings(), rotation: next });
      deps.redraw();
      announcer.say(`Turned to ${next % 360} degrees.`);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (!aim) refresh();
      place();
    }
  };

  const capture = element.parentElement ?? element;
  capture.addEventListener("pointerdown", onPointerDown, { capture: true });
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerleave", onPointerLeave);
  element.addEventListener("keydown", onKeyDown);

  // ---- the ghost -----------------------------------------------------------
  const draw = (ctx: Ctx2D, view: PlanView): void => {
    if (!deps.active() || !aim) return;
    const px = 1 / view.scale;
    const [first, ...rest] = aim.footprint;
    if (!first) return;
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const q of rest) ctx.lineTo(q.x, q.y);
    ctx.closePath();
    ctx.fillStyle = GHOST_FILL;
    ctx.fill();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5 * px;
    ctx.setLineDash([5 * px, 4 * px]);
    ctx.stroke();
    ctx.setLineDash([]);
    // the front, as the plan marks it on every item: the footprint's last edge
    const a = aim.footprint[2];
    const b = aim.footprint[3];
    if (a && b) {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineWidth = 3 * px;
      ctx.stroke();
    }
  };

  const finish = (): void => {
    placer = null;
    aim = null;
    altHeld = false;
    deps.status("");
    deps.redraw();
  };

  return {
    draw,
    arm: () => {
      const p = ensure(middle());
      if (!p) return;
      if (!aim) p.moveTo(middle());
      refresh();
    },
    finish,
    destroy: () => {
      capture.removeEventListener("pointerdown", onPointerDown, { capture: true });
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerleave", onPointerLeave);
      element.removeEventListener("keydown", onKeyDown);
    },
  };
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

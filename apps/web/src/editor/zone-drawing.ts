// Drawing desk clusters on the plan surface (P3-6): the pointer and keyboard gestures, the preview they
// paint, and the one item.arrange a finished drag sends. The rules are in zone-tool.ts and tested there;
// this binds them to a canvas, a pointer and a keyboard, as room-drawing.ts does for rooms.
//
// The gesture is a drag rather than a chain of clicks, because a cluster is an AREA, not an outline: you
// sweep the part of the floor plate that is going to hold desks. A click with no drag falls back to the
// room under the pointer, which is the common case on a plan that already has rooms.
import { derive, type Point, type Project, type Wall } from "@fpv/ir";
import type { Ctx2D, PlanRenderer, PlanView } from "../plan/plan.js";
import type { Announcer } from "./announce.js";
import type { Placeable } from "./item-tool.js";
import { formatMm } from "./status.js";
import {
  type ArrangeCommand,
  DEFAULT_PIECE,
  MIN_SIDE_MM,
  type ZoneAim,
  type ZoneAimOptions,
  type ZoneRule,
  ZoneTool,
} from "./zone-tool.js";

const ZONE = "#7a5cc4";
const ZONE_FILL = "rgba(122, 92, 196, 0.10)";

export interface ZoneDrawingDeps {
  plan: PlanRenderer;
  element: HTMLElement;
  announcer: Announcer;
  project(): Project | null;
  /** The piece picked in the catalog tab, or null to lay out a plain desk. */
  piece(): Placeable | null;
  /** The pattern, gap, facing and margin from the tool options bar, and the snapping preference. */
  settings(): ZoneRule & { magnetism: boolean };
  /** What is selected, so Enter can fill a room chosen without a pointer (ADR-017 D4). */
  selection(): readonly string[];
  /** True while the zone tool is the active tool. */
  active(): boolean;
  send(command: ArrangeCommand): Promise<void>;
  redraw(): void;
  status(text: string): void;
}

export interface ZoneDrawing {
  draw(ctx: Ctx2D, view: PlanView): void;
  readonly drawing: boolean;
  /** Fills the room the keyboard is on, for someone working without a pointer. */
  fillRoomById(roomId: string): void;
  finish(): void;
  destroy(): void;
}

export function bindZoneDrawing(deps: ZoneDrawingDeps): ZoneDrawing {
  const { plan, element, announcer } = deps;
  let tool: ZoneTool | null = null;
  let aim: ZoneAim | null = null;
  let altHeld = false;
  let shiftHeld = false;
  /** Where the press landed, so a release in the same spot can be treated as a click. */
  let pressedAt: Point | null = null;

  const dpr = (): number => Math.min(2, window.devicePixelRatio);

  const walls = (): readonly Wall[] => {
    const project = deps.project();
    const level = plan.level;
    if (!project || !level) return [];
    return project.walls.filter((w) => w.levelId === level);
  };

  const aimOptions = (): ZoneAimOptions => ({
    walls: walls(),
    pixelMm: 1 / plan.view.scale,
    magnetism: deps.settings().magnetism,
    altHeld,
    shiftHeld,
  });

  const planPoint = (e: { clientX: number; clientY: number }): Point => {
    const rect = element.getBoundingClientRect();
    const ratio = dpr();
    return plan.toPlan((e.clientX - rect.left) * ratio, (e.clientY - rect.top) * ratio);
  };

  const ensureTool = (): ZoneTool | null => {
    if (tool) return tool;
    const level = plan.level;
    if (!level) return null;
    tool = new ZoneTool({
      levelId: level,
      piece: () => deps.piece() ?? DEFAULT_PIECE,
      rule: () => deps.settings(),
    });
    return tool;
  };

  const report = (): void => {
    if (!aim) {
      deps.status("");
      return;
    }
    deps.status(`${formatMm(aim.widthMm)} × ${formatMm(aim.depthMm)} mm · ${aim.fits} pieces`);
  };

  /** Sends a command and says what happened, in the same words for a drag and for a filled room. */
  const dispatch = (command: ArrangeCommand, where: string): void => {
    const count = command.payload.rule.count;
    void deps
      .send(command)
      .then(() => announcer.say(`${count} ${count === 1 ? "piece" : "pieces"} arranged ${where}.`))
      .catch((e: unknown) =>
        announcer.alert(`Nothing was arranged: ${e instanceof Error ? e.message : String(e)}`),
      );
  };

  /** A click rather than a drag: fill the room under the pointer, if there is one. */
  const fillAt = (point: Point): void => {
    const t = ensureTool();
    const project = deps.project();
    const level = plan.level;
    if (!t || !project || !level) return;
    const room = derive.containingRoom(project, level, point);
    if (!room) {
      announcer.say("No room there. Drag to mark out the area instead.");
      return;
    }
    const command = t.fillRoom(room.id, room.polygon);
    if (!command) {
      announcer.say(`Nothing fits in ${room.name ?? "that room"} at this size and gap.`);
      return;
    }
    dispatch(command, `in ${room.name ?? "the room"}`);
  };

  const fillRoomById = (roomId: string): void => {
    const t = ensureTool();
    const project = deps.project();
    const room = project?.rooms.find((r) => r.id === roomId);
    if (!t || !room) return;
    const command = t.fillRoom(room.id, room.polygon);
    if (!command) {
      announcer.say(`Nothing fits in ${room.name ?? "that room"} at this size and gap.`);
      return;
    }
    dispatch(command, `in ${room.name ?? "the room"}`);
  };

  const finish = (): void => {
    tool?.cancel();
    tool = null;
    aim = null;
    pressedAt = null;
    report();
    deps.redraw();
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (!deps.active() || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    element.focus();
    altHeld = e.altKey;
    shiftHeld = e.shiftKey;
    const t = ensureTool();
    if (!t) return;
    pressedAt = planPoint(e);
    t.begin(pressedAt, aimOptions());
    aim = null;
    report();
    deps.redraw();
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!deps.active()) return;
    altHeld = e.altKey;
    shiftHeld = e.shiftKey;
    if (!tool?.drawing) return;
    aim = tool.aim(planPoint(e), aimOptions());
    if (aim) announcer.say(aim.announcement);
    report();
    deps.redraw();
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (!deps.active() || !tool?.drawing) return;
    e.stopPropagation();
    const point = planPoint(e);
    const t = tool;
    const started = pressedAt;
    const command = t.end(point, aimOptions());
    const dragged =
      started !== null &&
      (Math.abs(point.x - started.x) >= MIN_SIDE_MM || Math.abs(point.y - started.y) >= MIN_SIDE_MM);
    const size = aim ? `${formatMm(aim.widthMm)} by ${formatMm(aim.depthMm)} mm` : "";
    tool = null;
    aim = null;
    pressedAt = null;
    report();
    deps.redraw();
    if (command) {
      dispatch(command, "here");
      return;
    }
    // Nothing was made. Say which of the two reasons it was, rather than leaving a person to guess.
    if (!dragged) fillAt(point);
    else announcer.say(`Nothing fits in ${size} at this gap. Nothing was added.`);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!deps.active()) return;
    if (e.key === "Enter" && !tool?.drawing) {
      // The whole gesture without a pointer: pick a room, press Enter, it fills.
      const project = deps.project();
      const room = project?.rooms.find((r) => deps.selection().includes(r.id));
      if (!room) {
        announcer.say("Select a room first, or drag to mark out an area.");
        return;
      }
      e.preventDefault();
      fillRoomById(room.id);
      return;
    }
    if (e.key === "Escape" && tool?.drawing) {
      e.preventDefault();
      announcer.say("Cluster abandoned.");
      finish();
      // Deliberately not stopped: the shell takes the same Escape back to the select tool (ADR-017 D2).
    }
  };

  const capture = element.parentElement ?? element;
  capture.addEventListener("pointerdown", onPointerDown, { capture: true });
  element.addEventListener("pointermove", onPointerMove);
  capture.addEventListener("pointerup", onPointerUp, { capture: true });
  element.addEventListener("keydown", onKeyDown);

  // ---- the preview -------------------------------------------------------
  const draw = (ctx: Ctx2D, view: PlanView): void => {
    if (!aim) return;
    const px = 1 / view.scale;
    ctx.beginPath();
    const [first, ...rest] = aim.polygon;
    if (!first) return;
    ctx.moveTo(first.x, first.y);
    for (const q of rest) ctx.lineTo(q.x, q.y);
    ctx.closePath();
    // Filled while it is being swept, unlike a placed zone: the fill is what says "this area", and there
    // is nothing standing inside it yet for the tint to wash over.
    ctx.fillStyle = ZONE_FILL;
    ctx.fill();
    ctx.strokeStyle = ZONE;
    ctx.lineWidth = 1.4 * px;
    ctx.setLineDash([8 * px, 5 * px]);
    ctx.stroke();
    ctx.setLineDash([]);

    // The size and the count, where the pointer is: the count is the whole point of the gesture.
    const at = { x: view.offsetX + first.x * view.scale, y: view.offsetY - first.y * view.scale };
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = ZONE;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(
      `${formatMm(aim.widthMm)} × ${formatMm(aim.depthMm)} mm · ${aim.fits} pieces`,
      at.x + 8,
      at.y - 8,
    );
    ctx.restore();
  };

  return {
    draw,
    get drawing() {
      return tool?.drawing ?? false;
    },
    fillRoomById,
    finish,
    destroy: () => {
      capture.removeEventListener("pointerdown", onPointerDown, { capture: true });
      element.removeEventListener("pointermove", onPointerMove);
      capture.removeEventListener("pointerup", onPointerUp, { capture: true });
      element.removeEventListener("keydown", onKeyDown);
    },
  };
}

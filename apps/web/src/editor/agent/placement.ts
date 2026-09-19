// Where the chat window sits, and how it is moved (ADR-022).
//
// Docked bottom-right by default and tall, because that is where a conversation belongs beside a
// drawing: the plan keeps the middle of the screen, and the chat is the column you glance at. It can
// be pulled off its dock and put anywhere, which is what makes it usable on a second monitor or over
// the 3D view rather than beside it.
//
// The rules are here, away from React, for the same reason the drawing tools keep theirs away from
// the canvas: "a window dragged half off the screen cannot be dragged back" is a sentence a test can
// hold, and a rendering cannot.

export interface Placement {
  mode: "docked" | "floating";
  /** Floating position and size, in CSS pixels from the top left of the viewport. */
  x: number;
  y: number;
  width: number;
  height: number;
  minimised: boolean;
}

export const MIN_WIDTH = 280;
export const MIN_HEIGHT = 220;
/** How much of the window must stay on screen, so there is always something to grab. */
const KEEP_ON_SCREEN = 120;
/** The gap from the edges when docked: enough to see the plan's own controls underneath. */
const DOCK_GAP = 12;

export const DEFAULT_PLACEMENT: Placement = {
  mode: "docked",
  x: 0,
  y: 0,
  width: 380,
  height: 520,
  minimised: false,
};

export interface Viewport {
  width: number;
  height: number;
  /** The bars the window should not cover: the app bar and tool options above, the status below. */
  top: number;
  bottom: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The window's rectangle, in CSS pixels.
 *
 * Docked means the full height between the bars, against the right edge. Floating is wherever it was
 * put, clamped so a corner is always reachable — a window dragged off the bottom of the screen with
 * no way back is a window somebody has to clear their site data to recover.
 */
export function rectOf(placement: Placement, view: Viewport): Rect {
  const available = Math.max(MIN_HEIGHT, view.height - view.top - view.bottom);
  if (placement.mode === "docked") {
    const width = Math.min(
      Math.max(MIN_WIDTH, placement.width),
      Math.max(MIN_WIDTH, view.width - DOCK_GAP * 2),
    );
    return {
      left: Math.max(DOCK_GAP, view.width - width - DOCK_GAP),
      top: view.top + DOCK_GAP,
      width,
      height: Math.max(MIN_HEIGHT, available - DOCK_GAP * 2),
    };
  }
  const width = Math.min(Math.max(MIN_WIDTH, placement.width), Math.max(MIN_WIDTH, view.width));
  const height = Math.min(Math.max(MIN_HEIGHT, placement.height), Math.max(MIN_HEIGHT, available));
  return {
    left: clamp(placement.x, KEEP_ON_SCREEN - width, view.width - KEEP_ON_SCREEN),
    top: clamp(placement.y, view.top, view.height - view.bottom - KEEP_ON_SCREEN),
    width,
    height,
  };
}

/**
 * The placement after a drag of the title bar.
 *
 * Dragging a docked window undocks it where it stood, so it does not jump out from under the pointer
 * at the first pixel of movement.
 */
export function afterDrag(placement: Placement, from: Rect, dx: number, dy: number): Placement {
  return {
    ...placement,
    mode: "floating",
    x: from.left + dx,
    y: from.top + dy,
    width: from.width,
    height: from.height,
  };
}

/** The placement after dragging the bottom-left corner; a docked window resizes without undocking. */
export function afterResize(placement: Placement, from: Rect, dx: number, dy: number): Placement {
  return {
    ...placement,
    // Pulled from the left edge, so the window grows towards the middle of the screen where there is
    // room, rather than towards an edge it is already against.
    width: Math.max(MIN_WIDTH, from.width - dx),
    height: Math.max(MIN_HEIGHT, from.height + dy),
    ...(placement.mode === "floating" ? { x: from.left + dx } : {}),
  };
}

export function docked(placement: Placement): Placement {
  return { ...placement, mode: "docked" };
}

export function floated(placement: Placement, from: Rect): Placement {
  return {
    ...placement,
    mode: "floating",
    x: from.left,
    y: from.top,
    width: from.width,
    height: from.height,
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

const KEY = "fpv.agent.placement";

/**
 * Where the window was left, per browser.
 *
 * Wrapped in try/catch both ways: a private window, cleared site data or a blocked storage all throw
 * or come back empty, and none of those is a reason for the chat not to open.
 */
export function readPlacement(storage?: Storage | null): Placement {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(KEY);
    if (!raw) return DEFAULT_PLACEMENT;
    const held = JSON.parse(raw) as Partial<Placement>;
    return {
      mode: held.mode === "floating" ? "floating" : "docked",
      x: number(held.x, DEFAULT_PLACEMENT.x),
      y: number(held.y, DEFAULT_PLACEMENT.y),
      width: number(held.width, DEFAULT_PLACEMENT.width),
      height: number(held.height, DEFAULT_PLACEMENT.height),
      minimised: held.minimised === true,
    };
  } catch {
    return DEFAULT_PLACEMENT;
  }
}

export function writePlacement(placement: Placement, storage?: Storage | null): void {
  try {
    (storage ?? globalThis.localStorage)?.setItem(KEY, JSON.stringify(placement));
  } catch {
    // a browser that will not remember where the window was is not a browser that cannot show it
  }
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

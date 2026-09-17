// Changing a number by dragging, the way design tools do (P3-5 follow-up). Press a field's label or its
// axis letter and drag sideways: the value follows the pointer, the plan and the 3D view follow the value,
// and letting go commits it once. Shift moves ten times faster, Alt ten times slower, and Escape puts the
// value back. Up and Down step a focused field the same way from the keyboard.
//
// Adapted from the owner's own design editor (wizzel, MIT): the pointer is locked while dragging, so a drag
// is not stopped by the edge of the screen, and a drawn cursor stands in for the hidden one. Unlike that
// version, a refused lock falls back to an ordinary drag, and nothing is sent until the drag ends.

export interface ScrubKind {
  /** How far the value moves for one pixel of drag, before Shift or Alt. */
  perPx: number;
  /** How far one arrow key press moves it, before Shift. */
  step: number;
  /** Decimals the value keeps. */
  decimals: number;
}

/** The units a field can be scrubbed in; anything else is typed only. */
const KINDS: Readonly<Record<string, ScrubKind>> = {
  mm: { perPx: 1, step: 1, decimals: 0 },
  "°": { perPx: 0.5, step: 1, decimals: 1 },
  seats: { perPx: 0.1, step: 1, decimals: 0 },
  // A count of things, as seats are: a tenth per pixel, so a whole drag of the panel's width is about
  // twenty desks rather than two hundred.
  desks: { perPx: 0.1, step: 1, decimals: 0 },
};

export function scrubKindOf(unit: string | undefined): ScrubKind | null {
  return unit ? (KINDS[unit] ?? null) : null;
}

/** Shift is ten times the pace and Alt a tenth of it. */
export function paceOf(mods: { shiftKey: boolean; altKey: boolean }): number {
  return mods.shiftKey ? 10 : mods.altKey ? 0.1 : 1;
}

/**
 * The number a field starts from: its own value, or, for an empty field that stands for something, the
 * first number in what it shows ("2 700 (level)" starts at 2700). Null when there is none.
 */
export function scrubStart(value: string, emptyShown?: string): number | null {
  const read = (text: string): number | null => {
    // \s takes the narrow no-break space the fields group thousands with, too
    const m = /-?\d[\d\s]*(?:\.\d+)?/.exec(text);
    if (!m) return null;
    const n = Number(m[0].replace(/\s/g, ""));
    return Number.isFinite(n) ? n : null;
  };

  if (value.trim() !== "") return read(value);
  return emptyShown ? read(emptyShown) : null;
}

/** A scrubbed value as the field's text: whole millimetres and seats, tenths of a degree. */
export function scrubText(kind: ScrubKind, value: number): string {
  const f = 10 ** kind.decimals;
  const rounded = Math.round(value * f) / f + 0; // + 0 turns -0 into 0
  return String(rounded);
}

export interface ScrubHandlers {
  /** The drag has passed the threshold: the value is about to move. */
  start(): void;
  /** The pointer moved `dx` pixels sideways with these keys held. */
  move(dx: number, mods: { shiftKey: boolean; altKey: boolean }): void;
  /** The drag ended: released (`commit`) or cancelled with Escape. Not called for a plain click. */
  end(commit: boolean): void;
}

/** Pixels of movement before a press becomes a drag, so a click on the label still focuses the field. */
const THRESHOLD_PX = 3;

/**
 * Follow a press on `handle` as a scrub. A press that never moves past the threshold is left alone, so the
 * label's own click still does what a label click does.
 */
export function beginScrub(press: PointerEvent, handle: HTMLElement, h: ScrubHandlers): void {
  if (press.button !== 0) return;
  const doc = handle.ownerDocument;
  const view = doc.defaultView ?? window;
  const originX = press.clientX;
  let lastX = press.clientX;
  let started = false;
  let locked = false;
  let cursor = { x: press.clientX, y: press.clientY };
  let overlay: HTMLElement | null = null;
  let glyph: HTMLElement | null = null;

  const onMove = (e: PointerEvent): void => {
    const dx = locked ? e.movementX : e.clientX - lastX;
    lastX = e.clientX;
    if (!started) {
      if (Math.abs(e.clientX - originX) < THRESHOLD_PX) return;
      started = true;
      ({ overlay, glyph } = showCursor(doc, cursor));
      try {
        // A promise in current browsers, undefined in older ones; a refusal just leaves an ordinary drag.
        const asked = handle.requestPointerLock?.() as unknown as Promise<void> | undefined;
        asked?.catch?.(() => {});
      } catch {
        // no pointer lock here
      }
      h.start();
      h.move(e.clientX - originX, e);
      return;
    }
    e.preventDefault();
    // the drawn cursor wraps round the window while the real one is locked in place
    cursor = {
      x: (((cursor.x + dx) % view.innerWidth) + view.innerWidth) % view.innerWidth,
      y: cursor.y,
    };
    if (glyph) glyph.style.transform = `translate(${cursor.x - 12}px, ${cursor.y - 12}px)`;
    if (dx !== 0) h.move(dx, e);
  };
  const onUp = (): void => finish(true);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    finish(false);
  };
  const onLock = (): void => {
    locked = doc.pointerLockElement === handle;
  };

  function finish(commit: boolean): void {
    doc.removeEventListener("pointermove", onMove, true);
    doc.removeEventListener("pointerup", onUp, true);
    doc.removeEventListener("pointercancel", onCancel, true);
    doc.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("pointerlockchange", onLock);
    if (doc.pointerLockElement === handle) doc.exitPointerLock();
    overlay?.remove();
    if (started) h.end(commit);
  }
  const onCancel = (): void => finish(false);

  doc.addEventListener("pointermove", onMove, true);
  doc.addEventListener("pointerup", onUp, true);
  doc.addEventListener("pointercancel", onCancel, true);
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("pointerlockchange", onLock);
}

/** A sheet over the page that hides the pointer, with a left-right arrow drawn where it would be. */
function showCursor(
  doc: Document,
  at: { x: number; y: number },
): { overlay: HTMLElement; glyph: HTMLElement } {
  const overlay = doc.createElement("div");
  overlay.setAttribute("aria-hidden", "true");
  overlay.dataset.scrubbing = "";
  overlay.style.cssText = "position:fixed;inset:0;z-index:1000;cursor:none;";
  const glyph = doc.createElement("div");
  glyph.style.cssText = `position:absolute;left:0;top:0;width:24px;height:24px;pointer-events:none;transform:translate(${at.x - 12}px, ${at.y - 12}px);`;
  // a double-headed arrow, white edged so it reads on any background
  glyph.innerHTML =
    '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M2 12l5-5v3h10V7l5 5-5 5v-3H7v3z" fill="#111" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  overlay.appendChild(glyph);
  doc.body.appendChild(overlay);
  return { overlay, glyph };
}

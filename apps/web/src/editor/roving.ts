// One tab stop per toolbar (ADR-017 D4, following the ARIA authoring practices): Tab reaches the group,
// arrows move within it, Home and End jump to its ends, and every other key is left alone. Index maths
// only — the shell owns the elements and moves the focus.

export type Orientation = "horizontal" | "vertical";

export interface RovingOptions {
  count: number;
  orientation: Orientation;
  /** Past the last item focus returns to the first; on by default, as toolbars usually wrap. */
  wrap?: boolean;
}

/** The index this key moves focus to.
 *
 *  Returns null when the key means nothing to the group, which is the caller's signal to let the event
 *  through untouched. When the group does not wrap and focus is already at the end, it returns that same
 *  index rather than null: the key was still the group's to handle, so the caller should consume it. */
export function rovingNext(current: number, key: string, options: RovingOptions): number | null {
  const { count, orientation } = options;
  if (count <= 0) return null;
  const at = Math.min(Math.max(current, 0), count - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const forward = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
  const back = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  if (key !== forward && key !== back) return null;
  const next = at + (key === forward ? 1 : -1);
  if (next >= 0 && next < count) return next;
  return (options.wrap ?? true) ? (next + count) % count : at;
}

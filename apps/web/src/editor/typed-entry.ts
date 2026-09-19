// Drawing by typing: the floating length and angle card (P3-9; ledger W-072..W-076, R-046, R-047).
//
// "Drawing by typing is the same gesture as drawing by pointer: length, Tab, angle, Enter places the
// segment; Enter twice ends the chain; the angle is relative to the previous wall and absolute for the
// first" (ADR-017 D4). It is the difference between an editor you can sketch in and one you can draw a
// measured plan in — a surveyor's dimensions are numbers, not pointer positions, and a plan read from a
// drawing is corrected by typing the number that drawing states.
//
// The card belongs to no single tool. The wall tool grew one first and the room tool, whose own seed()
// and typedPoint() were written and tested at the same time, was left without one: a chain of walls
// could be typed exactly while a room had to be drawn by eye. Rather than a second copy with its own
// behaviour to drift, both tools take this one.
//
// Classes are Tailwind utilities written as literals. Tailwind's scanner reads .ts files, so they
// generate; the `absolute` is load-bearing, since the card positions itself with style.left/top.

export interface TypedSeed {
  lengthMm: number;
  angleDeg: number;
}

/** What the card needs of a drawing tool: both the wall tool and the room tool already answer this. */
export interface TypedTool {
  readonly drawing: boolean;
  /** How many points are down, which decides whether the angle is relative or absolute. */
  readonly points: readonly unknown[];
  seed(): TypedSeed;
}

export interface TypedEntryOptions {
  /**
   * Which tool this card belongs to.
   *
   * Both drawing tools are bound when the editor starts, so both cards are in the plan at once with
   * only one of them shown. The attribute is what tells them apart — for anyone reading the DOM, and
   * for the checks that drive the editor, neither of which should be counting children.
   */
  tool: "wall" | "room";
}

/** What one segment is called, which is the only word that differs between the two cards. */
const NOUN = { wall: "wall", room: "side" } as const;

export interface TypedEntry {
  /** Put the card beside the anchor with the tool's own seed in it, or hide it when nothing is drawing. */
  show(tool: TypedTool | null, anchorScreen: { x: number; y: number } | null): void;
  hide(): void;
  /** What is in the boxes now. */
  values(): TypedSeed;
  /** True while the person is typing in one of the fields. */
  focused(): boolean;
  /** Whether a node is part of the card: a press on it belongs to the field, not to the drawing. */
  contains(node: Node | null): boolean;
  /**
   * Whether this Enter follows another with nothing changed in between, which is what ends a chain
   * (ADR-017 D4). Every edit, pointer move and placement clears it, so "Enter twice" means twice in a
   * row and not twice all evening.
   */
  repeatedEnter(): boolean;
  /** Something happened that was not an Enter: the next one places rather than ends. */
  touched(): void;
  destroy(): void;
}

export function mountTypedEntry(parent: HTMLElement, options: TypedEntryOptions): TypedEntry {
  const noun = NOUN[options.tool];
  const card = document.createElement("div");
  card.dataset.tool = options.tool;
  card.className =
    "fpv-typed-entry absolute z-10 flex flex-col gap-1 rounded-md border bg-card/95 p-2 shadow-md " +
    "text-xs text-foreground";
  card.hidden = true;
  const length = numberField("Length", "mm");
  const angle = numberField("Angle", "°");
  const note = document.createElement("p");
  note.className = "text-[11px] text-muted-foreground";
  const hint = document.createElement("p");
  hint.className = "text-[11px] text-muted-foreground";
  hint.textContent = "Enter places · Enter again ends";
  card.append(length.row, angle.row, note, hint);
  parent.append(card);

  let sinceEnter = true;
  const touched = (): void => {
    sinceEnter = true;
  };
  for (const input of [length.input, angle.input]) input.addEventListener("input", touched);

  return {
    show(tool, anchorScreen) {
      if (!tool?.drawing) {
        card.hidden = true;
        return;
      }
      const seed = tool.seed();
      // Never while it is being typed in: replacing what somebody is halfway through writing is the
      // rudest thing a form can do, and the seed is an offer rather than a correction.
      if (document.activeElement !== length.input && document.activeElement !== angle.input) {
        length.input.value = String(Math.round(seed.lengthMm));
        angle.input.value = String(Math.round(seed.angleDeg));
      }
      note.textContent =
        tool.points.length >= 2 ? `relative to the last ${noun}` : "measured from the x axis";
      // Shown before it is measured: a hidden element has no size, and the card has to know its own
      // before it can be kept inside the plan.
      card.hidden = false;
      if (anchorScreen) {
        const at = keepInside(
          anchorScreen,
          { width: card.offsetWidth, height: card.offsetHeight },
          { width: parent.clientWidth, height: parent.clientHeight },
        );
        card.style.left = `${at.x}px`;
        card.style.top = `${at.y}px`;
      }
    },
    hide() {
      // Hand the focus back before hiding. A hidden input keeps the focus it had, and the shell treats
      // a focused field as typing — so after ending a chain from the keyboard the next shortcut went
      // into an invisible box and the tool never changed. The plan is a focus region of its own
      // (tabindex 0), so this puts the keyboard exactly where the person just was.
      if (card.contains(document.activeElement)) {
        const plan = parent as HTMLElement & { focus?: () => void };
        plan.focus?.();
      }
      card.hidden = true;
    },
    values() {
      return { lengthMm: Number(length.input.value), angleDeg: Number(angle.input.value) };
    },
    focused() {
      return document.activeElement === length.input || document.activeElement === angle.input;
    },
    contains(node) {
      return node !== null && card.contains(node);
    },
    repeatedEnter() {
      const repeated = !sinceEnter;
      sinceEnter = false;
      return repeated;
    },
    touched,
    destroy() {
      for (const input of [length.input, angle.input]) input.removeEventListener("input", touched);
      card.remove();
    },
  };
}

/**
 * Where the card sits: beside the anchor, but never off the plan.
 *
 * It used to be the anchor plus a fixed offset and nothing else, so drawing anywhere near the right or
 * bottom edge pushed the card out past the plan, which clips its children — the fields were still there
 * and could not be reached with a pointer at all. Found by driving the editor rather than by reading it.
 *
 * Below and right of the anchor by preference, because that is where the eye is not: the segment being
 * drawn runs away from the anchor and the card should not sit on top of it. When there is no room that
 * side, it flips to the other rather than hanging off the edge.
 */
export function keepInside(
  anchor: { x: number; y: number },
  card: { width: number; height: number },
  bounds: { width: number; height: number },
): { x: number; y: number } {
  const GAP = 12;
  const EDGE = 4;
  let x = anchor.x + GAP;
  let y = anchor.y + GAP;
  // A plan with no measured size is one that has not been laid out yet, not one with no room in it.
  // Pinning to the corner there would move the card away from its anchor for no reason.
  if (bounds.width <= 0 || bounds.height <= 0) return { x, y };
  if (x + card.width + EDGE > bounds.width) x = anchor.x - GAP - card.width;
  if (y + card.height + EDGE > bounds.height) y = anchor.y - GAP - card.height;
  // Still outside after the flip — a card taller than the plan, or an anchor off the edge — is pinned
  // to the edge: a field that is awkwardly placed can still be used, and one off the plan cannot.
  x = Math.min(Math.max(EDGE, x), Math.max(EDGE, bounds.width - card.width - EDGE));
  y = Math.min(Math.max(EDGE, y), Math.max(EDGE, bounds.height - card.height - EDGE));
  return { x, y };
}

/**
 * A plan point already in screen pixels, put into CSS pixels.
 *
 * The plan's own transform works in device pixels, and a card positioned with style.left is placed in
 * CSS pixels; on a display where those differ the card lands at a fraction of the distance from the
 * anchor it should.
 */
export function screenOffset(at: { x: number; y: number }, dpr: number): { x: number; y: number } {
  return { x: at.x / dpr, y: at.y / dpr };
}

function numberField(name: string, unit: string): { row: HTMLElement; input: HTMLInputElement } {
  const row = document.createElement("label");
  row.className = "flex items-center gap-1.5";
  const caption = document.createElement("span");
  caption.className = "w-12 text-muted-foreground";
  caption.textContent = name;
  const input = document.createElement("input");
  input.type = "number";
  // The border and background are stated because Preflight removes both from an input; without them the
  // field is indistinguishable from the label beside it.
  input.className =
    "h-6 w-20 rounded border border-input bg-background px-1.5 text-right tabular-nums " +
    "outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
  input.setAttribute("aria-label", `${name} in ${unit === "°" ? "degrees" : unit}`);
  const suffix = document.createElement("span");
  suffix.className = "w-4 text-muted-foreground";
  suffix.textContent = unit;
  row.append(caption, input, suffix);
  return { row, input };
}

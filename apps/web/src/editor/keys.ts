// Keyboard shortcuts as data (ADR-017 D4): parsed once when a command is registered, matched against key
// events, and printed for the command palette and the shortcut list. Nothing here touches the DOM, so the
// rules are testable on their own; the shell only feeds it events.

/** A parsed shortcut. `key` is normalised: single characters lower-cased, named keys as events spell them. */
export interface Chord {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/** The parts of a KeyboardEvent a chord is matched against; a real event satisfies this. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

type ModifierField = "ctrl" | "shift" | "alt" | "meta";

const MODIFIERS: Record<string, ModifierField> = {
  ctrl: "ctrl",
  control: "ctrl",
  cmd: "meta",
  command: "meta",
  meta: "meta",
  super: "meta",
  win: "meta",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

/** Spellings people write in a shortcut string, mapped to the names KeyboardEvent.key uses. */
const NAMES: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  del: "Delete",
  delete: "Delete",
  ins: "Insert",
  insert: "Insert",
  space: " ",
  spacebar: " ",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  plus: "+",
};

/** How a chord prints, per key; anything else prints as itself, upper-cased when it is a single letter. */
const KEY_LABELS: Record<string, string> = {
  " ": "Space",
  Escape: "Esc",
  Delete: "Del",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/** One spelling per key, so "Esc", "escape" and a real event's "Escape" all compare equal. */
export function normaliseKey(key: string): string {
  if (key.length === 1) return key.toLowerCase();
  const known = NAMES[key.toLowerCase()];
  if (known) return known;
  // events spell the function keys F1..F24, so accept "f7" for the same key rather than never matching
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase();
  // Any other multi-character name (ContextMenu, AudioVolumeUp, Dead) is kept as written. That set is
  // open-ended, so a name we do not know cannot be told apart from a typo here; a misspelled MODIFIER
  // still throws in parseChord, which is where the mistakes people actually make show up.
  return key;
}

/** Reads "Ctrl+Shift+Z", "W" or "Ctrl++". Throws on an unknown modifier or a missing key: a typo in a
 *  shortcut should fail when the command is registered, not silently never fire. */
export function parseChord(text: string): Chord {
  const raw = text.split("+");
  const tokens: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const token = (raw[i] ?? "").trim();
    // an empty final segment is the plus key itself: "Ctrl++" splits to ["Ctrl", "", ""]
    if (token === "") {
      if (i > 0 && i === raw.length - 1) tokens.push("+");
      continue;
    }
    tokens.push(token);
  }
  if (!tokens.length) throw new Error(`empty shortcut ${JSON.stringify(text)}`);
  const chord: Chord = { key: "", ctrl: false, shift: false, alt: false, meta: false };
  const last = tokens.length - 1;
  for (let i = 0; i < last; i += 1) {
    const field = MODIFIERS[(tokens[i] as string).toLowerCase()];
    if (!field) throw new Error(`unknown modifier ${JSON.stringify(tokens[i])} in shortcut ${text}`);
    chord[field] = true;
  }
  const key = tokens[last] as string;
  if (MODIFIERS[key.toLowerCase()]) throw new Error(`shortcut ${text} ends with a modifier, not a key`);
  chord.key = normaliseKey(key);
  return chord;
}

/** True when the event is this shortcut. */
export function matchesChord(chord: Chord, event: KeyLike): boolean {
  if (normaliseKey(event.key) !== chord.key) return false;
  if (event.ctrlKey !== chord.ctrl) return false;
  if (event.altKey !== chord.alt) return false;
  if (event.metaKey !== chord.meta) return false;
  // punctuation already carries its own shift state ("?" is Shift+/ on most layouts), so comparing the
  // flag would stop those shortcuts ever matching. Letters, digits and named keys do compare it.
  if (chord.key.length === 1 && !/[a-z0-9]/.test(chord.key)) return true;
  return event.shiftKey === chord.shift;
}

export function chordFromEvent(event: KeyLike): Chord {
  return {
    key: normaliseKey(event.key),
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
  };
}

/** How the shortcut reads in the palette and the shortcut list. */
export function describeChord(chord: Chord, mac = false): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push(mac ? "⌃" : "Ctrl");
  if (chord.alt) parts.push(mac ? "⌥" : "Alt");
  if (chord.shift) parts.push("⇧");
  if (chord.meta) parts.push(mac ? "⌘" : "Meta");
  const key = KEY_LABELS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  parts.push(key);
  return parts.join(" ");
}

export function describeShortcut(text: string, mac = false): string {
  return describeChord(parseChord(text), mac);
}

/** The parts of an event target that decide whether a keystroke is text; a real element satisfies it. */
export interface TargetLike {
  tagName?: string | undefined;
  isContentEditable?: boolean | undefined;
  type?: string | undefined;
}

/** Where a bare letter is typing rather than a shortcut, so V and W do not change tool mid-word.
 *  Buttons and checkboxes are inputs too, but they never swallow a letter. */
export function isTypingTarget(target: TargetLike | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag !== "input") return false;
  const type = (target.type ?? "text").toLowerCase();
  return !["button", "checkbox", "radio", "range", "reset", "submit", "image", "file", "color"].includes(
    type,
  );
}

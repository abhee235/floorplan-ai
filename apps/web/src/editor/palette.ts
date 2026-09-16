// The command palette (ADR-017 D4): every command with its shortcut, which is how shortcuts stay
// discoverable. A combobox over a listbox, following the ARIA authoring practices: the input keeps focus,
// arrows move the active option through aria-activedescendant, and Enter runs it.
import type { CommandMatch, CommandRegistry } from "./commands.js";
import { describeChord } from "./keys.js";
import { rovingNext } from "./roving.js";
import { paletteSections } from "./status.js";

export interface PaletteOptions {
  /** Runs the chosen command; the shell says out loud what happened. */
  run(id: string): void;
}

export interface Palette {
  element: HTMLElement;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  /** True when the palette handled the key itself. */
  handleKey(event: KeyboardEvent): boolean;
}

let paletteSeq = 0;

export function createPalette(commands: CommandRegistry, options: PaletteOptions): Palette {
  const uid = `fpv-palette-${(paletteSeq += 1)}`;
  const backdrop = document.createElement("div");
  backdrop.className = "fpv-palette-backdrop";
  backdrop.hidden = true;

  const panel = document.createElement("div");
  panel.className = "fpv-palette";
  panel.role = "dialog";
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Commands");

  const field = document.createElement("div");
  field.className = "fpv-palette-field";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "fpv-palette-input";
  input.placeholder = "Search commands";
  input.autocomplete = "off";
  input.role = "combobox";
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", `${uid}-list`);
  input.setAttribute("aria-label", "Search commands");
  const hint = document.createElement("kbd");
  hint.className = "fpv-key";
  hint.textContent = "Esc";
  field.append(input, hint);

  const list = document.createElement("div");
  list.className = "fpv-palette-list";
  list.id = `${uid}-list`;
  list.role = "listbox";
  list.setAttribute("aria-label", "Commands");

  const foot = document.createElement("div");
  foot.className = "fpv-palette-foot";
  foot.append(
    key("↑"),
    key("↓"),
    text(" to move "),
    key("Enter"),
    text(" to run"),
    grow(),
    text("Every command, with its shortcut"),
  );

  panel.append(field, list, foot);
  backdrop.append(panel);

  let open = false;
  let active = 0;
  let rows: { id: string; element: HTMLElement; enabled: boolean }[] = [];
  let returnFocus: HTMLElement | null = null;

  const render = (): void => {
    const matches = commands.match(input.value);
    list.replaceChildren();
    rows = [];
    for (const section of paletteSections(matches)) {
      const group = document.createElement("div");
      group.role = "group";
      group.setAttribute("aria-label", section.group);
      const heading = document.createElement("p");
      heading.className = "fpv-palette-heading";
      heading.textContent = section.group;
      group.append(heading);
      for (const match of section.items) group.append(row(match));
      list.append(group);
    }
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "fpv-palette-empty";
      empty.textContent = "No command matches that.";
      list.append(empty);
    }
    setActive(0);
  };

  const row = (match: CommandMatch): HTMLElement => {
    const command = match.command;
    const element = document.createElement("div");
    const index = rows.length;
    element.className = "fpv-palette-row";
    element.id = `${uid}-opt-${index}`;
    element.role = "option";
    const enabled = command.enabled?.() ?? true;
    if (!enabled) element.setAttribute("aria-disabled", "true");

    const title = document.createElement("span");
    title.className = "fpv-palette-title";
    title.append(...marked(command.title, match.spans));
    element.append(title);

    if (command.detail) {
      const detail = document.createElement("span");
      detail.className = "fpv-palette-detail";
      detail.textContent = ` · ${command.detail}`;
      title.append(detail);
    }
    if (command.chord) {
      const shortcut = document.createElement("kbd");
      shortcut.className = "fpv-key";
      shortcut.textContent = describeChord(command.chord);
      element.append(shortcut);
    }
    element.addEventListener("pointerdown", (e) => {
      e.preventDefault(); // keep focus in the input so the palette does not close under the pointer
      choose(index);
    });
    rows.push({ id: command.id, element, enabled });
    return element;
  };

  const setActive = (index: number): void => {
    active = rows.length ? Math.min(Math.max(index, 0), rows.length - 1) : 0;
    for (let i = 0; i < rows.length; i += 1) {
      const isActive = i === active;
      const entry = rows[i];
      if (!entry) continue;
      entry.element.classList.toggle("on", isActive);
      entry.element.setAttribute("aria-selected", isActive ? "true" : "false");
    }
    const current = rows[active];
    input.setAttribute("aria-activedescendant", current ? current.element.id : "");
    current?.element.scrollIntoView({ block: "nearest" });
  };

  const choose = (index: number): void => {
    const entry = rows[index];
    if (!entry) return;
    close();
    options.run(entry.id);
  };

  const close = (): void => {
    if (!open) return;
    open = false;
    backdrop.hidden = true;
    returnFocus?.focus();
    returnFocus = null;
  };

  const openPalette = (): void => {
    if (open) return;
    const previous = document.activeElement;
    returnFocus = previous instanceof HTMLElement ? previous : null;
    open = true;
    backdrop.hidden = false;
    input.value = "";
    render();
    input.focus();
  };

  input.addEventListener("input", render);
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) close();
  });

  const handleKey = (event: KeyboardEvent): boolean => {
    if (!open) return false;
    if (event.key === "Escape") {
      close();
      return true;
    }
    if (event.key === "Enter") {
      choose(active);
      return true;
    }
    const next = rovingNext(active, event.key, { count: rows.length, orientation: "vertical" });
    if (next === null) return false;
    setActive(next);
    return true;
  };

  return {
    element: backdrop,
    get isOpen() {
      return open;
    },
    open: openPalette,
    close,
    handleKey,
  };
}

/** The command's title with the matched ranges wrapped, so the palette can show where the query landed. */
function marked(title: string, spans: readonly [number, number][]): (HTMLElement | string)[] {
  if (!spans.length) return [title];
  const out: (HTMLElement | string)[] = [];
  let at = 0;
  for (const [from, to] of spans) {
    if (from > at) out.push(title.slice(at, from));
    const mark = document.createElement("mark");
    mark.textContent = title.slice(from, to);
    out.push(mark);
    at = to;
  }
  if (at < title.length) out.push(title.slice(at));
  return out;
}

function key(label: string): HTMLElement {
  const k = document.createElement("kbd");
  k.className = "fpv-key";
  k.textContent = label;
  return k;
}

function text(value: string): HTMLElement {
  const span = document.createElement("span");
  span.textContent = value;
  return span;
}

function grow(): HTMLElement {
  const span = document.createElement("span");
  span.className = "fpv-grow";
  return span;
}

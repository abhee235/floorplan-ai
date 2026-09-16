// The editor shell (ADR-017 D1): one non-overlapping grid — app bar, tool options, then the tool rail,
// the canvas stack and the properties panel, over a status bar. Everything here is DOM; the rules it
// follows (commands, shortcuts, roving, announcements, wording) live in the modules beside it and are
// tested on their own.
import type { Project } from "@fpv/ir";
import { Announcer } from "./announce.js";
import { CommandRegistry } from "./commands.js";
import { isTypingTarget } from "./keys.js";
import { createPalette, type Palette } from "./palette.js";
import { rovingNext } from "./roving.js";
import { countsText, formatMm, type ProblemLike, pointerText, problemSummary, scaleLabel } from "./status.js";
import { checkTools, TOOLS, type ToolDefinition, type ToolId, toolById } from "./tools.js";

/** The elements the rest of the app mounts into; this is exactly what startApp asks for. */
export interface ShellSlots {
  viewport: HTMLElement;
  plan: HTMLElement;
  status: HTMLElement;
  fit: HTMLButtonElement;
  importButton: HTMLButtonElement;
  importFile: HTMLInputElement;
  review: HTMLElement;
}

export type ViewMode = "plan" | "both" | "3d";

export interface Shell {
  slots: ShellSlots;
  commands: CommandRegistry;
  announcer: Announcer;
  palette: Palette;
  tool(): ToolDefinition;
  setTool(id: ToolId): void;
  onTool(fn: (tool: ToolDefinition) => void): () => void;
  onLevel(fn: (levelId: string) => void): () => void;
  onZoom(fn: (factor: number) => void): () => void;
  setPointer(at: { x: number; y: number } | null): void;
  setSnap(text: string): void;
  setProblems(problems: readonly ProblemLike[]): void;
  setScale(pixelsPerMm: number, devicePixelRatio?: number): void;
  setProject(project: Project | null): void;
  setViewMode(mode: ViewMode): void;
  /** The current value of one of the active tool's options. */
  option(toolId: ToolId, optionId: string): string | number | boolean | undefined;
  destroy(): void;
}

export function mountShell(root: HTMLElement): Shell {
  checkTools(); // ADR-017: a tool that does not state how it is used cannot go on the rail
  const doc = root.ownerDocument;
  const shell = div("fpv-shell");
  const toolListeners = new Set<(tool: ToolDefinition) => void>();
  const levelListeners = new Set<(levelId: string) => void>();
  const zoomListeners = new Set<(factor: number) => void>();
  const optionValues = new Map<string, string | number | boolean>();
  for (const tool of TOOLS)
    for (const option of tool.options) optionValues.set(`${tool.id}.${option.id}`, option.value);

  // ---- app bar ----------------------------------------------------------
  const appBar = doc.createElement("header");
  appBar.className = "fpv-app-bar";
  const projectName = span("fpv-project-name", "floorplan-viz");
  const levelSelect = doc.createElement("select");
  levelSelect.className = "fpv-select";
  levelSelect.setAttribute("aria-label", "Level");
  levelSelect.addEventListener("change", () => {
    for (const fn of levelListeners) fn(levelSelect.value);
    const name = levelSelect.selectedOptions[0]?.textContent ?? levelSelect.value;
    announcer.say(`Level ${name}.`);
  });
  const undoButton = button("fpv-chip", "Undo", "edit.undo");
  const redoButton = button("fpv-chip", "Redo", "edit.redo");
  const viewSwitch = div("fpv-segmented");
  viewSwitch.role = "radiogroup";
  viewSwitch.setAttribute("aria-label", "What is on screen");
  const importButton = button("fpv-chip", "Import plan…");
  const importFile = doc.createElement("input");
  importFile.type = "file";
  importFile.accept = ".dxf,.dwg,.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp";
  importFile.hidden = true;
  const exportButton = button("fpv-chip fpv-primary", "Export", "file.export");
  appBar.append(
    projectName,
    dot(),
    label("Level", levelSelect),
    group([undoButton, redoButton], "History"),
    grow(),
    viewSwitch,
    importButton,
    importFile,
    exportButton,
  );

  // ---- tool options bar -------------------------------------------------
  const optionsBar = div("fpv-tool-options");
  optionsBar.role = "toolbar";
  optionsBar.setAttribute("aria-label", "Settings for the active tool");
  const optionsTitle = span("fpv-tool-title", "");
  const optionsFields = div("fpv-tool-fields");
  const modifiersNote = span("fpv-muted", "");
  optionsBar.append(optionsTitle, rule(), optionsFields, grow(), modifiersNote);

  // ---- tool rail --------------------------------------------------------
  const rail = div("fpv-rail");
  rail.role = "toolbar";
  rail.setAttribute("aria-orientation", "vertical");
  rail.setAttribute("aria-label", "Tools");
  const railButtons = new Map<ToolId, HTMLButtonElement>();
  TOOLS.forEach((tool, index) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "fpv-rail-button";
    b.dataset.tool = tool.id;
    b.tabIndex = index === 0 ? 0 : -1; // one tab stop for the whole rail
    b.setAttribute("aria-pressed", "false");
    b.title = `${tool.title} (${tool.shortcut})`;
    b.setAttribute("aria-label", `${tool.title}, ${tool.shortcut}`);
    b.innerHTML = TOOL_ICONS[tool.id];
    b.addEventListener("click", () => setTool(tool.id));
    railButtons.set(tool.id, b);
    if (tool.id === "pan") rail.append(rule("fpv-rail-rule"));
    rail.append(b);
  });
  rail.addEventListener("keydown", (e) => {
    const ids = TOOLS.map((t) => t.id);
    const current = ids.indexOf((doc.activeElement as HTMLElement | null)?.dataset?.tool as ToolId);
    const next = rovingNext(current < 0 ? 0 : current, e.key, {
      count: ids.length,
      orientation: "vertical",
    });
    if (next === null) return;
    e.preventDefault();
    const id = ids[next];
    if (!id) return;
    for (const [toolId, b] of railButtons) b.tabIndex = toolId === id ? 0 : -1;
    railButtons.get(id)?.focus();
  });

  // ---- canvas stack -----------------------------------------------------
  const stack = div("fpv-stack");
  const planWrap = div("fpv-plan-wrap");
  const plan = div("fpv-plan");
  plan.id = "plan";
  plan.tabIndex = 0;
  plan.role = "application";
  plan.setAttribute("aria-label", "Plan. Press Enter to work inside it, Escape to leave.");
  const review = doc.createElement("aside");
  review.id = "review";
  review.hidden = true;
  plan.append(review);

  const zoomCluster = div("fpv-zoom");
  const zoomOut = button("fpv-icon-button", "−");
  zoomOut.setAttribute("aria-label", "Zoom out");
  const scaleReadout = span("fpv-scale", "—");
  scaleReadout.setAttribute("aria-label", "Drawing scale");
  const zoomIn = button("fpv-icon-button", "+");
  zoomIn.setAttribute("aria-label", "Zoom in");
  const fit = button("fpv-icon-button", "Fit");
  fit.setAttribute("aria-label", "Fit the plan to the window");
  zoomOut.addEventListener("click", () => {
    for (const fn of zoomListeners) fn(1 / 1.15);
  });
  zoomIn.addEventListener("click", () => {
    for (const fn of zoomListeners) fn(1.15);
  });
  zoomCluster.append(zoomOut, scaleReadout, zoomIn, rule(), fit);
  planWrap.append(plan, zoomCluster);

  const dock = div("fpv-dock");
  const viewport = div("fpv-viewport");
  viewport.id = "viewport";
  dock.append(viewport);
  stack.append(planWrap, dock);

  // ---- properties panel -------------------------------------------------
  const properties = doc.createElement("aside");
  properties.className = "fpv-properties";
  properties.setAttribute("aria-label", "Properties");
  const propsBody = div("fpv-properties-body");
  const selectionHeading = doc.createElement("p");
  selectionHeading.className = "fpv-section-heading";
  selectionHeading.textContent = "Nothing selected";
  const selectionHelp = doc.createElement("p");
  selectionHelp.className = "fpv-muted";
  selectionHelp.textContent =
    "Click an entity in the plan, or press Tab to step through them. These settings apply to the level.";
  const levelFields = div("fpv-fields");
  const countsHeading = doc.createElement("p");
  countsHeading.className = "fpv-section-heading";
  countsHeading.textContent = "This level";
  const counts = doc.createElement("p");
  counts.className = "fpv-muted";
  counts.textContent = countsText(null);
  propsBody.append(selectionHeading, selectionHelp, levelFields, countsHeading, counts);
  properties.append(propsBody);

  const body = div("fpv-body");
  body.append(rail, stack, properties);

  // ---- status bar -------------------------------------------------------
  const statusBar = doc.createElement("footer");
  statusBar.className = "fpv-status-bar";
  const pointerSlot = span("fpv-numeric", "");
  const snapSlot = span("", "");
  const problemSlot = span("fpv-ok", "No problems");
  const activity = span("fpv-activity", "connecting…");
  activity.id = "status";
  const paletteHint = span("fpv-muted", "");
  paletteHint.append(doc.createTextNode("Press "), kbd("Ctrl K"), doc.createTextNode(" for commands"));
  statusBar.append(pointerSlot, snapSlot, problemSlot, grow(), activity, paletteHint);

  // ---- live regions (ADR-017 D5) ----------------------------------------
  const politeRegion = div("fpv-sr-only");
  politeRegion.setAttribute("aria-live", "polite");
  politeRegion.setAttribute("aria-atomic", "true");
  const assertiveRegion = div("fpv-sr-only");
  assertiveRegion.setAttribute("aria-live", "assertive");
  assertiveRegion.setAttribute("aria-atomic", "true");
  const announcer = new Announcer(
    { polite: politeRegion, assertive: assertiveRegion },
    { defer: (flush) => requestAnimationFrame(flush) },
  );

  const commands = new CommandRegistry();
  const palette = createPalette(commands, {
    run: (id) => {
      void runCommand(id);
    },
  });

  shell.append(appBar, optionsBar, body, statusBar, politeRegion, assertiveRegion, palette.element);
  root.append(shell);

  // ---- tools ------------------------------------------------------------
  let activeTool: ToolId = "select";

  const renderOptions = (): void => {
    const tool = toolById(activeTool) as ToolDefinition;
    optionsTitle.textContent = tool.title;
    modifiersNote.textContent = tool.modifiers;
    optionsFields.replaceChildren();
    for (const option of tool.options) {
      const key = `${tool.id}.${option.id}`;
      const value = optionValues.get(key);
      if (option.kind === "toggle") {
        const input = doc.createElement("input");
        input.type = "checkbox";
        input.checked = value === true;
        input.addEventListener("change", () => optionValues.set(key, input.checked));
        optionsFields.append(label(option.label, input, "fpv-inline-label"));
      } else if (option.kind === "number") {
        const input = doc.createElement("input");
        input.type = "number";
        input.className = "fpv-number";
        input.value = String(value ?? "");
        input.addEventListener("change", () => optionValues.set(key, Number(input.value)));
        optionsFields.append(label(`${option.label}${option.unit ? ` (${option.unit})` : ""}`, input));
      } else {
        const select = doc.createElement("select");
        select.className = "fpv-select";
        for (const choice of option.choices ?? []) {
          const o = doc.createElement("option");
          o.value = choice.value;
          o.textContent = choice.label;
          select.append(o);
        }
        select.value = String(value ?? "");
        select.addEventListener("change", () => optionValues.set(key, select.value));
        optionsFields.append(label(option.label, select));
      }
    }
  };

  const setTool = (id: ToolId): void => {
    const tool = toolById(id);
    if (!tool || tool.id === activeTool) return;
    activeTool = tool.id;
    for (const [toolId, b] of railButtons) {
      const on = toolId === tool.id;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
    renderOptions();
    plan.dataset.tool = tool.id;
    announcer.say(`${tool.title}. ${tool.keyboard}.`);
    for (const fn of toolListeners) fn(tool);
  };

  // ---- commands the shell itself owns ------------------------------------
  const runCommand = async (id: string): Promise<void> => {
    const outcome = await commands.run(id);
    if (outcome === "disabled") announcer.alert(`${commands.get(id)?.title ?? id} does not apply just now.`);
  };

  for (const tool of TOOLS)
    commands.add({
      id: `tool.${tool.id}`,
      title: tool.title,
      group: "Tools",
      shortcut: tool.shortcut,
      detail: tool.summary,
      run: () => setTool(tool.id),
    });
  commands.add({
    id: "view.commands",
    title: "Show all commands",
    group: "View",
    shortcut: "Ctrl+K",
    run: () => palette.open(),
  });
  commands.add({
    id: "view.shortcuts",
    title: "Keyboard shortcuts",
    group: "View",
    shortcut: "?",
    run: () => palette.open(),
  });

  // ---- keys -------------------------------------------------------------
  const onKeyDown = (event: KeyboardEvent): void => {
    if (palette.handleKey(event)) {
      event.preventDefault();
      return;
    }
    if (palette.isOpen) return;
    const target = event.target as HTMLElement | null;
    const bare = !event.ctrlKey && !event.metaKey && !event.altKey;
    if (bare && isTypingTarget(target)) return;
    // Space and Enter belong to whatever control has focus, not to a tool shortcut
    if (bare && (event.key === " " || event.key === "Enter") && isControl(target)) return;
    if (event.key === "Escape" && activeTool !== "select") {
      event.preventDefault();
      setTool("select");
      return;
    }
    const command = commands.forKey(event);
    if (!command) return;
    event.preventDefault();
    void runCommand(command.id);
  };
  doc.addEventListener("keydown", onKeyDown);

  // Tab must not fall through the rail's hidden buttons; the plan is one stop of its own.
  const setViewMode = (mode: ViewMode): void => {
    stack.dataset.view = mode;
    for (const b of viewSwitch.children)
      if (b instanceof HTMLElement)
        b.setAttribute("aria-checked", b.dataset.view === mode ? "true" : "false");
    // the canvases size themselves from their container, which just changed
    root.ownerDocument.defaultView?.dispatchEvent(new Event("resize"));
  };
  for (const [mode, text] of [
    ["plan", "Plan"],
    ["both", "Plan + 3D"],
    ["3d", "3D"],
  ] as [ViewMode, string][]) {
    const b = button("fpv-chip", text);
    b.role = "radio";
    b.dataset.view = mode;
    b.addEventListener("click", () => setViewMode(mode));
    viewSwitch.append(b);
  }

  setTool("wall");
  setTool("select"); // render the options bar once through the normal path
  setViewMode("both");

  return {
    slots: { viewport, plan, status: activity, fit, importButton, importFile, review },
    commands,
    announcer,
    palette,
    tool: () => toolById(activeTool) as ToolDefinition,
    setTool,
    onTool: (fn) => {
      toolListeners.add(fn);
      return () => toolListeners.delete(fn);
    },
    onLevel: (fn) => {
      levelListeners.add(fn);
      return () => levelListeners.delete(fn);
    },
    onZoom: (fn) => {
      zoomListeners.add(fn);
      return () => zoomListeners.delete(fn);
    },
    setPointer: (at) => {
      pointerSlot.textContent = pointerText(at);
    },
    setSnap: (text) => {
      snapSlot.textContent = text;
    },
    setProblems: (problems) => {
      const summary = problemSummary(problems);
      problemSlot.textContent = summary.text;
      problemSlot.className = summary.tone === "ok" ? "fpv-ok" : `fpv-${summary.tone}`;
    },
    setScale: (pixelsPerMm, dpr) => {
      scaleReadout.textContent = scaleLabel(pixelsPerMm, dpr ?? 1);
    },
    setProject: (project) => {
      projectName.textContent = project?.meta.name ?? "floorplan-viz";
      counts.textContent = countsText(project);
      const levels = [...(project?.levels ?? [])].sort((a, b) => a.index - b.index);
      const chosen = levelSelect.value;
      levelSelect.replaceChildren();
      for (const level of levels) {
        const option = doc.createElement("option");
        option.value = level.id;
        option.textContent = level.name;
        levelSelect.append(option);
      }
      if (levels.some((l) => l.id === chosen)) levelSelect.value = chosen;
      const level = levels.find((l) => l.id === levelSelect.value) ?? levels[0];
      levelFields.replaceChildren();
      if (level) {
        levelFields.append(
          readOnlyField("Name", level.name),
          readOnlyField("Elevation", `${formatMm(level.elevation)} mm`),
          readOnlyField("Height", `${formatMm(level.height)} mm`),
          readOnlyField("Floor", `${formatMm(level.floorThickness)} mm`),
        );
      }
    },
    setViewMode,
    option: (toolId, optionId) => optionValues.get(`${toolId}.${optionId}`),
    destroy: () => {
      doc.removeEventListener("keydown", onKeyDown);
      shell.remove();
    },
  };
}

/** Controls for which Space or Enter means "activate me", not "run a shortcut". */
function isControl(target: HTMLElement | null): boolean {
  if (!target) return false;
  const tag = target.tagName.toLowerCase();
  return (
    ["button", "a", "select", "input", "textarea", "summary", "option"].includes(tag) ||
    target.role === "button"
  );
}

// ---- small DOM helpers ---------------------------------------------------

function div(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

function button(className: string, text: string, describedBy?: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.textContent = text;
  if (describedBy) el.dataset.command = describedBy;
  return el;
}

function kbd(text: string): HTMLElement {
  const el = document.createElement("kbd");
  el.className = "fpv-key";
  el.textContent = text;
  return el;
}

function label(text: string, control: HTMLElement, className = "fpv-field"): HTMLLabelElement {
  const el = document.createElement("label");
  el.className = className;
  el.append(span("", text), control);
  return el;
}

function readOnlyField(name: string, value: string): HTMLElement {
  const row = div("fpv-field");
  const input = document.createElement("input");
  input.className = "fpv-number";
  input.value = value;
  input.readOnly = true;
  row.append(span("", name), input);
  return row;
}

function group(children: HTMLElement[], ariaLabel: string): HTMLElement {
  const el = div("fpv-group");
  el.role = "group";
  el.setAttribute("aria-label", ariaLabel);
  el.append(...children);
  return el;
}

function grow(): HTMLElement {
  return div("fpv-grow");
}

function dot(): HTMLElement {
  return span("fpv-dot", "·");
}

function rule(className = "fpv-rule"): HTMLElement {
  return div(className);
}

/** Line icons at 18 px, drawn to match the design canvas. */
const TOOL_ICONS: Record<ToolId, string> = {
  select: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M5 3l14 8-6 1.6L10 19z"/></svg>`,
  wall: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 15h18M3 9h18" stroke-linecap="round"/><path d="M8 9v6M16 9v6"/></svg>`,
  room: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v14H4z"/><path d="M4 12h8v7"/></svg>`,
  opening: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 12h5M16 12h5" stroke-linecap="round"/><path d="M8 12a8 8 0 0 1 8 0"/><path d="M8 12v-6"/></svg>`,
  item: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h16v9H4z"/><path d="M7 9V6h10v3"/></svg>`,
  measure: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M3 14l11-11 7 7-11 11z"/><path d="M8 9l2 2M11 6l2 2M5 12l2 2"/></svg>`,
  annotate: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M5 6h14M12 6v13M9 19h6"/></svg>`,
  pan: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11m0-1.5a1.5 1.5 0 0 1 3 0V12m0-1a1.5 1.5 0 0 1 3 0v4a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5v-3a1.5 1.5 0 0 1 3 0"/></svg>`,
};

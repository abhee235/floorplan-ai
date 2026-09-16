// The editor shell (ADR-017 D1, ADR-018 D1): one non-overlapping grid, rendered by React, with the plan
// canvases and the three.js viewport mounted into refs and left entirely to the imperative code that
// already owns them. React never re-renders the canvas; it only renders the chrome around it.

import { Maximize2, Minus, Plus } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Layout, LayoutChangedMeta } from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { TooltipProvider } from "@/components/ui/tooltip";
import { startApp } from "../app.js";
import { drawCompass } from "../plan/compass.js";
import { AppBar } from "./AppBar.js";
import { Announcer } from "./announce.js";
import { CommandPalette } from "./CommandPalette.js";
import { CommandRegistry } from "./commands.js";
import { isTypingTarget } from "./keys.js";
import { PropertiesPanel } from "./PropertiesPanel.js";
import { StatusBar } from "./StatusBar.js";
import { scaleLabel } from "./status.js";
import { ToolOptionsBar } from "./ToolOptionsBar.js";
import { ToolRail } from "./ToolRail.js";
import {
  checkTools,
  phraseText,
  TOOLS,
  type ToolDefinition,
  type ToolId,
  toolById,
  toolReady,
} from "./tools.js";
import { type Editor, EditorContext, type ViewMode } from "./useEditor.js";
import { bindWallDrawing } from "./wall-drawing.js";

type OptionValues = Record<string, string | number | boolean>;

const initialOptions = (): OptionValues => {
  const values: OptionValues = {};
  for (const tool of TOOLS) for (const o of tool.options) values[`${tool.id}.${o.id}`] = o.value;
  return values;
};

export function EditorShell(): JSX.Element {
  checkTools(); // ADR-017: a tool that does not say how it is used cannot go on the rail

  const planRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLElement>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  const fitRef = useRef<HTMLButtonElement>(null);
  const activityRef = useRef<HTMLSpanElement>(null);
  const politeRef = useRef<HTMLDivElement>(null);
  const assertiveRef = useRef<HTMLDivElement>(null);

  const [toolId, setToolId] = useState<ToolId>("select");
  const [view, setView] = useState<ViewMode>("both");
  const [options, setOptions] = useState<OptionValues>(initialOptions);
  const [snap, setSnap] = useState("");
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [scale, setScale] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [level, setLevel] = useState<string | null>(null);
  const [app, setApp] = useState<ReturnType<typeof startApp> | null>(null);

  const commands = useMemo(() => new CommandRegistry(), []);

  // The announcer writes into the two live regions, which React owns. Proxying through the refs lets it
  // be built before they exist, and keeps its coalescing rules (ADR-017 D5) exactly as they were tested.
  const announcer = useMemo(
    () =>
      new Announcer(
        {
          polite: region(politeRef),
          assertive: region(assertiveRef),
        },
        { defer: (flush) => requestAnimationFrame(flush) },
      ),
    [],
  );

  // Non-React code reads the newest tool and options through refs, so it never closes over a stale render.
  const toolRef = useRef(toolId);
  toolRef.current = toolId;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const tool = (toolById(toolId) ?? TOOLS[0]) as ToolDefinition;

  const setTool = useCallback(
    (id: ToolId) => {
      const next = toolById(id);
      if (!next) return;
      setToolId(next.id);
      announcer.say(
        // phraseText, not the Phrase itself: keyboard is an array of parts now, and interpolating it
        // straight into the template would announce "[object Object]" to a screen reader without any
        // type error to catch it.
        toolReady(next)
          ? `${next.title}. ${phraseText(next.keyboard)}.`
          : `${next.title}. Not built yet, so the plan will not answer.`,
      );
    },
    [announcer],
  );

  const setOption = useCallback((t: ToolId, id: string, value: string | number | boolean) => {
    setOptions((prev) => ({ ...prev, [`${t}.${id}`]: value }));
  }, []);

  const editor: Editor = {
    commands,
    announcer,
    tool,
    setTool,
    view,
    setView,
    option: (t, id) => options[`${t}.${id}`],
    setOption,
    openPalette: () => setPaletteOpen(true),
    snap,
    setSnap,
    pointer,
    setPointer,
    scale,
    setScale,
  };

  // ---- the imperative app, started once the refs exist -------------------
  useEffect(() => {
    const plan = planRef.current;
    const viewport = viewportRef.current;
    const review = reviewRef.current;
    const activity = activityRef.current;
    const fit = fitRef.current;
    if (!plan || !viewport || !review || !activity || !fit) return;

    const started = startApp({
      viewport,
      plan,
      status: activity,
      fit,
      review,
      ...(importFileRef.current ? { importFile: importFileRef.current } : {}),
    });
    setApp(started);
    setLevel(started.plan.level);
    return () => {
      started.client.close();
      started.destroy(); // the size observer outlives the socket otherwise, one leak per remount
    };
  }, []);

  // ---- everything that used to live in main.ts ---------------------------
  useEffect(() => {
    if (!app) return;
    const { client, plan, replica, review } = app;

    let pending = false;
    const redraw = (): void => {
      plan.invalidateOverlay();
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        plan.flush();
      });
    };

    const wallDrawing = bindWallDrawing({
      plan,
      element: planRef.current as HTMLElement,
      announcer,
      project: () => replica.project,
      settings: () => ({
        thickness: Number(optionsRef.current["wall.thickness"] ?? 100),
        kind: String(optionsRef.current["wall.kind"] ?? "interior"),
        magnetism: optionsRef.current["wall.snapWalls"] !== false,
      }),
      active: () => toolRef.current === "wall",
      send: async (command) => {
        // the bridge resolves with a result either way, so a refusal has to be read out of it rather
        // than caught: without this a rejected command still announced that the walls had been drawn
        const result = await client.command(command);
        if (!result.ok)
          throw new Error(
            result.error
              ? `${result.error.message}${result.error.hint ? ` (${result.error.hint})` : ""}`
              : "the host refused the command",
          );
      },
      redraw,
      status: setSnap,
    });

    // One overlay painter: the draft review panel, the wall preview and the compass all draw over the
    // plan. setOverlayExtra takes a single function, so anything new joins this composition rather than
    // replacing it — registering a second painter would silently drop the first.
    plan.setOverlayExtra((ctx, view2) => {
      review.draw(ctx, view2);
      wallDrawing.draw(ctx, view2);
      const north = replica.project?.meta.north;
      if (north !== undefined) drawCompass(ctx, view2, north);
    });

    commands.add(
      {
        id: "edit.undo",
        title: "Undo",
        group: "Edit",
        shortcut: "Ctrl+Z",
        enabled: () => replica.historyPosition >= 0,
        run: async () => {
          await client.undo();
          announcer.say("Undone.");
        },
      },
      {
        id: "edit.redo",
        title: "Redo",
        group: "Edit",
        shortcut: "Ctrl+Shift+Z",
        run: async () => {
          await client.redo();
          announcer.say("Redone.");
        },
      },
      {
        id: "edit.selectNone",
        title: "Select nothing",
        group: "Edit",
        enabled: () => replica.selection.length > 0,
        run: async () => {
          await client.select([]);
          announcer.say("Selection cleared.");
        },
      },
      {
        id: "view.fit",
        title: "Fit the plan to the window",
        group: "View",
        shortcut: "F",
        run: () => {
          plan.fit();
          announcer.say("Plan fitted to the window.");
        },
      },
      { id: "view.plan", title: "Show the plan only", group: "View", run: () => setView("plan") },
      { id: "view.both", title: "Show the plan and the 3D view", group: "View", run: () => setView("both") },
      { id: "view.3d", title: "Show the 3D view only", group: "View", run: () => setView("3d") },
      {
        id: "file.import",
        title: "Import plan…",
        group: "File",
        detail: "a DXF, a PDF or an image",
        run: () => importFileRef.current?.click(),
      },
    );
    for (const t of TOOLS)
      commands.add({
        id: `tool.${t.id}`,
        title: t.title,
        group: "Tools",
        shortcut: t.shortcut,
        detail: t.summary,
        run: () => setTool(t.id),
      });
    commands.add({
      id: "view.commands",
      title: "Show all commands",
      group: "View",
      shortcut: "Ctrl+K",
      run: () => setPaletteOpen(true),
    });

    const unsubscribe = replica.subscribe(() => {
      setScale(plan.view.scale);
      setLevel(plan.level);
    });
    setScale(plan.view.scale);
    return () => {
      unsubscribe();
      wallDrawing.destroy();
    };
  }, [app, announcer, commands, setTool]);

  // Leaving the wall tool ends the chain rather than abandoning it half drawn (W-090); Escape returns to
  // select from anywhere, and is never treated as typing (ADR-017 D2).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (paletteOpen) return;
      const target = event.target as HTMLElement | null;
      const bare = !event.ctrlKey && !event.metaKey && !event.altKey;
      if (bare && event.key !== "Escape" && isTypingTarget(target)) return;
      if (bare && (event.key === " " || event.key === "Enter") && isControl(target)) return;
      if (event.key === "Escape" && toolRef.current !== "select") {
        event.preventDefault();
        setTool("select");
        return;
      }
      const command = commands.forKey(event);
      if (!command) return;
      event.preventDefault();
      void commands.run(command.id);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [commands, paletteOpen, setTool]);

  const replica = app?.replica ?? null;

  return (
    <EditorContext.Provider value={editor}>
      <TooltipProvider delayDuration={400}>
        {/* tracks match the bars: app bar h-10, tool options h-9, status h-7 */}
        <div className="grid h-full grid-rows-[40px_36px_minmax(0,1fr)_28px] bg-background text-foreground">
          {replica ? (
            <AppBar
              replica={replica}
              level={level}
              onLevel={(id) => {
                app?.plan.setLevel(id);
                setLevel(id);
              }}
              onImport={() => importFileRef.current?.click()}
            />
          ) : (
            <header className="flex h-10 items-center border-b bg-card px-3">
              <strong className="font-semibold">floorplan-viz</strong>
            </header>
          )}

          <ToolOptionsBar />

          {/* columns match the rail (w-12) and the properties panel (w-72) */}
          <div className="grid min-h-0 grid-cols-[48px_minmax(0,1fr)_288px]">
            <ToolRail />

            {/* The panes are written once and mounted into whichever container the view mode asks for.
                They must not be duplicated per branch: planRef and viewportRef are handed to imperative
                code that appends canvases to them, and a second copy would take the ref on mount and
                leave the first holding a detached node.

                Only "both" gets the splitter. react-resizable-panels lays out in percentages, so it has
                no way to express "this pane is collapsed to nothing" that is as honest as simply not
                rendering the group — the single-pane modes keep the grid they already had. */}
            {(() => {
              // h-full, because these panes are flex children now rather than grid tracks. A grid track
              // stretched them for free; a flex item does not, so without it the wrapper collapsed to
              // zero and took the canvas host down with it.
              const planPane = (
                <div className={`relative h-full min-h-0 overflow-hidden ${view === "3d" ? "hidden" : ""}`}>
                  <div
                    ref={planRef}
                    id="plan"
                    tabIndex={0}
                    role="application"
                    aria-label="Plan. Press Enter to work inside it, Escape to leave."
                    data-tool={toolId}
                    className="relative h-full w-full touch-none overflow-hidden bg-[#fbfaf7]"
                  >
                    <aside ref={reviewRef} id="review" hidden />
                  </div>
                  <div className="absolute right-3 bottom-3 flex items-center gap-1 rounded-md border bg-card/95 p-1 shadow-sm">
                    {/* Icons rather than the "−" and "+" characters these used to be: a minus sign and a
                        plus sign come from the font and so carry its own weight and metrics, which at this
                        size did not match anything else in the chrome. */}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Zoom out"
                      onClick={() => zoom(app, 1 / 1.15)}
                    >
                      <Minus aria-hidden />
                    </Button>
                    <span className="min-w-11 text-center text-xs tabular-nums text-muted-foreground">
                      {scaleLabel(scale, Math.min(2, window.devicePixelRatio))}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Zoom in"
                      onClick={() => zoom(app, 1.15)}
                    >
                      <Plus aria-hidden />
                    </Button>
                    <Button ref={fitRef} variant="ghost" size="xs" aria-label="Fit the plan to the window">
                      <Maximize2 aria-hidden />
                      Fit
                    </Button>
                  </div>
                </div>
              );
              const viewPane = (
                <div
                  className={`relative h-full min-h-0 overflow-hidden ${view === "plan" ? "hidden" : ""}`}
                  data-pane="3d"
                >
                  <div ref={viewportRef} id="viewport" className="h-full w-full overflow-hidden" />
                </div>
              );

              if (view !== "both")
                return (
                  <div
                    className={
                      view === "plan"
                        ? "grid min-h-0 grid-rows-[minmax(0,1fr)_0]"
                        : "grid min-h-0 grid-rows-[0_minmax(0,1fr)]"
                    }
                  >
                    {planPane}
                    {viewPane}
                  </div>
                );

              return (
                // `orientation`, not `direction`: v4 renamed it, and it is what the handle's own
                // aria-[orientation=vertical] styling keys off.
                //
                // The sizes are STRINGS on purpose. v4 reads a bare number as PIXELS and a unitless
                // string as a percentage, so defaultSize={72} would ask for a 72-pixel plan above a
                // 28-pixel 3D view — the exact complaint this change exists to fix.
                <ResizablePanelGroup
                  id="fpv.planVsView"
                  orientation="vertical"
                  defaultLayout={savedLayout()}
                  onLayoutChanged={saveLayout}
                >
                  <ResizablePanel id={PLAN_PANEL} defaultSize="72" minSize="20" className="relative min-h-0">
                    {planPane}
                  </ResizablePanel>
                  {/* The handle is a real separator: focusable, with arrow keys, because a divider that
                      only answers to a drag is a divider a keyboard cannot move. */}
                  <ResizableHandle withHandle aria-label="Resize the plan and the 3D view" />
                  <ResizablePanel id={VIEW_PANEL} defaultSize="28" minSize="10" className="relative min-h-0">
                    {viewPane}
                  </ResizablePanel>
                </ResizablePanelGroup>
              );
            })()}

            {replica ? <PropertiesPanel replica={replica} level={level} /> : <aside className="border-l" />}
          </div>

          {/* Never behind a branch: the app writes its activity line into activityRef, and swapping this
              subtree when the project arrives would reconcile that span away and leave the app writing
              into a node that is no longer on screen. */}
          <StatusBar replica={replica} activityRef={activityRef} />
        </div>

        <input
          ref={importFileRef}
          type="file"
          hidden
          accept=".dxf,.dwg,.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp"
        />
        <div ref={politeRef} aria-live="polite" aria-atomic="true" className="sr-only" />
        <div ref={assertiveRef} aria-live="assertive" aria-atomic="true" className="sr-only" />

        <CommandPalette
          commands={commands}
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          onRun={(id) => void commands.run(id)}
        />
      </TooltipProvider>
    </EditorContext.Provider>
  );
}

// Remembering where the divider was left. v4 dropped `autoSaveId`, so this is ours to do: `defaultLayout`
// in, `onLayoutChanged` out.
//
// A Layout is keyed BY PANEL ID, not an ordered pair, which is why both panels below are given explicit
// ids. GroupProps says id "falls back to useId when not provided", and a useId value is not stable across
// reloads — a layout saved under those keys would restore nothing at all, silently.
// The panel ids are NOT "plan" and "view", and that is not cosmetic. react-resizable-panels stamps a
// panel's id onto its own wrapper div, so `id="plan"` put a second element with that id in the document —
// above the real #plan that hosts the canvases. document.querySelector("#plan") then returned the panel,
// which resizes happily, while the actual canvas host sat at height 0 and every buffer kept the `|| 300`
// fallback. The plan drew into a 300px buffer stretched over its real height and the grid vanished.
//
// The key moves to v2 with them: a layout persisted under the old ids would restore nothing.
const LAYOUT_KEY = "fpv.planVsView.v2";
const PLAN_PANEL = "pane-plan";
const VIEW_PANEL = "pane-view";

function savedLayout(): Layout | undefined {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    // Both panels must be present and positive, or the value is treated as absent rather than trusted:
    // a corrupt entry would collapse a pane, and a pane you cannot see is hard to work out how to recover.
    const entries = Object.entries(parsed as Record<string, unknown>);
    const ok =
      entries.length === 2 &&
      [PLAN_PANEL, VIEW_PANEL].every((id) => {
        const v = (parsed as Record<string, unknown>)[id];
        return typeof v === "number" && Number.isFinite(v) && v > 0;
      });
    return ok ? (parsed as Layout) : undefined;
  } catch {
    return undefined;
  }
}

function saveLayout(layout: Layout, meta: LayoutChangedMeta): void {
  // Only a real drag or key press. isUserInteraction is false for the initial mount, for constraint
  // recomputes and for default-size changes, and writing on those would overwrite a split someone chose
  // with a transient computed one the first time the window resized.
  if (!meta.isUserInteraction) return;
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // A split that does not survive a reload is a much smaller problem than a crash on every drag.
  }
}

function zoom(app: ReturnType<typeof startApp> | null, factor: number): void {
  if (!app) return;
  app.plan.zoomAt(app.plan.view.width / 2, app.plan.view.height / 2, factor);
}

/** Controls for which Space or Enter means "activate me", not "run a shortcut". */
function isControl(target: HTMLElement | null): boolean {
  if (!target) return false;
  const tag = target.tagName.toLowerCase();
  return ["button", "a", "select", "input", "textarea", "summary", "option"].includes(tag);
}

/** A live region that reads and writes through a ref, so the announcer can exist before the DOM does. */
function region(ref: { current: HTMLElement | null }): { textContent: string | null } {
  return {
    get textContent() {
      return ref.current?.textContent ?? "";
    },
    set textContent(value: string | null) {
      if (ref.current) ref.current.textContent = value;
    },
  };
}

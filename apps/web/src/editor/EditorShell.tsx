// The editor shell (ADR-017 D1, ADR-018 D1): one non-overlapping grid, rendered by React, with the plan
// canvases and the three.js viewport mounted into refs and left entirely to the imperative code that
// already owns them. React never re-renders the canvas; it only renders the chrome around it.

import { Maximize2, Minus, Plus } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { startApp } from "../app.js";
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
import { checkTools, TOOLS, type ToolDefinition, type ToolId, toolById, toolReady } from "./tools.js";
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
        toolReady(next)
          ? `${next.title}. ${next.keyboard}.`
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
    return () => started.client.close();
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

    // One overlay painter: the draft review panel and the wall preview both draw over the plan.
    plan.setOverlayExtra((ctx, view2) => {
      review.draw(ctx, view2);
      wallDrawing.draw(ctx, view2);
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

            <div
              className={
                view === "plan"
                  ? "grid min-h-0 grid-rows-[minmax(0,1fr)_0]"
                  : view === "3d"
                    ? "grid min-h-0 grid-rows-[0_minmax(0,1fr)]"
                    : "grid min-h-0 grid-rows-[minmax(0,1fr)_232px]"
              }
            >
              <div className={`relative min-h-0 overflow-hidden ${view === "3d" ? "hidden" : ""}`}>
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
                  <Button variant="ghost" size="icon-xs" aria-label="Zoom in" onClick={() => zoom(app, 1.15)}>
                    <Plus aria-hidden />
                  </Button>
                  <Button ref={fitRef} variant="ghost" size="xs" aria-label="Fit the plan to the window">
                    <Maximize2 aria-hidden />
                    Fit
                  </Button>
                </div>
              </div>

              <div className={`relative min-h-0 overflow-hidden border-t ${view === "plan" ? "hidden" : ""}`}>
                <div ref={viewportRef} id="viewport" className="h-full w-full overflow-hidden" />
              </div>
            </div>

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

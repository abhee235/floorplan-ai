// The editor shell (ADR-017 D1, ADR-018 D1): one non-overlapping grid, rendered by React, with the plan
// canvases and the three.js viewport mounted into refs and left entirely to the imperative code that
// already owns them. React never re-renders the canvas; it only renders the chrome around it.

import { Maximize2, Minus, Plus } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Layout, LayoutChangedMeta } from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CLIENT_VERSION, startApp } from "../app.js";
import type { BridgeClient } from "../bridge/client.js";
import { drawCompass } from "../plan/compass.js";
import { AppBar } from "./AppBar.js";
import { Announcer } from "./announce.js";
import { CatalogPanel, type CatalogSearch } from "./CatalogPanel.js";
import { CommandPalette } from "./CommandPalette.js";
import { pageOf } from "./catalog.js";
import { CommandRegistry } from "./commands.js";
import { GestureLog, recordGesture, setGestureLog } from "./gestures.js";
import { AboutDialog, ShortcutsDialog } from "./HelpDialogs.js";
import { bindItemPlacing, type ItemPlacing } from "./item-placing.js";
import type { Placeable } from "./item-tool.js";
import { isInsidePopup, isTypingTarget } from "./keys.js";
import { bindMeasureDrawing } from "./measure-drawing.js";
import { bindOpeningDrawing } from "./opening-drawing.js";
import { PropertiesPanel } from "./PropertiesPanel.js";
import { bindRoomDrawing } from "./room-drawing.js";
import { SessionLogDialog } from "./SessionLogDialog.js";
import { StatusBar } from "./StatusBar.js";
import { deleteCommands, describeEntity, kindOf, type TextureChoice } from "./selection.js";
import { scaleLabel } from "./status.js";
import { Toolbar } from "./Toolbar.js";
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
import { useProjectFiles } from "./useProjectFiles.js";
import { useModified, useOpenProjects, useProjectState } from "./useReplica.js";
import { bindWallDrawing } from "./wall-drawing.js";
import { bindZoneDrawing, type ZoneDrawing } from "./zone-drawing.js";
import type { ZonePattern } from "./zone-tool.js";

type OptionValues = Record<string, string | number | boolean>;

/** The side panel's two tabs (ADR-017 D3): the selection, and the catalog to add to it from. */
type PanelTab = "properties" | "catalog";

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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [level, setLevel] = useState<string | null>(null);
  const [app, setApp] = useState<ReturnType<typeof startApp> | null>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>("properties");
  const [selectionKey, setSelectionKey] = useState("");
  const [textures, setTextures] = useState<readonly TextureChoice[]>([]);
  // what the item tool places, for the catalog to say so; a ref alone would not re-render the tab
  const [pieceName, setPieceName] = useState<string | null>(null);
  // The piece the item tool places, picked in the catalog. Kept after the tool is left, so pressing I
  // again carries on with it.
  const pieceRef = useRef<Placeable | null>(null);
  const itemPlacingRef = useRef<ItemPlacing | null>(null);
  const zoneDrawingRef = useRef<ZoneDrawing | null>(null);
  // the catalog's search field, which the item tool hands focus to when there is nothing to place yet
  const catalogInputRef = useRef<HTMLInputElement | null>(null);

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

  // Ending a live gesture when the tool changes. Both drawing adapters only go inactive when `active()`
  // turns false — nothing told them to finish — so a half-drawn chain or ring stayed alive with its 3D
  // preview still in the scene, and the status bar went on reporting it under a different tool. The
  // comment below has claimed W-090 does this since P3-1; until now it did not.
  const endGestures = useRef<(() => void)[]>([]);

  const setTool = useCallback(
    (id: ToolId) => {
      const next = toolById(id);
      if (!next) return;
      recordGesture("tool", { tool: next.id, from: toolRef.current });
      if (next.id === "item") {
        // The catalog is where a piece is picked, so it opens with the tool every time: with a piece already
        // picked it shows what is being placed and lets another be picked; with none, the tool waits there.
        setPanelTab("catalog");
        if (!pieceRef.current) {
          requestAnimationFrame(() => catalogInputRef.current?.focus());
          announcer.say("Pick a piece in the catalog, then place it on the plan.");
          return;
        }
      }
      if (next.id !== toolRef.current) for (const end of endGestures.current) end();
      // the ref first: the canvas bindings read it before React has rendered the change
      toolRef.current = next.id;
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

  // Through here rather than straight to the state setter, so the app bar, the palette and a keyboard
  // shortcut all leave the same line in the log (ADR-019 D4).
  const chooseView = useCallback((mode: ViewMode) => {
    recordGesture("view", { mode });
    setView(mode);
  }, []);

  // What is open, and whether it is saved (ADR-012 D8). Read through the replica rather than kept
  // here: the host is the authority on both, and a save moves the saved position without the project
  // changing at all.
  const projectState = useProjectState(app?.replica ?? null);
  const modified = useModified(app?.replica ?? null);
  const openProjects = useOpenProjects(app?.replica ?? null);
  const files = useProjectFiles(
    app?.client ?? null,
    {
      projectId: projectState?.projectId ?? app?.replica.project?.meta.id ?? "",
      name: projectState?.name ?? app?.replica.project?.meta.name ?? "Untitled",
      path: projectState?.path ?? null,
      modified,
      recoveryAvailable: projectState?.recoveryAvailable ?? null,
      known: projectState !== null,
    },
    announcer,
  );
  // The commands are registered once and must not close over the first render's actions.
  const filesRef = useRef(files.actions);
  filesRef.current = files.actions;

  const editor: Editor = {
    commands,
    recent: files.recent,
    openRecent: (projectId) => void filesRef.current.openProject(projectId),
    open: openProjects,
    currentProject: projectState?.projectId ?? "",
    switchProject: (projectId) => void filesRef.current.switchTo(projectId),
    announcer,
    tool,
    setTool,
    view,
    setView: chooseView,
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
      onScale: setScale,
      // The select tool's own gestures — a room corner dragged, a corner removed — say what they are
      // doing through the same status line and the same live regions as the drawing tools, rather than
      // through a second channel of their own.
      onHint: setSnap,
      onSay: (text, assertive) => (assertive ? announcer.alert(text) : announcer.say(text)),
      onPointer: setPointer,
      ...(importFileRef.current ? { importFile: importFileRef.current } : {}),
    });
    setApp(started);
    setLevel(started.plan.level);
    // From here the editor's gestures have somewhere to go (ADR-019 D4). Until now they went nowhere,
    // which is also how every component test gets to call recordGesture without arranging anything.
    setGestureLog(new GestureLog((gestures) => started.client.gesture(gestures)));
    return () => {
      setGestureLog(null);
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
      send: (command) => sendOrThrow(client, command),
      redraw,
      status: setSnap,
      preview3d: (points) => {
        const level = plan.level;
        if (!level) return;
        app.binding.setWallPreview(
          points,
          points.length >= 2
            ? {
                levelId: level,
                thickness: Number(optionsRef.current["wall.thickness"] ?? 100),
                kind: String(optionsRef.current["wall.kind"] ?? "interior"),
              }
            : null,
        );
      },
    });

    const roomDrawing = bindRoomDrawing({
      plan,
      element: planRef.current as HTMLElement,
      announcer,
      project: () => replica.project,
      settings: () => ({ magnetism: optionsRef.current["room.snapWalls"] !== false }),
      active: () => toolRef.current === "room",
      // room.create can refuse with room.not-enclosed, and a click on open ground must not announce a room
      send: (command) => sendOrThrow(client, command),
      redraw,
      status: setSnap,
      preview3d: (polygon) => {
        const level = plan.level;
        if (!level) return;
        app.binding.setRoomPreview(polygon, polygon.length >= 3 ? { levelId: level } : null);
      },
    });

    const itemPlacing = bindItemPlacing({
      plan,
      element: planRef.current as HTMLElement,
      announcer,
      project: () => replica.project,
      piece: () => pieceRef.current,
      settings: () => ({
        magnetism: optionsRef.current["item.snapWalls"] !== false,
        rotation: Number(optionsRef.current["item.rotation"] ?? 0),
      }),
      setRotation: (degrees) => {
        optionsRef.current = { ...optionsRef.current, "item.rotation": degrees };
        setOption("item", "rotation", degrees);
      },
      active: () => toolRef.current === "item",
      send: async (command) => {
        const result = await client.command(command);
        if (!result.ok)
          throw new Error(result.error ? result.error.message : "the host refused the placement");
        const placed = (result.result as { result?: { id?: unknown } } | undefined)?.result;
        return typeof placed?.id === "string" ? placed.id : null;
      },
      select: (ids) => void client.select(ids),
      redraw,
      status: setSnap,
    });
    itemPlacingRef.current = itemPlacing;

    const openingDrawing = bindOpeningDrawing({
      plan,
      element: planRef.current as HTMLElement,
      announcer,
      project: () => replica.project,
      settings: () => ({
        kind: String(optionsRef.current["opening.opening"] ?? "door") as "door" | "window" | "passage",
        widthMm: Number(optionsRef.current["opening.width"] ?? 900),
      }),
      active: () => toolRef.current === "opening",
      send: async (command) => {
        const result = await client.command(command);
        if (!result.ok) throw new Error(result.error ? result.error.message : "the host refused the opening");
        const added = (result.result as { result?: { id?: unknown } } | undefined)?.result;
        return typeof added?.id === "string" ? added.id : null;
      },
      select: (ids) => void client.select(ids),
      redraw,
      status: setSnap,
    });

    const measureDrawing = bindMeasureDrawing({
      plan,
      element: planRef.current as HTMLElement,
      announcer,
      project: () => replica.project,
      settings: () => ({
        units: String(optionsRef.current["measure.units"] ?? "mm") as "mm" | "m" | "ft",
        magnetism: optionsRef.current["measure.snapWalls"] !== false,
      }),
      active: () => toolRef.current === "measure",
      redraw,
      status: setSnap,
    });

    const zoneDrawing = bindZoneDrawing({
      plan,
      element: planRef.current as HTMLElement,
      announcer,
      project: () => replica.project,
      // A cluster lays out whatever the catalog tab has picked; with nothing picked it lays out a desk.
      piece: () => pieceRef.current,
      settings: () => {
        const gap = Number(optionsRef.current["zone.spacing"] ?? 600);
        return {
          pattern: String(optionsRef.current["zone.pattern"] ?? "rows") as ZonePattern,
          spacing: { x: gap, y: gap },
          facing: Number(optionsRef.current["zone.facing"] ?? 180),
          margin: Number(optionsRef.current["zone.margin"] ?? 300),
          magnetism: optionsRef.current["zone.snapWalls"] !== false,
        };
      },
      selection: () => replica.selection,
      active: () => toolRef.current === "zone",
      send: (command) => sendOrThrow(client, command),
      redraw,
      status: setSnap,
    });
    zoneDrawingRef.current = zoneDrawing;

    // Leaving a tool finishes what it was drawing (W-090): what is already down is kept and committed,
    // rather than abandoned half drawn with its preview left standing in the 3D scene.
    endGestures.current = [
      () => wallDrawing.finish(),
      () => roomDrawing.finish(),
      () => itemPlacing.finish(),
      () => zoneDrawing.finish(),
      () => openingDrawing.finish(),
      () => measureDrawing.finish(),
    ];

    // One overlay painter: the draft review panel, both drawing tools and the compass all draw over the
    // plan. setOverlayExtra takes a single function, so anything new joins this composition rather than
    // replacing it — registering a second painter would silently drop the first.
    plan.setOverlayExtra((ctx, view2) => {
      review.draw(ctx, view2);
      wallDrawing.draw(ctx, view2);
      roomDrawing.draw(ctx, view2);
      itemPlacing.draw(ctx, view2);
      openingDrawing.draw(ctx, view2);
      measureDrawing.draw(ctx, view2);
      zoneDrawing.draw(ctx, view2);
      app.drawSelectionDrag(ctx, view2);
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
        id: "edit.delete",
        title: "Delete",
        group: "Edit",
        shortcut: "Delete",
        detail: "remove what is selected",
        enabled: () => replica.selection.length > 0,
        run: async () => {
          const ids = [...replica.selection];
          const dels = deleteCommands(ids);
          if (dels.length === 0) {
            // Everything selected was a kind the editor cannot delete — say so rather than appear to
            // work and change nothing.
            announcer.say("Nothing selected can be deleted.");
            return;
          }
          // One command per kind, in an order that never names an id another command has just removed.
          // Each is its own history entry: undoing a mixed delete therefore takes more than one Undo,
          // which is worth knowing but is better than a half-applied compound.
          for (const del of dels) {
            const result = await client.command(del);
            if (!result.ok) {
              announcer.alert(`Could not delete: ${result.error?.message ?? "the host refused the command"}`);
              return;
            }
          }
          announcer.say(`${ids.length} ${ids.length === 1 ? "entity" : "entities"} deleted.`);
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
      { id: "view.plan", title: "Show the plan only", group: "View", run: () => chooseView("plan") },
      {
        id: "view.both",
        title: "Show the plan and the 3D view",
        group: "View",
        run: () => chooseView("both"),
      },
      { id: "view.3d", title: "Show the 3D view only", group: "View", run: () => chooseView("3d") },
      // Several projects in one session (ADR-012 D8). Ctrl+N is the browser's own new window and
      // cannot be taken, so New uses Ctrl+Alt+N; the rest are the shortcuts every editor has.
      {
        id: "file.new",
        title: "New project",
        group: "File",
        shortcut: "Ctrl+Alt+N",
        detail: "empty, with one level",
        run: () => void filesRef.current.newProject(),
      },
      {
        id: "file.open",
        title: "Your projects…",
        group: "File",
        shortcut: "Ctrl+O",
        run: () => void filesRef.current.open(),
      },
      {
        id: "file.save",
        title: "Save",
        group: "File",
        shortcut: "Ctrl+S",
        run: () => void filesRef.current.save(),
      },
      {
        id: "file.close",
        title: "Close project",
        group: "File",
        detail: "the others stay open",
        run: () => void filesRef.current.closeProject(),
      },
      {
        id: "file.exportProject",
        title: "Export project…",
        group: "File",
        detail: "one file you can keep or send",
        run: () => void filesRef.current.exportProject(),
      },
      {
        id: "file.importProject",
        title: "Import project…",
        group: "File",
        detail: "a project exported from here or anywhere",
        run: () => void filesRef.current.importProject(),
      },
      {
        id: "file.import",
        title: "Import plan…",
        group: "File",
        detail: "a DXF, a PDF or an image",
        run: () => importFileRef.current?.click(),
      },
      // Export was a button running `file.export`, which was registered nowhere: every click did
      // nothing, silently. These are the three formats the host can actually write today; the drawing
      // formats arrive with P3-7 and will be added here then rather than offered and refused.
      ...(
        [
          ["csv", "Bill of materials (CSV)"],
          ["xlsx", "Bill of materials (Excel)"],
          ["glb", "3D model (GLB)"],
        ] as const
      ).map(([format, title]) => ({
        id: `file.export.${format}`,
        title,
        group: "File",
        detail: "written beside the project",
        run: async () => {
          const name = (replica.project?.meta.name ?? "project").replace(/[^\w-]+/g, "-").toLowerCase();
          announcer.say(`Writing the ${format.toUpperCase()}…`);
          // includeUnverified: a line whose product is unverified is HIGHLIGHTED in the file, which is
          // the designed behaviour (ADR-013). Refusing the person's own Export over it would only send
          // them round the same loop. Validation errors still refuse, because a broken project must not
          // be exported quietly.
          const reply = await client.tool("export", {
            format,
            path: `${name}.${format}`,
            includeUnverified: true,
            overwrite: true,
          });
          if (!reply.ok) {
            announcer.alert(`Nothing was written: ${reply.error?.message ?? "the host refused the export"}`);
            return;
          }
          const out = (reply.result as { result?: { path?: string; bytes?: number } } | undefined)?.result;
          announcer.say(`Written to ${out?.path ?? "the project folder"}.`);
        },
      })),
      {
        id: "camera.fit",
        title: "Fit the 3D view to the model",
        group: "3D",
        run: () => {
          app?.fitCamera();
          announcer.say("3D view fitted to the model.");
        },
      },
      ...(
        [
          ["plan", "Of the plan"],
          ["model", "Of the model"],
          ["eye", "At eye level"],
        ] as const
      ).map(([which, title]) => ({
        id: `image.${which}`,
        title,
        group: "3D",
        detail: "saved as a PNG",
        run: async () => {
          if (!app) return;
          // "model" is the three-quarter view the render tool calls "room"; focused on the selection
          // when a room is picked, and on everything when nothing is.
          const view = which === "model" ? "room" : which;
          const room = replica.selection.find((id) => id.startsWith("room_")) ?? null;
          announcer.say("Rendering…");
          const saved = await app.saveImage(view, room);
          announcer.say(saved ? `Saved ${saved}.` : "Nothing was rendered.");
        },
      })),
      {
        id: "help.log",
        title: "Session log…",
        group: "Help",
        detail: "everything this run did",
        run: () => setLogOpen(true),
      },
      {
        id: "help.shortcuts",
        title: "Keyboard shortcuts…",
        group: "Help",
        run: () => setShortcutsOpen(true),
      },
      {
        id: "help.about",
        title: "About floorplan-ai…",
        group: "Help",
        run: () => setAboutOpen(true),
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

    // The catalog's textures, for the material rows. Asked once the first snapshot is in, which is after
    // the hello: a request sent while the socket was still connecting was refused, and the rows then
    // offered paint alone for the whole session. The catalog does not change under a session.
    let texturesAsked = false;
    const askTextures = (): void => {
      if (texturesAsked || !replica.project) return;
      texturesAsked = true;
      void client
        .request({ type: "get", what: "textures" })
        .then((reply) => {
          const list = (reply.result as { textures?: unknown } | undefined)?.textures;
          if (Array.isArray(list)) setTextures(list as TextureChoice[]);
        })
        .catch(() => {
          // an older host has no texture list; the rows still offer paint and what the project wears
        });
    };
    const unsubscribe = replica.subscribe(() => {
      setScale(plan.view.scale);
      setLevel(plan.level);
      setSelectionKey(replica.selection.join(","));
      askTextures();
    });
    askTextures();
    setScale(plan.view.scale);
    return () => {
      unsubscribe();
      wallDrawing.destroy();
      roomDrawing.destroy();
      itemPlacing.destroy();
      openingDrawing.destroy();
      measureDrawing.destroy();
      zoneDrawing.destroy();
      itemPlacingRef.current = null;
      zoneDrawingRef.current = null;
    };
  }, [app, announcer, commands, setTool, setOption]);

  // The panel is the selection (ADR-017 D3): picking something on the plan shows its properties. Not while
  // placing, where each new piece is selected in turn and the catalog should stay where it is.
  useEffect(() => {
    if (selectionKey !== "" && toolRef.current !== "item") setPanelTab("properties");
  }, [selectionKey]);

  const searchCatalog = useCallback(
    async (args: CatalogSearch) => {
      if (!app) throw new Error("not connected to the host");
      const reply = await app.client.tool("search_catalog", { ...args, limit: 20 });
      const page = reply.ok ? pageOf(reply.result) : null;
      if (!page) throw new Error(reply.error?.message ?? "the host sent no results");
      return page;
    },
    [app],
  );

  const placePiece = useCallback(
    (piece: Placeable) => {
      pieceRef.current = piece;
      setPieceName(piece.name);
      // A new piece starts as placed, turned by the wall it meets; a turn asked for the last one is not
      // this one's.
      optionsRef.current = { ...optionsRef.current, "item.rotation": 0 };
      setOption("item", "rotation", 0);
      setTool("item");
      planRef.current?.focus();
      itemPlacingRef.current?.arm();
      announcer.say(
        `Placing ${piece.name}. Click on the plan, or move it with the arrows and press Enter. Escape finishes.`,
      );
    },
    [announcer, setTool, setOption],
  );

  const replaceWith = useCallback(
    async (piece: Placeable) => {
      const project = app?.replica.project;
      const [id] = app?.replica.selection ?? [];
      if (!app || !project || !id || kindOf(id) !== "item") return;
      const before = describeEntity(project, id)?.title ?? "The item";
      try {
        await sendOrThrow(app.client, { type: "item.setProduct", payload: { itemId: id, ref: piece.ref } });
        announcer.say(`${before} replaced with ${piece.name}.`);
      } catch (e) {
        announcer.alert(`${before} could not be replaced: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [app, announcer],
  );

  const selected = selectionKey ? selectionKey.split(",") : [];
  const only = selected.length === 1 ? (selected[0] as string) : null;
  const project = app?.replica.project ?? null;
  const replacing =
    only && kindOf(only) === "item" && project ? (describeEntity(project, only)?.title ?? null) : null;

  // Leaving the wall tool ends the chain rather than abandoning it half drawn (W-090); Escape returns to
  // select from anywhere, and is never treated as typing (ADR-017 D2).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (paletteOpen) return;
      const target = event.target as HTMLElement | null;
      const bare = !event.ctrlKey && !event.metaKey && !event.altKey;
      if (bare && isInsidePopup(target)) return;
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
              onRename={(name) => filesRef.current.rename(name)}
              stale={app?.client.welcome?.stale ?? null}
            />
          ) : (
            <header className="flex h-10 items-center border-b bg-card px-3">
              <strong className="font-semibold">floorplan-ai</strong>
            </header>
          )}

          <Toolbar
            replica={replica}
            level={level}
            onLevel={(id) => {
              app?.plan.setLevel(id);
              setLevel(id);
            }}
          />

          {/* columns match the rail (w-12) and the properties panel (w-72) */}
          <div className="grid min-h-0 grid-cols-[48px_minmax(0,1fr)_288px]">
            <ToolRail />

            {/* One tree for every view mode. planRef, viewportRef and fitRef are handed to imperative
                code that appends canvases and listeners to those nodes, so the nodes must live for the
                whole session: never duplicated, and never moved to another parent. A view mode that
                rendered its own container (the grid the single-pane modes once had) made React replace
                the panes on every switch, and the canvases and listeners went with the old nodes —
                the editor went blank until a reload.

                So the splitter is always there, and a view mode hides the pane it does not show, and the
                divider with it. The layout is untouched by that, so the split someone chose is still there
                when both panes come back. */}
            {(() => {
              // h-full, because these panes are flex children now rather than grid tracks. A grid track
              // stretched them for free; a flex item does not, so without it the wrapper collapsed to
              // zero and took the canvas host down with it.
              const planPane = (
                <div className="relative h-full min-h-0 overflow-hidden">
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
                <div className="relative h-full min-h-0 overflow-hidden" data-pane="3d">
                  <div ref={viewportRef} id="viewport" className="h-full w-full overflow-hidden" />
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
                  {/* data-view-hidden, not a class: the library puts className on an inner element and
                      display:flex inline on the outer one, so only the attribute rule in styles.css can
                      take a panel out of the layout. The panel left behind grows into the space. */}
                  <ResizablePanel
                    id={PLAN_PANEL}
                    defaultSize="72"
                    minSize="20"
                    className="relative min-h-0"
                    data-view-hidden={view === "3d" || undefined}
                  >
                    {planPane}
                  </ResizablePanel>
                  {/* The handle is a real separator: focusable, with arrow keys, because a divider that
                      only answers to a drag is a divider a keyboard cannot move. Hidden with a pane, it
                      also leaves the tab order, which is right: there is nothing to divide. */}
                  <ResizableHandle
                    withHandle
                    aria-label="Resize the plan and the 3D view"
                    data-view-hidden={view !== "both" || undefined}
                  />
                  <ResizablePanel
                    id={VIEW_PANEL}
                    defaultSize="28"
                    minSize="10"
                    className="relative min-h-0"
                    data-view-hidden={view === "plan" || undefined}
                  >
                    {viewPane}
                  </ResizablePanel>
                </ResizablePanelGroup>
              );
            })()}

            {app ? (
              <Tabs
                value={panelTab}
                onValueChange={(v) => setPanelTab(v as PanelTab)}
                className="flex min-h-0 flex-col gap-0 border-l bg-card"
              >
                <TabsList
                  variant="line"
                  aria-label="Side panel"
                  className="h-9 w-full shrink-0 justify-start rounded-none border-b px-2"
                >
                  <TabsTrigger value="properties" className="flex-none px-2">
                    Properties
                  </TabsTrigger>
                  <TabsTrigger value="catalog" className="flex-none px-2">
                    Catalog
                  </TabsTrigger>
                </TabsList>
                {/* Both stay mounted, so a half-typed search or a field being edited survives a look at the
                    other tab; the inactive one is only hidden. */}
                <TabsContent value="properties" forceMount className="min-h-0 data-[state=inactive]:hidden">
                  <PropertiesPanel
                    replica={app.replica}
                    level={level}
                    send={(command) => sendOrThrow(app.client, command)}
                    textures={textures}
                    preview={app.preview}
                  />
                </TabsContent>
                <TabsContent value="catalog" forceMount className="min-h-0 data-[state=inactive]:hidden">
                  <CatalogPanel
                    inputRef={catalogInputRef}
                    search={searchCatalog}
                    onPlace={placePiece}
                    onReplace={replaceWith}
                    replacing={replacing}
                    placing={toolId === "item" ? pieceName : null}
                    onStopPlacing={() => setTool("select")}
                  />
                </TabsContent>
              </Tabs>
            ) : (
              <aside className="border-l" />
            )}
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
        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} commands={commands.all()} />
        <SessionLogDialog
          open={logOpen}
          onOpenChange={setLogOpen}
          // The dialog asks; the host owns the files. A refusal comes back as the host's own sentence.
          ask={async (body) => {
            const reply = await (app as NonNullable<typeof app>).client.request(body);
            if (!reply.ok) throw new Error(reply.error?.message ?? "the host refused to read the log");
            return (reply.result ?? {}) as Record<string, unknown>;
          }}
        />
        {files.dialogs}
        <AboutDialog
          open={aboutOpen}
          onOpenChange={setAboutOpen}
          facts={{
            appVersion: CLIENT_VERSION,
            hostVersion: app?.client.welcome?.hostVersion ?? null,
            protocolVersion: app?.client.welcome?.protocolVersion ?? null,
            projectName: app?.replica.project?.meta.name ?? null,
            projectPath: app?.client.welcome?.path ?? null,
            stale: app?.client.welcome?.stale ?? null,
            bridge: app?.client.status ?? "not connected",
          }}
        />
      </TooltipProvider>
    </EditorContext.Provider>
  );
}

/**
 * Sends one command, and throws with the host's reason when it is refused. The bridge resolves with a
 * result either way, so a refusal has to be read out of it rather than caught: without this a refused
 * command still announced that the walls had been drawn.
 */
async function sendOrThrow(client: BridgeClient, command: unknown): Promise<void> {
  const result = await client.command(command);
  if (!result.ok)
    throw new Error(
      result.error
        ? `${result.error.message}${result.error.hint ? ` (${result.error.hint})` : ""}`
        : "the host refused the command",
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
  // zoomAt only marks the renderer's own state dirty; the frame loop watches a flag inside startApp,
  // so without asking for a redraw the view changed and nothing was ever painted.
  app.redraw();
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

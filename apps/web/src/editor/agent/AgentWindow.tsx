// The chat window: a companion at the bottom right, or dragged anywhere (ADR-022).
//
// An overlay rather than a column of the editor's grid, because the plan and the 3D view are what a
// person is watching while the agent works, and a chat that took a third of the width would push
// them aside for the whole session.
//
// It comes with a launcher: a button that sits above the status bar and is always there, whether or
// not the chat is open. A shortcut nobody has been told about is not a way in, and the window is the
// only part of the editor a first-time visitor has to be told exists. Pressing it opens the chat;
// pressing it again puts it away. The window is sized to sit above that button rather than to fill
// the screen, and both its edges away from the corner can be dragged, so it can be made small.
//
// The window is a dialog in the accessibility sense but deliberately not a modal one: the editor
// stays usable while the agent works, which is the entire point of watching it work.

import { ChevronDown, GripVertical, Maximize2, Minus, PanelRightClose, Sparkles, X } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  afterDrag,
  afterResize,
  afterResizeTop,
  DEFAULT_PLACEMENT,
  docked,
  floated,
  type Placement,
  readPlacement,
  rectOf,
  type Viewport,
  writePlacement,
} from "./placement.js";

/** The bars the window keeps clear of: the app bar and tool options above, the status bar below. */
const TOP_BARS = 76;
const BOTTOM_BAR = 28;
/** The launcher's own strip, which the docked window stops short of so the button stays pressable. */
const LAUNCHER = 44;

/** What a drag of one of the window's handles is doing. */
type Handle = "move" | "resize" | "resize-top";

export interface AgentWindowProps {
  open: boolean;
  onOpen(): void;
  onClose(): void;
  title: string;
  subtitle?: string | null;
  children: JSX.Element;
}

export function AgentWindow({
  open,
  onOpen,
  onClose,
  title,
  subtitle,
  children,
}: AgentWindowProps): JSX.Element {
  const [placement, setPlacement] = useState<Placement>(() => readPlacement());
  const [view, setView] = useState<Viewport>(() => viewport());
  const rect = rectOf(placement, view);
  const dragging = useRef<{ kind: Handle; x: number; y: number; from: typeof rect } | null>(null);
  const showing = open && !placement.minimised;

  useEffect(() => {
    const onResize = () => setView(viewport());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Asking for the chat gives you the chat. Minimised is remembered between sessions, and without
  // this a person who left it minimised presses the shortcut, gets nothing but the launcher back,
  // and reasonably concludes the agent is broken. Minimising does not change `open`, so this only
  // fires when somebody has actually asked for the window back.
  useEffect(() => {
    if (!open) return;
    setPlacement((current) => {
      if (!current.minimised) return current;
      const next = { ...current, minimised: false };
      writePlacement(next);
      return next;
    });
  }, [open]);

  const change = useCallback((next: Placement) => {
    setPlacement(next);
    writePlacement(next);
  }, []);

  const onPointerDown = (kind: Handle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // The title bar is the drag handle and it also carries three buttons, so a press that lands on
    // one of them is not a drag. Taking the pointer here swallowed their clicks: preventDefault on
    // pointerdown cancels the compatibility mouse events, and capture sends the pointerup to the
    // header rather than to the button, so Minimise, Dock and Close did nothing at all. The resize
    // handles are themselves buttons, which is why only the move handler asks.
    if (kind === "move" && (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    // Optional, because not every environment that renders this implements pointer capture; without
    // it a drag simply stops tracking outside the handle rather than throwing.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragging.current = { kind, x: e.clientX, y: e.clientY, from: rect };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragging.current;
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    // A press that has not moved is a press, not a drag: undocking on a click of the title bar would
    // make the window jump for anyone who meant to do nothing.
    if (drag.kind === "move" && Math.abs(dx) + Math.abs(dy) < 3) return;
    setPlacement(
      drag.kind === "move"
        ? afterDrag(placement, drag.from, dx, dy)
        : drag.kind === "resize-top"
          ? afterResizeTop(placement, drag.from, dy)
          : afterResize(placement, drag.from, dx, dy),
    );
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    dragging.current = null;
    writePlacement(placement);
  };

  const handle = {
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
  };

  return (
    <>
      {showing ? (
        <section
          id="agent-window"
          role="dialog"
          aria-label={title}
          className="fixed z-30 flex flex-col overflow-hidden rounded-lg border bg-card shadow-xl"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        >
          {/* The title bar is the handle. `touch-none` because a drag on a touch screen would
              otherwise scroll the page out from under the window. */}
          <header
            className="flex h-9 shrink-0 cursor-grab touch-none items-center gap-1 border-b bg-muted/40 px-2 active:cursor-grabbing"
            onPointerDown={onPointerDown("move")}
            {...handle}
          >
            <GripVertical className="size-3.5 text-muted-foreground" aria-hidden />
            {/* The name does not shrink and the model does. A local model's name is fifty characters
                of repository path, and it was squeezing the title down to "Ag…". */}
            <span className="shrink-0 font-medium text-sm">{title}</span>
            {subtitle ? (
              <span className="min-w-0 truncate text-muted-foreground text-xs">· {subtitle}</span>
            ) : null}
            <span className="grow" />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={placement.mode === "docked" ? "Undock the chat" : "Dock the chat to the right"}
              onClick={() =>
                change(placement.mode === "docked" ? floated(placement, rect) : docked(placement))
              }
            >
              {placement.mode === "docked" ? <Maximize2 aria-hidden /> : <PanelRightClose aria-hidden />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Minimise the chat"
              onClick={() => change({ ...placement, minimised: true })}
            >
              <Minus aria-hidden />
            </Button>
            <Button variant="ghost" size="icon-xs" aria-label="Close the chat" onClick={onClose}>
              <X aria-hidden />
            </Button>
          </header>

          <div className="flex min-h-0 grow flex-col">{children}</div>

          {/* The top edge sets the height on its own, which is the measurement a chat this shape
              actually needs: the window is as tall as the conversation you want to see. It sits over
              the top of the title bar, so the two handles do not fight for the same pixels. */}
          <button
            type="button"
            aria-label="Change the chat's height"
            className="absolute inset-x-2 top-0 h-1.5 cursor-ns-resize touch-none rounded-b hover:bg-primary/30"
            onPointerDown={onPointerDown("resize-top")}
            {...handle}
          />
          {/* Top left, because the window is pressed into the bottom right: a handle in that corner
              could not be reached. */}
          <button
            type="button"
            aria-label="Resize the chat"
            className="absolute top-0 left-0 size-4 cursor-nwse-resize touch-none"
            onPointerDown={onPointerDown("resize")}
            {...handle}
          />
        </section>
      ) : null}

      {/* Always there, open or not: the way in that does not have to be discovered, and the way out
          that does not move. Its own press does all three things a person means by it -- open a chat
          they have never opened, bring back one they minimised, put away one that is in the way. */}
      <div className="fixed right-3 bottom-8 z-30">
        <Button
          variant={showing ? "secondary" : "default"}
          size="sm"
          className="gap-1.5 rounded-full shadow-lg"
          aria-expanded={showing}
          aria-controls="agent-window"
          onClick={() => {
            if (!open) onOpen();
            else change({ ...placement, minimised: !placement.minimised });
          }}
        >
          {showing ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <Sparkles className="size-3.5" aria-hidden />
          )}
          Ask the agent
        </Button>
      </div>
    </>
  );
}

function viewport(): Viewport {
  const width = typeof window === "undefined" ? 1280 : window.innerWidth;
  const height = typeof window === "undefined" ? 800 : window.innerHeight;
  // The launcher counts as part of the bottom bar: the docked window stops above it, so the button
  // that puts the chat away is never underneath the chat.
  return { width, height, top: TOP_BARS, bottom: BOTTOM_BAR + LAUNCHER };
}

export { DEFAULT_PLACEMENT };

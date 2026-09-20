// The chat window: docked bottom-right, or dragged anywhere (ADR-022).
//
// An overlay rather than a column of the editor's grid, because the plan and the 3D view are what a
// person is watching while the agent works, and a chat that took a third of the width would push
// them aside for the whole session. Docked it is a tall strip at the right; undocked it can sit over
// the 3D view, on a second monitor, or out of the way entirely.
//
// The window is a dialog in the accessibility sense but deliberately not a modal one: the editor
// stays usable while the agent works, which is the entire point of watching it work.

import { GripVertical, Maximize2, Minus, PanelRightClose, X } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  afterDrag,
  afterResize,
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

export interface AgentWindowProps {
  open: boolean;
  onClose(): void;
  title: string;
  subtitle?: string | null;
  children: JSX.Element;
}

export function AgentWindow({
  open,
  onClose,
  title,
  subtitle,
  children,
}: AgentWindowProps): JSX.Element | null {
  const [placement, setPlacement] = useState<Placement>(() => readPlacement());
  const [view, setView] = useState<Viewport>(() => viewport());
  const rect = rectOf(placement, view);
  const dragging = useRef<{ kind: "move" | "resize"; x: number; y: number; from: typeof rect } | null>(null);

  useEffect(() => {
    const onResize = () => setView(viewport());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Asking for the chat gives you the chat. Minimised is remembered between sessions, and without
  // this a person who left it minimised presses the shortcut, gets a pill in the far corner, and
  // reasonably concludes the agent is broken. Minimising does not change `open`, so this only fires
  // when somebody has actually asked for the window back.
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

  const onPointerDown = (kind: "move" | "resize") => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // The title bar is the drag handle and it also carries three buttons, so a press that lands on
    // one of them is not a drag. Taking the pointer here swallowed their clicks: preventDefault on
    // pointerdown cancels the compatibility mouse events, and capture sends the pointerup to the
    // header rather than to the button, so Minimise, Dock and Close did nothing at all. The resize
    // handle is itself a button, which is why only the move handler asks.
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
        : afterResize(placement, drag.from, dx, dy),
    );
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    dragging.current = null;
    writePlacement(placement);
  };

  if (!open) return null;

  if (placement.minimised)
    return (
      <div className="fixed right-3 bottom-9 z-30">
        <Button
          variant="default"
          size="sm"
          className="shadow-lg"
          onClick={() => change({ ...placement, minimised: false })}
        >
          {title}
        </Button>
      </div>
    );

  return (
    <section
      role="dialog"
      aria-label={title}
      className="fixed z-30 flex flex-col overflow-hidden rounded-lg border bg-card shadow-xl"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      {/* The title bar is the handle. `touch-none` because a drag on a touch screen would otherwise
          scroll the page out from under the window. */}
      <header
        className="flex h-9 shrink-0 cursor-grab touch-none items-center gap-1 border-b bg-muted/40 px-2 active:cursor-grabbing"
        onPointerDown={onPointerDown("move")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <GripVertical className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="truncate font-medium text-sm">{title}</span>
        {subtitle ? <span className="truncate text-muted-foreground text-xs">· {subtitle}</span> : null}
        <span className="grow" />
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={placement.mode === "docked" ? "Undock the chat" : "Dock the chat to the right"}
          onClick={() => change(placement.mode === "docked" ? floated(placement, rect) : docked(placement))}
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

      {/* Bottom left, because the window lives at the bottom right: a handle in the corner it is
          pressed against could not be reached. */}
      <button
        type="button"
        aria-label="Resize the chat"
        className="absolute bottom-0 left-0 size-4 cursor-nesw-resize touch-none"
        onPointerDown={onPointerDown("resize")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </section>
  );
}

function viewport(): Viewport {
  const width = typeof window === "undefined" ? 1280 : window.innerWidth;
  const height = typeof window === "undefined" ? 800 : window.innerHeight;
  return { width, height, top: TOP_BARS, bottom: BOTTOM_BAR };
}

export { DEFAULT_PLACEMENT };

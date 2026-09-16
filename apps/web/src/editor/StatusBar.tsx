// The status bar (ADR-017 D1): where the pointer is, what a snap caught, the problems in words, and the
// reminder that every command is one keystroke away. The wording comes from status.ts, which is framework
// free and keeps its own tests.
//
// This renders whether or not the replica exists yet, which matters more than it looks: the app writes its
// activity line straight into `activityRef`, and if that span lived inside a branch that flipped when the
// project arrived, React would reconcile it away and the app would go on writing into a node no longer on
// screen. The counts move into a child so the hooks stay unconditional.
import type { JSX, RefObject } from "react";
import type { Replica } from "../replica.js";
import { pointerText, problemCounts, scaleLabel } from "./status.js";
import { useEditor } from "./useEditor.js";
import { useProblemCount } from "./useReplica.js";

export interface StatusBarProps {
  replica: Replica | null;
  /** The app writes its own activity line (import progress, bridge state) straight into this element. */
  activityRef: RefObject<HTMLSpanElement | null>;
}

export function StatusBar({ replica, activityRef }: StatusBarProps): JSX.Element {
  const editor = useEditor();
  return (
    <footer className="text-muted-foreground flex h-7 items-center gap-3.5 overflow-hidden border-t bg-card px-3">
      <span className="tabular-nums">{pointerText(editor.pointer)}</span>
      {editor.snap ? <span>{editor.snap}</span> : null}
      {replica ? <Problems replica={replica} /> : <span>Connecting…</span>}
      <span className="grow" />
      <span ref={activityRef} className="truncate" />
      <span className="tabular-nums">{scaleLabel(editor.scale, Math.min(2, window.devicePixelRatio))}</span>
      <span>
        Press <kbd className="rounded border bg-muted px-1.5 py-px text-[11px]">Ctrl K</kbd> for commands
      </span>
    </footer>
  );
}

function Problems({ replica }: { replica: Replica }): JSX.Element {
  const { errors, warnings } = useProblemCount(replica);
  const problems = problemCounts(errors, warnings);
  const tone =
    problems.tone === "ok"
      ? "text-[#2e7d32]"
      : problems.tone === "error"
        ? "text-destructive"
        : "text-[#a05a00]";
  return <span className={tone}>{problems.text}</span>;
}

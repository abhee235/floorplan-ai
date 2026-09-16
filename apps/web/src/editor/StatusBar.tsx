// The status bar (ADR-017 D1): where the pointer is, what a snap caught, the problems in words, and the
// reminder that every command is one keystroke away. The wording comes from status.ts, which is framework
// free and keeps its own tests.
//
// This renders whether or not the replica exists yet, which matters more than it looks: the app writes its
// activity line straight into `activityRef`, and if that span lived inside a branch that flipped when the
// project arrived, React would reconcile it away and the app would go on writing into a node no longer on
// screen. The counts move into a child so the hooks stay unconditional.

import type { JSX, RefObject } from "react";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import type { Replica } from "../replica.js";
import { pointerText, problemCounts, scaleLabel } from "./status.js";
import { useEditor } from "./useEditor.js";
import { useProblemCount } from "./useReplica.js";

export interface StatusBarProps {
  replica: Replica | null;
  /** The app writes its own activity line (import progress, bridge state) straight into this element. */
  activityRef: RefObject<HTMLSpanElement | null>;
}

const RULE = <Separator orientation="vertical" className="h-4 opacity-60" />;

export function StatusBar({ replica, activityRef }: StatusBarProps): JSX.Element {
  const editor = useEditor();
  return (
    <footer className="flex h-7 items-center gap-3 overflow-hidden border-t bg-card px-3 text-xs text-muted-foreground">
      {/* Only takes space once there is a pointer to report. The width is fixed so the bar does not
          jitter as the coordinates change, but reserving it while the pointer is off the plan just
          indented everything after it for no reason. */}
      {editor.pointer ? (
        <>
          <span className="w-[180px] tabular-nums">{pointerText(editor.pointer)}</span>
          {RULE}
        </>
      ) : null}
      {editor.snap ? (
        <>
          <span className="text-foreground">{editor.snap}</span>
          {RULE}
        </>
      ) : null}
      {replica ? <Problems replica={replica} /> : <span>Connecting…</span>}
      <span className="grow" />
      <span ref={activityRef} className="truncate" />
      {RULE}
      <span className="tabular-nums">{scaleLabel(editor.scale, Math.min(2, window.devicePixelRatio))}</span>
      {RULE}
      <span className="flex items-center gap-1.5">
        <KbdGroup>
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
        commands
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

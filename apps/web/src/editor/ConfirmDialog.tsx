// "You have unsaved work" (ADR-012 D8), before anything that would throw it away.
//
// Three answers, not two. A confirm with only Discard and Cancel makes the person cancel, save by hand
// and start again, so the common case — yes, keep it, then carry on — costs three steps. Save and
// continue does the whole thing, which is what every editor that asks this question offers.

import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** What the person said. `cancel` is also what closing the dialog means. */
export type UnsavedAnswer = "save" | "discard" | "cancel";

export interface UnsavedDialogProps {
  open: boolean;
  /** What is about to happen, in the person's words: "Open another project", "Start a new project". */
  action: string;
  projectName: string;
  /** Whether the project has a file yet; without one, saving has to ask where first. */
  hasPath: boolean;
  onAnswer: (answer: UnsavedAnswer) => void;
}

export function UnsavedDialog({
  open,
  action,
  projectName,
  hasPath,
  onAnswer,
}: UnsavedDialogProps): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onAnswer("cancel"))}>
      <DialogContent className="max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save the changes to {projectName}?</DialogTitle>
          <DialogDescription>{action} will discard everything done since the last save.</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" className="h-8" onClick={() => onAnswer("discard")}>
            Don't save
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" className="h-8" onClick={() => onAnswer("cancel")}>
              Cancel
            </Button>
            <Button className="h-8" autoFocus onClick={() => onAnswer("save")}>
              {hasPath ? "Save" : "Save as…"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface RecoveryDialogProps {
  open: boolean;
  /** When the recovery file was written, ISO. */
  at: string;
  projectName: string;
  onAnswer: (recover: boolean) => void;
}

/**
 * A recovery file newer than the saved project (ADR-012 D6).
 *
 * The host has detected this since the file format was built, and said so on stderr — a place nobody
 * editing a floor plan in a browser will ever look. Work survived a crash and then sat there unmentioned.
 */
export function RecoveryDialog({ open, at, projectName, onAnswer }: RecoveryDialogProps): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onAnswer(false))}>
      <DialogContent className="max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Unsaved work was recovered</DialogTitle>
          <DialogDescription>
            {projectName} has changes from {at.replace("T", " ").slice(0, 16)} that were never saved — the app
            closed before they were written. Opening them replaces what is shown; the saved file is not
            touched until you save.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="h-8" onClick={() => onAnswer(false)}>
            Ignore them
          </Button>
          <Button className="h-8" autoFocus onClick={() => onAnswer(true)}>
            Open the recovered work
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

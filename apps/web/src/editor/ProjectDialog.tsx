// File ▸ Open (ADR-021): the library, as a list of projects.
//
// This was a folder browser. The host listed its own directories and this drew them, because a browser
// will not hand a server a local path — not through a file input, and not through the File System
// Access API, whose handles belong to the tab and can never be read by the host. That only worked
// because the server and the person happened to be on the same machine, and it would have had to be
// switched off the moment anything else could reach the host. A feature that has to be disabled to ship
// the product was the wrong feature.
//
// So there are no paths here. A project is a name and an id, the app knows where it keeps them, and the
// way across to a person's own disk is export and import, which the browser does itself.

import { Clock, FolderOpen, Loader2, Plus, Search, Trash2 } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** One project in the library. There is no address: where it lives is the host's business. */
export interface LibraryProject {
  projectId: string;
  name: string;
  createdAt: string;
  lastOpenedAt: string;
}

/** Asks the host; resolves with the result body, or throws with the host's own reason. */
export type AskHost = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface ProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ask: AskHost;
  /** Open one of them. Throws with the host's reason on a refusal. */
  onChoose: (projectId: string) => Promise<void>;
  /** Start a new one, which exists from the moment it is made. */
  onNew: () => Promise<void>;
  /** Delete one for good. */
  onDelete: (projectId: string) => Promise<void>;
  /** Which project this tab is looking at, so the list can say so. */
  currentProject: string;
}

/** "3 minutes ago", "yesterday", "12 March" — how a list of documents says when. */
export function when(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

export function ProjectDialog({
  open,
  onOpenChange,
  ask,
  onChoose,
  onNew,
  onDelete,
  currentProject,
}: ProjectDialogProps): JSX.Element {
  const [projects, setProjects] = useState<LibraryProject[]>([]);
  const [find, setFind] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The project a second press would delete, so one click never destroys anything. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const body = await ask({ type: "files", op: "list" });
      setProjects((body.projects as LibraryProject[]) ?? []);
      setProblem(null);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [ask]);

  useEffect(() => {
    if (!open) return;
    setFind("");
    setConfirming(null);
    void load();
  }, [open, load]);

  const shown = useMemo(() => {
    const q = find.trim().toLowerCase();
    return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;
  }, [projects, find]);

  /** Do something and close, or stay open showing why it did not work. */
  const act = async (run: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await run();
      onOpenChange(false);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[70vh] max-w-2xl flex-col gap-3 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Your projects</DialogTitle>
          <DialogDescription>Everything you have here. Open one, or start another.</DialogDescription>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute top-2 left-2 size-4 text-muted-foreground" />
            <Input
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder="Find a project by name"
              aria-label="Find a project by name"
              className="h-8 pl-8"
            />
          </div>
          <Button className="h-8 gap-1.5" onClick={() => void act(onNew)}>
            <Plus className="size-4" />
            New project
          </Button>
          {busy ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : null}
        </div>

        <div
          className="min-h-0 flex-1 overflow-y-auto rounded-md border bg-card"
          role="listbox"
          aria-label="Your projects"
        >
          {shown.map((p) => (
            <div
              key={p.projectId}
              className={`flex items-center gap-3 border-b px-3 py-2 last:border-b-0 hover:bg-accent ${
                p.projectId === currentProject ? "bg-accent/60" : ""
              }`}
            >
              <button
                type="button"
                role="option"
                aria-selected={p.projectId === currentProject}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                onClick={() => void act(() => onChoose(p.projectId))}
              >
                <FolderOpen className="size-4 shrink-0 text-sky-600 dark:text-sky-400" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{p.name}</span>
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Clock className="size-3" />
                    {when(p.lastOpenedAt)}
                    {p.projectId === currentProject ? " · open now" : ""}
                  </span>
                </span>
              </button>
              {/* Two presses to delete. A row you click to open is the worst possible neighbour for a
                  one-click destructive button. */}
              <Button
                variant={confirming === p.projectId ? "destructive" : "ghost"}
                className="h-7 shrink-0 gap-1 px-2 text-[12px]"
                aria-label={confirming === p.projectId ? `Really delete ${p.name}` : `Delete ${p.name}`}
                onClick={() =>
                  confirming === p.projectId
                    ? void act(() => onDelete(p.projectId))
                    : setConfirming(p.projectId)
                }
              >
                <Trash2 className="size-3.5" />
                {confirming === p.projectId ? "Really delete" : ""}
              </Button>
            </div>
          ))}
          {shown.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              {problem
                ? "The list could not be read."
                : projects.length === 0
                  ? "No projects yet. New project starts one."
                  : "No project has that name."}
            </p>
          ) : null}
        </div>

        {problem ? (
          <p className="shrink-0 rounded-md bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            {problem}
          </p>
        ) : null}

        <DialogFooter className="shrink-0">
          <Button variant="outline" className="h-8" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

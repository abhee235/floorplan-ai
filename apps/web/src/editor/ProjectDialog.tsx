// File ▸ Open… and File ▸ Save as… (ADR-012 D8): choosing a project directory on the machine running
// the host.
//
// A browser cannot show a native picker for a directory on that machine. Its own file input returns
// files the BROWSER chose, with no path the host could ever open, and the directory handles the File
// System Access API hands out belong to the tab, not to the host process that owns the project. So the
// host lists directories over the bridge and this draws the listing: the same picker a desktop
// application shows, with the host doing the looking.
//
// The path is also editable outright. Typing one is faster than clicking to it when you already know
// where you are going, and it is the only way to reach a folder the listing cannot show — a network
// share, a drive that is not under the home folder.

import { ArrowUp, CornerDownLeft, FolderOpen, Home, Loader2 } from "lucide-react";
import type { JSX, KeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { Label } from "@/components/ui/label";

/** Which job the dialog is doing; they share a listing and differ in what the button does. */
export type ProjectDialogMode = "open" | "save";

export interface BrowseEntry {
  name: string;
  path: string;
  project: boolean;
  at: string | null;
}

export interface Listing {
  dir: string;
  parent: string | null;
  entries: BrowseEntry[];
  problem?: string;
}

/** A project the host knows about. `address` is opaque here; `id` is what a link says (ADR-020 D1). */
export interface RecentProject {
  id: string;
  address: string;
  name: string;
  lastOpenedAt: string;
}

export interface Place {
  name: string;
  path: string;
}

/** Asks the host; resolves with the result body, or throws with the host's own reason. */
export type AskHost = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface ProjectDialogProps {
  /** The job, or null when the dialog is closed. */
  mode: ProjectDialogMode | null;
  onOpenChange: (open: boolean) => void;
  ask: AskHost;
  /** Do the thing: open that directory, or save to it. Throws with the host's reason on a refusal. */
  onChoose: (path: string) => Promise<void>;
  /** The open project's name, which is what Save as offers as a folder name. */
  currentName: string;
}

/** The last path segment, whichever separator the host uses. */
function leaf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Join a directory and a name with the separator that directory already uses. */
function childOf(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

function when(at: string | null): string {
  if (!at) return "";
  return at.replace("T", " ").slice(0, 16);
}

export function ProjectDialog({
  mode,
  onOpenChange,
  ask,
  onChoose,
  currentName,
}: ProjectDialogProps): JSX.Element {
  const [listing, setListing] = useState<Listing | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [name, setName] = useState(currentName);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const go = useCallback(
    async (path?: string) => {
      setBusy(true);
      setProblem(null);
      try {
        const body = (await ask({ type: "files", op: "browse", ...(path ? { path } : {}) })) as unknown;
        const next = body as Listing;
        setListing(next);
        setTyped(next.dir);
        setChosen(null);
        if (next.problem) setProblem(next.problem);
      } catch (e) {
        setProblem(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [ask],
  );

  // Where to start, what has been used lately, and the shortcuts — whenever the dialog opens.
  useEffect(() => {
    if (!mode) return;
    let cancelled = false;
    setChosen(null);
    setProblem(null);
    setName(currentName);
    void (async () => {
      try {
        const body = await ask({ type: "files", op: "recent" });
        if (cancelled) return;
        setRecent((body.recent as RecentProject[]) ?? []);
        setPlaces((body.places as Place[]) ?? []);
        await go(String(body.start ?? ""));
      } catch (e) {
        if (!cancelled) setProblem(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, ask, go, currentName]);

  /** What the button would act on: the selected project, or the folder being named. */
  const target =
    mode === "save" ? (name.trim().length > 0 && listing ? childOf(listing.dir, name.trim()) : null) : chosen;

  const act = async (path: string | null): Promise<void> => {
    if (!path || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await onChoose(path);
      onOpenChange(false);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onPathKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    void go(typed.trim());
  };

  const title = mode === "save" ? "Save the project as" : "Open a project";

  return (
    <Dialog open={mode !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[76vh] max-w-3xl flex-col gap-3 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {mode === "save"
              ? "A project is a folder. Choose where it goes and what it is called."
              : "Folders on this machine. The ones holding a project can be opened."}
          </DialogDescription>
        </DialogHeader>

        {/* Where we are, and a way to type somewhere else outright. */}
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="outline"
            size="icon"
            className="size-8 shrink-0"
            aria-label="Up one folder"
            disabled={!listing?.parent || busy}
            onClick={() => void go(listing?.parent ?? undefined)}
          >
            <ArrowUp className="size-4" />
          </Button>
          <div className="relative flex-1">
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={onPathKey}
              aria-label="Folder path"
              spellCheck={false}
              className="h-8 pr-8 font-mono text-[12px]"
            />
            <CornerDownLeft className="absolute top-2 right-2 size-4 text-muted-foreground" />
          </div>
          {busy ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : null}
        </div>

        <div className="flex min-h-0 flex-1 gap-3">
          {/* Shortcuts and what has been open lately. */}
          <div className="w-52 shrink-0 space-y-3 overflow-y-auto">
            <nav aria-label="Places">
              <p className="px-1 pb-1 text-[11px] font-medium text-muted-foreground uppercase">Places</p>
              {places.map((p) => (
                <button
                  key={p.path}
                  type="button"
                  className="flex w-full items-center gap-1.5 truncate rounded px-1.5 py-1 text-left text-[13px] hover:bg-accent"
                  onClick={() => void go(p.path)}
                >
                  <Home className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{p.name}</span>
                </button>
              ))}
            </nav>

            {mode === "open" && recent.length > 0 ? (
              <nav aria-label="Recent projects">
                <p className="px-1 pb-1 text-[11px] font-medium text-muted-foreground uppercase">Recent</p>
                {recent.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    title={r.address}
                    className="flex w-full flex-col items-start rounded px-1.5 py-1 text-left hover:bg-accent"
                    onClick={() => void act(r.address)}
                  >
                    <span className="w-full truncate text-[13px]">{r.name}</span>
                    <span className="w-full truncate text-[11px] text-muted-foreground">{r.address}</span>
                  </button>
                ))}
              </nav>
            ) : null}
          </div>

          {/* The listing itself. */}
          <div
            className="min-w-0 flex-1 overflow-y-auto rounded-md border bg-card"
            role="listbox"
            aria-label="Folders here"
          >
            {(listing?.entries.length ?? 0) === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                {listing?.problem ? "That folder cannot be read." : "No folders here."}
              </p>
            ) : null}
            {listing?.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                role="option"
                aria-selected={chosen === entry.path}
                // A project is a leaf: clicking it chooses it. Any other folder is somewhere to go.
                onClick={() =>
                  entry.project
                    ? (setChosen(entry.path), mode === "save" ? setName(entry.name) : undefined)
                    : void go(entry.path)
                }
                onDoubleClick={() => (entry.project ? void act(entry.path) : undefined)}
                className={`flex w-full items-center gap-2 border-b px-3 py-1.5 text-left last:border-b-0 hover:bg-accent ${
                  chosen === entry.path ? "bg-accent" : ""
                }`}
              >
                <FolderOpen
                  className={`size-4 shrink-0 ${entry.project ? "text-sky-600 dark:text-sky-400" : "text-muted-foreground"}`}
                />
                <span className="min-w-0 flex-1 truncate text-[13px]">{entry.name}</span>
                {entry.project ? (
                  <span className="shrink-0 rounded bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-900 dark:bg-sky-950 dark:text-sky-200">
                    project
                  </span>
                ) : null}
                <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                  {when(entry.at)}
                </span>
              </button>
            ))}
          </div>
        </div>

        {mode === "save" ? (
          <div className="flex shrink-0 items-center gap-2">
            <Label htmlFor="project-folder-name" className="shrink-0 text-[13px]">
              Folder name
            </Label>
            <Input
              id="project-folder-name"
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void act(target);
                }
              }}
              className="h-8 flex-1"
            />
          </div>
        ) : null}

        {problem ? (
          <p className="shrink-0 rounded-md bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            {problem}
          </p>
        ) : null}

        <DialogFooter className="shrink-0 sm:items-center sm:justify-between">
          <p
            className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-muted-foreground"
            title={target ?? ""}
          >
            {target ?? (mode === "open" ? "Nothing chosen" : "")}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" className="h-8" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button className="h-8" disabled={!target || busy} onClick={() => void act(target)}>
              {mode === "save" ? "Save" : "Open"}
              {target && mode === "open" ? ` ${leaf(target)}` : ""}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// The project's name in the title bar, and the place you rename it (ADR-021 D3).
//
// The name was drawn here and nowhere else, so the one place a person looks to change it was the one
// place that would not let them — and with Save as gone there was no other way in at all. Clicking the
// name makes it an input, which is how every application that centres a document's name in its title
// bar behaves.
//
// Renaming goes through `project.setMeta`, the command that already exists. So it is one undo away,
// written to the session log like anything else, and every other tab looking at this project sees the
// new name arrive as an ordinary patch.

import type { JSX, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";

export interface ProjectTitleProps {
  name: string;
  modified: boolean;
  /** Commit a new name. Throws with the host's reason if it is refused. */
  onRename: (name: string) => Promise<void>;
}

export function ProjectTitle({ name, modified, onRename }: ProjectTitleProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const input = useRef<HTMLInputElement>(null);

  // Opening the editor takes the name as it is now, not as it was when this component first rendered:
  // the project may have been renamed in another tab, or another project opened entirely.
  useEffect(() => {
    if (editing) {
      setDraft(name);
      requestAnimationFrame(() => input.current?.select());
    }
  }, [editing, name]);

  const commit = (): void => {
    const wanted = draft.trim();
    setEditing(false);
    // An empty name is not a rename, it is a slip; the project keeps the name it had.
    if (wanted.length === 0 || wanted === name) return;
    void onRename(wanted);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    // The shell listens for single keys as tool shortcuts. Typing a name must not draw a wall.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setEditing(false);
    }
  };

  if (editing)
    return (
      <div className="absolute inset-x-0 mx-auto flex w-fit max-w-[40%] items-center">
        <input
          ref={input}
          value={draft}
          aria-label="Project name"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={commit}
          className="h-7 min-w-[12rem] rounded-sm border border-input bg-background px-2 text-center font-semibold outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>
    );

  return (
    // Centred on the WINDOW rather than placed after the menus, as a word processor centres the
    // document name: it names what is open, and does not belong in the row of controls. The wrapper
    // is click-through so it can never swallow a menu; the button itself takes its clicks back.
    <div className="pointer-events-none absolute inset-x-0 mx-auto flex w-fit max-w-[40%] items-baseline gap-1.5">
      <button
        type="button"
        className="pointer-events-auto truncate rounded-sm px-1.5 py-0.5 text-center font-semibold hover:bg-accent"
        title="Rename this project"
        onClick={() => setEditing(true)}
      >
        {name}
      </button>
      {/* The unsaved mark, the same dot an editor tab uses. It is `historyPosition !== savedPosition`
          from the host, not a guess: a save moves the saved position without changing the project, so
          nothing in the change stream would ever put this out again. */}
      {modified ? (
        <span className="shrink-0 text-muted-foreground" aria-label="Unsaved changes" title="Unsaved changes">
          &bull;
        </span>
      ) : null}
    </div>
  );
}

// The menu bar (ADR-017 D1 amendment): what is open, the menus, and nothing else.
//
// Menus at the top, controls in the toolbar below, as a desktop application separates them. This row
// carried the level, the history and the view switch as well until 2026-09-19; once the menus arrived it
// held two kinds of thing at once and read as a crowded strip rather than as a menu bar. The controls
// moved down one row into the toolbar, which is where the things you press belong.
//
// The only other occupant is the mark that says the host is behind its own source, at the far edge: it
// is not a menu, it is not often there, and when it is there it should catch the eye.

import type { JSX } from "react";
import type { Replica } from "../replica.js";
import { MainMenu } from "./MainMenu.js";
import { ProjectTitle } from "./ProjectTitle.js";
import { StaleNote } from "./StaleNote.js";
import { useModified, useProjectState } from "./useReplica.js";

export interface AppBarProps {
  replica: Replica;
  /** Give the project another name; the title bar is where a person looks to do it (ADR-021 D3). */
  onRename: (name: string) => Promise<void>;
  /** One sentence about the host running code older than what is written, or null when all is well. */
  stale?: string | null;
}

export function AppBar({ replica, onRename, stale = null }: AppBarProps): JSX.Element {
  const state = useProjectState(replica);
  const modified = useModified(replica);
  const name = state?.name ?? "floorplan-ai";

  return (
    <header className="relative flex h-10 items-center gap-2 border-b bg-card px-3">
      <MainMenu />

      <span className="grow" />

      <StaleNote note={stale} />

      <ProjectTitle name={name} modified={modified} onRename={onRename} />
    </header>
  );
}

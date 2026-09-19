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
import { Separator } from "@/components/ui/separator";
import type { Replica } from "../replica.js";
import { MainMenu } from "./MainMenu.js";
import { StaleNote } from "./StaleNote.js";
import { useProject } from "./useReplica.js";

export interface AppBarProps {
  replica: Replica;
  /** One sentence about the host running code older than what is written, or null when all is well. */
  stale?: string | null;
}

export function AppBar({ replica, stale = null }: AppBarProps): JSX.Element {
  const project = useProject(replica);

  return (
    <header className="flex h-10 items-center gap-2 border-b bg-card px-3">
      <strong className="truncate font-semibold">{project?.meta.name ?? "floorplan-ai"}</strong>

      <Separator orientation="vertical" className="mx-1 h-4" />

      <MainMenu />

      <span className="grow" />

      <StaleNote note={stale} />
    </header>
  );
}

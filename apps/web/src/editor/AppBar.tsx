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
    <header className="relative flex h-10 items-center gap-2 border-b bg-card px-3">
      <MainMenu />

      <span className="grow" />

      <StaleNote note={stale} />

      {/* Centred on the window rather than placed after the menus, as a word processor centres the
          document name in its title bar: it names what is open, which is not a control and does not
          belong in the row of them. Absolutely positioned so it is centred on the WINDOW and does not
          shift when a menu name changes length, and click-through so it can never swallow a menu. */}
      <strong className="pointer-events-none absolute inset-x-0 mx-auto w-fit max-w-[40%] truncate text-center font-semibold">
        {project?.meta.name ?? "floorplan-ai"}
      </strong>
    </header>
  );
}

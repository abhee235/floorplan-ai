// Looking around the machine's folders from the editor (ADR-012 D8).
//
// A project lives in a directory on the machine running the host, and a browser tab cannot show a
// native picker for one: the file input it does have returns files the BROWSER chose, with no path the
// host could open. So the host lists directories and the dialog draws the listing.
//
// This adds no reach the session did not have. `project open` and `project save` already take any path
// the caller names, and the host is a local process started by the person using it. What it does add is
// the ability to SEE what is there before naming it, which is the difference between a picker and a
// guess.

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PROJECT_FILE } from "./files.js";

/** One line of a listing. Only directories appear: a project IS a directory (ADR-012 D1). */
export interface BrowseEntry {
  name: string;
  path: string;
  /** A directory holding project.json can be opened; any other is only somewhere to go. */
  project: boolean;
  /** Last modified, ISO, or null when it could not be read. */
  at: string | null;
}

export interface Listing {
  dir: string;
  /** The folder above, or null at a drive root. */
  parent: string | null;
  entries: BrowseEntry[];
  /** Set when the directory itself could not be read; `entries` is then empty. */
  problem?: string;
}

/** A named shortcut in the sidebar of the dialog. */
export interface Place {
  name: string;
  path: string;
}

/** How many entries one listing may carry; a folder of thousands would be unusable drawn anyway. */
export const BROWSE_LIMIT = 500;

function parentOf(dir: string): string | null {
  const up = dirname(dir);
  // dirname("C:\\") is "C:\\" and dirname("/") is "/": a root is its own parent, which is how a root
  // is recognised without hard-coding what a root looks like on each platform.
  return up === dir ? null : up;
}

/** List the directories inside `path`, marking the ones that are projects. */
export async function browse(path: string): Promise<Listing> {
  const dir = resolve(path);
  let names: import("node:fs").Dirent[];
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    return {
      dir,
      parent: parentOf(dir),
      entries: [],
      problem: e instanceof Error ? e.message : String(e),
    };
  }
  const dirs = names
    // Hidden folders and the session directory are noise in a picker, not choices.
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .slice(0, BROWSE_LIMIT);
  const entries = await Promise.all(
    dirs.map(async (d): Promise<BrowseEntry> => {
      const full = join(dir, d.name);
      let at: string | null = null;
      let project = false;
      try {
        at = (await stat(full)).mtime.toISOString();
      } catch {
        at = null;
      }
      try {
        await stat(join(full, PROJECT_FILE));
        project = true;
      } catch {
        project = false;
      }
      return { name: d.name, path: full, project, at };
    }),
  );
  // Projects first, then folders, each alphabetically: the thing being looked for sorts to the top.
  entries.sort((a, b) => (a.project === b.project ? a.name.localeCompare(b.name) : a.project ? -1 : 1));
  return { dir, parent: parentOf(dir), entries };
}

/**
 * The shortcuts offered beside a listing; only the ones that exist are returned.
 *
 * "My projects" leads, and is the answer to "where are my projects?" — a folder that always exists,
 * that Save as suggests, and that the picker starts in when nothing else says otherwise.
 */
export async function places(current: string | null, projects?: string): Promise<Place[]> {
  const home = homedir();
  const candidates: Place[] = [
    ...(projects ? [{ name: "My projects", path: projects }] : []),
    ...(current ? [{ name: `${basename(current)} (this project)`, path: dirname(current) }] : []),
    { name: "Home", path: home },
    { name: "Documents", path: join(home, "Documents") },
    { name: "Desktop", path: join(home, "Desktop") },
  ];
  const out: Place[] = [];
  const seen = new Set<string>();
  for (const place of candidates) {
    if (seen.has(place.path)) continue;
    try {
      if ((await stat(place.path)).isDirectory()) {
        seen.add(place.path);
        out.push(place);
      }
    } catch {
      // a machine without a Desktop folder, or a project on a drive that has gone
    }
  }
  return out;
}

/**
 * Where a picker opens: beside the open project, else the projects folder.
 *
 * The home directory was the old answer and a poor one — a person's home is full of everything except
 * their floor plans, so the picker opened on noise and the first thing anyone had to do was navigate
 * away from it.
 */
export function startingDir(current: string | null, projects?: string): string {
  if (current) return dirname(current);
  return projects ?? homedir();
}

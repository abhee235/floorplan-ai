// Is the running host older than the code on disk?
//
// The host holds the project in memory and runs the reducers from source through tsx, which does not
// reload. Change a reducer, rebuild the web app, refresh the browser, and you get a new front end
// talking to a process that still runs the old rules — the plan moves, the model does not, and it looks
// exactly like a bug in the change you just made. It has cost three false bug reports in one day.
//
// The remedy cannot be to restart the host by itself: the project lives in that process, and a restart
// would drop unsaved edits and the whole undo history. So it says so instead, and leaves the choice to
// the person, who knows whether they have anything to lose.
//
// Only a source checkout can be stale in this way. A packaged host has no `packages/*/src` to compare
// itself with, finds nothing, and says nothing.
import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Staleness {
  /** Source changed after this process started: it is running rules that are no longer what is written. */
  hostBehind: boolean;
  /** The built web app is older than the web source it was built from. */
  buildBehind: boolean;
  /** The newest file involved, relative to the root, to name in the message. */
  newest: string | null;
}

/** Directories whose contents decide whether the HOST is behind: everything it runs. */
const HOST_SOURCES = ["packages", "apps/host/src"];
const SKIP = new Set(["node_modules", "dist", ".git", "test", "coverage"]);

/**
 * The newest source file under `dir`, as a millisecond time and a path, or null when there is nothing
 * there. Walked by hand rather than with a recursive readdir, so that a directory can be refused BEFORE
 * it is entered: node_modules holds tens of thousands of files and enumerating it took ten seconds,
 * which is ten seconds added to opening a tab. Test directories are skipped too, because editing a test
 * cannot change what the host does.
 */
function newestUnder(root: string, dir: string): { at: number; path: string } | null {
  let best: { at: number; path: string } | null = null;
  const stack: string[] = [""];
  let looked = false;
  while (stack.length > 0) {
    const here = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, dir, here), { withFileTypes: true });
      looked = true;
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const relative = here === "" ? entry.name : `${here}/${entry.name}`;
      if (entry.isDirectory()) {
        stack.push(relative);
        continue;
      }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      try {
        const at = statSync(join(root, dir, relative)).mtimeMs;
        if (!best || at > best.at) best = { at, path: `${dir}/${relative}` };
      } catch {
        // a file that went between the listing and the stat; nothing to compare
      }
    }
  }
  return looked ? best : null;
}

/**
 * Whether the host, started at `startedAt`, is running code older than what is on disk, and whether the
 * built web app is older than its own source.
 */
export function staleness(root: string, startedAt: number): Staleness {
  let newestSource: { at: number; path: string } | null = null;
  for (const dir of HOST_SOURCES) {
    const found = newestUnder(root, dir);
    if (found && (!newestSource || found.at > newestSource.at)) newestSource = found;
  }
  const webSource = newestUnder(root, "apps/web/src");
  let builtAt = 0;
  try {
    builtAt = statSync(join(root, "apps/web/dist/index.html")).mtimeMs;
  } catch {
    // never built, or a packaged install with the app somewhere else
  }
  const hostBehind = newestSource !== null && newestSource.at > startedAt;
  const buildBehind = webSource !== null && builtAt > 0 && webSource.at > builtAt;
  return {
    hostBehind,
    buildBehind,
    newest: hostBehind ? (newestSource?.path ?? null) : buildBehind ? (webSource?.path ?? null) : null,
  };
}

/** What to tell the person, in one sentence, or null when there is nothing to tell. */
export function stalenessNote(s: Staleness): string | null {
  const where = s.newest ? ` (${s.newest})` : "";
  if (s.hostBehind && s.buildBehind)
    return `The code changed${where} after the host started, and the app has not been built since. Build it and restart the host, or what you see will not match what it does.`;
  if (s.hostBehind)
    return `The host started before the last change to the code${where}. Restart it, or it will keep running the old rules.`;
  if (s.buildBehind)
    return `The app has not been built since the last change to it${where}. Run the web build and reload.`;
  return null;
}

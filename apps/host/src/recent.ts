// The projects this installation has opened lately (ADR-012 D7), so File ▸ Open recent has something to
// offer and the Open dialog does not start on an empty folder.
//
// One small JSON file in the data directory, beside the catalog. It is a convenience, never a source of
// truth: a corrupt or missing file reads as an empty list rather than failing an open, and an entry
// whose directory has since gone is dropped when the list is read rather than when it is written —
// a project on a drive that is not plugged in today is still worth remembering for tomorrow.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./files.js";

/** How many are kept. Enough for a menu, short enough that the file stays trivial to read. */
export const RECENT_LIMIT = 12;
export const RECENT_FILE = "recent.json";

export interface RecentProject {
  /** The project directory, absolute. */
  path: string;
  name: string;
  /** When it was last opened or saved here, ISO. */
  at: string;
}

export function recentPath(dataDir: string): string {
  return join(dataDir, RECENT_FILE);
}

/** The list, newest first. Unreadable, absent or malformed all mean "nothing remembered yet". */
export function readRecent(file: string): RecentProject[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : (raw as { projects?: unknown })?.projects;
  if (!Array.isArray(list)) return [];
  const out: RecentProject[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { path, name, at } = item as Record<string, unknown>;
    if (typeof path !== "string" || path.length === 0) continue;
    out.push({
      path,
      name: typeof name === "string" && name.length > 0 ? name : path,
      at: typeof at === "string" ? at : "",
    });
    if (out.length >= RECENT_LIMIT) break;
  }
  return out;
}

/** The list with the ones that are still on disk, which is what a menu should show. */
export function readRecentPresent(file: string): RecentProject[] {
  return readRecent(file).filter((r) => existsSync(join(r.path, "project.json")));
}

/**
 * Put one at the top, keeping its single entry: opening the same project twice should move it, not
 * repeat it. Failure to write is swallowed — losing the recent list is never worth failing a save over.
 */
export async function noteRecent(file: string, entry: RecentProject): Promise<void> {
  try {
    const rest = readRecent(file).filter((r) => r.path !== entry.path);
    const next = [entry, ...rest].slice(0, RECENT_LIMIT);
    await writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // a read-only data directory, a race with another host: the list is a convenience
  }
}

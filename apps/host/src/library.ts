// The project library (ADR-021): where this installation keeps projects, and the only place the editor
// can address.
//
// The editor used to browse the machine's folders and ask the person to choose where a project lived.
// That is a desktop application's idea wearing a web interface. A browser will not hand a server a
// local path — not through a file input, and not through the File System Access API either, whose
// handles belong to the tab and can never be read by the host — so the only way to make it work was for
// the host to list its own disk, which stops being a feature and becomes a remote file read the moment
// anyone else can reach the host.
//
// So the app owns where projects go. A project's folder is its id, under one library directory, and
// nothing above this module needs to know that: the editor addresses projects by id and never sees a
// path. Crossing to and from the person's own disk is import and export, which the browser does itself
// through a download and an upload.
//
// This is not a change of format. A project is still the directory of ADR-012 — project.json, the
// manifest, atomic writes, recovery — and can still be committed to git or copied by hand. What changed
// is who chooses the location: nobody.

import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { isProjectId } from "@fpv/ir";

export const LIBRARY_DIR_NAME = "projects";

/**
 * Where the library lives, created if it is not there.
 *
 * An installation may be told to put it elsewhere — a bigger disk, a backed-up volume — which is an
 * administrator's decision made once, not a question put to whoever is drawing a floor plan.
 */
export function libraryRoot(dataDir: string, override?: string | null): string {
  const dir = override ?? join(dataDir, LIBRARY_DIR_NAME);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // a read-only data directory: opening a project will fail with the host's own reason, which says more
  }
  return dir;
}

/**
 * The folder a project lives in.
 *
 * Derived from the id rather than stored, so there is nothing to keep in step and no way for the two to
 * disagree. The id is checked because it arrives from a browser: a project id is twelve characters of
 * lower-case base36 and nothing else, so nothing it names can climb out of the library.
 */
export function folderFor(root: string, id: string): string {
  if (!isProjectId(id)) throw new Error(`not a project id: ${id}`);
  return join(root, id);
}

/** Make the folder for a project about to be written there. */
export function makeFolder(root: string, id: string): string {
  const dir = folderFor(root, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove a project's folder and everything in it. The caller has already asked whether to. */
export async function removeFolder(root: string, id: string): Promise<void> {
  await rm(folderFor(root, id), { recursive: true, force: true });
}

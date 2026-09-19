// Where the host keeps per-user data (ADR-008 D5): the catalog database and installed libraries.
// One directory, overridable with FPV_DATA_DIR or --data; created on first use.
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The project was called floorplan-viz when this directory was first created on people's machines. The
// data directory keeps that name so an existing catalog and its libraries are still found after the rename.
export const APP_DIR_NAME = "floorplan-viz";

export function defaultDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.FPV_DATA_DIR) return env.FPV_DATA_DIR;
  if (platform === "win32")
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), APP_DIR_NAME);
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", APP_DIR_NAME);
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), APP_DIR_NAME);
}

/** The data directory, created if needed, with the catalog database path beside it. */
export function dataPaths(dir: string = defaultDataDir()): {
  dir: string;
  catalogDb: string;
  libraries: string;
} {
  mkdirSync(dir, { recursive: true });
  return { dir, catalogDb: join(dir, "catalog.db"), libraries: join(dir, "libraries") };
}

/**
 * Where a person's projects live by default (ADR-020 D1a).
 *
 * Without one, "open a project" starts nowhere in particular and the answer to "where are my projects?"
 * is whatever the person can remember about their own disk. A named folder that always exists gives the
 * picker somewhere to start, Save as somewhere to suggest, and the question an answer.
 *
 * Documents is where a desktop application puts a person's work and where they will look for it. A
 * machine without one — a server, a stripped Windows install — gets a folder in the home directory
 * instead, which is worse but never wrong.
 */
export function defaultProjectsDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.FPV_PROJECTS_DIR) return env.FPV_PROJECTS_DIR;
  const documents = join(home, "Documents");
  return existsSync(documents) ? join(documents, APP_DIR_NAME) : join(home, APP_DIR_NAME);
}

/** The projects folder, created if it is not there, so the picker is never looking at nothing. */
export function projectsHome(dir: string = defaultProjectsDir()): string {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // a read-only home, a path that cannot be made: the picker still starts there and says it is empty
  }
  return dir;
}

// Where the host keeps per-user data (ADR-008 D5): the catalog database and installed libraries.
// One directory, overridable with FPV_DATA_DIR or --data; created on first use.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

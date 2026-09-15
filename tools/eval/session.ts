// A fresh host session for one evaluation run: an empty project, the seed catalog in memory, the core AV rules
// pack, plan files read relative to the repository root, and exports kept in memory.
import { fileURLToPath } from "node:url";
import { AV_CORE, ensureSeed } from "@fpv/catalog";
import { CatalogStore } from "@fpv/catalog/store";
import type { ExportWriter } from "@fpv/tools";
import { FilePlanReader } from "../../apps/host/src/plans.js";
import { createSession, type Session } from "../../apps/host/src/session.js";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function evalSession(now: () => string = () => new Date().toISOString()): {
  session: Session;
  close(): void;
} {
  const catalog = CatalogStore.open(":memory:");
  ensureSeed(catalog, now());
  const files = new Map<string, number>();
  const writer: ExportWriter = {
    appVersion: "eval",
    async write(path, bytes) {
      files.set(path, bytes.length);
      return { path: `memory:${path}`, bytes: bytes.length };
    },
  };
  const session = createSession({
    now,
    catalog,
    rules: AV_CORE,
    writer,
    plans: new FilePlanReader({ baseDir: () => REPO_ROOT }),
  });
  return { session, close: () => catalog.close() };
}
